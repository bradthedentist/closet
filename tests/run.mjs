// Node unit tests (no browser): catalog rules, policy re-check, auth fragment validation, Drive client + import queue
// against the in-memory mock Drive (lost responses, hidden Range, checksum mismatch, idempotence, separation).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as C from '../js/core/catalog.js';
import { POLICY_VERSION, MIN_MARGIN } from '../js/core/policy.js';
import { md5Hex, sha256Hex } from '../js/core/hash.js';
import { createMockDrive } from '../js/core/mock-drive.js';
import { createDrive, AuthError } from '../js/core/drive.js';
import { createStore } from '../js/core/store.js';
import { createImportQueue } from '../js/core/import-queue.js';
import { memoryKV } from '../js/core/idb.js';
import * as G from '../js/core/geom.js';
import { parseAuthFragment, buildAuthUrl, redirectUriFor, SCOPE } from '../js/core/auth.js';

let pass = 0, failN = 0; const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const NOW = '2026-11-09T05:00:00.000Z';
const REV = 'c56244cc94f92419e8369fa71efdaf403b124ce8';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ana = (top, s1, second, s2, prompt = 'a photo of a denim jacket') => ({ status: s1 - s2 >= MIN_MARGIN && top !== 'not_clothing' ? 'ai_suggested' : 'needs_review', category: s1 - s2 >= MIN_MARGIN && top !== 'not_clothing' ? top : null, reason: 'x', policyVersion: POLICY_VERSION, revision: REV,
  ranking: [{ category: top, score: s1, prompt }, { category: second, score: s2 }, { category: 'bags', score: s2 - 0.05 }] });
const fileRef = (o = {}) => ({ id: 'f' + Math.random().toString(36).slice(2, 8), size: 10, ...o });
const recFor = (n, over = {}) => ({ requestId: 'req' + n + 'aaaa', itemId: 'item' + n + 'bbbb', status: 'owned', analysis: ana('outerwear', 0.2, 'tops', 0.15),
  files: { original: fileRef({ sha256: sha('p' + n), verifiedBy: 'sha256' }), display: fileRef(), thumb: fileRef(), cutout: fileRef(), mask: fileRef() }, view: 'cutout', ...over });

// ---------------- catalog ----------------
test('auto type saved only when policy margin met; name from prompt', () => {
  const r = C.addItem(C.emptyCatalog('test', NOW), recFor(1), NOW);
  assert.equal(r.item.category.value, 'outerwear'); assert.equal(r.item.category.source, 'ai_suggested'); assert.equal(r.item.name, 'Denim jacket');
  assert.equal(r.item.brand, ''); assert.equal(r.item.size, ''); assert.equal(r.item.fabric, '');
});
test('close ranking -> Check type with candidates, no invented type', () => {
  const r = C.addItem(C.emptyCatalog('test', NOW), recFor(1, { analysis: ana('tops', 0.2, 'dresses', 0.19) }), NOW);
  assert.equal(r.item.category.value, null); assert.equal(r.item.category.reason, 'close_ranking'); assert.deepEqual(r.item.category.candidates, ['tops', 'dresses']); assert.equal(r.item.name, 'New item');
});
test('not clothing / unavailable / undecodable flagged', () => {
  let c = C.emptyCatalog('test', NOW);
  c = C.addItem(c, recFor(1, { analysis: ana('not_clothing', 0.3, 'tops', 0.1) }), NOW).catalog;
  c = C.addItem(c, recFor(2, { analysis: null, unavailableReason: 'offline' }), NOW).catalog;
  c = C.addItem(c, recFor(3, { analysis: { reason: 'could_not_decode' }, view: 'original', files: { original: fileRef({ sha256: sha('p3'), verifiedBy: 'size_only' }) } }), NOW).catalog;
  assert.deepEqual(c.items.map((x) => x.category.reason), ['may_not_be_clothing', 'not_analyzed', 'could_not_decode']);
  assert.equal(C.counts(c, 'all').check, 3); C.validateCatalog(c);
});
test('policy-inconsistent analysis rejected', () => {
  const bad = ana('outerwear', 0.2, 'tops', 0.15); bad.category = 'shoes';
  assert.throws(() => C.addItem(C.emptyCatalog('test', NOW), recFor(1, { analysis: bad }), NOW), /does not match/);
  const bad2 = ana('outerwear', 0.2, 'tops', 0.15); bad2.policyVersion = 'other';
  assert.throws(() => C.addItem(C.emptyCatalog('test', NOW), recFor(1, { analysis: bad2 }), NOW), /policy version/);
  const bad3 = ana('outerwear', 0.2, 'tops', 0.25); bad3.status = 'ai_suggested'; bad3.category = 'outerwear';
  assert.throws(() => C.addItem(C.emptyCatalog('test', NOW), recFor(1, { analysis: bad3 }), NOW), /not sorted/);
});
test('idempotent request ID; same photo never added twice; conflict on reused ID', () => {
  let c = C.addItem(C.emptyCatalog('test', NOW), recFor(1), NOW).catalog;
  const again = C.addItem(c, recFor(1), NOW); assert.equal(again.duplicate, true); assert.equal(again.catalog, c);
  const samePhoto = C.addItem(c, recFor(1, { requestId: 'otherreq1', itemId: 'otheritem1', status: 'considering' }), NOW); assert.equal(samePhoto.duplicate, true); assert.equal(samePhoto.reason, 'same_photo');
  const r2 = recFor(2); r2.requestId = recFor(1).requestId; assert.throws(() => C.addItem(c, r2, NOW), /Request conflict/);
  assert.equal(c.items.length, 1);
});
test('owned vs considering kept separate; move between', () => {
  let c = C.emptyCatalog('test', NOW);
  c = C.addItem(c, recFor(1), NOW).catalog; c = C.addItem(c, recFor(2, { status: 'considering' }), NOW).catalog;
  assert.equal(C.query(c, { status: 'owned' }).length, 1); assert.equal(C.query(c, { status: 'considering' }).length, 1);
  c = C.setStatus(c, 'item2bbbb', 'owned', NOW).catalog; assert.equal(C.query(c, { status: 'owned' }).length, 2);
  assert.throws(() => C.setStatus(c, 'item2bbbb', 'maybe', NOW));
  assert.throws(() => C.addItem(c, recFor(3, { status: 'wishlist' }), NOW), /Owned or Considering/);
});
test('edit: user type, user-only fields, removed + restore (never hard delete)', () => {
  let c = C.addItem(C.emptyCatalog('test', NOW), recFor(1), NOW).catalog;
  c = C.editItem(c, 'item1bbbb', { category: 'dresses', brand: ' Zara ', name: 'Blue dress' }, NOW).catalog;
  const it = c.items[0]; assert.equal(it.category.source, 'user'); assert.equal(it.brand, 'Zara'); assert.equal(it.nameSource, 'user');
  assert.throws(() => C.applyReanalysis(c, 'item1bbbb', ana('tops', 0.3, 'bags', 0.1), NOW), /set by you/);
  c = C.markRemoved(c, 'item1bbbb', NOW).catalog; assert.equal(c.items.length, 1); assert.equal(C.liveItems(c).length, 0);
  c = C.addItem(c, recFor(9, { files: { ...recFor(9).files, original: fileRef({ sha256: sha('p1'), verifiedBy: 'sha256' }) } }), NOW).catalog; // same photo re-added after removal is allowed
  assert.throws(() => C.restoreItem(c, 'item1bbbb', NOW), /already in your closet/);
});
test('outfits: upsert by id (no duplicates), considering marked, validation', () => {
  let c = C.emptyCatalog('test', NOW);
  c = C.addItem(c, recFor(1), NOW).catalog; c = C.addItem(c, recFor(2, { status: 'considering' }), NOW).catalog;
  const o = { id: 'outfit0001', name: 'Weekend trip', occasion: 'Trip', pieces: [{ itemId: 'item1bbbb', x: 0.3, y: 0.3, w: 0.4, rot: -3, z: 1 }, { itemId: 'item2bbbb', x: 0.7, y: 0.7, w: 0.3, rot: 4, z: 2 }] };
  c = C.upsertOutfit(c, o, NOW).catalog; c = C.upsertOutfit(c, { ...o, name: 'Weekend trip 2' }, NOW).catalog;
  assert.equal(c.outfits.length, 1); assert.equal(c.outfits[0].name, 'Weekend trip 2');
  assert.deepEqual(C.outfitSummary(c, c.outfits[0]), { pieces: 2, notOwned: 1 });
  assert.throws(() => C.upsertOutfit(c, { ...o, pieces: [o.pieces[0], o.pieces[0]] }, NOW), /only once/);
  assert.throws(() => C.upsertOutfit(c, { ...o, pieces: [{ ...o.pieces[0], itemId: 'nope00000' }] }, NOW), /unknown item/);
  C.validateCatalog(c);
});
test('validateCatalog rejects tampering', () => {
  let c = C.addItem(C.emptyCatalog('test', NOW), recFor(1), NOW).catalog;
  const t = JSON.parse(JSON.stringify(c)); t.items[0].status = 'both'; assert.throws(() => C.validateCatalog(t));
  const t2 = JSON.parse(JSON.stringify(c)); t2.items[0].category.margin = 0.001; assert.throws(() => C.validateCatalog(t2), /policy/);
  const t3 = JSON.parse(JSON.stringify(c)); t3.items.push({ ...t3.items[0], id: 'item7bbbb' }); assert.throws(() => C.validateCatalog(t3));
});

// ---------------- board geometry ----------------
test('board gestures: drag, pinch scale/rotate, handle, clamps', () => {
  const p = { itemId: 'a', x: 0.5, y: 0.5, w: 0.4, rot: 0, z: 1 };
  const d = G.drag(p, 40, -20, 400, 400); assert.equal(d.x, 0.6); assert.equal(d.y, 0.45);
  const pz = G.pinch(p, { x: 100, y: 200 }, { x: 300, y: 200 }, { x: 100, y: 200 }, { x: 100, y: 600 }, 400, 400);
  assert.ok(Math.abs(pz.w - 0.8) < 1e-9); assert.equal(pz.rot, 90);
  const h = G.handle(p, { x: 200, y: 200 }, { x: 300, y: 300 }, { x: 400, y: 400 }); assert.ok(Math.abs(h.w - 0.8) < 1e-9); assert.equal(h.rot, 0);
  assert.equal(G.drag(p, 1e6, 0, 400, 400).x, G.LIMITS.xyMax); assert.equal(G.pinch(p, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 1000, y: 0 }, 400, 400).w, G.LIMITS.wMax);
  assert.equal(G.handle({ ...p, rot: 170 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }).rot, -100);
  const placed = G.place('shoes', [], 1); assert.ok(placed.x > 0.5 && placed.y > 0.6);
  assert.deepEqual(G.toFront([p, { ...p, itemId: 'b', z: 5 }], 'a').map((x) => x.z), [6, 5]);
});

// ---------------- auth ----------------
test('auth fragment: drive.file only, state checked, broad scope refused', () => {
  const ok = parseAuthFragment('#state=s1&access_token=tok&token_type=Bearer&expires_in=3599&scope=' + encodeURIComponent(SCOPE), 's1', 0);
  assert.equal(ok.ok, true); assert.equal(ok.expiresAt, 3599000);
  assert.equal(parseAuthFragment('#state=s2&access_token=tok&token_type=Bearer&scope=' + encodeURIComponent(SCOPE), 's1', 0).error, 'state_mismatch');
  assert.equal(parseAuthFragment('#state=s1&access_token=tok&token_type=Bearer&scope=' + encodeURIComponent(SCOPE + ' https://www.googleapis.com/auth/drive'), 's1', 0).error, 'scope_too_broad');
  assert.equal(parseAuthFragment('#state=s1&error=interaction_required', 's1', 0).error, 'interaction_required');
  const url = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'https://bradthedentist.github.io/closet/oauth.html', state: 's', prompt: 'none', loginHint: 'a@b', hd: 'x.com' }));
  assert.equal(url.searchParams.get('scope'), SCOPE); assert.equal(url.searchParams.get('response_type'), 'token'); assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(redirectUriFor(new URL('https://bradthedentist.github.io/closet/?test=1')), 'https://bradthedentist.github.io/closet/oauth.html');
  assert.equal(redirectUriFor(new URL('http://localhost:8080/?test=1')), 'http://localhost:8080/');
});

// ---------------- Drive + queue ----------------
function rig(opts = {}) {
  const mock = createMockDrive(opts);
  let token = 'mock-token';
  const drive = createDrive({ fetch: mock.fetch, getToken: async () => token, sleep: async () => {} });
  return { mock, drive, setToken: (t) => (token = t) };
}
const photo = (n, size = 3000, type = 'image/jpeg') => { const b = crypto.createHash('sha512').update('seed' + n).digest(); const u = new Uint8Array(size); for (let i = 0; i < size; i++) u[i] = b[i % 64] ^ (i & 255); return new File([u], 'IMG_' + n + '.jpeg', { type }); };
async function makeQueue(r, mode = 'test', over = {}) {
  const layout = await r.drive.ensureLayout(mode);
  const store = createStore({ drive: r.drive, layout, mode, cache: memoryKV(), now: () => NOW });
  await store.load();
  const pending = memoryKV();
  const d = { drive: r.drive, layout, store, pending, mode, now: () => NOW, sleep: async () => {}, uuid: () => crypto.randomUUID().replace(/-/g, ''),
    sha256: async (f) => sha256Hex(new Uint8Array(await f.arrayBuffer())), md5: async (f) => md5Hex(new Uint8Array(await f.arrayBuffer())),
    prepare: async (f) => (f.type === 'image/heic' && over.noHeic ? { ok: false } : { ok: true, blob: new Blob([new Uint8Array(50).fill(1)], { type: 'image/jpeg' }), width: 100, height: 120, sourceWidth: 4032, sourceHeight: 3024 }),
    classify: over.classify || (async () => ana('outerwear', 0.2, 'tops', 0.15)),
    cutout: over.cutout || (async () => ({ cutoutBlob: new Blob([new Uint8Array(40).fill(2)], { type: 'image/png' }), maskBlob: new Blob([new Uint8Array(30).fill(3)], { type: 'image/png' }), thumbBlob: new Blob([new Uint8Array(20).fill(4)], { type: 'image/png' }), info: { model: 'mock', inputSize: 640 } })),
    photoThumb: async () => new Blob([new Uint8Array(25).fill(5)], { type: 'image/jpeg' }), releaseClassifier: async () => {}, onStatus: () => {} };
  return { q: createImportQueue(d), store, pending, layout, d };
}
test('layout: private app folders, TEST separate from production, no permission calls', async () => {
  const r = rig();
  const t = await r.drive.ensureLayout('test'), p = await r.drive.ensureLayout('prod'), t2 = await r.drive.ensureLayout('test');
  assert.notEqual(t.rootId, p.rootId); assert.deepEqual(t, t2);
  assert.equal(r.mock.files.get(t.rootId).name, 'Closet (app) TEST'); assert.equal(r.mock.files.get(p.rootId).name, 'Closet (app)');
  assert.equal(r.mock.violations.length, 0);
});
test('add 3 photos: originals byte-identical + verified, cutout/mask/thumb/display, one commit each', async () => {
  const r = rig(); const { q, store } = await makeQueue(r);
  const files = [photo(1), photo(2, 9 * 1024 * 1024 + 7), photo(3, 500, 'image/heic')];
  const out = await q.run(files, 'owned');
  assert.deepEqual(out.results.map((x) => x.outcome), ['added', 'added', 'added']);
  const originals = r.mock.byRole('original'); assert.equal(originals.length, 3);
  for (const f of files) { const d = originals.find((o) => o.name === f.name); assert.ok(Buffer.from(d.bytes).equals(Buffer.from(await f.arrayBuffer()))); }
  for (const role of ['cutout', 'mask', 'thumb', 'display']) assert.equal(r.mock.byRole(role).length, 3, role);
  assert.equal(store.get().items.length, 3); assert.ok(store.get().items.every((i) => i.files.original.verifiedBy === 'sha256'));
  assert.equal(r.mock.violations.length, 0);
});
test('re-adding same photos: no new files, reported as duplicate (Owned or Considering)', async () => {
  const r = rig(); const { q, store } = await makeQueue(r);
  await q.run([photo(1)], 'owned');
  const n = r.mock.files.size;
  const out = await q.run([photo(1), photo(1)], 'considering');
  assert.deepEqual(out.results.map((x) => x.outcome), ['duplicate', 'duplicate']); assert.equal(r.mock.files.size, n); assert.equal(store.get().items.length, 1);
});
test('lost commit response then retry -> exactly one item, one original', async () => {
  const r = rig(); const { q, store } = await makeQueue(r);
  r.mock.fault((m, u) => m === 'PATCH' && u.pathname.startsWith('/upload/drive/v3/files/') && u.searchParams.get('uploadType') === 'media', { after: () => {}, times: 1 });
  const out1 = await q.run([photo(5)], 'owned');
  // the catalog write landed on Drive but the response was lost; client retries with same request id -> reloads remote
  const out2 = await q.run([photo(5)], 'owned');
  const all = [...out1.results, ...out2.results].map((x) => x.outcome);
  assert.ok(all.includes('added') || all.includes('duplicate'), all.join());
  await store.load(); assert.equal(store.get().items.length, 1); assert.equal(r.mock.byRole('original').length, 1);
});
test('resumable: lost chunk response + hidden Range header still completes byte-exact', async () => {
  const r = rig({ exposeRange: false }); const { q } = await makeQueue(r);
  let n = 0; r.mock.fault((m, u, init) => m === 'PUT' && u.searchParams.get('upload_id') && /^bytes 8388608-/.test(init.headers['Content-Range'] || '') && ++n === 1, { after: () => {}, times: 1 });
  const f = photo(7, 20 * 1024 * 1024 + 3);
  const out = await q.run([f], 'owned');
  assert.equal(out.results[0].outcome, 'added', out.results[0].message);
  const o = r.mock.byRole('original'); assert.equal(o.length, 1); assert.ok(Buffer.from(o[0].bytes).equals(Buffer.from(await f.arrayBuffer())));
});
test('reload mid-upload: saved session resumes, no second original', async () => {
  const r = rig(); const { q, pending } = await makeQueue(r);
  const f = photo(8, 18 * 1024 * 1024);
  r.mock.fault((m, u, init) => m === 'PUT' && /^bytes 8388608-/.test(init.headers['Content-Range'] || ''), { before: () => { throw new TypeError('offline'); }, times: 99 });
  const out1 = await q.run([f], 'owned'); assert.equal(out1.results[0].outcome, 'failed');
  const keys = await pending.keys(); assert.equal(keys.length, 1); const p = await pending.get(keys[0]); assert.ok(p.session && p.session.uri);
  r.mock.clearFaults();
  const again = await makeQueue(r); // new queue instance = app reload; same device pending store
  const q2 = createImportQueue({ ...again.d, pending });
  const out2 = await q2.run([f], 'owned');
  assert.equal(out2.results[0].outcome, 'added', out2.results[0].message);
  assert.equal(r.mock.sessions.size, 1, 'session reused, not restarted');
  const o = r.mock.byRole('original'); assert.equal(o.length, 1); assert.ok(Buffer.from(o[0].bytes).equals(Buffer.from(await f.arrayBuffer())));
  assert.equal(again.store.get().items.length, 1);
});
test('checksum mismatch -> original quarantined to Removed, not committed', async () => {
  const r = rig(); const { q, store, layout } = await makeQueue(r);
  r.mock.fault((m, u, init) => m === 'PUT' && u.searchParams.get('upload_id') && !/\*/.test(init.headers['Content-Range'] || ''), { before: () => null, times: 1 });
  const realFetch = r.mock.fetch; let flipped = false;
  const drive = createDrive({ fetch: async (url, init) => { const res = await realFetch(url, init); if (!flipped && /upload_id/.test(url) && res.status === 200) { flipped = true; const j = await res.clone().json(); r.mock.tamper(j.id, new Uint8Array(3000).fill(9)); } return res; }, getToken: async () => 'mock-token', sleep: async () => {} });
  const { q: q2 } = await makeQueue({ mock: r.mock, drive });
  const out = await q2.run([photo(9)], 'owned');
  assert.equal(out.results[0].outcome, 'failed'); assert.match(out.results[0].message, /did not match/);
  const o = r.mock.byRole('original')[0]; assert.ok(o.parents.includes((await r.drive.ensureLayout('test')).removed));
});
test('md5-only Drive checksum and delayed checksum both verify', async () => {
  const r = rig({ checksums: 'md5' }); const { q, store } = await makeQueue(r);
  await q.run([photo(10)], 'owned'); assert.equal(store.get().items[0].files.original.verifiedBy, 'md5');
  const r2 = rig(); r2.mock.state.checksumDelay = 2; const m2 = await makeQueue(r2); await m2.q.run([photo(11)], 'owned');
  assert.equal(m2.store.get().items[0].files.original.verifiedBy, 'sha256');
});
test('expired token stops batch, keeps pending, later run resumes with same request ID', async () => {
  const r = rig(); const { q, pending, store } = await makeQueue(r);
  r.setToken('expired');
  const out = await q.run([photo(12), photo(13)], 'considering'); assert.equal(out.stopped, 'auth');
  assert.equal((await pending.keys()).length, 2); const before = (await pending.get((await pending.keys())[0])).requestId;
  r.setToken('mock-token');
  const out2 = await q.run([photo(12), photo(13)], 'considering');
  assert.deepEqual(out2.results.map((x) => x.outcome), ['added', 'added']);
  assert.ok(store.get().items.some((i) => i.requestId === before)); assert.equal((await pending.keys()).length, 0);
  assert.ok(store.get().items.every((i) => i.status === 'considering'));
});
test('recognizer down -> saved as not analyzed (never a made-up type); cutout failure -> original view', async () => {
  const r = rig(); const { q, store } = await makeQueue(r, 'test', { classify: async () => { throw new Error('no wasm'); }, cutout: async () => { throw new Error('out of memory'); } });
  const out = await q.run([photo(14)], 'owned');
  assert.equal(out.results[0].outcome, 'added'); assert.equal(out.results[0].cutoutFailed, true);
  const it = store.get().items[0]; assert.equal(it.category.value, null); assert.equal(it.category.reason, 'not_analyzed'); assert.equal(it.view, 'original'); assert.ok(it.files.thumb);
});
test('undecodable (HEIC on desktop): original still saved, item flagged', async () => {
  const r = rig(); const { q, store } = await makeQueue(r, 'test', { noHeic: true });
  const out = await q.run([photo(15, 4000, 'image/heic')], 'owned');
  assert.equal(out.results[0].outcome, 'added'); assert.equal(store.get().items[0].category.reason, 'could_not_decode'); assert.equal(r.mock.byRole('original').length, 1);
});
test('concurrent change on another device is merged, not overwritten', async () => {
  const r = rig(); const a = await makeQueue(r); await a.q.run([photo(16)], 'owned');
  const layout = await r.drive.ensureLayout('test');
  const other = createStore({ drive: r.drive, layout, mode: 'test', cache: memoryKV(), now: () => NOW }); await other.load();
  await other.apply((c) => C.editItem(c, c.items[0].id, { notes: 'from phone' }, NOW));
  await a.store.apply((c) => C.upsertOutfit(c, { id: 'outfit0002', name: 'Dinner', occasion: '', pieces: [{ itemId: c.items[0].id, x: 0.5, y: 0.5, w: 0.5, rot: 0, z: 1 }] }, NOW));
  await other.load(); assert.equal(other.get().items[0].notes, 'from phone'); assert.equal(other.get().outfits.length, 1);
});
test('removal moves files to Removed folder (no delete endpoint exists)', async () => {
  const r = rig(); const { q, store, layout } = await makeQueue(r); await q.run([photo(17)], 'owned');
  const it = store.get().items[0];
  for (const role of Object.keys(it.files)) await r.drive.move(it.files[role].id, layout.removed, role === 'original' ? layout.originals : undefined);
  await store.apply((c) => C.markRemoved(c, it.id, NOW));
  assert.ok(r.mock.files.get(it.files.original.id).parents.includes(layout.removed)); assert.equal(r.mock.files.size > 0, true);
  assert.ok(!r.mock.log.some((l) => l.startsWith('DELETE')));
});

for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { failN++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
}
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
