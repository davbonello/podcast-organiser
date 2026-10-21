/*
 * logic.js — pure functions for the Podcast Organiser (no DOM, no network).
 * Works in the browser (window.POLogic) and in Node (module.exports) so it can be unit tested.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.POLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 86400000;

  /* ---------- dates ---------- */

  // UTC midnight of the *local* calendar day containing ms.
  function localDayStartUTC(ms) {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // Spotify release_date is "YYYY", "YYYY-MM" or "YYYY-MM-DD". Returns UTC-midnight ms, or null.
  function parseReleaseDate(str) {
    if (!str) return null;
    const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(str);
    if (!m) return null;
    return Date.UTC(+m[1], m[2] ? +m[2] - 1 : 0, m[3] ? +m[3] : 1);
  }

  /* ---------- trimming raw Spotify objects (keeps the local cache small) ---------- */

  // images are listed widest first; pick the smallest one that is still >= target px wide.
  function pickImage(images, target) {
    target = target || 160;
    if (!Array.isArray(images) || !images.length) return null;
    const sized = images.filter(i => i && i.url);
    if (!sized.length) return null;
    const ok = sized.filter(i => (i.width || 0) >= target);
    if (ok.length) return ok.reduce((a, b) => ((a.width || 0) <= (b.width || 0) ? a : b)).url;
    return sized[0].url;
  }

  function trimShow(show) {
    return {
      id: show.id,
      name: show.name || '',
      image: pickImage(show.images, 160),
      url: show.external_urls && show.external_urls.spotify ? show.external_urls.spotify : null,
      totalEpisodes: typeof show.total_episodes === 'number' ? show.total_episodes : null,
      languages: Array.isArray(show.languages) ? show.languages : [],
      description: (show.description || '').slice(0, 240)
    };
  }

  function trimEpisode(ep) {
    const rp = ep.resume_point || {};
    return {
      id: ep.id,
      name: ep.name || '',
      release_date: ep.release_date || null,
      duration_ms: ep.duration_ms || 0,
      fully_played: !!rp.fully_played,
      resume_position_ms: rp.resume_position_ms || 0,
      url: ep.external_urls && ep.external_urls.spotify ? ep.external_urls.spotify : null,
      uri: ep.uri || null,
      playable: ep.is_playable !== false
    };
  }

  /* ---------- followed-podcasts feed ---------- */

  // "New" = released on or after the calendar day of the previous visit (release dates only have day precision).
  function isNewEpisode(releaseMs, prevVisitMs) {
    if (releaseMs === null || prevVisitMs === null || prevVisitMs === undefined) return false;
    return releaseMs >= localDayStartUTC(prevVisitMs);
  }

  function buildFeed(shows, episodesByShow, opts) {
    const now = opts.now !== undefined ? opts.now : Date.now();
    const days = opts.days;
    const cutoff = localDayStartUTC(now) - days * DAY;
    const items = [];
    for (const show of shows) {
      const eps = (episodesByShow && episodesByShow[show.id]) || [];
      for (const ep of eps) {
        if (!ep || ep.playable === false) continue;
        const releaseMs = parseReleaseDate(ep.release_date);
        if (releaseMs === null || releaseMs < cutoff) continue;
        const duration = ep.duration_ms || 0;
        const pos = ep.resume_position_ms || 0;
        const played = !!ep.fully_played;
        items.push({
          id: ep.id,
          showId: show.id,
          showName: show.name,
          showImage: show.image,
          title: ep.name,
          releaseMs: releaseMs,
          durationMs: duration,
          played: played,
          unlistened: !played,
          progress: !played && duration > 0 ? Math.min(1, pos / duration) : 0,
          isNew: isNewEpisode(releaseMs, opts.prevVisit),
          url: ep.url
        });
      }
    }
    items.sort((a, b) => b.releaseMs - a.releaseMs || a.showName.localeCompare(b.showName));
    return items;
  }

  function summarise(items, shows) {
    const per = {};
    for (const s of shows) {
      per[s.id] = { id: s.id, name: s.name, image: s.image, total: 0, newCount: 0, unlistened: 0, played: 0 };
    }
    let newCount = 0;
    let unlistened = 0;
    for (const it of items) {
      const p = per[it.showId];
      if (!p) continue;
      p.total++;
      if (it.isNew) { p.newCount++; newCount++; }
      if (it.unlistened) { p.unlistened++; unlistened++; } else { p.played++; }
    }
    const perShow = Object.values(per).sort((a, b) => b.unlistened - a.unlistened || a.name.localeCompare(b.name));
    return { newCount: newCount, unlistenedCount: unlistened, totalEpisodes: items.length, perShow: perShow };
  }

  function applyFilter(items, filter, showId) {
    return items.filter(it => {
      if (showId && it.showId !== showId) return false;
      if (filter === 'new') return it.isNew;
      if (filter === 'unlistened') return it.unlistened;
      return true;
    });
  }

  /* ---------- formatting ---------- */

  function dayLabel(ms, now) {
    const diff = Math.round((localDayStartUTC(now) - ms) / DAY);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  function groupByDay(items, now) {
    const groups = [];
    let current = null;
    for (const it of items) {
      if (!current || current.key !== it.releaseMs) {
        current = { key: it.releaseMs, label: dayLabel(it.releaseMs, now), items: [] };
        groups.push(current);
      }
      current.items.push(it);
    }
    return groups;
  }

  function formatDuration(ms) {
    const mins = Math.round((ms || 0) / 60000);
    if (mins < 1) return '<1 min';
    if (mins < 60) return mins + ' min';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h + ' h ' + String(m).padStart(2, '0') + ' min';
  }

  function timeAgo(ms, now) {
    const sec = Math.max(0, Math.round((now - ms) / 1000));
    if (sec < 45) return 'just now';
    const min = Math.round(sec / 60);
    if (min < 60) return min + ' min ago';
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + ' h ago';
    const d = Math.round(hr / 24);
    return d + (d === 1 ? ' day ago' : ' days ago');
  }

  /* ---------- Maltese podcast discovery ---------- */

  const MALTA_RE = /\b(malta|maltese|malti|maltin|gozo|valletta)/i;

  // Returns why a show looks Maltese, or null if it doesn't.
  function malteseReason(show) {
    const langs = Array.isArray(show.languages) ? show.languages : [];
    if (langs.some(l => /^mt(?:-|$)/i.test(l))) return 'Maltese language';
    const text = (show.name || '') + ' ' + (show.description || '');
    if (MALTA_RE.test(text)) return 'Mentions Malta';
    return null;
  }

  // Activity score 0-100 from the show's most recent episodes: 60 pts recency (fades over 90 days), 40 pts frequency (episodes in last 90 days, capped at 12).
  function scoreShow(episodes, now) {
    const dates = (episodes || []).map(e => parseReleaseDate(e.release_date)).filter(d => d !== null);
    if (!dates.length) return { score: 0, latestMs: null, daysSinceLatest: null, count90: 0 };
    const today = localDayStartUTC(now);
    const latest = Math.max.apply(null, dates);
    const daysSince = Math.max(0, Math.round((today - latest) / DAY));
    const count90 = dates.filter(d => d >= today - 90 * DAY).length;
    const recency = Math.max(0, 1 - daysSince / 90) * 60;
    const frequency = (Math.min(count90, 12) / 12) * 40;
    return { score: Math.round(recency + frequency), latestMs: latest, daysSinceLatest: daysSince, count90: count90 };
  }

  // candidates: [{ show, reason, episodes }]. Drops followed shows and shows with no episode in the last 90 days.
  function rankDiscovery(candidates, followedIds, now) {
    const out = [];
    for (const c of candidates) {
      if (followedIds.has(c.show.id)) continue;
      const s = scoreShow(c.episodes, now);
      if (s.score <= 0) continue;
      out.push({ show: c.show, reason: c.reason, score: s.score, latestMs: s.latestMs, daysSinceLatest: s.daysSinceLatest, count90: s.count90 });
    }
    out.sort((a, b) => b.score - a.score || a.show.name.localeCompare(b.show.name));
    return out;
  }

  /* ---------- small async helper ---------- */

  // Runs fn over items with at most `limit` in flight; results keep input order.
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  return {
    DAY, localDayStartUTC, parseReleaseDate, pickImage, trimShow, trimEpisode,
    isNewEpisode, buildFeed, summarise, applyFilter,
    dayLabel, groupByDay, formatDuration, timeAgo,
    malteseReason, scoreShow, rankDiscovery, mapLimit
  };
});
