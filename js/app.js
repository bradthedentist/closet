// Closet app shell: sign-in, Drive-backed catalog, closet grid, item view, add flow, outfit board, settings.
import { CLIENT_ID, HOSTED_DOMAIN, APP_VERSION } from '../config.js';
import * as C from './core/catalog.js';
import { CATEGORIES } from './core/policy.js';
import { sha256Hex, md5Hex, uuid } from './core/hash.js';
import { createDrive, AuthError } from './core/drive.js';
import { createStore } from './core/store.js';
import { createImportQueue, putDerivedFile, fileProps, ROLE_FOLDER } from './core/import-queue.js';
import { createAuth } from './core/auth.js';
import { openKV } from './core/idb.js';
import { createMockDrive } from './core/mock-drive.js';
import * as Prep from './ml/photo-prep.js';
import { createBoard } from './board.js';
import { openTouchup } from './touchup.js';
import { esc, $, $$, ICON, toast, sheet, fmtDate, fmtMB } from './ui.js';

const params = new URLSearchParams(location.search);
const auth = createAuth({ clientId: CLIENT_ID, hd: HOSTED_DOMAIN });
const authResult = auth.consume();
if (authResult && authResult.returnTo !== undefined && authResult.returnTo !== location.search) history.replaceState(null, '', location.pathname + (authResult.returnTo || '') + location.hash);
const P = new URLSearchParams(location.search);
const MODE = P.get('local') === '1' ? 'local' : P.get('test') === '1' ? 'test' : 'prod';
const db = openKV('closet-app-' + MODE);
const S = { tab: 'closet', seg: 'all', cat: 'all', search: '', showSearch: false, email: '', layout: null, store: null, drive: null, busy: false, draft: null, board: null, settings: { cutSize: 0 } };
const app = $('#app'), tabbar = $('#tabbar');
let ML = null, CUT = null; // lazily imported model modules
const lazyML = async () => (ML = ML || (await import('./ml/classifier.js')));
const lazyCUT = async () => (CUT = CUT || (await import('./ml/cutout.js')));
if (MODE !== 'prod') $('#testbar').classList.remove('hidden');
if (MODE === 'local') $('#testbar').textContent = 'DEVICE-ONLY DEMO · nothing is saved to Drive · gone on reload';

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
try { S.settings = Object.assign(S.settings, JSON.parse(localStorage.getItem('closet.settings') || '{}')); } catch (e) {}
const saveSettings = () => localStorage.setItem('closet.settings', JSON.stringify(S.settings));

// ---------------------------------------------------------------- images (Drive -> IndexedDB cache -> object URL)
const urls = new Map(), inflight = new Map();
async function blobFor(f) {
  const key = f.id + ':' + f.size;
  let b = await db.blobs.get(key).catch(() => null);
  if (!b) { b = await S.drive.download(f.id); db.blobs.set(key, b).catch(() => {}); }
  return b;
}
function urlFor(f) {
  if (!f) return Promise.resolve(null);
  const key = f.id + ':' + f.size;
  if (urls.has(key)) return Promise.resolve(urls.get(key));
  if (!inflight.has(key)) inflight.set(key, blobFor(f).then((b) => { const u = URL.createObjectURL(b); urls.set(key, u); inflight.delete(key); return u; }).catch((e) => { inflight.delete(key); throw e; }));
  return inflight.get(key);
}
function setImg(img, f) { if (!f) return; urlFor(f).then((u) => { if (u) img.src = u; }).catch((e) => { if (e instanceof AuthError) onAuthLost(); }); }
function hydrate(root = app) { $$('img[data-fid]', root).forEach((img) => { const it = item(img.dataset.item); if (!it) return; const f = it.files[img.dataset.fid]; setImg(img, f); img.removeAttribute('data-fid'); }); }
const cat = () => S.store && S.store.get();
const item = (id) => cat() && cat().items.find((x) => x.id === id);

// ---------------------------------------------------------------- boot / auth
function welcome(msg) {
  tabbar.classList.add('hidden');
  const setup = !CLIENT_ID || /REPLACE/.test(CLIENT_ID);
  app.innerHTML = '<div class="welcome"><h1>Closet</h1><p>Your clothes as clean cutouts, sorted automatically. Style outfits, and keep pieces you’re considering separate from what you own.</p>' +
    (msg ? '<div class="banner" style="margin:16px 0 0">' + esc(msg) + '</div>' : '') +
    '<button class="btn dark" id="signin" ' + (setup ? 'disabled' : '') + '>Sign in with Google</button>' +
    (setup ? '<small>Setup not finished: the sign-in client ID is missing.</small>' : '') +
    '<small>Private to you. The app stores photos in its own folder in your Google Drive (“' + (MODE === 'test' ? 'Closet (app) TEST' : 'Closet (app)') + '”) and can only see files it created there — never the rest of your Drive. Photos are analyzed on this device; nothing is sent to other services.</small>' +
    (MODE === 'prod' ? '' : '<small>Mode: ' + esc(MODE) + '</small>') + '</div>';
  const b = $('#signin'); if (b) b.onclick = () => auth.start({ silent: false });
}
function onAuthLost() {
  if (S.authLost) return; S.authLost = true; auth.expire();
  const bn = document.createElement('div'); bn.className = 'banner'; bn.id = 'authbanner';
  bn.innerHTML = '<span>Google sign-in expired.</span><button>Continue</button>';
  bn.querySelector('button').onclick = () => auth.start({ silent: auth.hasHint() });
  const v = $('.view'); if (v) v.prepend(bn); else welcome('Google sign-in expired.');
}
async function boot() {
  if (MODE === 'local') {
    const mock = createMockDrive({ checksums: 'both' });
    S.drive = createDrive({ fetch: mock.fetch, getToken: async () => 'mock-token', sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) });
    S.email = 'device-only demo';
  } else {
    if (authResult && !authResult.ok) {
      if (authResult.silent && /interaction_required|login_required|consent_required|account_selection_required/.test(authResult.error)) return auth.start({ silent: false });
      if (authResult.error === 'scope_too_broad') return welcome('Google granted more access than this app allows, so it was not used. Please try again.');
      if (authResult.error !== 'no_pending_sign_in') return welcome('Sign-in did not finish (' + authResult.error + '). Please try again.');
    }
    if (!auth.token()) {
      if (auth.hasHint() && !sessionStorage.getItem('closet.autoSilent')) { sessionStorage.setItem('closet.autoSilent', '1'); return auth.start({ silent: true }); }
      return welcome();
    }
    sessionStorage.removeItem('closet.autoSilent');
    S.drive = createDrive({ fetch: (u, i) => fetch(u, i), getToken: async () => auth.token() });
  }
  app.innerHTML = '<div class="welcome"><h1>Closet</h1><p>Opening your closet…</p></div>';
  try {
    if (MODE !== 'local') { const a = await S.drive.about(); S.email = a.user && a.user.emailAddress || ''; auth.rememberHint(S.email); }
    S.layout = await S.drive.ensureLayout(MODE);
    S.store = createStore({ drive: S.drive, layout: S.layout, mode: MODE, cache: db.kv });
    let first = true;
    S.store.onChange(() => { if (first) { first = false; } render(); });
    await S.store.load();
  } catch (e) {
    if (e instanceof AuthError) { auth.expire(); return welcome('Please sign in again.'); }
    return welcome('Could not open your closet: ' + (e && e.message || e));
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  try { S.draft = JSON.parse(localStorage.getItem('closet.draft.' + MODE) || 'null'); } catch (e) {}
  window.addEventListener('hashchange', render);
  render();
  const add = P.get('add'); if (add === 'owned' || add === 'considering') { P.delete('add'); history.replaceState(null, '', location.pathname + (P.toString() ? '?' + P : '') + location.hash); openAdd(add); }
}

// ---------------------------------------------------------------- routing / tab bar
function route() { const h = location.hash.replace(/^#\/?/, ''); const [a, b] = h.split('/'); return { name: a || 'closet', id: b || null }; }
function go(h) { location.hash = '#/' + h; }
function renderTabs(active) {
  tabbar.classList.remove('hidden');
  const t = (k, label, icon) => '<button class="tab' + (active === k ? ' on' : '') + '" data-go="' + k + '">' + icon + label + '</button>';
  tabbar.innerHTML = t('closet', 'Closet', ICON.closet) + t('outfits', 'Outfits', ICON.outfits) + t('considering', 'Considering', ICON.heart) + '<button class="tab add" data-add="1"><span class="plus">' + ICON.plus + '</span>Add</button>';
  tabbar.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.add) openAdd(route().name === 'considering' || (route().name === 'item' && item(route().id) && item(route().id).status === 'considering') ? 'considering' : 'owned'); else go(b.dataset.go === 'closet' ? '' : b.dataset.go); };
}
function render() {
  if (!cat()) return;
  const r = route();
  if (r.name === 'item' && item(r.id)) return renderItem(item(r.id));
  if (r.name === 'outfits') return renderOutfits();
  if (r.name === 'settings') return renderSettings();
  return renderCloset(r.name === 'considering' ? 'considering' : 'closet');
}

// ---------------------------------------------------------------- closet grid
function catLine(it) {
  const c = it.category;
  if (c.value) return ICON.spark.replace('#7E8C74', c.source === 'user' ? '#9A9086' : '#7E8C74') + esc(C.CATEGORY_LABELS[c.value]);
  if (c.reason === 'close_ranking' && c.candidates && c.candidates.length === 2) return '<span class="warn">Not sure – ' + esc(C.CATEGORY_LABELS[c.candidates[0]]) + ' or ' + esc(C.CATEGORY_LABELS[c.candidates[1]]) + '?</span>';
  if (c.reason === 'may_not_be_clothing') return '<span class="warn">May not be clothing</span>';
  if (c.reason === 'could_not_decode') return '<span class="warn">Photo can’t be shown here</span>';
  return '<span class="warn">Type not checked yet</span>';
}
function cardHtml(it) {
  const f = it.files.thumb, cons = it.status === 'considering';
  const media = f ? '<img class="' + (it.view === 'cutout' ? 'cut' : 'photo') + '" alt="" data-fid="thumb" data-item="' + esc(it.id) + '">' : '<div class="ph">This photo format can’t be shown on this device. Original kept in Drive.</div>';
  return '<button class="card' + (cons ? ' consider' : '') + '" data-open="' + esc(it.id) + '"><div class="tile' + (it.view === 'cutout' ? '' : ' photoTile') + '">' +
    (cons ? '<span class="badge no">Not owned</span>' : '') + (it.category.value ? '' : '<span class="badge check">Check type</span>') + media +
    '</div><div class="meta"><div class="name">' + esc(it.name) + '</div><div class="cat">' + catLine(it) + '</div></div></button>';
}
function renderCloset(which) {
  const c = cat(), considering = which === 'considering';
  const status = considering ? 'considering' : S.seg;
  const counts = C.counts(c, status), all = C.counts(c, 'all');
  const own = C.query(c, { status: 'owned' }).length, con = C.query(c, { status: 'considering' }).length;
  if (S.cat !== 'all' && S.cat !== 'check' && !counts[S.cat]) S.cat = 'all';
  if (S.cat === 'check' && !counts.check) S.cat = 'all';
  const list = C.query(c, { status, category: S.cat, text: S.search });
  const chips = ['<button class="chip' + (S.cat === 'all' ? ' on' : '') + '" data-cat="all">All <b>' + counts.all + '</b></button>']
    .concat(counts.check ? ['<button class="chip warnchip' + (S.cat === 'check' ? ' on' : '') + '" data-cat="check">Check type <b>' + counts.check + '</b></button>'] : [])
    .concat(CATEGORIES.filter((k) => counts[k]).map((k) => '<button class="chip' + (S.cat === k ? ' on' : '') + '" data-cat="' + k + '">' + C.CATEGORY_PLURAL[k] + ' <b>' + counts[k] + '</b></button>'));
  const emptyMsg = !all.all ? '<div class="empty"><h3>Your closet is empty</h3>Tap <b>Add</b> and choose photos of your clothes — one piece per photo works best. Each one is cut out and sorted automatically.</div>'
    : considering && !con ? '<div class="empty"><h3>Nothing here yet</h3>Add pieces you’re thinking about buying. They stay separate from what you own and are marked “Not owned” in outfits.</div>'
    : !list.length ? '<div class="empty">No pieces match.</div>' : '';
  app.innerHTML = '<div class="view">' +
    '<div class="hdr"><div><h1>' + (considering ? 'Considering' : 'Closet') + '</h1><div class="sub">' + (considering ? con + ' not owned · style them with your closet' : own + ' owned · ' + con + ' considering') + '</div></div>' +
    '<div style="display:flex;gap:8px"><button class="iconbtn" id="srch" aria-label="Search">' + ICON.search + '</button><button class="iconbtn" id="acct" aria-label="Settings">' + ICON.gear + '</button></div></div>' +
    (S.showSearch ? '<div class="search"><input id="q" type="search" placeholder="Search name, brand, notes" value="' + esc(S.search) + '"></div>' : '') +
    (considering ? '' : '<div class="seg">' + ['all', 'owned', 'considering'].map((k) => '<button data-seg="' + k + '" class="' + (S.seg === k ? 'on' : '') + '">' + k[0].toUpperCase() + k.slice(1) + '</button>').join('') + '</div>') +
    (all.all ? '<div class="chips">' + chips.join('') + '</div>' : '') +
    (list.length ? '<div class="section"><h2>' + (S.search ? 'Results' : 'Recently added') + '</h2><span>Sorted automatically</span></div><div class="grid">' + list.map(cardHtml).join('') + '</div>' : emptyMsg) +
    '<div class="credit">Types are suggested on this device by an AI model and can be wrong; tap a piece to fix it. Brand, size and fabric are only what you enter.</div></div>';
  renderTabs(considering ? 'considering' : 'closet');
  app.onclick = (e) => {
    const t = e.target.closest('[data-open],[data-seg],[data-cat],#srch,#acct'); if (!t) return;
    if (t.dataset.open) return go('item/' + t.dataset.open);
    if (t.dataset.seg) { S.seg = t.dataset.seg; S.cat = 'all'; return render(); }
    if (t.dataset.cat) { S.cat = t.dataset.cat; return render(); }
    if (t.id === 'srch') { S.showSearch = !S.showSearch; if (!S.showSearch) S.search = ''; render(); const q = $('#q'); if (q) q.focus(); return; }
    if (t.id === 'acct') return go('settings');
  };
  const q = $('#q'); if (q) q.oninput = () => { S.search = q.value; const pos = q.selectionStart; render(); const q2 = $('#q'); q2.focus(); q2.setSelectionRange(pos, pos); };
  hydrate();
}

// ---------------------------------------------------------------- item view
async function op(fn, okMsg) {
  try { const r = await S.store.apply(fn); if (okMsg) toast(okMsg); return r; }
  catch (e) { if (e instanceof AuthError) onAuthLost(); else toast('Not saved: ' + (e && e.message || e), 5000); throw e; }
}
const now = () => new Date().toISOString();
function renderItem(it) {
  const c = it.category, cons = it.status === 'considering';
  const chip = c.value ? '<button class="aichip" id="cat">' + ICON.spark.replace('#7E8C74', c.source === 'user' ? '#9A9086' : '#7E8C74') + esc(C.CATEGORY_LABELS[c.value]) + ' <small>' + (c.source === 'user' ? 'Set by you' : 'AI suggestion') + '</small><span class="pen">' + ICON.pen + '</span></button>'
    : '<button class="aichip warnc" id="cat">Check type: ' + catLine(it).replace(/<[^>]+>/g, '') + '<span class="pen">' + ICON.pen + '</span></button>';
  const media = it.files.thumb ? (it.view === 'cutout' ? '<img class="cut" alt="" data-fid="cutout" data-item="' + esc(it.id) + '">' : '<img class="photo" style="max-width:86%;max-height:86%" alt="" data-fid="display" data-item="' + esc(it.id) + '">') : '<div class="ph">This photo format can’t be shown on this device. Open the app on your iPhone and tap “Process again”.</div>';
  const kv = (k, label) => '<label class="kv"><span>' + label + '</span><input data-k="' + k + '" value="' + esc(it[k]) + '" placeholder="+ Add" autocomplete="off" enterkeyhint="done"></label>';
  const o = it.files.original;
  app.innerHTML = '<div class="view">' +
    '<div class="topnav"><button class="iconbtn" id="back" aria-label="Back">' + ICON.back + '</button><button class="iconbtn" id="more" aria-label="More">' + ICON.more + '</button></div>' +
    '<div class="stage' + (cons ? ' consider' : '') + '">' + media +
    (it.files.display || it.files.original ? '<button class="orig" id="orig">' + (it.files.thumb ? '<img alt="" data-fid="thumb" data-item="' + esc(it.id) + '">' : '') + 'View original photo</button>' : '') +
    (it.view === 'cutout' ? '<button class="touch" id="touch">Touch up</button>' : (it.files.display ? '<button class="touch" id="mkcut">' + (it.files.mask ? 'Use cutout' : 'Make cutout') + '</button>' : '')) + '</div>' +
    '<div class="ititle" id="title"><h1>' + esc(it.name) + ' ' + ICON.penTitle + '</h1></div>' +
    '<div class="row">' + chip + (cons ? '<span class="notowned">Not owned</span>' : '<span class="owned">' + ICON.check + 'Owned</span>') + '</div>' +
    '<div class="hint">' + (c.value && c.source !== 'user' ? 'Sorted automatically from the photo. Tap the pencil if it’s wrong.' : c.value ? '' : 'The app wasn’t sure, so it didn’t guess. Tap to choose the type.') + (it.cutoutInfo && it.cutoutInfo.failed ? ' Background removal didn’t work for this photo, so the photo is shown.' : '') + '</div>' +
    '<div class="panel">' + kv('brand', 'Brand') + kv('size', 'Size') + kv('fabric', 'Fabric') + '<div class="kv"><span>Added</span><em>' + esc(fmtDate(it.createdAt)) + '</em></div></div>' +
    '<div class="panel"><div class="notes"><b>Notes</b><textarea id="notes" placeholder="Add a note…">' + esc(it.notes) + '</textarea></div></div>' +
    '<div class="cta"><button class="btn dark" id="style">Style this</button><button class="btn light" id="move">' + (cons ? 'Move to Owned' : 'Move to Considering') + '</button></div>' +
    '<div class="hint">Original photo is kept unchanged in your private Drive folder (' + esc(o.name) + ', ' + fmtMB(o.size) + ', checked by ' + (o.verifiedBy === 'size_only' ? 'size' : o.verifiedBy.toUpperCase()) + '); the cutout is a separate copy.</div>' +
    '<button class="linkbtn danger" id="remove">Remove from closet</button><div style="height:20px"></div></div>';
  renderTabs(cons ? 'considering' : 'closet');
  hydrate();
  app.onclick = async (e) => {
    const t = e.target.closest('button,#title'); if (!t) return;
    if (t.id === 'back') return history.length > 1 ? history.back() : go(cons ? 'considering' : '');
    if (t.id === 'cat') return pickCategory(it);
    if (t.id === 'title' && !t.querySelector('input')) {
      t.innerHTML = '<input id="tin" value="' + esc(it.name) + '" maxlength="80" enterkeyhint="done">'; const i = $('#tin'); i.focus(); i.select();
      const done = async () => { const v = i.value.trim(); if (v && v !== it.name) await op((cc) => C.editItem(cc, it.id, { name: v }, now())).catch(() => {}); render(); };
      i.onblur = done; i.onkeydown = (ev) => { if (ev.key === 'Enter') i.blur(); }; return;
    }
    if (t.id === 'move') { await op((cc) => C.setStatus(cc, it.id, cons ? 'owned' : 'considering', now()), cons ? 'Moved to Owned' : 'Moved to Considering').catch(() => {}); return; }
    if (t.id === 'style') { startDraftWith(it); return go('outfits'); }
    if (t.id === 'orig') return viewOriginal(it);
    if (t.id === 'touch') return touchUp(it);
    if (t.id === 'mkcut') return it.files.mask ? setViewMode(it, 'cutout') : makeCutout(it);
    if (t.id === 'more') return moreSheet(it);
    if (t.id === 'remove') return removeItem(it);
  };
  $$('input[data-k]').forEach((inp) => { inp.onkeydown = (ev) => { if (ev.key === 'Enter') inp.blur(); }; inp.onchange = () => op((cc) => C.editItem(cc, it.id, { [inp.dataset.k]: inp.value }, now()), 'Saved').catch(() => {}); });
  const n = $('#notes'); n.onchange = () => op((cc) => C.editItem(cc, it.id, { notes: n.value }, now()), 'Saved').catch(() => {});
}
function pickCategory(it) {
  const s = sheet('<h2>What is it?</h2><p>' + (it.category.value ? '' : 'The app wasn’t sure' + (it.category.candidates ? ' (' + it.category.candidates.map((k) => C.CATEGORY_LABELS[k]).join(' or ') + '?)' : '') + '. ') + 'Your choice is saved as “set by you” and never replaced automatically.</p><div class="plist">' +
    CATEGORIES.map((k) => '<button class="btn ' + (it.category.value === k ? 'dark' : 'light') + '" data-c="' + k + '">' + C.CATEGORY_LABELS[k] + '</button>').join('') + '</div>');
  s.el.onclick = async (e) => { const b = e.target.closest('[data-c]'); if (!b) return; s.close(); await op((cc) => C.editItem(cc, it.id, { category: b.dataset.c }, now()), 'Type saved').catch(() => {}); };
}
function moreSheet(it) {
  const canRe = it.category.source !== 'user';
  const s = sheet('<h2>' + esc(it.name) + '</h2><div class="plist">' +
    (it.view === 'cutout' ? '<button class="btn light" data-a="orig">Use original photo instead</button><button class="btn light" data-a="touch">Touch up cutout</button>' : (it.files.mask ? '<button class="btn light" data-a="cut">Use cutout</button>' : '') + (it.files.display ? '<button class="btn light" data-a="mk">' + (it.files.mask ? 'Redo cutout' : 'Make cutout') + '</button>' : '')) +
    (canRe ? '<button class="btn light" data-a="re">Recognize type again</button>' : '') +
    '<button class="btn light" data-a="proc">Process again from original</button>' +
    '<button class="btn light" data-a="rm" style="color:#A2442F">Remove from closet</button></div><p>Remove never deletes: files move to the “Removed” folder in Drive, and you can restore from Settings.</p>');
  s.el.onclick = async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return; s.close();
    if (b.dataset.a === 'orig') setViewMode(it, 'original');
    if (b.dataset.a === 'cut') setViewMode(it, 'cutout');
    if (b.dataset.a === 'touch') touchUp(it);
    if (b.dataset.a === 'mk') makeCutout(it);
    if (b.dataset.a === 're') reprocess(it, { classify: true, cut: false, fromOriginal: false });
    if (b.dataset.a === 'proc') reprocess(it, { classify: canRe, cut: true, fromOriginal: true });
    if (b.dataset.a === 'rm') removeItem(it);
  };
}
async function setViewMode(it, view) {
  if (view === 'cutout' && !it.files.mask) return makeCutout(it);
  await op((cc) => C.setView(cc, it.id, view, null, undefined, now()), view === 'cutout' ? 'Showing cutout' : 'Showing original photo').catch(() => {});
}
async function viewOriginal(it) {
  const m = document.createElement('div'); m.className = 'modal';
  const o = it.files.original;
  m.innerHTML = '<div class="mtop"><span>' + esc(o.name) + ' · ' + fmtMB(o.size) + '</span><button class="iconbtn" aria-label="Close">' + ICON.close + '</button></div><div class="mbody"><div class="spinner"></div></div><div class="mfoot">Unchanged original in Drive › ' + (MODE === 'test' ? 'Closet (app) TEST' : 'Closet (app)') + ' › Originals. Verified by ' + (o.verifiedBy === 'size_only' ? 'size' : o.verifiedBy.toUpperCase()) + ' when saved.</div>';
  document.body.appendChild(m); m.querySelector('button').onclick = () => m.remove();
  const body = m.querySelector('.mbody');
  try {
    const b = await S.drive.download(o.id); const u = URL.createObjectURL(b); const img = new Image();
    img.onload = () => { body.innerHTML = ''; body.appendChild(img); };
    img.onerror = async () => { URL.revokeObjectURL(u); if (it.files.display) { const du = await urlFor(it.files.display); body.innerHTML = '<img alt="" src="' + esc(du) + '">'; m.querySelector('.mfoot').insertAdjacentHTML('afterbegin', 'This device can’t display the original format, so the downsized copy is shown. '); } else body.textContent = 'This device can’t display this photo format.'; };
    img.src = u; m.addEventListener('remove', () => URL.revokeObjectURL(u));
  } catch (e) { body.textContent = 'Could not load: ' + (e && e.message || e); if (e instanceof AuthError) onAuthLost(); }
}
async function moveFiles(it, toRemoved) {
  for (const [role, f] of Object.entries(it.files)) {
    const home = S.layout[ROLE_FOLDER[role]];
    await S.drive.move(f.id, toRemoved ? S.layout.removed : home, toRemoved ? home : S.layout.removed);
  }
}
async function removeItem(it) {
  if (!confirm('Remove “' + it.name + '” from your closet?\n\nNothing is deleted: its photos move to the “Removed” folder in Drive, and you can restore it in Settings.')) return;
  try { await moveFiles(it, true); await op((cc) => C.markRemoved(cc, it.id, now()), 'Removed — restore any time in Settings'); go(it.status === 'considering' ? 'considering' : ''); }
  catch (e) { if (!(e instanceof AuthError)) toast('Not removed: ' + (e && e.message || e), 5000); else onAuthLost(); }
}
async function restoreItem(it) {
  try { await S.store.apply((cc) => C.restoreItem(cc, it.id, now())); await moveFiles(it, false); toast('Restored'); render(); }
  catch (e) { toast('Not restored: ' + (e && e.message || e), 5000); }
}

// cutout, touch-up and reprocessing for an existing item
function busySheet(title, text) {
  const s = sheet('<h2>' + esc(title) + '</h2><p id="bs">' + esc(text) + '</p><div class="bar"><i id="bsbar"></i></div><p style="font-size:12px;color:var(--ink3)">Keep the app open.</p>', { dismissable: false });
  return { set: (t, frac) => { $('#bs', s.el).textContent = t; if (frac != null) $('#bsbar', s.el).style.width = Math.round(frac * 100) + '%'; }, close: s.close };
}
const progressText = (label) => (got, total) => `Downloading ${label} (one time): ${fmtMB(got)} of ${fmtMB(total)}`;
async function makeCutout(it) {
  const b = busySheet('Making cutout', 'Preparing…');
  try {
    const cut = await lazyCUT();
    b.set('Loading background remover…', 0.05);
    await cut.load((g, t) => b.set(progressText('cutout model')(g, t), g / t));
    b.set('Removing background…', 0.6);
    const disp = await blobFor(it.files.display);
    const r = await cut.cutout(disp, { size: S.settings.cutSize || cut.defaultSize() });
    await saveCutoutFiles(it, r, b);
    await cut.release();
    b.close(); toast('Cutout made');
  } catch (e) { b.close(); if (e instanceof AuthError) onAuthLost(); else toast(e && e.code === 'empty_mask' ? 'No garment found in the photo — keeping the photo view.' : 'Cutout failed: ' + (e && e.message || e), 6000); }
}
async function saveCutoutFiles(it, r, b) {
  b && b.set('Saving cutout…', 0.85);
  const base = (it.source.filename || 'photo').replace(/\.[^.]{1,6}$/, '');
  const files = {};
  for (const [role, blob, folder, name] of [['cutout', r.cutoutBlob, S.layout.cutouts, base + '.cutout.png'], ['mask', r.maskBlob, S.layout.cutouts, base + '.mask.png'], ['thumb', r.thumbBlob, S.layout.thumbs, base + '.thumb.png']]) {
    const existing = it.files[role];
    if (existing) { const f = await S.drive.updateMedia(existing.id, blob, blob.type); files[role] = { id: f.id, size: blob.size, mimeType: blob.type }; db.blobs.delete(existing.id + ':' + existing.size).catch(() => {}); }
    else files[role] = await putDerivedFile(S.drive, fileProps(MODE, it.requestId, role), folder, name, blob);
  }
  await op((cc) => C.setView(cc, it.id, 'cutout', files, r.info, now()));
}
async function touchUp(it) {
  try {
    const [disp, mask] = await Promise.all([blobFor(it.files.display), blobFor(it.files.mask)]);
    const cut = await lazyCUT();
    await openTouchup({ displayBlob: disp, maskBlob: mask, title: 'Touch up ' + it.name, onSave: async (maskCanvas) => {
      const src = await Prep.decode(disp);
      const r = await cut.composeFromMask(src, maskCanvas); if (src.close) src.close();
      await saveCutoutFiles(it, { ...r, info: { ...(it.cutoutInfo || {}), bbox: r.bbox, coverage: r.coverage, touchedUp: true } });
      toast('Cutout saved');
    } });
  } catch (e) { if (e instanceof AuthError) onAuthLost(); else toast('Touch-up unavailable: ' + (e && e.message || e), 5000); }
}
async function reprocess(it, { classify, cut, fromOriginal }) {
  const b = busySheet(fromOriginal ? 'Processing again' : 'Recognizing type', 'Preparing…');
  try {
    let disp = it.files.display ? await blobFor(it.files.display) : null;
    if (fromOriginal || !disp) {
      b.set('Reading original…', 0.05);
      const orig = await S.drive.download(it.files.original.id);
      const prep = await Prep.prepare(orig);
      if (!prep.ok) throw new Error('This device can’t read this photo format. Try on the iPhone.');
      disp = prep.blob;
      const files = { display: await putDerivedFile(S.drive, fileProps(MODE, it.requestId, 'display'), S.layout.display, (it.source.filename || 'photo').replace(/\.[^.]{1,6}$/, '') + ' (downsized display copy).jpg', disp) };
      if (!it.files.thumb) files.thumb = await putDerivedFile(S.drive, fileProps(MODE, it.requestId, 'thumb'), S.layout.thumbs, 'photo.thumb.jpg', await Prep.photoThumb(disp));
      await op((cc) => C.setView(cc, it.id, item(it.id).view, files, undefined, now()));
      it = item(it.id);
    }
    if (classify) {
      const ml = await lazyML(); b.set('Loading clothing recognizer…', 0.15);
      await ml.load((g, t) => b.set(progressText('clothing recognizer')(g, t), 0.15 + (0.35 * g) / t));
      b.set('Recognizing type…', 0.5);
      const a = await ml.analyze(disp); await ml.release();
      await op((cc) => C.applyReanalysis(cc, it.id, a, now()));
      it = item(it.id);
    }
    if (cut) {
      const cm = await lazyCUT(); b.set('Loading background remover…', 0.55);
      await cm.load((g, t) => b.set(progressText('cutout model')(g, t), 0.55 + (0.25 * g) / t));
      b.set('Removing background…', 0.8);
      try { const r = await cm.cutout(disp, { size: S.settings.cutSize || cm.defaultSize() }); await saveCutoutFiles(it, r, b); } catch (e) { if (e instanceof AuthError) throw e; toast('Cutout failed: ' + (e && e.message || e), 5000); }
      await cm.release();
    }
    b.close(); toast('Done');
  } catch (e) { b.close(); if (e instanceof AuthError) onAuthLost(); else toast('Not finished: ' + (e && e.message || e), 6000); }
}

// ---------------------------------------------------------------- add flow
function openAdd(defaultStatus) {
  if (S.busy) return toast('Still saving the last photos…');
  if (MODE !== 'local' && auth.remainingMs() < 20 * 60 * 1000) {
    const s = sheet('<h2>Refresh sign-in</h2><p>Your Google sign-in ends soon. Refresh it first so a batch of photos can finish saving.</p><div class="plist"><button class="btn dark" id="rf">Continue</button></div>');
    $('#rf', s.el).onclick = () => { const q = new URLSearchParams(location.search); q.set('add', defaultStatus); auth.start({ silent: auth.hasHint(), returnTo: '?' + q.toString() }); };
    return;
  }
  let status = defaultStatus;
  const s = sheet('<h2>Add clothes</h2><p>Choose photos from your library — one piece per photo works best. Each one is cut out and sorted on this device; the original photo is saved unchanged.</p>' +
    '<div class="seg" id="dest"><button data-s="owned">Owned</button><button data-s="considering">Considering</button></div>' +
    '<p id="destnote" style="font-size:12.5px"></p>' +
    '<div class="plist"><button class="btn dark" id="pick">Choose photos</button></div><input id="file" type="file" accept="image/*,.heic,.heif" multiple class="hidden">' +
    (ML && ML.isLoaded && ML.isLoaded() ? '' : '<p style="font-size:12px;color:var(--ink3)">First time only: the app downloads about 200 MB of on-device models (clothing recognizer + background remover). Wi-Fi recommended.</p>'));
  const paint = () => { $$('#dest button', s.el).forEach((b) => b.classList.toggle('on', b.dataset.s === status)); $('#destnote', s.el).textContent = status === 'considering' ? 'Considering = not owned yet. Kept separate and marked “Not owned”.' : 'Owned = already in your closet.'; };
  paint();
  $('#dest', s.el).onclick = (e) => { const b = e.target.closest('[data-s]'); if (b) { status = b.dataset.s; paint(); } };
  const input = $('#file', s.el);
  $('#pick', s.el).onclick = () => input.click();
  input.onchange = () => { const files = Array.from(input.files || []); if (!files.length) return; s.close(); runImport(files, status); };
}
async function runImport(files, status) {
  S.busy = true;
  const s = sheet('<h2>Adding ' + files.length + ' photo' + (files.length > 1 ? 's' : '') + '</h2><p id="ist">Getting ready…</p><div class="bar"><i id="ibar"></i></div><div class="plist" id="ilist">' +
    files.map((f, i) => '<div class="prow" data-i="' + i + '"><div><div class="pname">' + esc(f.name || 'Photo ' + (i + 1)) + '</div><div class="pstat">Waiting · ' + fmtMB(f.size) + '</div></div></div>').join('') + '</div><p style="font-size:12px;color:var(--ink3)">Keep the app open until this finishes.</p><div class="plist hidden" id="idone"><button class="btn dark">Done</button></div>', { dismissable: false });
  s.scrim.dataset.busy = '1';
  const row = (i) => $('.prow[data-i="' + i + '"] .pstat', s.el);
  const setTop = (t, frac) => { $('#ist', s.el).textContent = t; if (frac != null) $('#ibar', s.el).style.width = Math.round(frac * 100) + '%'; };
  let mlOk = true, mlErr = null, cutMod = null, cutOk = true;
  let ml = null;
  try { ml = await lazyML(); setTop('Loading clothing recognizer…', 0.02); await ml.load((g, t) => setTop(progressText('clothing recognizer')(g, t), (0.3 * g) / t)); }
  catch (e) { mlOk = false; mlErr = String(e && e.message || e); toast('Clothing recognizer unavailable — photos will be saved as “Check type”.', 6000); }
  const done = { n: 0 };
  const deps = {
    drive: S.drive, layout: S.layout, store: S.store, mode: MODE, pending: db.kv, now, uuid, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    sha256: async (f) => sha256Hex(await f.arrayBuffer()), md5: async (f) => md5Hex(new Uint8Array(await f.arrayBuffer())),
    prepare: (f) => Prep.prepare(f), photoThumb: (b) => Prep.photoThumb(b),
    classify: async (blob) => { if (!mlOk) throw new Error(mlErr || 'unavailable'); return await ml.analyze(blob); },
    releaseClassifier: async () => { if (ml) await ml.release(); },
    cutout: async (blob) => {
      if (!cutOk) throw new Error('background remover unavailable');
      if (!cutMod) { try { cutMod = await lazyCUT(); setTop('Loading background remover…'); await cutMod.load((g, t) => setTop(progressText('cutout model')(g, t), 0.3 + (0.3 * g) / t)); } catch (e) { cutOk = false; throw e; } }
      return await cutMod.cutout(blob, { size: S.settings.cutSize || cutMod.defaultSize() });
    },
    onStatus: (i, t) => { const r = row(i); if (r) r.textContent = t; setTop(t.startsWith('Saving original') ? 'Saving to your Drive…' : t, null); },
    onItem: () => { done.n++; $('#ibar', s.el).style.width = Math.round(60 + (40 * done.n) / files.length) + '%'; },
  };
  let out;
  try { out = await createImportQueue(deps).run(files, status); }
  catch (e) { out = { results: files.map((f) => ({ name: f.name, outcome: 'failed', message: String(e && e.message || e) })), stopped: e instanceof AuthError ? 'auth' : null }; }
  if (cutMod) await cutMod.release().catch(() => {});
  S.busy = false; s.scrim.dataset.busy = '0';
  const res = out.results;
  res.forEach((r, i) => {
    const el = row(i); if (!el) return;
    const msg = r.outcome === 'added' ? 'Added' + (r.review ? ' · check type' : '') + (r.cutoutFailed && !r.unreadable ? ' · photo shown (cutout didn’t work)' : '') + (r.unreadable ? ' · can’t be shown on this device' : '') : r.outcome === 'duplicate' ? r.message : (r.message || r.outcome);
    el.textContent = msg; el.className = 'pstat ' + (r.outcome === 'added' ? 'good' : r.outcome === 'duplicate' ? '' : 'bad');
  });
  const added = res.filter((r) => r.outcome === 'added').length, review = res.filter((r) => r.outcome === 'added' && r.review).length, dup = res.filter((r) => r.outcome === 'duplicate').length, bad = res.filter((r) => r.outcome === 'failed' || r.outcome === 'skipped').length;
  setTop([added + ' added', review ? review + ' to check' : '', dup ? dup + ' already in closet' : '', bad ? bad + ' not saved' : ''].filter(Boolean).join(' · ') + (out.stopped === 'auth' ? ' — sign in again, then add the rest (they resume).' : ''), 1);
  $('#idone', s.el).classList.remove('hidden');
  $('#idone button', s.el).onclick = () => { s.close(); go(status === 'considering' ? 'considering' : ''); if (out.stopped === 'auth') onAuthLost(); };
}

// ---------------------------------------------------------------- outfits
const saveDraft = () => localStorage.setItem('closet.draft.' + MODE, JSON.stringify(S.draft));
function newDraft() { S.draft = { id: uuid(), name: 'New outfit', occasion: '', pieces: [], saved: false }; saveDraft(); }
function startDraftWith(it) {
  if (!S.draft) newDraft();
  if (!S.draft.pieces.some((p) => p.itemId === it.id)) { S.pendingAdd = it.id; }
}
function outfitThumb(o) {
  const ps = o.pieces.slice().sort((a, b) => a.z - b.z).map((p) => { const it = item(p.itemId); if (!it || it.removed) return ''; const W = 104, H = 100, w = p.w * W; const b = it.cutoutInfo && it.cutoutInfo.bbox; const asp = it.view === 'cutout' && b ? b[3] / b[2] : 1.2;
    return '<div class="sp" style="width:' + w + 'px;left:' + (p.x * W - w / 2) + 'px;top:' + (p.y * H - (w * asp) / 2) + 'px;transform:rotate(' + p.rot + 'deg)"><img alt="" data-fid="thumb" data-item="' + esc(it.id) + '"></div>'; }).join('');
  return '<div class="sthumb">' + ps + '</div>';
}
function renderOutfits() {
  const c = cat(); if (!S.draft) newDraft();
  const d = S.draft, live = C.liveItems(c);
  d.pieces = d.pieces.filter((p) => live.some((x) => x.id === p.itemId));
  const saved = c.outfits.filter((o) => !o.removed).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const existing = c.outfits.find((o) => o.id === d.id && !o.removed);
  const dirty = !existing || JSON.stringify({ n: existing.name, o: existing.occasion, p: existing.pieces }) !== JSON.stringify({ n: d.name, o: d.occasion, p: d.pieces.map((p) => ({ itemId: p.itemId, x: +(+p.x).toFixed(4), y: +(+p.y).toFixed(4), w: +(+p.w).toFixed(4), rot: +(+p.rot).toFixed(2), z: Math.round(p.z) })) });
  const sum = C.outfitSummary(c, { pieces: d.pieces });
  const tray = live.slice().sort((a, b) => (a.status === b.status ? (a.createdAt < b.createdAt ? 1 : -1) : a.status === 'owned' ? -1 : 1));
  const OCC = ['Trip', 'Weekend', 'Work', 'Dinner', 'Event', 'Everyday'];
  app.innerHTML = '<div class="view">' +
    '<div class="hdr"><div style="min-width:0;flex:1"><div class="sub" style="margin:0 0 4px">Outfit · ' + sum.pieces + ' piece' + (sum.pieces === 1 ? '' : 's') + (sum.notOwned ? ' · ' + sum.notOwned + ' not owned' : '') + '</div><h1 id="oname" style="font-size:34px;cursor:text">' + esc(d.name) + ' ' + ICON.penTitle + '</h1></div>' +
    '<button class="btn dark small" id="osave" ' + (dirty && d.pieces.length ? '' : 'disabled') + '>' + (dirty ? 'Save' : 'Saved') + '</button></div>' +
    '<div class="occ">' + OCC.map((o) => '<button class="chip' + (d.occasion === o ? ' on' : '') + '" data-occ="' + o + '">' + o + '</button>').join('') + (d.occasion && !OCC.includes(d.occasion) ? '<button class="chip on" data-occ="' + esc(d.occasion) + '">' + esc(d.occasion) + '</button>' : '') + '<button class="chip" data-occ="__other">Other…</button></div>' +
    '<div class="board" id="board"></div>' +
    (live.length ? '<div class="tray" id="tray">' + tray.map((it) => '<button class="mini' + (it.status === 'considering' ? ' c' : '') + (d.pieces.some((p) => p.itemId === it.id) ? ' on' : '') + '" data-add="' + esc(it.id) + '" aria-label="' + esc(it.name) + '"><img alt="" data-fid="thumb" data-item="' + esc(it.id) + '"></button>').join('') + '</div>' : '<div class="hint">Add clothes first, then build outfits here.</div>') +
    '<div class="cta"><button class="btn light" id="onew">New outfit</button>' + (existing ? '<button class="btn light" id="ocopy">Save as copy</button>' : '') + '</div>' +
    '<div class="section"><h2>Saved outfits</h2><span>' + saved.length + '</span></div>' +
    (saved.length ? '<div class="saved">' + saved.map((o) => { const sm = C.outfitSummary(c, o); return '<button class="scard' + (o.id === d.id ? ' on' : '') + '" data-load="' + esc(o.id) + '">' + outfitThumb(o) + '<div class="n">' + esc(o.name) + '</div><div class="d">' + sm.pieces + ' piece' + (sm.pieces === 1 ? '' : 's') + (sm.notOwned ? ' · ' + sm.notOwned + ' not owned' : '') + (o.occasion ? ' · ' + esc(o.occasion) : '') + '</div></button>'; }).join('') + '</div>' : '<div class="hint">Saved outfits for trips and occasions show up here.</div>') +
    (existing ? '<button class="linkbtn danger" id="odel">Remove this outfit</button>' : '') + '<div style="height:20px"></div></div>';
  renderTabs('outfits');
  S.board = createBoard($('#board'), { itemFor: (id) => item(id), srcFor: (it, img) => setImg(img, it.view === 'cutout' ? it.files.cutout : (it.files.display || it.files.thumb)),
    onCommit: (ps) => { d.pieces = ps; saveDraft(); refreshOutfitHeader(); } });
  S.board.set(d.pieces);
  if (S.pendingAdd && item(S.pendingAdd)) { S.board.add(item(S.pendingAdd)); S.pendingAdd = null; }
  hydrate();
  app.onclick = async (e) => {
    const t = e.target.closest('button,#oname'); if (!t) return;
    if (t.dataset.add) { S.board.add(item(t.dataset.add)); $$('.mini').forEach((m) => m.classList.toggle('on', d.pieces.some((p) => p.itemId === m.dataset.add))); return; }
    if (t.dataset.occ) { if (t.dataset.occ === '__other') { const v = prompt('Occasion or trip (e.g. “Paris, May”):', d.occasion || ''); if (v === null) return; d.occasion = v.trim().slice(0, 60); } else d.occasion = d.occasion === t.dataset.occ ? '' : t.dataset.occ; saveDraft(); return render(); }
    if (t.id === 'oname') { const v = prompt('Outfit name:', d.name); if (v && v.trim()) { d.name = v.trim().slice(0, 80); saveDraft(); render(); } return; }
    if (t.id === 'osave') { t.disabled = true; await op((cc) => C.upsertOutfit(cc, { id: d.id, name: d.name, occasion: d.occasion, pieces: d.pieces }, now()), 'Outfit saved').catch(() => {}); d.saved = true; saveDraft(); return render(); }
    if (t.id === 'onew') { if (dirty && d.pieces.length && !confirm('Start a new outfit? Unsaved changes to this one will be lost.')) return; newDraft(); return render(); }
    if (t.id === 'ocopy') { S.draft = { ...d, id: uuid(), name: d.name + ' (copy)', saved: false }; saveDraft(); return render(); }
    if (t.dataset.load) { if (dirty && d.pieces.length && t.dataset.load !== d.id && !confirm('Open this outfit? Unsaved changes will be lost.')) return; const o = c.outfits.find((x) => x.id === t.dataset.load); S.draft = { id: o.id, name: o.name, occasion: o.occasion, pieces: o.pieces.map((p) => ({ ...p })), saved: true }; saveDraft(); return render(); }
    if (t.id === 'odel') { if (!confirm('Remove outfit “' + d.name + '”? (The clothes stay in your closet.)')) return; await op((cc) => C.removeOutfit(cc, d.id, now()), 'Outfit removed').catch(() => {}); newDraft(); return render(); }
  };
}
function refreshOutfitHeader() {
  const c = cat(), d = S.draft, existing = c.outfits.find((o) => o.id === d.id && !o.removed);
  const b = $('#osave'); if (b) { b.disabled = !d.pieces.length; b.textContent = 'Save'; }
  const sum = C.outfitSummary(c, { pieces: d.pieces }); const sub = $('.hdr .sub'); if (sub) sub.textContent = 'Outfit · ' + sum.pieces + ' piece' + (sum.pieces === 1 ? '' : 's') + (sum.notOwned ? ' · ' + sum.notOwned + ' not owned' : '');
  if (b && existing && !d.pieces.length) b.disabled = true;
  $$('.mini').forEach((m) => m.classList.toggle('on', d.pieces.some((p) => p.itemId === m.dataset.add)));
}

// ---------------------------------------------------------------- settings
async function renderSettings() {
  const c = cat(), removed = c.items.filter((x) => x.removed);
  const cutDefault = /iP(hone|ad|od)/.test(navigator.userAgent) ? 640 : 1024;
  const cs = S.settings.cutSize || cutDefault;
  app.innerHTML = '<div class="view settings"><div class="topnav"><button class="iconbtn" id="back" aria-label="Back">' + ICON.back + '</button><span></span></div>' +
    '<div class="ititle"><h1>Settings</h1></div>' +
    '<div class="panel"><div class="kv"><span>Signed in</span><em>' + esc(S.email) + '</em></div><div class="kv"><span>Mode</span><em>' + (MODE === 'prod' ? 'Your closet' : MODE === 'test' ? 'TEST (separate folder)' : 'Device-only demo') + '</em></div>' +
    (MODE === 'local' ? '' : '<a class="kv" href="https://drive.google.com/drive/folders/' + encodeURIComponent(S.layout.rootId) + '" target="_blank" rel="noopener noreferrer"><span>Drive folder</span><span class="addv">' + (MODE === 'test' ? 'Closet (app) TEST' : 'Closet (app)') + ' ›</span></a>') +
    '<div class="kv"><span>Access</span><em>Only files this app created (drive.file)</em></div></div>' +
    '<div class="panel"><label class="kv"><span>Cutout quality</span><select id="cutq"><option value="640"' + (cs === 640 ? ' selected' : '') + '>Standard (faster, less memory)</option><option value="1024"' + (cs === 1024 ? ' selected' : '') + '>High (sharper, needs more memory)</option></select></label>' +
    '<div class="kv"><span>On-device models</span><em id="mcache">…</em></div></div>' +
    '<div class="section"><h2>Removed items</h2><span>' + removed.length + '</span></div>' +
    (removed.length ? '<div class="plist">' + removed.map((it) => '<div class="prow"><img alt="" data-fid="thumb" data-item="' + esc(it.id) + '"><div><div class="pname">' + esc(it.name) + '</div><div class="pstat">Removed ' + esc(fmtDate(it.removedAt)) + ' · files in “Removed” folder</div></div><button class="btn light small" data-restore="' + esc(it.id) + '">Restore</button></div>').join('') + '</div>' : '<div class="hint">Nothing removed. Removing never deletes — files move to the Drive folder “Removed”, which you can empty yourself.</div>') +
    '<button class="linkbtn" id="clearcache">Clear this device’s photo cache</button>' +
    (MODE === 'local' ? '' : '<button class="linkbtn danger" id="signout">Sign out</button>') +
    '<div class="credit">Closet ' + esc(APP_VERSION) + '. Clothing type: Marqo-FashionSigLIP (Apache-2.0). Cutouts: IS-Net general-use (Apache-2.0), U²-Net-p fallback (Apache-2.0). Runtime: ONNX Runtime Web (MIT). Fonts: DM Sans and Instrument Serif (SIL OFL 1.1). Notices: <a href="NOTICE.txt">NOTICE.txt</a>. Ghost-mannequin views are not part of this free version.</div></div>';
  renderTabs('closet'); hydrate();
  app.onclick = async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.id === 'back') return history.length > 1 ? history.back() : go('');
    if (t.dataset.restore) return restoreItem(item(t.dataset.restore));
    if (t.id === 'clearcache') { await db.blobs.clear(); urls.clear(); toast('Photo cache cleared (Drive copies untouched)'); }
    if (t.id === 'signout') { if (!confirm('Sign out of Google on this device?')) return; auth.signOut(); await db.blobs.clear().catch(() => {}); location.replace(location.pathname + location.search); }
  };
  $('#cutq').onchange = (e) => { S.settings.cutSize = Number(e.target.value); saveSettings(); toast('Cutout quality saved'); };
  try { const { cachedModelBytes } = await import('./ml/ort.js'); const n = await cachedModelBytes(); const el = $('#mcache'); if (el) el.textContent = n ? fmtMB(n) + ' cached on this device' : 'Not downloaded yet'; } catch (e) {}
}

boot();
