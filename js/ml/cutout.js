// On-device background removal. Primary: IS-Net "isnet-general-use" (DIS, Apache-2.0), converted for this app to
// fp16-stored weights (fp32 compute) with dynamic input size; self-hosted in /models (SHA-256 pinned). Fallback when
// IS-Net cannot load on the device: U^2-Net-p (Apache-2.0, 4.6 MB). The mask becomes the cutout's alpha channel;
// the photo itself is never altered and the original stays untouched in Drive.
import { loadOrt, getVerified } from './ort.js';
import { decode, dims, toBlob } from './photo-prep.js';
const here = (p) => new URL('../../models/' + p, import.meta.url).href;
export const MODELS = Object.freeze({
  isnet: { name: 'isnet-general-use-f16w', url: here('isnet-general-use-f16w-dyn.onnx'), sha256: 'db502c3283b58ff1a457a133644818cfdedc3c75660cb102b4c0ac3ed3812ea1', bytes: 90297764, mean: [0.5, 0.5, 0.5], std: [1, 1, 1], input: 'input_image' },
  u2netp: { name: 'u2netp', url: here('u2netp.onnx'), sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8', bytes: 4574861, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], input: 'input.1', size: 320 },
});
export const WORK_EDGE = 1280, THUMB_EDGE = 480;
let ort = null, session = null, active = null, loading = null;
export function defaultSize() { const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); return ios ? 640 : 1024; }
export async function load(onProgress) {
  if (session) return active; if (loading) return loading;
  loading = (async () => {
    ort = await loadOrt();
    for (const key of ['isnet', 'u2netp']) {
      const m = MODELS[key];
      try {
        const buf = await getVerified(m.url, m.sha256, m.bytes, 'Cutout model', key === 'isnet' ? onProgress : null);
        session = await ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
        active = key; return key;
      } catch (e) { session = null; if (key === 'u2netp') throw e; }
    }
  })();
  try { return await loading; } finally { loading = null; }
}
export async function release() { if (session) { try { await session.release(); } catch (e) {} session = null; active = null; } }
export const activeModel = () => active;

async function runMask(src, size) {
  const m = MODELS[active], S = active === 'u2netp' ? m.size : size;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, S, S);
  const d = g.getImageData(0, 0, S, S).data, P = S * S, x = new Float32Array(3 * P);
  for (let i = 0; i < P; i++) for (let k = 0; k < 3; k++) x[k * P + i] = (d[i * 4 + k] / 255 - m.mean[k]) / m.std[k];
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, S, S]) });
  const t = out[session.outputNames[0]], v = t.data;
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < P; i++) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
  const span = hi - lo || 1, img = g.createImageData(S, S);
  for (let i = 0; i < P; i++) { const a = Math.round(((v[i] - lo) / span) * 255); img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = a; }
  for (const k of Object.keys(out)) if (out[k].dispose) out[k].dispose();
  g.putImageData(img, 0, 0); return { canvas: c, S };
}
function workSize(w, h) { const s = Math.min(1, WORK_EDGE / Math.max(w, h)); return { W: Math.max(1, Math.round(w * s)), H: Math.max(1, Math.round(h * s)) }; }
// Mask canvas (white, alpha = garment) -> cropped cutout PNG + thumb PNG. Used by the add flow and by touch-up.
export async function composeFromMask(src, mask) {
  const W = mask.width, H = mask.height;
  const md = mask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1, on = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (md[(y * W + x) * 4 + 3] > 24) { on++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const coverage = on / (W * H);
  if (x1 < 0 || coverage < 0.004) { const e = new Error('No garment was found in the photo.'); e.code = 'empty_mask'; throw e; }
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const comp = document.createElement('canvas'); comp.width = W; comp.height = H;
  const cg = comp.getContext('2d'); cg.imageSmoothingQuality = 'high'; cg.drawImage(src, 0, 0, W, H); cg.globalCompositeOperation = 'destination-in'; cg.drawImage(mask, 0, 0);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const crop = document.createElement('canvas'); crop.width = cw; crop.height = ch; crop.getContext('2d').drawImage(comp, x0, y0, cw, ch, 0, 0, cw, ch);
  const ts = Math.min(1, THUMB_EDGE / Math.max(cw, ch));
  const th = document.createElement('canvas'); th.width = Math.max(1, Math.round(cw * ts)); th.height = Math.max(1, Math.round(ch * ts));
  const tg = th.getContext('2d'); tg.imageSmoothingQuality = 'high'; tg.drawImage(crop, 0, 0, th.width, th.height);
  const [cutoutBlob, thumbBlob, maskBlob] = await Promise.all([toBlob(crop, 'image/png'), toBlob(th, 'image/png'), toBlob(mask, 'image/png')]);
  comp.width = comp.height = crop.width = crop.height = th.width = th.height = 0;
  return { cutoutBlob, thumbBlob, maskBlob, bbox: [x0, y0, cw, ch], coverage: Math.round(coverage * 1e4) / 1e4, workW: W, workH: H };
}
export async function cutout(displayBlob, { size } = {}) {
  await load();
  const t0 = performance.now(), S = size || defaultSize();
  const src = await decode(displayBlob);
  try {
    const { w, h } = dims(src), { W, H } = workSize(w, h);
    const { canvas: small } = await runMask(src, S);
    const mask = document.createElement('canvas'); mask.width = W; mask.height = H;
    const mg = mask.getContext('2d', { willReadFrequently: true }); mg.imageSmoothingEnabled = true; mg.imageSmoothingQuality = 'high'; mg.drawImage(small, 0, 0, W, H);
    small.width = small.height = 0;
    const r = await composeFromMask(src, mask); mask.width = mask.height = 0;
    return { cutoutBlob: r.cutoutBlob, thumbBlob: r.thumbBlob, maskBlob: r.maskBlob,
      info: { model: MODELS[active].name, inputSize: active === 'u2netp' ? MODELS.u2netp.size : S, ms: Math.round(performance.now() - t0), bbox: r.bbox, coverage: r.coverage, workW: W, workH: H, touchedUp: false } };
  } finally { if (src.close) src.close(); }
}
