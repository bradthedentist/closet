// Minimal Google Drive REST v3 client for the closet app (browser fetch; Node tests inject a mock fetch).
// Scope: drive.file only, so every query only ever sees files THIS app created. No permission/sharing calls exist here.
// All files are created private in the app's own folder tree. Tokens are passed per request and never logged.
export const API = 'https://www.googleapis.com/drive/v3';
export const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER = 'application/vnd.google-apps.folder';
export class AuthError extends Error { constructor(msg) { super(msg || 'Google sign-in expired.'); this.code = 'auth'; } }
export class DriveError extends Error { constructor(msg, status, reason) { super(msg); this.status = status; this.reason = reason; } }
const FILE_FIELDS = 'id,name,size,mimeType,md5Checksum,sha256Checksum,version,parents,appProperties,trashed,modifiedTime';
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const CHUNK = 8 * 1024 * 1024; // multiple of 256 KiB

export function createDrive({ fetch, getToken, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRetry } = {}) {
  async function call(url, init = {}, { retries = 4, raw = false, okStatuses = [] } = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await getToken();
      if (!token) throw new AuthError('Not signed in.');
      let res;
      try {
        res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + token } });
      } catch (e) {
        if (attempt >= retries || init.noRetry) throw new DriveError('Network error talking to Google Drive: ' + String(e && e.message || e).slice(0, 120), 0, 'network');
        onRetry && onRetry(attempt); await sleep(400 * 2 ** attempt); continue;
      }
      if (res.status === 401) throw new AuthError();
      if (res.ok || okStatuses.includes(res.status)) return raw ? res : (res.status === 204 ? null : await res.json());
      let reason = '', message = '';
      try { const j = await res.json(); reason = j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason || j.error && j.error.status || ''; message = j.error && j.error.message || ''; } catch (e) {}
      const retryable = res.status >= 500 || res.status === 429 || (res.status === 403 && /rateLimit|userRateLimitExceeded/i.test(reason));
      if (retryable && attempt < retries && !init.noRetry) { onRetry && onRetry(attempt); await sleep(500 * 2 ** attempt); continue; }
      throw new DriveError('Google Drive error ' + res.status + (reason ? ' (' + reason + ')' : '') + (message ? ': ' + message.slice(0, 160) : ''), res.status, reason);
    }
  }
  const q = (params) => Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

  async function list(query, fields = FILE_FIELDS) {
    const out = []; let pageToken;
    do {
      const r = await call(API + '/files?' + q({ q: query, fields: 'nextPageToken,files(' + fields + ')', pageSize: 200, spaces: 'drive', pageToken }));
      out.push(...(r.files || [])); pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }
  const getMeta = (id, fields = FILE_FIELDS) => call(API + '/files/' + encodeURIComponent(id) + '?' + q({ fields }));
  async function download(id) { const r = await call(API + '/files/' + encodeURIComponent(id) + '?alt=media', {}, { raw: true }); return await r.blob(); }
  const about = () => call(API + '/about?fields=user(emailAddress,displayName)');

  async function findByProps(props, parentId) {
    const parts = ['trashed=false'];
    for (const [k, v] of Object.entries(props)) parts.push("appProperties has { key='" + esc(k) + "' and value='" + esc(v) + "' }");
    if (parentId) parts.push("'" + esc(parentId) + "' in parents");
    return await list(parts.join(' and '));
  }
  async function createFolder(name, parentId, appProperties) {
    return await call(API + '/files?' + q({ fields: FILE_FIELDS }), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: parentId ? [parentId] : undefined, appProperties }) }, { retries: 0 });
  }
  // Find-or-create a folder identified by appProperties (never by name alone). Oldest wins if a race made two.
  async function ensureFolder(name, parentId, appProperties) {
    const found = (await findByProps(appProperties, parentId)).filter((f) => f.mimeType === FOLDER).sort((a, b) => (a.modifiedTime < b.modifiedTime ? -1 : 1));
    if (found.length) return found[0];
    return await createFolder(name, parentId, appProperties);
  }
  async function ensureLayout(mode) {
    const tag = mode === 'prod' ? 'prod' : mode;
    const rootName = mode === 'test' ? 'Closet (app) TEST' : 'Closet (app)';
    const root = await ensureFolder(rootName, null, { closetApp: 'root-v1', closetMode: tag });
    const sub = {};
    for (const [key, name] of [['originals', 'Originals'], ['cutouts', 'Cutouts'], ['thumbs', 'Thumbs'], ['display', 'Display copies'], ['removed', 'Removed']])
      sub[key] = (await ensureFolder(name, root.id, { closetApp: 'folder-v1', closetMode: tag, closetFolder: key })).id;
    return { rootId: root.id, ...sub };
  }
  function multipartBody(meta, blob) {
    const boundary = 'closet' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const head = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: ' + (meta.mimeType || blob.type || 'application/octet-stream') + '\r\n\r\n';
    return { body: new Blob([head, blob, '\r\n--' + boundary + '--\r\n']), type: 'multipart/related; boundary=' + boundary };
  }
  async function createSmall(meta, blob) {
    const { body, type } = multipartBody(meta, blob);
    return await call(UPLOAD + '/files?' + q({ uploadType: 'multipart', fields: FILE_FIELDS }), { method: 'POST', headers: { 'Content-Type': type }, body, noRetry: true });
  }
  async function updateMedia(id, blob, mimeType) {
    return await call(UPLOAD + '/files/' + encodeURIComponent(id) + '?' + q({ uploadType: 'media', fields: FILE_FIELDS }), { method: 'PATCH', headers: { 'Content-Type': mimeType || blob.type || 'application/octet-stream' }, body: blob });
  }
  async function move(id, addParent, removeParent) {
    return await call(API + '/files/' + encodeURIComponent(id) + '?' + q({ addParents: addParent, removeParents: removeParent, fields: FILE_FIELDS }), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  }
  async function updateJson(id, obj) { return await updateMedia(id, new Blob([JSON.stringify(obj)], { type: 'application/json' }), 'application/json'); }

  // Resumable upload (any size). session = {uri,total} persisted by the caller (local device only) so a reload or a
  // lost response resumes at the offset Drive reports, instead of starting a second file.
  function parseRange(res) { const r = res.headers.get('Range') || res.headers.get('range'); if (!r) return null; const m = /bytes=0-(\d+)/.exec(r); return m ? Number(m[1]) + 1 : null; }
  async function startResumable(meta, total, mimeType) {
    const res = await call(UPLOAD + '/files?' + q({ uploadType: 'resumable', fields: FILE_FIELDS }), { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType || 'application/octet-stream', 'X-Upload-Content-Length': String(total) }, body: JSON.stringify(meta), noRetry: true }, { raw: true });
    const uri = res.headers.get('Location') || res.headers.get('location');
    if (!uri || !/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/.test(uri)) throw new DriveError('Drive did not return an upload session.', res.status, 'no_session');
    return { uri, total };
  }
  async function queryOffset(session) {
    const res = await call(session.uri, { method: 'PUT', headers: { 'Content-Range': 'bytes */' + session.total }, noRetry: true }, { raw: true, okStatuses: [308, 404, 410] });
    if (res.status === 200 || res.status === 201) return { done: true, file: await res.json() };
    if (res.status === 404 || res.status === 410) return { expired: true };
    return { done: false, offset: parseRange(res) || 0 };
  }
  async function resumable({ meta, blob, session, saveSession, onProgress }) {
    const total = blob.size;
    let s = session && session.uri && session.total === total ? session : null, offset = 0, stalls = 0, failures = 0;
    if (s) { const st = await queryOffset(s); if (st.done) return st.file; if (st.expired) s = null; else offset = st.offset; }
    if (!s) { s = await startResumable(meta, total, meta.mimeType || blob.type); offset = 0; saveSession && (await saveSession(s)); }
    for (;;) {
      onProgress && onProgress(offset, total);
      const end = Math.min(offset + CHUNK, total);
      let res;
      try {
        res = await call(s.uri, { method: 'PUT', headers: { 'Content-Range': 'bytes ' + offset + '-' + (end - 1) + '/' + total }, body: blob.slice(offset, end), noRetry: true }, { raw: true, okStatuses: [308] });
        failures = 0;
      } catch (e) {
        if (e instanceof AuthError) throw e;
        if (++failures > 5) throw e;
        await sleep(500 * 2 ** failures);
        const st = await queryOffset(s); // re-sync with what Drive actually holds
        if (st.done) return st.file;
        if (st.expired) { s = await startResumable(meta, total, meta.mimeType || blob.type); offset = 0; saveSession && (await saveSession(s)); }
        else offset = st.offset;
        continue;
      }
      if (res.status === 200 || res.status === 201) { onProgress && onProgress(total, total); return await res.json(); }
      const next = parseRange(res);
      const nextOffset = next == null ? end : next; // Range header may be hidden by CORS; chunk sizes are 256 KiB multiples
      if (nextOffset <= offset) { if (++stalls > 5) throw new DriveError('Upload is not making progress.', 308, 'stalled'); } else stalls = 0;
      offset = nextOffset;
      if (offset >= total) { // all bytes sent but Drive has not confirmed: ask it where it is
        const st = await queryOffset(s);
        if (st.done) return st.file;
        if (st.expired || st.offset >= total) throw new DriveError('Drive did not confirm the upload.', 308, 'unconfirmed');
        offset = st.offset;
      }
    }
  }
  return { call, list, getMeta, download, about, findByProps, ensureFolder, ensureLayout, createSmall, updateMedia, updateJson, move, resumable, queryOffset, FILE_FIELDS };
}
