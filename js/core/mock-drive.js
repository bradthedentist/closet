// In-memory imitation of the Drive REST v3 endpoints this app uses. Used by the Node tests and by the "?local=1"
// device-only demo (nothing leaves the browser; data is gone on reload). It implements drive.file visibility (only
// files created through it exist), appProperties queries, multipart + resumable uploads with 308/Range, versions,
// md5/sha256 checksums, and fault injection. Any /permissions request is recorded as a violation.
import { md5Hex, sha256Hex } from './hash.js';
export function createMockDrive(opts = {}) {
  const files = new Map(), sessions = new Map(), log = [], violations = [];
  let seq = 0; const faults = [];
  const state = { exposeRange: opts.exposeRange !== false, checksums: opts.checksums || 'sha256', token: 'mock-token', checksumDelay: 0 };
  const id = (p) => p + (++seq).toString(36).padStart(6, '0') + 'x';
  const json = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const err = (status, reason, message) => json(status, { error: { code: status, message: message || reason, errors: [{ reason }] } });
  const now = () => new Date(Date.UTC(2026, 10, 9, 0, 0, seq)).toISOString();
  async function meta(f) {
    const m = { id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents.slice(), appProperties: { ...f.appProperties }, trashed: false, version: String(f.version), modifiedTime: f.modifiedTime };
    if (f.bytes) { m.size = String(f.bytes.length); if (state.checksumDelay > 0 && f.checksumHidden-- > 0) return m; if (state.checksums === 'sha256' || state.checksums === 'both') m.sha256Checksum = f.sha256 || (f.sha256 = await sha256Hex(f.bytes)); if (state.checksums === 'md5' || state.checksums === 'both') m.md5Checksum = f.md5 || (f.md5 = md5Hex(f.bytes)); }
    return m;
  }
  function create(m, bytes) {
    const f = { id: id('f'), name: m.name || 'Untitled', mimeType: m.mimeType || 'application/octet-stream', parents: m.parents || ['root'], appProperties: m.appProperties || {}, bytes: bytes || null, version: 1, modifiedTime: now(), checksumHidden: state.checksumDelay };
    files.set(f.id, f); return f;
  }
  function setBytes(f, bytes) { f.bytes = bytes; f.sha256 = null; f.md5 = null; f.version++; f.modifiedTime = now(); }
  function matchQuery(f, q) {
    for (const part of q.split(/ and (?![^{]*\})/)) {
      let m;
      if (part === 'trashed=false') continue;
      if ((m = /^'([^']+)' in parents$/.exec(part))) { if (!f.parents.includes(m[1])) return false; continue; }
      if ((m = /^appProperties has \{ key='([^']+)' and value='([^']*)' \}$/.exec(part))) { if (f.appProperties[m[1]] !== m[2]) return false; continue; }
      if ((m = /^name='([^']*)'$/.exec(part))) { if (f.name !== m[1]) return false; continue; }
      if ((m = /^mimeType='([^']*)'$/.exec(part))) { if (f.mimeType !== m[1]) return false; continue; }
      throw new Error('mock: unsupported query part ' + part);
    }
    return true;
  }
  async function readBody(body) { if (body == null) return new Uint8Array(0); if (typeof body === 'string') return new TextEncoder().encode(body); if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer()); if (body instanceof Uint8Array) return body; return new Uint8Array(await new Response(body).arrayBuffer()); }
  function parseMultipart(bytes, ctype) {
    const b = /boundary=(.+)$/.exec(ctype)[1]; const text = new TextDecoder('latin1').decode(bytes);
    const parts = text.split('--' + b).slice(1, -1);
    const metaPart = parts[0], hdrEnd = metaPart.indexOf('\r\n\r\n'); const metaJson = JSON.parse(metaPart.slice(hdrEnd + 4, metaPart.length - 2));
    const p1 = text.indexOf('--' + b, text.indexOf('--' + b) + 1); const h2 = text.indexOf('\r\n\r\n', p1) + 4; const endIdx = text.lastIndexOf('\r\n--' + b + '--');
    return { meta: metaJson, data: bytes.slice(h2, endIdx) };
  }
  async function handle(url, init) {
    const u = new URL(url), method = (init.method || 'GET').toUpperCase(), auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
    log.push(method + ' ' + u.pathname + (u.search ? '?' + [...u.searchParams.keys()].join(',') : ''));
    if (/permissions/.test(u.pathname)) { violations.push(method + ' ' + u.pathname); return err(403, 'forbidden_in_test'); }
    if (u.host !== 'www.googleapis.com') { violations.push('host ' + u.host); return err(400, 'bad_host'); }
    for (let i = 0; i < faults.length; i++) { const f = faults[i]; if (f.match(method, u, init)) { if (--f.times <= 0) faults.splice(i, 1); if (f.before) { const r = f.before(); if (r) return r; } else if (f.after) { const r = await route(u, method, init); f.after(r); throw new TypeError('mock network: response lost'); } } }
    if (auth !== 'Bearer ' + state.token) return err(401, 'authError');
    return await route(u, method, init);
  }
  async function route(u, method, init) {
    const P = u.pathname, sp = u.searchParams, h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (P === '/drive/v3/about') return json(200, { user: { emailAddress: 'romy@example.test', displayName: 'Test' } });
    if (P === '/drive/v3/files' && method === 'GET') { const q = sp.get('q') || ''; const out = []; for (const f of files.values()) if (matchQuery(f, q)) out.push(await meta(f)); return json(200, { files: out }); }
    if (P === '/drive/v3/files' && method === 'POST') { const m = JSON.parse(new TextDecoder().decode(await readBody(init.body))); return json(200, await meta(create(m, null))); }
    let m;
    if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(P))) {
      const f = files.get(decodeURIComponent(m[1])); if (!f) return err(404, 'notFound');
      if (method === 'GET' && sp.get('alt') === 'media') return new Response(new Blob([f.bytes || new Uint8Array(0)], { type: f.mimeType }), { status: 200 });
      if (method === 'GET') return json(200, await meta(f));
      if (method === 'PATCH') { const add = sp.get('addParents'), rem = sp.get('removeParents'); if (rem) f.parents = f.parents.filter((p) => !rem.split(',').includes(p)); if (add) for (const a of add.split(',')) if (!f.parents.includes(a)) f.parents.push(a); f.version++; return json(200, await meta(f)); }
    }
    if (P === '/upload/drive/v3/files' && method === 'POST' && sp.get('uploadType') === 'multipart') { const { meta: mm, data } = parseMultipart(await readBody(init.body), h['content-type']); return json(200, await meta(create(mm, data))); }
    if (P === '/upload/drive/v3/files' && method === 'POST' && sp.get('uploadType') === 'resumable') {
      const mm = JSON.parse(new TextDecoder().decode(await readBody(init.body))); const total = Number(h['x-upload-content-length']); const sid = 'up' + (++seq);
      sessions.set(sid, { meta: mm, total, buf: new Uint8Array(total), got: 0, done: null });
      return new Response(null, { status: 200, headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=' + sid } });
    }
    if (P === '/upload/drive/v3/files' && method === 'PUT' && sp.get('upload_id')) {
      const s = sessions.get(sp.get('upload_id')); if (!s) return err(404, 'notFound');
      const cr = h['content-range'] || ''; const rangeHdr = () => (state.exposeRange && s.got > 0 ? { Range: 'bytes=0-' + (s.got - 1) } : {});
      if (/^bytes \*\//.test(cr)) { if (s.done) return json(200, await meta(s.done)); return new Response(null, { status: 308, headers: rangeHdr() }); }
      const mm2 = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr); if (!mm2) return err(400, 'badContentRange');
      const a = +mm2[1], b = +mm2[2]; const data = await readBody(init.body);
      if (data.length !== b - a + 1) return err(400, 'lengthMismatch');
      if (a > s.got) return new Response(null, { status: 308, headers: rangeHdr() }); // gap: ignore, report real offset
      s.buf.set(data.slice(s.got - a), s.got); s.got = Math.max(s.got, b + 1);
      if (s.got >= s.total) { if (!s.done) s.done = create(s.meta, s.buf); return json(200, await meta(s.done)); }
      return new Response(null, { status: 308, headers: rangeHdr() });
    }
    if ((m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(P)) && method === 'PATCH' && sp.get('uploadType') === 'media') { const f = files.get(decodeURIComponent(m[1])); if (!f) return err(404, 'notFound'); setBytes(f, await readBody(init.body)); return json(200, await meta(f)); }
    return err(400, 'unsupported ' + method + ' ' + P);
  }
  return {
    fetch: (url, init = {}) => handle(url, init),
    files, sessions, log, violations, state,
    fault(match, how) { faults.push({ match, times: how.times || 1, before: how.before, after: how.after }); },
    byRole(role) { return [...files.values()].filter((f) => f.appProperties.closetRole === role); },
    clearFaults() { faults.length = 0; },
    tamper(id, bytes) { setBytes(files.get(id), bytes); },
  };
}
