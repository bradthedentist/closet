// Catalog persistence: one JSON file in the app's Drive folder is authoritative; a copy is cached on the device.
// Writes are optimistic: before each write the Drive file's `version` is compared with the version we last read.
// If something else changed it (another device/tab), the remote catalog is re-read and the SAME pure operation is
// re-applied to it, so no edit is silently lost and no item is duplicated (request-ID ledger).
import { emptyCatalog, validateCatalog, CatalogError } from './catalog.js';
export const CATALOG_NAME = 'closet-catalog.json';

export function createStore({ drive, layout, mode, cache, now = () => new Date().toISOString() }) {
  let catalog = null, fileId = null, version = null, listeners = new Set(), chain = Promise.resolve();
  const emit = () => listeners.forEach((f) => { try { f(catalog); } catch (e) {} });
  async function readRemote() {
    const found = (await drive.findByProps({ closetApp: 'catalog-v1', closetMode: mode }, layout.rootId)).sort((a, b) => (a.modifiedTime < b.modifiedTime ? -1 : 1));
    if (!found.length) return null;
    const f = found[0];
    const blob = await drive.download(f.id);
    const json = JSON.parse(await blob.text());
    validateCatalog(json);
    if (json.mode !== mode) throw new CatalogError('bad_catalog', 'Catalog belongs to a different mode.');
    return { file: f, json };
  }
  async function load() {
    const cached = cache && (await cache.get('catalog:' + mode));
    if (cached && !catalog) { try { validateCatalog(cached.json); catalog = cached.json; emit(); } catch (e) {} }
    const r = await readRemote();
    if (r) { fileId = r.file.id; version = r.file.version; catalog = r.json; }
    else {
      const c = emptyCatalog(mode, now());
      const f = await drive.createSmall({ name: CATALOG_NAME, mimeType: 'application/json', parents: [layout.rootId], appProperties: { closetApp: 'catalog-v1', closetMode: mode } }, new Blob([JSON.stringify(c)], { type: 'application/json' }));
      fileId = f.id; version = f.version; catalog = c;
    }
    cache && (await cache.set('catalog:' + mode, { json: catalog, version }));
    emit(); return catalog;
  }
  // op: (catalog) => {catalog, ...result}. Serialized; retried on remote change.
  function apply(op) {
    const run = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const meta = await drive.getMeta(fileId, 'id,version');
        if (String(meta.version) !== String(version)) {
          const r = await readRemote();
          if (!r) throw new CatalogError('catalog_missing', 'The closet catalog file is missing from Drive.');
          fileId = r.file.id; version = r.file.version; catalog = r.json;
        }
        const res = op(catalog);
        if (res.catalog === catalog) return res; // no change (e.g. duplicate)
        validateCatalog(res.catalog);
        const f = await drive.updateJson(fileId, res.catalog);
        version = f.version; catalog = res.catalog;
        cache && (await cache.set('catalog:' + mode, { json: catalog, version }));
        emit(); return res;
      }
      throw new CatalogError('busy', 'The closet was changed somewhere else several times; try again.');
    };
    const p = chain.then(run, run); chain = p.catch(() => {}); return p;
  }
  return { load, apply, get: () => catalog, onChange: (f) => (listeners.add(f), () => listeners.delete(f)), get fileId() { return fileId; } };
}
