/*
 * data.js — orchestrates the Spotify client and the pure logic into the two things the app shows:
 *   1. episodes of the shows you follow (loadFollowed)
 *   2. Maltese shows you don't follow, ranked by recent activity (loadDiscovery)
 * Browser: window.PODataFactory.create({ api, logic }). Node tests inject a mock api.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PODataFactory = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DISCOVERY_QUERIES = ['Malta', 'Maltese', 'Malti', 'Maltin', 'podcast Malta'];
  const DISCOVERY_PAGES = [0, 10];     // search returns max 10 per request
  const MAX_CANDIDATES = 25;           // caps the per-show episode lookups (keeps within API quota)

  function isFatal(e) {
    return !!e && (e.name === 'AuthError' || e.reason === 'QUOTA_EXCEEDED');
  }

  function create(deps) {
    const api = deps.api;
    const logic = deps.logic;
    const nowFn = deps.now || Date.now;

    // Returns raw episodes for a show, newest portion first.
    //  sinceMs given -> everything released on/after sinceMs (up to maxPages pages of `limit`)
    //  sinceMs null  -> just the `limit` most recent episodes
    // Spotify's docs don't state the sort order of /shows/{id}/episodes, so both orders are handled:
    // if the first page runs oldest -> newest, we read from the end of the list instead.
    async function fetchEpisodes(showId, opts) {
      const limit = opts.limit;
      const sinceMs = opts.sinceMs === undefined ? null : opts.sinceMs;
      const maxPages = opts.maxPages || 4;

      const first = await api.getShowEpisodes(showId, { limit: limit, offset: 0 });
      const firstItems = (first.items || []).filter(Boolean);
      if (!firstItems.length) return [];
      const total = typeof first.total === 'number' ? first.total : firstItems.length;
      const dates = firstItems.map(e => logic.parseReleaseDate(e.release_date)).filter(d => d !== null);
      const ascending = dates.length > 1 && dates[0] < dates[dates.length - 1];
      const minOf = list => Math.min.apply(null, list.map(e => logic.parseReleaseDate(e.release_date)).filter(d => d !== null));

      let collected = firstItems.slice();

      if (!ascending) {
        let offset = limit;
        let pages = 1;
        let lastPage = firstItems;
        while (sinceMs !== null && pages < maxPages && offset < total && minOf(lastPage) >= sinceMs) {
          const page = await api.getShowEpisodes(showId, { limit: limit, offset: offset });
          lastPage = (page.items || []).filter(Boolean);
          if (!lastPage.length) break;
          collected = collected.concat(lastPage);
          offset += limit;
          pages++;
        }
      } else if (total > limit) {
        collected = [];
        let end = total;
        for (let k = 0; k < maxPages && end > 0; k++) {
          const off = Math.max(0, end - limit);
          const lim = end - off;
          const page = await api.getShowEpisodes(showId, { limit: lim, offset: off });
          const items = (page.items || []).filter(Boolean);
          collected = collected.concat(items);
          end = off;
          if (sinceMs === null) break;
          if (items.length && minOf(items) < sinceMs) break;
        }
      }

      const seen = new Set();
      return collected.filter(e => (seen.has(e.id) ? false : (seen.add(e.id), true)));
    }

    async function loadFollowed(days, onProgress) {
      const rawShows = await api.getSavedShows();
      const shows = rawShows.map(logic.trimShow);
      const sinceMs = logic.localDayStartUTC(nowFn()) - days * logic.DAY;
      const episodesByShow = {};
      const failed = [];
      let done = 0;
      if (onProgress) onProgress(0, shows.length);
      await logic.mapLimit(shows, 4, async show => {
        try {
          const eps = await fetchEpisodes(show.id, { sinceMs: sinceMs, limit: 50, maxPages: 4 });
          episodesByShow[show.id] = eps.map(logic.trimEpisode);
        } catch (e) {
          if (isFatal(e)) throw e;
          failed.push({ id: show.id, name: show.name, message: e && e.message ? e.message : String(e) });
          episodesByShow[show.id] = [];
        }
        done++;
        if (onProgress) onProgress(done, shows.length);
      });
      return { shows: shows, episodesByShow: episodesByShow, failed: failed, fetchedAt: nowFn(), days: days };
    }

    async function loadDiscovery(followedIds, onProgress) {
      const followed = followedIds instanceof Set ? followedIds : new Set(followedIds || []);
      const found = new Map();
      const tasks = [];
      for (const q of DISCOVERY_QUERIES) for (const offset of DISCOVERY_PAGES) tasks.push({ q: q, offset: offset });

      await logic.mapLimit(tasks, 3, async t => {
        try {
          const res = await api.searchShows(t.q, { offset: t.offset, limit: 10 });
          const items = (res && res.shows && res.shows.items) || [];
          for (const s of items) if (s && s.id && !found.has(s.id)) found.set(s.id, s);
        } catch (e) {
          if (isFatal(e)) throw e;       // a single failed search page is not worth failing the whole run
        }
      });

      let candidates = [];
      for (const raw of found.values()) {
        if (followed.has(raw.id)) continue;
        const reason = logic.malteseReason(raw);   // judged on the full, untrimmed description
        if (reason) candidates.push({ raw: raw, reason: reason });
      }
      // Shows tagged with the Maltese language first, then the rest.
      candidates.sort((a, b) => (a.reason === 'Maltese language' ? 0 : 1) - (b.reason === 'Maltese language' ? 0 : 1));
      const considered = candidates.length;
      candidates = candidates.slice(0, MAX_CANDIDATES);

      let done = 0;
      if (onProgress) onProgress(0, candidates.length);
      const withEpisodes = await logic.mapLimit(candidates, 4, async c => {
        let episodes = [];
        try {
          episodes = await fetchEpisodes(c.raw.id, { sinceMs: null, limit: 10 });
        } catch (e) {
          if (isFatal(e)) throw e;
        }
        done++;
        if (onProgress) onProgress(done, candidates.length);
        return { show: logic.trimShow(c.raw), reason: c.reason, episodes: episodes };
      });

      const results = logic.rankDiscovery(withEpisodes, followed, nowFn());
      return { results: results, searched: found.size, considered: considered, fetchedAt: nowFn() };
    }

    return { loadFollowed, loadDiscovery, fetchEpisodes };
  }

  return { create, DISCOVERY_QUERIES, DISCOVERY_PAGES, MAX_CANDIDATES };
});
