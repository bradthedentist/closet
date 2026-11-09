// Closet catalog: pure, dependency-free logic shared by the app and the Node tests.
// Owned and Considering are a strict status field; items are never hard-deleted (removed:true + files moved to "Removed").
// Category provenance: 'ai_suggested' (on-device model, provisional policy), 'user' (Romy set it), or null (needs a check).
// Brand / size / fabric are ONLY ever user-entered; nothing in this module fills them.
import { CATEGORIES, MIN_MARGIN, POLICY_VERSION } from './policy.js';

export const SCHEMA = 'closet-app-catalog-v1';
export const STATUSES = Object.freeze(['owned', 'considering']);
export const CATEGORY_LABELS = Object.freeze({ tops: 'Top', bottoms: 'Bottom', dresses: 'Dress', outerwear: 'Outerwear', shoes: 'Shoes', bags: 'Bag', accessories: 'Accessory' });
export const CATEGORY_PLURAL = Object.freeze({ tops: 'Tops', bottoms: 'Bottoms', dresses: 'Dresses', outerwear: 'Outerwear', shoes: 'Shoes', bags: 'Bags', accessories: 'Accessories' });
export const REVIEW_REASONS = Object.freeze(['close_ranking', 'may_not_be_clothing', 'could_not_decode', 'not_analyzed']);
const TEXT_LIMITS = { name: 80, notes: 2000, brand: 80, size: 40, fabric: 120, occasion: 60, outfitName: 80 };
const FILE_ROLES = ['original', 'display', 'cutout', 'mask', 'thumb'];
const SHA = /^[0-9a-f]{64}$/, MD5 = /^[0-9a-f]{32}$/, ID = /^[A-Za-z0-9_-]{6,80}$/;

export class CatalogError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new CatalogError(code, msg); };
const clone = (x) => JSON.parse(JSON.stringify(x));
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function emptyCatalog(mode, now) {
  if (mode !== 'prod' && mode !== 'test' && mode !== 'local') fail('bad_mode', 'Unknown catalog mode.');
  return { schema: SCHEMA, mode, rev: 0, createdAt: now, updatedAt: now, items: [], outfits: [], ledger: {} };
}

// ---- category ----------------------------------------------------------------------------------------------
// Turns a classifier result into the stored category object. Re-checks the provisional policy so a malformed or
// policy-inconsistent analysis can never be saved as an automatic type.
export function categoryFromAnalysis(a, unavailableReason) {
  if (!a) return { value: null, source: null, needsReview: true, reason: 'not_analyzed', note: unavailableReason ? String(unavailableReason).slice(0, 160) : null };
  if (a.reason === 'could_not_decode') return { value: null, source: null, needsReview: true, reason: 'could_not_decode' };
  const r = Array.isArray(a.ranking) ? a.ranking.slice(0, 4).map((x) => ({ category: String(x.category), score: Number(x.score), prompt: x.prompt ? String(x.prompt).slice(0, 80) : undefined })) : [];
  if (r.length < 2 || r.some((x) => !Number.isFinite(x.score) || x.score < -1.01 || x.score > 1.01)) fail('bad_analysis', 'Analysis ranking malformed.');
  for (let i = 1; i < r.length; i++) if (r[i].score > r[i - 1].score + 1e-9) fail('bad_analysis', 'Analysis ranking not sorted.');
  const margin = Math.round((r[0].score - r[1].score) * 1e5) / 1e5;
  if (a.policyVersion !== POLICY_VERSION) fail('bad_analysis', 'Analysis used a different policy version.');
  const base = { ranking: r.map(({ category, score }) => ({ category, score })), margin, policyVersion: POLICY_VERSION, modelRevision: String(a.revision || '').slice(0, 64), analyzedAt: a.analyzedAt || null };
  if (r[0].category === 'not_clothing') return { ...base, value: null, source: null, needsReview: true, reason: 'may_not_be_clothing' };
  if (!CATEGORIES.includes(r[0].category)) fail('bad_analysis', 'Unknown category in analysis.');
  if (margin < MIN_MARGIN) return { ...base, value: null, source: null, needsReview: true, reason: 'close_ranking', candidates: [r[0].category, r[1].category].filter((c) => CATEGORIES.includes(c)) };
  if (a.status !== 'ai_suggested' || a.category !== r[0].category) fail('bad_analysis', 'Analysis decision does not match its ranking.');
  return { ...base, value: r[0].category, source: 'ai_suggested', needsReview: false, reason: 'top_rank_margin', suggestedName: nameFromPrompt(r[0].prompt) };
}
export function nameFromPrompt(p) {
  if (!p) return null;
  let s = String(p).replace(/^a photo of /, '').replace(/^(a pair of|an|a) /, '').trim();
  if (!s || s.length > 40) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function validateCategory(c) {
  if (!c || typeof c !== 'object') fail('bad_item', 'Category missing.');
  if (c.value === null) { if (c.source !== null || c.needsReview !== true || !REVIEW_REASONS.includes(c.reason)) fail('bad_item', 'Unreviewed category inconsistent.'); return; }
  if (!CATEGORIES.includes(c.value)) fail('bad_item', 'Unknown category.');
  if (c.source === 'user') { if (c.needsReview) fail('bad_item', 'User category cannot need review.'); return; }
  if (c.source !== 'ai_suggested' || c.needsReview || !(c.margin >= MIN_MARGIN) || c.policyVersion !== POLICY_VERSION) fail('bad_item', 'Automatic category not backed by the policy.');
}

// ---- validation --------------------------------------------------------------------------------------------
function validateFile(f, role) {
  if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !f.id) fail('bad_item', role + ' file reference missing.');
  if (!(Number.isInteger(f.size) && f.size > 0)) fail('bad_item', role + ' file size invalid.');
  if (role === 'original') {
    if (!SHA.test(f.sha256 || '')) fail('bad_item', 'Original SHA-256 missing.');
    if (f.md5 != null && !MD5.test(f.md5)) fail('bad_item', 'Original MD5 malformed.');
    if (!['sha256', 'md5', 'size_only'].includes(f.verifiedBy)) fail('bad_item', 'Original verification missing.');
  }
}
export function validateItem(it) {
  if (!it || !ID.test(it.id || '') || !ID.test(it.requestId || '')) fail('bad_item', 'Item id invalid.');
  if (!STATUSES.includes(it.status)) fail('bad_item', 'Item status must be owned or considering.');
  if (typeof it.removed !== 'boolean') fail('bad_item', 'Item removed flag missing.');
  validateCategory(it.category);
  for (const k of ['name', 'notes', 'brand', 'size', 'fabric']) if (typeof it[k] !== 'string' || it[k].length > TEXT_LIMITS[k]) fail('bad_item', k + ' invalid.');
  if (!it.files || typeof it.files !== 'object') fail('bad_item', 'Files missing.');
  validateFile(it.files.original, 'original');
  const unreadable = it.category.reason === 'could_not_decode' && it.view === 'original';
  for (const r of ['display', 'thumb']) if (!unreadable || it.files[r]) validateFile(it.files[r], r);
  if (it.view !== 'cutout' && it.view !== 'original') fail('bad_item', 'View mode invalid.');
  if (it.view === 'cutout') { validateFile(it.files.cutout, 'cutout'); validateFile(it.files.mask, 'mask'); }
  for (const r of Object.keys(it.files)) if (!FILE_ROLES.includes(r)) fail('bad_item', 'Unknown file role.');
}
export function validateOutfit(o, itemIds) {
  if (!o || !ID.test(o.id || '')) fail('bad_outfit', 'Outfit id invalid.');
  if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > TEXT_LIMITS.outfitName) fail('bad_outfit', 'Outfit needs a name.');
  if (typeof o.occasion !== 'string' || o.occasion.length > TEXT_LIMITS.occasion) fail('bad_outfit', 'Occasion invalid.');
  if (!Array.isArray(o.pieces) || o.pieces.length > 40) fail('bad_outfit', 'Pieces invalid.');
  const seen = new Set();
  for (const p of o.pieces) {
    if (!p || !itemIds.has(p.itemId)) fail('bad_outfit', 'Outfit piece refers to an unknown item.');
    if (seen.has(p.itemId)) fail('bad_outfit', 'An item can appear only once in an outfit.');
    seen.add(p.itemId);
    for (const k of ['x', 'y', 'w', 'rot', 'z']) if (!Number.isFinite(p[k])) fail('bad_outfit', 'Piece layout invalid.');
    if (p.x < -0.5 || p.x > 1.5 || p.y < -0.5 || p.y > 1.5 || p.w < 0.05 || p.w > 1.6 || Math.abs(p.rot) > 360) fail('bad_outfit', 'Piece layout out of range.');
  }
}
export function validateCatalog(c) {
  if (!c || c.schema !== SCHEMA) fail('bad_catalog', 'Not a closet catalog.');
  if (!['prod', 'test', 'local'].includes(c.mode)) fail('bad_catalog', 'Catalog mode invalid.');
  if (!Number.isInteger(c.rev) || c.rev < 0 || !Array.isArray(c.items) || !Array.isArray(c.outfits) || !c.ledger || typeof c.ledger !== 'object') fail('bad_catalog', 'Catalog structure invalid.');
  const ids = new Set(), live = new Map();
  for (const it of c.items) {
    validateItem(it);
    if (ids.has(it.id)) fail('bad_catalog', 'Duplicate item id.');
    ids.add(it.id);
    const l = c.ledger[it.requestId];
    if (!l || l.itemId !== it.id || l.sha256 !== it.files.original.sha256) fail('bad_catalog', 'Ledger does not match items.');
    if (!it.removed) { if (live.has(it.files.original.sha256)) fail('bad_catalog', 'The same photo is in the closet twice.'); live.set(it.files.original.sha256, it.id); }
  }
  const oids = new Set();
  for (const o of c.outfits) { validateOutfit(o, ids); if (oids.has(o.id)) fail('bad_catalog', 'Duplicate outfit id.'); oids.add(o.id); }
  return true;
}
const bump = (c, now) => { c.rev += 1; c.updatedAt = now; return c; };
const getItem = (c, id) => c.items.find((x) => x.id === id) || fail('not_found', 'Item not found.');

// ---- item operations (all return {catalog, ...}; input catalog is never mutated) ----------------------------
// rec: {requestId, itemId, status, analysis, unavailableReason, files:{original,display,cutout?,mask?,thumb}, view, cutoutInfo, source}
export function addItem(cat, rec, now) {
  const c = clone(cat);
  const sha = rec && rec.files && rec.files.original && rec.files.original.sha256;
  const led = c.ledger[rec.requestId];
  if (led) {
    if (led.sha256 !== sha) fail('request_conflict', 'Request conflict: this request ID was used for a different photo.');
    return { catalog: cat, item: getItem(cat, led.itemId), duplicate: true, reason: 'same_request' };
  }
  const same = c.items.find((x) => !x.removed && x.files.original.sha256 === sha);
  if (same) return { catalog: cat, item: same, duplicate: true, reason: 'same_photo' };
  if (!STATUSES.includes(rec.status)) fail('bad_item', 'Choose Owned or Considering.');
  const category = categoryFromAnalysis(rec.analysis, rec.unavailableReason);
  const item = {
    id: rec.itemId, requestId: rec.requestId, status: rec.status, removed: false, createdAt: now, updatedAt: now,
    name: str(category.suggestedName || (category.value ? CATEGORY_LABELS[category.value] : 'New item'), TEXT_LIMITS.name),
    nameSource: category.suggestedName ? 'ai_suggested' : 'default',
    notes: '', brand: '', size: '', fabric: '',
    category: (({ suggestedName, ...rest }) => rest)(category),
    view: rec.view === 'cutout' ? 'cutout' : 'original',
    cutoutInfo: rec.cutoutInfo || null,
    source: { filename: str(rec.source && rec.source.filename, 200), width: rec.source && rec.source.width || null, height: rec.source && rec.source.height || null, mimeType: str(rec.source && rec.source.mimeType, 100) },
    files: clone(rec.files),
  };
  validateItem(item);
  c.items.push(item);
  c.ledger[rec.requestId] = { itemId: item.id, sha256: sha, status: rec.status, at: now };
  bump(c, now);
  return { catalog: c, item, duplicate: false };
}
export function editItem(cat, id, patch, now) {
  const c = clone(cat), it = getItem(c, id);
  for (const k of ['name', 'notes', 'brand', 'size', 'fabric']) if (k in patch) { it[k] = str(patch[k], TEXT_LIMITS[k]); if (k === 'name') it.nameSource = 'user'; }
  if ('category' in patch) {
    if (!CATEGORIES.includes(patch.category)) fail('bad_item', 'Unknown category.');
    it.category = { ...it.category, value: patch.category, source: 'user', needsReview: false, reason: 'user_set', candidates: undefined };
    delete it.category.candidates;
  }
  it.updatedAt = now; validateItem(it); bump(c, now);
  return { catalog: c, item: it };
}
export function applyReanalysis(cat, id, analysis, now) {
  const c = clone(cat), it = getItem(c, id);
  if (it.category.source === 'user') fail('user_category', 'Type was set by you; not replaced.');
  const cg = categoryFromAnalysis(analysis);
  const { suggestedName, ...rest } = cg;
  it.category = rest;
  if (it.nameSource === 'default') { it.name = str(suggestedName || (cg.value ? CATEGORY_LABELS[cg.value] : 'New item'), TEXT_LIMITS.name); it.nameSource = suggestedName ? 'ai_suggested' : 'default'; }
  it.updatedAt = now; validateItem(it); bump(c, now);
  return { catalog: c, item: it };
}
export function setStatus(cat, id, status, now) {
  if (!STATUSES.includes(status)) fail('bad_item', 'Status must be owned or considering.');
  const c = clone(cat), it = getItem(c, id);
  if (it.status === status) return { catalog: cat, item: getItem(cat, id), changed: false };
  it.status = status; it.updatedAt = now; bump(c, now);
  return { catalog: c, item: it, changed: true };
}
export function setView(cat, id, view, files, cutoutInfo, now) {
  const c = clone(cat), it = getItem(c, id);
  if (files) Object.assign(it.files, clone(files));
  it.view = view; if (cutoutInfo !== undefined) it.cutoutInfo = cutoutInfo;
  it.updatedAt = now; validateItem(it); bump(c, now);
  return { catalog: c, item: it };
}
export function markRemoved(cat, id, now) {
  const c = clone(cat), it = getItem(c, id);
  if (it.removed) return { catalog: cat, item: getItem(cat, id), changed: false };
  it.removed = true; it.removedAt = now; it.updatedAt = now; bump(c, now);
  return { catalog: c, item: it, changed: true };
}
export function restoreItem(cat, id, now) {
  const c = clone(cat), it = getItem(c, id);
  if (!it.removed) return { catalog: cat, item: getItem(cat, id), changed: false };
  if (c.items.some((x) => !x.removed && x.id !== id && x.files.original.sha256 === it.files.original.sha256)) fail('duplicate', 'The same photo is already in your closet.');
  it.removed = false; delete it.removedAt; it.updatedAt = now; bump(c, now);
  return { catalog: c, item: it, changed: true };
}

// ---- outfits ---------------------------------------------------------------------------------------------
export function upsertOutfit(cat, o, now) {
  const c = clone(cat);
  const out = { id: o.id, name: str(o.name, TEXT_LIMITS.outfitName) || 'Untitled outfit', occasion: str(o.occasion, TEXT_LIMITS.occasion), removed: false,
    pieces: (o.pieces || []).map((p) => ({ itemId: p.itemId, x: +(+p.x).toFixed(4), y: +(+p.y).toFixed(4), w: +(+p.w).toFixed(4), rot: +(+p.rot).toFixed(2), z: Math.round(p.z) })) };
  validateOutfit(out, new Set(c.items.map((x) => x.id)));
  const i = c.outfits.findIndex((x) => x.id === o.id);
  if (i >= 0) { const prev = c.outfits[i]; out.createdAt = prev.createdAt; out.updatedAt = now; c.outfits[i] = out; }
  else { out.createdAt = now; out.updatedAt = now; c.outfits.push(out); }
  bump(c, now);
  return { catalog: c, outfit: out, created: i < 0 };
}
export function removeOutfit(cat, id, now) {
  const c = clone(cat), o = c.outfits.find((x) => x.id === id) || fail('not_found', 'Outfit not found.');
  o.removed = true; o.updatedAt = now; bump(c, now);
  return { catalog: c };
}

// ---- queries ---------------------------------------------------------------------------------------------
export function liveItems(c) { return c.items.filter((x) => !x.removed); }
export function findLiveBySha(c, sha) { return c.items.find((x) => !x.removed && x.files.original.sha256 === sha) || null; }
export function counts(c, status) {
  const list = liveItems(c).filter((x) => status === 'all' || x.status === status);
  const by = { all: list.length, check: list.filter((x) => x.category.value === null).length };
  for (const k of CATEGORIES) by[k] = list.filter((x) => x.category.value === k).length;
  return by;
}
export function query(c, { status = 'all', category = 'all', text = '' } = {}) {
  const t = text.trim().toLowerCase();
  return liveItems(c)
    .filter((x) => status === 'all' || x.status === status)
    .filter((x) => category === 'all' || (category === 'check' ? x.category.value === null : x.category.value === category))
    .filter((x) => !t || [x.name, x.notes, x.brand, x.size, x.fabric, x.category.value ? CATEGORY_LABELS[x.category.value] : ''].join(' ').toLowerCase().includes(t))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
export function outfitSummary(c, o) {
  const items = o.pieces.map((p) => c.items.find((x) => x.id === p.itemId)).filter((x) => x && !x.removed);
  return { pieces: items.length, notOwned: items.filter((x) => x.status === 'considering').length };
}
