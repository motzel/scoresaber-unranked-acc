// ==UserScript==
// @name         ScoreSaber unranked ACC
// @namespace    https://motzel.dev
// @version      0.1
// @description  ScoreSaber Enhancements
// @author       motzel
// @icon         https://scoresaber.com/favicon-32x32.png
// @updateURL    https://github.com/motzel/scoresaber-unranked-acc/raw/master/scoresaber-unranked-acc.js
// @downloadURL  https://github.com/motzel/scoresaber-unranked-acc/raw/master/scoresaber-unranked-acc.js
// @supportURL   https://github.com/motzel/scoresaber-unranked-acc/issues
// @match        https://scoresaber.com/u/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function (window) {
  "use strict";

  if (window.XMLHttpRequest.prototype.interceptorApplied) return;

  const AFTER_RESPONSE_DELAY = 800;
  const AFTER_HISTORY_DELAY = 1000;
  const LOCAL_STORAGE_KEY = 'beatSaverCache';
  const LOCAL_STORAGE_SAVE_DELAY = 1000;

  const difficulties = {
    1: 'Easy',
    3: 'Normal',
    5: 'Hard',
    7: 'Expert',
    9: 'ExpertPlus',
  }

  let lastParams = null;
  const scoresCache = {};

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const getParamsHash = params => JSON.stringify(params);

  const matchSiteUrl = url => url.match(/\/u\/(\d+)(?:\?page=(\d+)&sort=(.*))?$/);
  const matchApiUrl = url => url.match(/\/api\/player\/(\d+)\/scores(?:\?page=(\d+)&sort=(.*))?$/);
  const getUrlData = (url, matcher) => {
    const match = matcher(url);
    if (!match) return null;

    const playerId = match[1];
    let page = parseInt(match[2], 10);
    if (isNaN(page)) page = 1;
    const sort = match[3] === 'recent' ? 'recent' : 'top';

    return {playerId, page, sort};
  }

  const getMaxScore = (blocks, maxScorePerBlock = 115) =>
    Math.floor(
      (blocks >= 14 ? 8 * maxScorePerBlock * (blocks - 13) : 0) +
      (blocks >= 6
        ? 4 * maxScorePerBlock * (Math.min(blocks, 13) - 5)
        : 0) +
      (blocks >= 2
        ? 2 * maxScorePerBlock * (Math.min(blocks, 5) - 1)
        : 0) +
      Math.min(blocks, 1) * maxScorePerBlock
    );

  const beatSaverService = (() => {
    let inProgress = {};

    const cache = JSON.parse(window.localStorage.getItem(LOCAL_STORAGE_KEY)) ?? {};

    let cacheSaveTimeoutId = null;
    const getCached = hash => cache[hash];
    const setCache = (hash, value) => {
      cache[hash] = value;

      if (cacheSaveTimeoutId) clearTimeout(cacheSaveTimeoutId);
      cacheSaveTimeoutId = setTimeout(() => window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(cache)), LOCAL_STORAGE_SAVE_DELAY);

      return value;
    }

    const fetchData = async hash => fetch(`https://api.beatsaver.com/maps/hash/${hash}`).then(async r => ({response: r, body: await r.json()}));

    const byHash = async hash => {
      if (!hash?.length) return null;

      hash = hash.toUpperCase();

      try {
        const cachedData = getCached(hash);
        if (cachedData !== undefined) return cachedData;

        if (!inProgress[hash]) {
          inProgress[hash] = fetchData(hash);
        }

        const promise = await inProgress[hash];
        if (promise.response.status === 404) {
          // store null so that this hash is never retrieved again
          return setCache(hash, null);
        }

        if (!promise.response.ok) throw `HTTP ${promise.response.status} error`;

        const data = promise.body;

        const id = data?.id ?? null;
        const bpm = data?.metadata?.bpm ?? null;
        const versions = data?.versions ?? null;

        if (!id || !bpm || !versions?.length || !versions?.[versions.length - 1]?.diffs)
          throw `API returned invalid data`;

        return setCache(hash, {hash, id, bpm, diffs: versions?.[versions.length - 1]?.diffs});
      } catch (e) {
        console.error(`An error occurred while downloading song data (${hash}) from Beat Saver: ${e.toString()}`);

        return null;
      } finally {
        delete (inProgress[hash]);
      }
    }

    return {
      byHash,
    }
  })();

  const enhance = async params => {
    const paramsHash = getParamsHash(params);
    const scores = scoresCache[paramsHash];

    if (!scores || paramsHash !== getParamsHash(getUrlData(window.location.href, matchSiteUrl))) return;

    [...document.querySelectorAll('.ranking.songs .table-item')]
      .forEach((el, idx) => {
        if (!scores?.[idx]?.maxScore || !scores?.[idx]?.baseScore) return;

        const songImage = el.querySelector('.song-image');
        if (!songImage) return;

        const imageMatch = songImage.src.match(/covers\/(.*?)\..*?$/);
        if (!imageMatch?.[1]?.length) return;

        const scoreInfoChilds = [...el.querySelectorAll('.scoreInfo > div')];
        if (scoreInfoChilds?.length !== 1) return;

        // skip if acc stat is already added
        if (scoreInfoChilds[0].querySelector('.stat.acc')) return;

        // check the hash to be sure
        const hash = imageMatch[1].toUpperCase();
        if (hash !== scores[idx]?.hash) return;

        const acc = (scores[idx].baseScore / scores[idx].maxScore * 100) / (scores[idx]?.multiplier ?? 1);

        const existingElClassName = scoreInfoChilds[0].className;

        const newSpanEl = window.document.createElement('span');
        newSpanEl.title = 'Accuracy';
        newSpanEl.className = `stat acc ${existingElClassName}`;
        newSpanEl.innerText = acc.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }) + '%';

        scoreInfoChilds[0].prepend(newSpanEl);
      });
  }

  const fetchBeatSaverData = async (scores, params) => {
    const hashes = [...new Set(scores.map(s => s?.hash).filter(h => h))];
    if (!hashes.length) return;

    const beatSaverData = (await Promise.all(
      hashes
        .map(hash => beatSaverService.byHash(hash))
        .concat([delay(AFTER_RESPONSE_DELAY)])
    ))
      .filter(bs => bs);
    if (!beatSaverData.length) return;

    const beatSaverObj = beatSaverData.reduce((obj, bs) => ({...obj, ...{[bs.hash]: bs}}), {});

    scoresCache[getParamsHash(params)] = scores.map(s => {
      const hash = s?.hash?.toUpperCase();

      if (!beatSaverObj[hash]) return;

      const beatSaver = {id: beatSaverObj[hash].id, bpm: beatSaverObj[hash].bpm};

      const characteristic = s?.difficulty?.gameMode?.replace('Solo', '');
      const difficulty = difficulties[s?.difficulty?.difficulty] ?? null;

      if (characteristic && difficulty) {
        beatSaver.diff = (beatSaverObj[hash]?.diffs ?? []).find(d => d.characteristic === characteristic && d.difficulty === difficulty) ?? null;
      }

      const maxScore = s.maxScore ? s.maxScore : getMaxScore(beatSaver?.diff?.notes ?? 0);

      return {
        ...s,
        maxScore,
        beatSaver
      }
    });

    enhance(params);
  }

  const pushState = window.history.pushState;
  const triggerHistoryEnhance = () => {
    const params = getUrlData(window.location.href, matchSiteUrl);
    if (!params) return;

    delay(AFTER_HISTORY_DELAY).then(_ => {
      // checking if the request is in progress or if data is being taken from the cache
      if (getParamsHash(params) !== getParamsHash(lastParams)) {
        lastParams = params;
        enhance(params);
      }
    })
  }
  window.history.pushState = function (state, title, url) {
    setTimeout(() => triggerHistoryEnhance(), 0);

    return pushState.apply(history, arguments);
  };
  window.addEventListener('popstate', () => triggerHistoryEnhance());

  const open = window.XMLHttpRequest.prototype.open;
  const send = window.XMLHttpRequest.prototype.send;
  window.XMLHttpRequest.prototype.interceptorApplied = true;
  window.XMLHttpRequest.prototype.open = function (method, url, async, user, pass) {
    const params = getUrlData(url, matchApiUrl);
    if (params) lastParams = params;
    this._url = url;
    open.call(this, method, url, async, user, pass);
  };
  window.XMLHttpRequest.prototype.send = function (data) {
    let self = this;
    let oldOnReadyStateChange;

    function onReadyStateChange() {
      if (self.readyState === 4) {
        const params = getUrlData(self._url, matchApiUrl);
        if (params) {
          try {
            const scores = (JSON.parse(self.responseText)?.playerScores ?? [])
              .map((s, idx) => {
                const hash = s?.leaderboard?.songHash ?? null;
                const difficulty = s?.leaderboard?.difficulty ?? null;
                const maxScore = s?.leaderboard?.maxScore ?? null;
                const baseScore = s?.score?.baseScore ?? null;
                const modifiedScore = s?.score?.modifiedScore ?? null;
                const multiplier = s?.score?.multiplier ?? null;

                if (!hash || !difficulty || !baseScore || !modifiedScore || !multiplier) return null;

                return {idx, hash, difficulty, baseScore, modifiedScore, maxScore, multiplier};
              })
              .filter(u => u)

            fetchBeatSaverData(scores, params);
          } catch (e) {
            // swallow error
          }
        }
      }

      if (oldOnReadyStateChange) {
        oldOnReadyStateChange();
      }
    }

    if (this.addEventListener) {
      this.addEventListener("readystatechange", onReadyStateChange, false);
    } else {
      oldOnReadyStateChange = this.onreadystatechange;
      this.onreadystatechange = onReadyStateChange;
    }

    send.call(this, data);
  }

  // trigger visibilitychange to refresh the data on first page load
  setTimeout(() => window.dispatchEvent( new Event('visibilitychange') ), 500);
})(window);