// Loads the pinned onnxruntime-web WASM runtime (MIT) from jsDelivr. Every file is SHA-256 checked before use and the
// runtime JS is imported from a verified Blob. Single-threaded (no SharedArrayBuffer / cross-origin isolation needed).
// Shared by the clothing-type recognizer and the background remover so the runtime is downloaded once.
export const ORT_VERSION = '1.22.0-dev.20250409-89f8206ba4';
export const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/';
const ORT_FILES = {
  'ort.wasm.min.mjs': { sha256: '0cb5ac5be2c414d5b9e361f857108630c6d6e24a5ab9be3cf5f761de55289e94', bytes: 48008 },
  'ort-wasm-simd-threaded.mjs': { sha256: '43c25054b6b9ac000f786c65545ff83a45f871e0e310e8c2f4d48a363bb66db4', bytes: 20856 },
  'ort-wasm-simd-threaded.wasm': { sha256: 'f061472c6e77d6d50d079aacdc0ff9b63fee287ddd2cbf46cf62438d3891de2b', bytes: 11133407 },
};
const CACHE = 'closet-models-v1';
async function sha256Hex(buf) { const d = await crypto.subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join(''); }
async function cacheOpen() { try { return 'caches' in self ? await caches.open(CACHE) : null; } catch (e) { return null; } }
// Public model/runtime files only (never user photos) go in this Cache API cache.
export async function getVerified(url, sha256, bytes, label, onProgress) {
  const cache = await cacheOpen();
  if (cache) { try { const hit = await cache.match(url); if (hit) { const b = await hit.arrayBuffer(); if (b.byteLength === bytes && (await sha256Hex(b)) === sha256) return b; await cache.delete(url); } } catch (e) {} }
  const res = await fetch(url, { method: 'GET', credentials: 'omit', mode: 'cors', cache: 'no-store', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(label + ' download failed (HTTP ' + res.status + ').');
  let buf;
  if (res.body && res.body.getReader && onProgress) {
    const r = res.body.getReader(), parts = []; let got = 0;
    for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); got += value.length; onProgress(got, bytes); }
    const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } buf = out.buffer;
  } else buf = await res.arrayBuffer();
  if (buf.byteLength !== bytes || (await sha256Hex(buf)) !== sha256) throw new Error(label + ' failed its integrity check and was not used.');
  if (cache) { try { await cache.put(url, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) {} }
  return buf;
}
let ortPromise = null;
export function loadOrt(onProgress) {
  if (ortPromise) return ortPromise;
  ortPromise = (async () => {
    const f = ORT_FILES;
    const [mainJs, glueJs, wasm] = await Promise.all([
      getVerified(ORT_BASE + 'ort.wasm.min.mjs', f['ort.wasm.min.mjs'].sha256, f['ort.wasm.min.mjs'].bytes, 'Runtime'),
      getVerified(ORT_BASE + 'ort-wasm-simd-threaded.mjs', f['ort-wasm-simd-threaded.mjs'].sha256, f['ort-wasm-simd-threaded.mjs'].bytes, 'Runtime glue'),
      getVerified(ORT_BASE + 'ort-wasm-simd-threaded.wasm', f['ort-wasm-simd-threaded.wasm'].sha256, f['ort-wasm-simd-threaded.wasm'].bytes, 'Runtime engine', onProgress)]);
    const blobUrl = (buf, type) => URL.createObjectURL(new Blob([buf], { type }));
    const ort = await import(blobUrl(mainJs, 'text/javascript'));
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
    // The glue resolves URLs relative to import.meta.url (invalid for blob: modules): after its hash is verified,
    // substitute the pinned source URL (string replacement only). The engine bytes come from the verified wasmBinary.
    const glueSrc = new TextDecoder().decode(glueJs).split('import.meta.url').join(JSON.stringify(ORT_BASE + 'ort-wasm-simd-threaded.mjs'));
    ort.env.wasm.wasmBinary = wasm; ort.env.wasm.wasmPaths = { mjs: blobUrl(glueSrc, 'text/javascript') };
    return ort;
  })();
  ortPromise.catch(() => { ortPromise = null; });
  return ortPromise;
}
export async function cachedModelBytes() {
  const c = await cacheOpen(); if (!c) return null; let n = 0;
  for (const k of await c.keys()) { const r = await c.match(k); const l = r && r.headers.get('content-length'); n += l ? Number(l) : (await r.clone().arrayBuffer()).byteLength; }
  return n;
}
