/*
 * app.js — screens and wiring for the Podcast Organiser.
 * All text from Spotify is inserted with textContent (never innerHTML); links/images are only used if they point at Spotify.
 */
(function () {
  'use strict';

  const L = window.POLogic;
  const SP = window.POSpotify;
  const DF = window.PODataFactory;
  const root = document.getElementById('app');

  const KEYS = { clientId: 'po.clientId', days: 'po.days', lastVisit: 'po.lastVisit', feed: 'po.cache.feed', disc: 'po.cache.disc' };
  const FEED_TTL = 10 * 60 * 1000;     // refresh the followed-shows feed on open if older than 10 min
  const DISC_TTL = 60 * 60 * 1000;     // refresh discovery on open if older than 1 h (keeps within Spotify's quota)
  const DAY_OPTIONS = [7, 14, 30, 60, 90, 180];
  const REQUIRED_SCOPES = ['user-library-read', 'user-read-playback-position'];

  /* ---------- storage ---------- */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
    getJSON(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    setJSON(k, v) { return store.set(k, JSON.stringify(v)); }
  };

  /* ---------- services ---------- */
  const spotify = SP.create({ storage: window.localStorage, fetch: window.fetch.bind(window), crypto: window.crypto });
  const data = DF.create({ api: spotify, logic: L });

  /* ---------- state ---------- */
  const state = {
    screen: 'boot',            // boot | setup | login | main
    tab: 'episodes',           // episodes | discover
    filter: 'all',             // all | new | unlistened
    showId: null,
    days: DAY_OPTIONS.includes(Number(store.get(KEYS.days))) ? Number(store.get(KEYS.days)) : 30,
    feed: null,
    disc: null,
    loadingFeed: false,
    loadingDisc: false,
    progress: null,
    error: null,
    settingsOpen: false,
    prevVisit: null
  };

  /* ---------- tiny DOM helpers ---------- */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kids = Array.isArray(arguments[i]) ? arguments[i] : [arguments[i]];
      for (const kid of kids) {
        if (kid === null || kid === undefined || kid === false) continue;
        el.append(kid);
      }
    }
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(attrs, shapes) {
    const el = document.createElementNS(SVG_NS, 'svg');
    for (const k of Object.keys(attrs || {})) el.setAttribute(k, attrs[k]);
    for (const s of shapes || []) {
      const node = document.createElementNS(SVG_NS, s.t);
      for (const k of Object.keys(s)) if (k !== 't') node.setAttribute(k, s[k]);
      el.append(node);
    }
    return el;
  }
  const ICONS = {
    refresh: [{ t: 'path', d: 'M21 12a9 9 0 1 1-3-6.7L21 8' }, { t: 'path', d: 'M21 3v5h-5' }],
    settings: [{ t: 'path', d: 'M4 6h9' }, { t: 'path', d: 'M17 6h3' }, { t: 'circle', cx: 15, cy: 6, r: 2 },
      { t: 'path', d: 'M4 12h3' }, { t: 'path', d: 'M11 12h9' }, { t: 'circle', cx: 9, cy: 12, r: 2 },
      { t: 'path', d: 'M4 18h11' }, { t: 'path', d: 'M19 18h1' }, { t: 'circle', cx: 17, cy: 18, r: 2 }],
    list: [{ t: 'path', d: 'M8 6h13' }, { t: 'path', d: 'M8 12h13' }, { t: 'path', d: 'M8 18h13' },
      { t: 'path', d: 'M3 6h.01' }, { t: 'path', d: 'M3 12h.01' }, { t: 'path', d: 'M3 18h.01' }],
    discover: [{ t: 'circle', cx: 11, cy: 11, r: 7 }, { t: 'path', d: 'M21 21l-4.3-4.3' }]
  };
  function icon(name) { return svg({ viewBox: '0 0 24 24', 'aria-hidden': 'true' }, ICONS[name]); }

  const safeSpotifyUrl = u => (typeof u === 'string' && /^https:\/\/open\.spotify\.com\//.test(u)) ? u : null;
  const safeImage = u => (typeof u === 'string' && /^https:\/\/[a-z0-9.-]*scdn\.co\//i.test(u)) ? u : null;

  function cover(url, size, alt) {
    const src = safeImage(url);
    return src
      ? h('img', { src: src, alt: alt || '', width: size, height: size, loading: 'lazy', decoding: 'async' })
      : h('div', { class: 'ph', 'aria-hidden': 'true' });
  }

  function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }

  async function copyText(text, btn) {
    const old = btn.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
    catch (e) { btn.textContent = 'Press and hold the address to copy'; }
    setTimeout(() => { btn.textContent = old; }, 2500);
  }

  /* ---------- rendering ---------- */
  function render(opts) {
    const keep = !opts || opts.keepScroll !== false;
    const y = window.scrollY;
    let nodes;
    if (state.screen === 'setup') nodes = [renderSetup()];
    else if (state.screen === 'login') nodes = [renderLogin()];
    else if (state.screen === 'main') nodes = renderMain();
    else nodes = [h('div', { class: 'screen' }, h('p', { text: 'Loading…' }))];
    root.replaceChildren(...nodes.filter(Boolean));
    window.scrollTo(0, keep ? y : 0);
  }

  function banner(kind, title, text) {
    return h('div', { class: 'banner ' + kind, role: kind === 'error' ? 'alert' : null }, h('b', { text: title }), text);
  }

  function footer() {
    return h('p', { class: 'foot' }, 'Podcast data and artwork provided by ',
      h('a', { href: 'https://open.spotify.com', target: '_blank', rel: 'noopener noreferrer', text: 'Spotify' }), '.');
  }

  /* ----- setup (first run: Spotify Client ID) ----- */
  function renderSetup() {
    const uri = redirectUri();
    const host = location.hostname;
    let uriWarn = null;
    if (host === 'localhost') uriWarn = 'Spotify does not accept "localhost". When testing on a computer, open this page as http://127.0.0.1:PORT/ instead.';
    else if (location.protocol !== 'https:' && host !== '127.0.0.1' && host !== '[::1]') uriWarn = 'Spotify only accepts HTTPS addresses (or 127.0.0.1 for testing). Host this app on an https:// address.';

    const input = h('input', { type: 'text', id: 'cid', placeholder: 'Client ID (letters and numbers)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Spotify Client ID' });
    const msg = h('p', { id: 'cid-msg', class: 'hint', role: 'alert' });
    const copyBtn = h('button', { class: 'btn small', type: 'button', text: 'Copy address' });
    copyBtn.addEventListener('click', () => copyText(uri, copyBtn));

    function save() {
      const v = input.value.trim();
      if (!/^[A-Za-z0-9]{20,64}$/.test(v)) { msg.textContent = 'That doesn\'t look like a Spotify Client ID. Copy it from the app\'s Settings page in the Spotify Developer Dashboard.'; return; }
      store.set(KEYS.clientId, v);
      state.error = null;
      state.screen = 'login';
      render({ keepScroll: false });
    }

    return h('div', { class: 'screen' },
      h('h1', { text: 'Podcast Organiser' }),
      h('p', { text: 'One-time setup to connect this app to your Spotify account.' }),
      uriWarn ? banner('warn', 'Check the address', uriWarn) : null,
      h('ol', { class: 'steps' },
        h('li', null, h('b', { text: 'Create a Spotify app' }),
          'Open the ', h('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener noreferrer', text: 'Spotify Developer Dashboard', style: { textDecoration: 'underline' } }),
          ', choose Create app, and tick "Web API". Any name and description will do.'),
        h('li', null, h('b', { text: 'Add this Redirect URI' }),
          'In the app\'s settings, paste this exact address (including the final slash) under Redirect URIs:',
          h('code', { class: 'uri', text: uri }), h('div', { class: 'field' }, copyBtn)),
        h('li', null, h('b', { text: 'Add yourself as a user' }),
          'Under User management, add your own Spotify name and e-mail address if it is not already listed.'),
        h('li', null, h('b', { text: 'Paste your Client ID' }),
          'Copy the Client ID from the app\'s Settings page and paste it here.',
          h('div', { class: 'field' }, input, h('button', { class: 'btn primary', type: 'button', text: 'Save', onclick: save })), msg)),
      footer());
  }

  /* ----- login ----- */
  function renderLogin() {
    const btn = h('button', { class: 'btn primary block', type: 'button', text: 'Connect to Spotify' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const url = await spotify.startLogin(store.get(KEYS.clientId), redirectUri());
        location.assign(url);
      } catch (e) {
        state.error = 'Could not start sign-in: ' + e.message;
        render();
      }
    });
    return h('div', { class: 'screen' },
      h('h1', { text: 'Podcast Organiser' }),
      h('p', { text: 'Sign in with Spotify to see new and unlistened episodes from the podcasts you follow.' }),
      state.error ? banner('error', 'Sign-in problem', state.error) : null,
      btn,
      h('p', { class: 'foot' }, 'Permissions requested: read your saved podcasts and your listening progress. This app never changes anything in your Spotify account.'),
      h('p', { class: 'foot' }, h('button', { class: 'link-btn', type: 'button', text: 'Change Client ID', onclick: () => { store.del(KEYS.clientId); state.error = null; state.screen = 'setup'; render({ keepScroll: false }); } })),
      footer());
  }

  /* ----- main ----- */
  function renderMain() {
    const nodes = [];
    const wrap = h('div', { class: 'app' });
    wrap.append(topbar());
    if (state.loadingFeed || state.loadingDisc) wrap.append(progressBar());
    if (state.error) wrap.append(banner('error', 'Something went wrong', state.error));
    const missing = missingScopes();
    if (missing.length) wrap.append(banner('warn', 'Permissions missing', 'Spotify did not grant: ' + missing.join(', ') + '. Open Settings, sign out and sign in again, and accept all permissions.'));
    if (state.tab === 'episodes') wrap.append(...episodesTab());
    else wrap.append(...discoverTab());
    wrap.append(footer());
    nodes.push(wrap, tabsBar());
    if (state.settingsOpen) nodes.push(settingsSheet());
    return nodes;
  }

  function missingScopes() {
    const granted = spotify.grantedScopes();
    if (!granted.length) return [];
    return REQUIRED_SCOPES.filter(s => !granted.includes(s));
  }

  function topbar() {
    const busy = state.tab === 'episodes' ? state.loadingFeed : state.loadingDisc;
    const stamp = state.tab === 'episodes' ? (state.feed && state.feed.fetchedAt) : (state.disc && state.disc.fetchedAt);
    const sub = busy ? 'Updating…' : (stamp ? 'Updated ' + L.timeAgo(stamp, Date.now()) : 'Not loaded yet');
    const refreshBtn = h('button', { class: 'icon-btn' + (busy ? ' spin' : ''), type: 'button', 'aria-label': 'Refresh', onclick: () => (state.tab === 'episodes' ? refreshFeed() : refreshDiscovery()) }, icon('refresh'));
    const settingsBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Settings', onclick: () => { state.settingsOpen = true; render(); } }, icon('settings'));
    return h('header', { class: 'topbar' },
      h('div', { class: 'grow' }, h('h1', { text: state.tab === 'episodes' ? 'Episodes' : 'Discover' }), h('div', { class: 'sub', text: sub })),
      refreshBtn, settingsBtn);
  }

  function progressBar() {
    const p = state.progress;
    const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
    return h('div', { class: 'progress' + (p && p.total ? '' : ' indeterminate'), id: 'progress', role: 'progressbar', 'aria-label': 'Loading' }, h('div', { style: { width: pct + '%' } }));
  }
  function updateProgress() {
    const el = document.getElementById('progress');
    if (!el || !state.progress || !state.progress.total) return;
    el.classList.remove('indeterminate');
    el.firstChild.style.width = Math.round((state.progress.done / state.progress.total) * 100) + '%';
  }

  function tabsBar() {
    const mk = (id, label, ic) => h('button', {
      type: 'button', 'aria-current': state.tab === id ? 'page' : null,
      onclick: () => { if (state.tab !== id) { state.tab = id; render({ keepScroll: false }); } }
    }, icon(ic), label);
    return h('nav', { class: 'tabs', 'aria-label': 'Sections' }, h('div', { class: 'inner' }, mk('episodes', 'Episodes', 'list'), mk('discover', 'Discover', 'discover')));
  }

  /* ----- Episodes tab ----- */
  function ring(fraction) {
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    return svg({ class: 'ring', viewBox: '0 0 36 36', 'aria-hidden': 'true' }, [
      { t: 'circle', class: 'track', cx: 18, cy: 18, r: 15.9155 },
      { t: 'circle', class: 'fill', cx: 18, cy: 18, r: 15.9155, 'stroke-dasharray': pct + ' ' + (100 - pct) }
    ]);
  }

  function episodesTab() {
    const out = [];
    const f = state.feed;
    if (!f) {
      out.push(h('div', { class: 'empty' }, h('b', { text: state.loadingFeed ? 'Loading your podcasts…' : 'Nothing loaded yet' }), state.loadingFeed ? '' : 'Tap refresh to load your episodes.'));
      return out;
    }
    if (f.failed && f.failed.length) {
      out.push(banner('warn', f.failed.length + (f.failed.length === 1 ? ' podcast' : ' podcasts') + ' could not be loaded', f.failed.map(x => x.name).join(', ') + '. Tap refresh to try again.'));
    }
    if (!f.shows.length) {
      out.push(h('div', { class: 'empty' }, h('b', { text: 'No followed podcasts found' }), 'Follow some podcasts in Spotify (the Follow button on a show), then refresh.'));
      return out;
    }

    const now = Date.now();
    const all = L.buildFeed(f.shows, f.episodesByShow, { days: state.days, prevVisit: state.prevVisit, now: now });
    const sum = L.summarise(all, f.shows);

    // stat cards
    out.push(h('div', { class: 'stats' },
      h('div', { class: 'stat new' }, h('div', { class: 'label', text: 'New' }), h('div', { class: 'value', text: String(sum.newCount) })),
      h('div', { class: 'stat unl' }, h('div', { class: 'label', text: 'Unlistened' }), h('div', { class: 'value', text: String(sum.unlistenedCount) }), ring(sum.totalEpisodes ? sum.unlistenedCount / sum.totalEpisodes : 0)),
      h('div', { class: 'stat' }, h('div', { class: 'label', text: 'Following' }), h('div', { class: 'value', text: String(f.shows.length) }))));

    // backlog by show
    const withEps = sum.perShow.filter(s => s.total > 0);
    if (withEps.length) {
      const max = Math.max.apply(null, withEps.map(s => s.total));
      const rows = withEps.slice(0, 8).map(s => h('div', { class: 'bar-row' },
        cover(s.image, 26, ''),
        h('div', null, h('div', { class: 'name', text: s.name }),
          h('div', { class: 'bar-track', 'aria-hidden': 'true' },
            h('div', { class: 'u', style: { width: (s.unlistened / max) * 100 + '%' } }),
            h('div', { class: 'p', style: { width: (s.played / max) * 100 + '%' } }))),
        h('div', { class: 'num', text: s.unlistened + '/' + s.total, 'aria-label': s.unlistened + ' unlistened of ' + s.total })));
      out.push(h('section', { class: 'card' }, h('h2', { text: 'Last ' + state.days + ' days by podcast' }), h('div', { class: 'bars' }, rows),
        h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: 'var(--warn)' } }), 'Unlistened'), h('span', null, h('i', { style: { background: 'var(--line)' } }), 'Played')),
        withEps.length > 8 ? h('p', { class: 'hint', text: '+ ' + (withEps.length - 8) + ' more podcasts' }) : null));
    }

    // show strip
    out.push(h('div', { class: 'strip', role: 'group', 'aria-label': 'Filter by podcast' }, sum.perShow.map(s => {
      const active = state.showId === s.id;
      return h('button', {
        class: 'chip' + (active ? ' active' : ''), type: 'button', 'aria-pressed': active ? 'true' : 'false', 'aria-label': s.name + ', ' + s.unlistened + ' unlistened',
        onclick: () => { state.showId = active ? null : s.id; render(); }
      }, h('div', { class: 'cover' }, cover(s.image, 60, ''), s.unlistened ? h('span', { class: 'badge', text: String(s.unlistened) }) : null), h('div', { class: 'nm', text: s.name }));
    })));

    // filter
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show episodes' });
    for (const [id, label] of [['all', 'All'], ['new', 'New'], ['unlistened', 'Unlistened']]) {
      seg.append(h('button', { type: 'button', 'aria-pressed': state.filter === id ? 'true' : 'false', text: label, onclick: () => { state.filter = id; render(); } }));
    }
    out.push(seg);

    const visible = L.applyFilter(all, state.filter, state.showId);
    const showName = state.showId ? (f.shows.find(s => s.id === state.showId) || {}).name : null;
    out.push(h('div', { class: 'filter-note' },
      h('span', { text: visible.length + (visible.length === 1 ? ' episode' : ' episodes') + (showName ? ' · ' + showName : '') + ' · last ' + state.days + ' days' }),
      state.showId ? h('button', { class: 'link-btn', type: 'button', text: 'Clear', onclick: () => { state.showId = null; render(); } }) : null));

    if (!visible.length) {
      const msg = state.filter === 'new' ? ['Nothing new', 'No episodes released since your last visit.']
        : state.filter === 'unlistened' ? ['You\'re all caught up', 'Every episode in this period has been played.']
          : ['No episodes', 'Nothing was released in the last ' + state.days + ' days. You can widen the period in Settings.'];
      out.push(h('div', { class: 'empty' }, h('b', { text: msg[0] }), msg[1]));
      return out;
    }

    for (const g of L.groupByDay(visible, now)) {
      out.push(h('div', { class: 'day', text: g.label }));
      for (const it of g.items) out.push(episodeCard(it));
    }
    return out;
  }

  function episodeCard(it) {
    const href = safeSpotifyUrl(it.url);
    const meta = h('div', { class: 'meta' },
      it.isNew ? h('span', { class: 'pill new', text: 'NEW' }) : null,
      it.unlistened ? h('span', { class: 'pill unl', text: 'UNLISTENED' }) : h('span', { class: 'pill done', text: 'PLAYED' }),
      h('span', { text: L.formatDuration(it.durationMs) }));
    const body = h('div', null,
      h('div', { class: 'show', text: it.showName }),
      h('div', { class: 'title', text: it.title }),
      meta,
      it.progress > 0 ? h('div', { class: 'prog', 'aria-hidden': 'true' }, h('div', { style: { width: Math.round(it.progress * 100) + '%' } })) : null);
    return h(href ? 'a' : 'div', {
      class: 'ep' + (it.played ? ' played' : ''), href: href, target: href ? '_blank' : null, rel: href ? 'noopener noreferrer' : null,
      'aria-label': it.title + ' — ' + it.showName + (href ? ' (opens in Spotify)' : '')
    }, cover(it.showImage, 56, ''), body);
  }

  /* ----- Discover tab ----- */
  function discoverTab() {
    const out = [];
    out.push(h('div', { class: 'card' },
      h('h2', { text: 'Maltese podcasts you don\'t follow' }),
      h('p', { class: 'act', style: { margin: 0, color: 'var(--muted)', fontSize: '13px' }, text: 'Found by searching Spotify for Maltese shows and ranked by recent activity — how recently and how often they publish. Spotify offers no podcast trending chart through its API, so this is an estimate of what is "trending".' })));
    const d = state.disc;
    if (!d) {
      out.push(h('div', { class: 'empty' }, h('b', { text: state.loadingDisc ? 'Searching Spotify…' : 'Not checked yet' }), state.loadingDisc ? 'This takes a few seconds.' : 'Tap refresh to look for Maltese podcasts.'));
      return out;
    }
    out.push(h('p', { class: 'hint', style: { color: 'var(--muted)', fontSize: '12px', margin: '0 2px 10px' }, text: d.results.length + ' suggested · ' + d.searched + ' shows found by searching' }));
    if (!d.results.length) {
      out.push(h('div', { class: 'empty' }, h('b', { text: 'No suggestions right now' }), 'No active Maltese podcasts you don\'t already follow were found.'));
      return out;
    }
    for (const r of d.results) out.push(discoveryCard(r));
    return out;
  }

  function discoveryCard(r) {
    const href = safeSpotifyUrl(r.show.url);
    const when = r.daysSinceLatest === 0 ? 'today' : r.daysSinceLatest === 1 ? 'yesterday' : r.daysSinceLatest + ' days ago';
    const langs = (r.show.languages || []).map(l => String(l).toUpperCase()).slice(0, 3);
    return h('article', { class: 'disc' },
      cover(r.show.image, 72, ''),
      h('div', null,
        h('h3', { text: r.show.name }),
        h('div', { class: 'tags' },
          h('span', { class: 'tag' + (r.reason === 'Maltese language' ? ' mt' : ''), text: r.reason }),
          langs.map(l => h('span', { class: 'tag', text: l }))),
        h('div', { class: 'act', text: 'Latest episode ' + when + ' · ' + r.count90 + ' in the last 90 days' }),
        h('div', { class: 'meter', role: 'img', 'aria-label': 'Activity score ' + r.score + ' out of 100' }, h('div', { style: { width: r.score + '%' } })),
        r.show.description ? h('div', { class: 'desc', text: r.show.description }) : null,
        href ? h('a', { class: 'btn small', href: href, target: '_blank', rel: 'noopener noreferrer', text: 'Open in Spotify' }) : null));
  }

  /* ----- settings sheet ----- */
  function settingsSheet() {
    const close = () => { state.settingsOpen = false; render(); };
    const select = h('select', { id: 'days', 'aria-label': 'Look-back window' }, DAY_OPTIONS.map(n => h('option', { value: String(n), text: 'Last ' + n + ' days', selected: n === state.days ? true : null })));
    select.addEventListener('change', () => {
      state.days = Number(select.value);
      store.set(KEYS.days, String(state.days));
      state.settingsOpen = false;
      if (!state.feed || state.feed.days < state.days) refreshFeed(); else render();
    });
    const copyBtn = h('button', { class: 'btn small', type: 'button', text: 'Copy Redirect URI' });
    copyBtn.addEventListener('click', () => copyText(redirectUri(), copyBtn));

    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
      h('h2', { text: 'Settings' }),
      h('div', { class: 'row' }, h('label', { for: 'days', text: 'How far back to look' }), select,
        h('span', { class: 'hint', text: 'Episodes released within this period are listed. A longer period needs more requests to Spotify.' })),
      h('div', { class: 'row' }, h('span', { class: 'lbl', text: 'Spotify app' }),
        h('span', { class: 'hint', text: 'Client ID: ' + (store.get(KEYS.clientId) || '—') }),
        h('code', { class: 'uri', text: redirectUri() }), copyBtn,
        h('span', { class: 'hint', text: 'This address must be listed under Redirect URIs in your Spotify app.' })),
      h('div', { class: 'row' },
        h('button', { class: 'btn block', type: 'button', text: 'Clear cached data', onclick: () => { store.del(KEYS.feed); store.del(KEYS.disc); state.feed = null; state.disc = null; state.settingsOpen = false; render(); refreshFeed().then(() => refreshDiscovery()); } }),
        h('button', { class: 'btn danger block', type: 'button', text: 'Sign out of Spotify', onclick: () => { spotify.logout(); store.del(KEYS.feed); store.del(KEYS.disc); state.feed = null; state.disc = null; state.settingsOpen = false; state.screen = 'login'; state.error = null; render({ keepScroll: false }); } })),
      h('button', { class: 'btn primary block', type: 'button', text: 'Done', onclick: close }));
    const bg = h('div', { class: 'sheet-bg', onclick: e => { if (e.target === bg) close(); } }, sheet);
    return bg;
  }

  /* ---------- data actions ---------- */
  function handleError(e) {
    if (e && e.name === 'AuthError') {
      spotify.logout();
      state.screen = 'login';
      state.settingsOpen = false;
    }
    state.error = e && e.message ? e.message : String(e);
  }

  async function refreshFeed() {
    if (state.loadingFeed) return;
    state.loadingFeed = true; state.error = null; state.progress = null; render();
    try {
      const result = await data.loadFollowed(state.days, (done, total) => { state.progress = { done: done, total: total }; updateProgress(); });
      state.feed = result;
      store.setJSON(KEYS.feed, result);
    } catch (e) { handleError(e); }
    state.loadingFeed = false; state.progress = null;
    render();
  }

  async function refreshDiscovery() {
    if (state.loadingDisc) return;
    state.loadingDisc = true; state.error = null; state.progress = null; render();
    try {
      const followed = new Set(((state.feed && state.feed.shows) || []).map(s => s.id));
      const result = await data.loadDiscovery(followed, (done, total) => { state.progress = { done: done, total: total }; updateProgress(); });
      state.disc = result;
      store.setJSON(KEYS.disc, result);
    } catch (e) { handleError(e); }
    state.loadingDisc = false; state.progress = null;
    render();
  }

  async function enterMain() {
    state.screen = 'main';
    // "New" is measured against the previous visit; fix it for this session so it doesn't vanish on refresh.
    let prev = Number(sessionStorage.getItem('po.prevVisit'));
    if (!prev) {
      prev = Number(store.get(KEYS.lastVisit)) || (Date.now() - 7 * L.DAY);
      try { sessionStorage.setItem('po.prevVisit', String(prev)); } catch (e) { /* ignore */ }
      store.set(KEYS.lastVisit, String(Date.now()));
    }
    state.prevVisit = prev;

    const cachedFeed = store.getJSON(KEYS.feed);
    const cachedDisc = store.getJSON(KEYS.disc);
    if (cachedFeed && cachedFeed.shows) state.feed = cachedFeed;
    if (cachedDisc && cachedDisc.results) state.disc = cachedDisc;
    render({ keepScroll: false });

    const feedStale = !state.feed || Date.now() - state.feed.fetchedAt > FEED_TTL || state.feed.days < state.days;
    if (feedStale) await refreshFeed();
    if (state.screen !== 'main') return;
    if (!state.disc || Date.now() - state.disc.fetchedAt > DISC_TTL) refreshDiscovery();
  }

  /* ---------- start-up ---------- */
  async function boot() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online without it */ });
    }
    if (!store.get(KEYS.clientId)) { state.screen = 'setup'; render(); return; }

    if (/[?&](code|error)=/.test(location.search)) {
      try { await spotify.handleRedirect(location.search); }
      catch (e) { state.error = e.message; }
      history.replaceState(null, '', location.pathname);
    }
    if (spotify.isLoggedIn()) await enterMain();
    else { state.screen = 'login'; render(); }
  }

  boot();
})();
