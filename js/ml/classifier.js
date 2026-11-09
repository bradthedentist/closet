// On-device clothing type: Marqo/marqo-fashionSigLIP vision graph (Apache-2.0) at a pinned Hugging Face revision,
// int8 ONNX, run with onnxruntime-web WASM. Scores 58 precomputed prompt embeddings (models/text-bank.f16.json) and
// applies the provisional policy in core/policy.js. Photo pixels never leave the device from this module.
import { loadOrt, getVerified } from './ort.js';
import { scoreImage, decide, expandCompactBank, POLICY_VERSION } from '../core/policy.js';
import { decode } from './photo-prep.js';
export const MODEL = Object.freeze({ id: 'Marqo/marqo-fashionSigLIP', revision: 'c56244cc94f92419e8369fa71efdaf403b124ce8', file: 'onnx/vision_model_quantized.onnx',
  sha256: 'f1009cfce0eedd409f601e8351eedab72e8529641105eee6517821a9a634a2f4', bytes: 93973443, license: 'Apache-2.0' });
export const MODEL_URL = 'https://huggingface.co/' + MODEL.id + '/resolve/' + MODEL.revision + '/' + MODEL.file;
const BANK = { url: new URL('../../models/text-bank.f16.json', import.meta.url).href, sha256: 'f0b4ad1695bf73658ed382023abdef68d52255a0f540151dfd8b5e5e7e7180e0', bytes: 122700 };
let session = null, ort = null, bank = null, loading = null;
export async function load(onProgress) {
  if (session) return; if (loading) return loading;
  loading = (async () => {
    ort = await loadOrt();
    const raw = await getVerified(BANK.url, BANK.sha256, BANK.bytes, 'Type list');
    const compact = JSON.parse(new TextDecoder().decode(raw));
    if (compact.revision !== MODEL.revision || compact.visionGraphSha256 !== MODEL.sha256) throw new Error('Type list does not match the recognizer model.');
    bank = expandCompactBank(compact, (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
    const buf = await getVerified(MODEL_URL, MODEL.sha256, MODEL.bytes, 'Clothing recognizer', onProgress);
    session = await ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  })();
  try { await loading; } finally { loading = null; }
}
// SiglipImageProcessor equivalent: RGB, direct resize to 224x224 (no crop), x/255, (x-0.5)/0.5, CHW float32.
function toTensor(src) {
  const S = 224, c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.fillStyle = '#fff'; g.fillRect(0, 0, S, S); g.drawImage(src, 0, 0, S, S);
  const d = g.getImageData(0, 0, S, S).data, out = new Float32Array(3 * S * S), P = S * S;
  for (let i = 0; i < P; i++) { out[i] = d[i * 4] / 127.5 - 1; out[P + i] = d[i * 4 + 1] / 127.5 - 1; out[2 * P + i] = d[i * 4 + 2] / 127.5 - 1; }
  c.width = c.height = 0; return out;
}
export async function analyze(blob) {
  await load();
  const t0 = performance.now(); let bmp;
  try { bmp = await decode(blob); } catch (e) { return { status: 'needs_review', category: null, reason: 'could_not_decode', margin: null, ranking: [], policyVersion: POLICY_VERSION, revision: MODEL.revision }; }
  const px = toTensor(bmp); if (bmp.close) bmp.close();
  const out = await session.run({ pixel_values: new ort.Tensor('float32', px, [1, 3, 224, 224]) });
  const emb = Array.from(out.image_embeds.data); if (out.image_embeds.dispose) out.image_embeds.dispose();
  const ranking = scoreImage(emb, bank), d = decide(ranking);
  return { status: d.status, category: d.category, reason: d.reason, margin: d.margin, ranking: ranking.slice(0, 4).map((r) => ({ category: r.category, score: r.score, prompt: r.bestPrompt })),
    modelId: MODEL.id, revision: MODEL.revision, policyVersion: POLICY_VERSION, analyzedAt: new Date().toISOString(), ms: Math.round(performance.now() - t0) };
}
export async function release() { if (session) { try { await session.release(); } catch (e) {} session = null; } }
export const isLoaded = () => !!session;
