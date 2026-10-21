/*
 * spotify.js — Spotify sign-in (Authorization Code with PKCE, no client secret) and a small Web API client.
 * Browser: window.POSpotify.create({ storage, fetch, crypto }). Node tests inject their own env.
 * Endpoints, parameters and scopes follow Spotify's documentation as checked on 13 Oct 2026.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.POSpotify = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const AUTH_URL = 'https://accounts.spotify.com/authorize';
  const TOKEN_URL = 'https://accounts.spotify.com/api/token';
  const API_BASE = 'https://api.spotify.com/v1';

  // user-library-read: saved shows. user-read-playback-position: episode resume_point (played / progress).
  // user-read-private: required by Spotify for the search endpoint.
  const SCOPES = ['user-library-read', 'user-read-playback-position', 'user-read-private'];

  const K = { tokens: 'po.tokens', pkce: 'po.pkce' };

  class AuthError extends Error {
    constructor(message) { super(message); this.name = 'AuthError'; }
  }
  class ApiError extends Error {
    constructor(status, message, reason) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.reason = reason || null;
    }
  }

  function randomString(cryptoObj, length) {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const values = cryptoObj.getRandomValues(new Uint8Array(length));
    let out = '';
    for (const v of values) out += possible[v % possible.length];
    return out;
  }

  async function sha256(cryptoObj, plain) {
    return cryptoObj.subtle.digest('SHA-256', new TextEncoder().encode(plain));
  }

  function base64url(buffer) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(buffer)))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  function create(env) {
    const storage = env.storage;
    const fetchFn = env.fetch;
    const cryptoObj = env.crypto;
    const nowFn = env.now || Date.now;
    const sleep = env.sleep || (ms => new Promise(r => setTimeout(r, ms)));

    const readJSON = key => { try { const v = storage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
    const writeJSON = (key, val) => storage.setItem(key, JSON.stringify(val));

    /* ----- sign-in ----- */

    async function startLogin(clientId, redirectUri) {
      const verifier = randomString(cryptoObj, 64);
      const challenge = base64url(await sha256(cryptoObj, verifier));
      const state = randomString(cryptoObj, 16);
      writeJSON(K.pkce, { verifier: verifier, state: state, clientId: clientId, redirectUri: redirectUri });
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        scope: SCOPES.join(' '),
        code_challenge_method: 'S256',
        code_challenge: challenge,
        redirect_uri: redirectUri,
        state: state
      }).toString();
      return url.toString();
    }

    // Call on page load. Returns { handled:false } when the URL is not an OAuth callback.
    async function handleRedirect(search) {
      const p = new URLSearchParams(search || '');
      if (!p.has('code') && !p.has('error')) return { handled: false };
      const saved = readJSON(K.pkce);
      storage.removeItem(K.pkce);
      if (p.get('error')) {
        throw new AuthError(p.get('error') === 'access_denied'
          ? 'Spotify sign-in was cancelled.'
          : 'Spotify sign-in failed (' + p.get('error') + ').');
      }
      if (!saved || saved.state !== p.get('state')) {
        throw new AuthError('Sign-in could not be verified (state mismatch). Please try again.');
      }
      const res = await fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: saved.clientId,
          grant_type: 'authorization_code',
          code: p.get('code'),
          redirect_uri: saved.redirectUri,
          code_verifier: saved.verifier
        }).toString()
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.access_token) {
        throw new AuthError('Spotify did not accept the sign-in' + (json.error_description ? ': ' + json.error_description : '.'));
      }
      writeJSON(K.tokens, {
        access_token: json.access_token,
        refresh_token: json.refresh_token || null,
        expires_at: nowFn() + (json.expires_in || 3600) * 1000,
        scope: json.scope || '',
        client_id: saved.clientId
      });
      return { handled: true };
    }

    function isLoggedIn() { return !!readJSON(K.tokens); }
    function grantedScopes() { const t = readJSON(K.tokens); return t && t.scope ? t.scope.split(' ') : []; }
    function logout() { storage.removeItem(K.tokens); storage.removeItem(K.pkce); }

    /* ----- tokens ----- */

    let refreshing = null;

    async function refresh() {
      if (!refreshing) {
        refreshing = (async () => {
          const t = readJSON(K.tokens);
          if (!t || !t.refresh_token) { logout(); throw new AuthError('Your Spotify session has expired. Please sign in again.'); }
          const res = await fetchFn(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: t.refresh_token,
              client_id: t.client_id
            }).toString()
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok) {
            if (json.error === 'invalid_grant') { logout(); throw new AuthError('Your Spotify session has expired. Please sign in again.'); }
            throw new ApiError(res.status, 'Could not refresh the Spotify session (' + (json.error || res.status) + ').');
          }
          // Spotify may omit refresh_token on refresh; keep using the existing one then.
          t.access_token = json.access_token;
          t.refresh_token = json.refresh_token || t.refresh_token;
          t.expires_at = nowFn() + (json.expires_in || 3600) * 1000;
          if (json.scope) t.scope = json.scope;
          writeJSON(K.tokens, t);
          return t.access_token;
        })().finally(() => { refreshing = null; });
      }
      return refreshing;
    }

    async function getAccessToken() {
      const t = readJSON(K.tokens);
      if (!t) throw new AuthError('Not signed in.');
      if (t.expires_at - nowFn() > 60000) return t.access_token;
      return refresh();
    }

    /* ----- API ----- */

    async function api(path, params) {
      let reauthed = false;
      let rateRetries = 0;
      for (;;) {
        const token = await getAccessToken();
        const url = new URL(API_BASE + path);
        for (const [k, v] of Object.entries(params || {})) {
          if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
        const res = await fetchFn(url.toString(), { headers: { Authorization: 'Bearer ' + token } });

        if (res.status === 401) {
          if (!reauthed) {
            reauthed = true;
            const t = readJSON(K.tokens);
            if (t) { t.expires_at = 0; writeJSON(K.tokens, t); }
            continue;
          }
          logout();
          throw new AuthError('Spotify rejected the session. Please sign in again.');
        }

        if (res.status === 429) {
          const body = await res.json().catch(() => ({}));
          const reason = body && body.error && body.error.reason;
          if (reason === 'QUOTA_EXCEEDED') {
            throw new ApiError(429, 'Spotify\'s request quota for this app has been used up. Try again later.', reason);
          }
          if (rateRetries < 3) {
            rateRetries++;
            const wait = Number(res.headers && res.headers.get && res.headers.get('Retry-After')) || 2;
            await sleep(Math.min(wait, 30) * 1000);
            continue;
          }
          throw new ApiError(429, 'Spotify is rate-limiting requests. Try again in a minute.', reason);
        }

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg = body && body.error && body.error.message ? body.error.message : 'HTTP ' + res.status;
          if (res.status === 403) {
            throw new ApiError(403, 'Spotify refused access (403). In the Spotify Developer Dashboard check that your account is on the app\'s user list and that the app owner has Premium. (' + msg + ')');
          }
          throw new ApiError(res.status, 'Spotify error ' + res.status + ': ' + msg);
        }
        return res.status === 204 ? null : res.json();
      }
    }

    async function getSavedShows() {
      const out = [];
      let offset = 0;
      for (;;) {
        const page = await api('/me/shows', { limit: 50, offset: offset });
        for (const it of (page.items || [])) if (it && it.show) out.push(it.show);
        if (!page.next || offset >= 2000) break;
        offset += 50;
      }
      return out;
    }

    function getShowEpisodes(showId, opts) {
      opts = opts || {};
      return api('/shows/' + encodeURIComponent(showId) + '/episodes', {
        market: opts.market || 'MT',
        limit: opts.limit || 50,
        offset: opts.offset || 0
      });
    }

    // Spotify caps search at 10 results per request (default 5).
    function searchShows(q, opts) {
      opts = opts || {};
      return api('/search', {
        q: q,
        type: 'show',
        market: opts.market || 'MT',
        limit: Math.min(opts.limit || 10, 10),
        offset: opts.offset || 0
      });
    }

    return { startLogin, handleRedirect, isLoggedIn, grantedScopes, logout, getAccessToken, api, getSavedShows, getShowEpisodes, searchShows };
  }

  return { create, SCOPES, AuthError, ApiError, randomString, sha256, base64url };
});
