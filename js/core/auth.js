// Google sign-in for a static PWA: OAuth 2.0 token flow by full-page REDIRECT (works in iOS home-screen mode where
// popups are unreliable). Scope is drive.file ONLY. The access token is kept in sessionStorage (cleared when the app
// session ends) and in memory; it is never logged or written anywhere else. Expiry ~1 h; a silent redirect with
// prompt=none + login_hint renews it while Google's own session is valid.
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const BROAD = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.metadata', 'https://www.googleapis.com/auth/drive.metadata.readonly', 'https://www.googleapis.com/auth/drive.photos.readonly', 'https://www.googleapis.com/auth/drive.appdata', 'https://www.googleapis.com/auth/drive.scripts', 'https://www.googleapis.com/auth/drive.apps.readonly'];
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const PENDING_KEY = 'closet.oauth.pending', TOKEN_KEY = 'closet.oauth.token', RETURN_KEY = 'closet.oauth.return';

export function redirectUriFor(loc) {
  // Must exactly match a redirect URI registered on the OAuth client.
  if (loc.origin === 'http://localhost:8080') return 'http://localhost:8080/';
  const base = loc.origin + loc.pathname.replace(/[^/]*$/, '');
  return base + 'oauth.html';
}
export function buildAuthUrl({ clientId, redirectUri, state, prompt, loginHint, hd }) {
  const p = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'token', scope: SCOPE, state, include_granted_scopes: 'false' });
  if (prompt !== undefined && prompt !== null) p.set('prompt', prompt);
  if (loginHint) p.set('login_hint', loginHint);
  if (hd) p.set('hd', hd);
  return AUTH_ENDPOINT + '?' + p.toString();
}
// Validates the redirect fragment. Rejects state mismatch, errors, and any grant broader than drive.file.
export function parseAuthFragment(fragment, expectedState, nowMs) {
  const p = new URLSearchParams(String(fragment || '').replace(/^#/, ''));
  if (!p.get('state') || p.get('state') !== expectedState) return { ok: false, error: 'state_mismatch' };
  if (p.get('error')) return { ok: false, error: p.get('error') };
  const token = p.get('access_token'), scopes = (p.get('scope') || '').split(/\s+/).filter(Boolean);
  if (!token || (p.get('token_type') || '').toLowerCase() !== 'bearer') return { ok: false, error: 'no_token' };
  if (!scopes.includes(SCOPE)) return { ok: false, error: 'drive_file_not_granted' };
  const broad = scopes.filter((s) => BROAD.includes(s));
  if (broad.length) return { ok: false, error: 'scope_too_broad', broad };
  const expiresIn = Math.max(0, Math.min(Number(p.get('expires_in')) || 0, 3600 * 24));
  return { ok: true, token, expiresAt: nowMs + expiresIn * 1000, scopes };
}
export function randomState() { const b = crypto.getRandomValues(new Uint8Array(16)); return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }

export function createAuth({ clientId, hd, storage = sessionStorage, local = localStorage, location: loc = location, now = () => Date.now() }) {
  let mem = null;
  try { mem = JSON.parse(storage.getItem(TOKEN_KEY) || 'null'); } catch (e) { mem = null; }
  function start({ silent = false, returnTo = loc.search || '' } = {}) {
    const state = randomState();
    storage.setItem(PENDING_KEY, JSON.stringify({ state, at: now(), silent, returnTo }));
    const hint = local.getItem('closet.loginHint') || '';
    loc.assign(buildAuthUrl({ clientId, redirectUri: redirectUriFor(loc), state, prompt: silent ? 'none' : (hint ? undefined : 'select_account'), loginHint: hint, hd }));
  }
  // Call on load. Consumes a fragment handed over by oauth.html (sessionStorage) or present on this page.
  function consume() {
    let frag = storage.getItem(RETURN_KEY); storage.removeItem(RETURN_KEY);
    if (!frag && /access_token=|error=/.test(loc.hash)) { frag = loc.hash; history.replaceState(null, '', loc.pathname + loc.search); }
    if (!frag) return null;
    let pend = null; try { pend = JSON.parse(storage.getItem(PENDING_KEY) || 'null'); } catch (e) {}
    storage.removeItem(PENDING_KEY);
    if (!pend) return { ok: false, error: 'no_pending_sign_in' };
    const r = parseAuthFragment(frag, pend.state, now());
    if (r.ok) { mem = { token: r.token, expiresAt: r.expiresAt }; storage.setItem(TOKEN_KEY, JSON.stringify(mem)); }
    r.silent = pend.silent; r.returnTo = pend.returnTo; return r;
  }
  const token = () => (mem && mem.expiresAt - 60000 > now() ? mem.token : null);
  const remainingMs = () => (mem ? mem.expiresAt - now() : 0);
  function signOut() { const t = mem && mem.token; mem = null; storage.removeItem(TOKEN_KEY); local.removeItem('closet.loginHint');
    if (t) try { fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=' + encodeURIComponent(t) }).catch(() => {}); } catch (e) {} }
  function rememberHint(email) { if (email) local.setItem('closet.loginHint', email); }
  function expire() { mem = null; storage.removeItem(TOKEN_KEY); }
  return { start, consume, token, remainingMs, signOut, rememberHint, expire, hasHint: () => !!local.getItem('closet.loginHint') };
}
