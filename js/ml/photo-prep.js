// Photo preparation on the device. Decodes with the browser's own decoder (Safari/iOS decodes HEIC/HEIF natively; no
// third-party HEIC decoder is shipped), applies EXIF orientation, and makes a downsized JPEG (long edge <=2048 px,
// quality 0.85, stepped down to stay under ~2 MB). The JPEG is used for recognition, cutout and display; it never
// replaces the stored original. Same logic as closet-auto-classifier/browser/photo-prep.js.
export const MAX_EDGE = 2048, TARGET = 2 * 1024 * 1024, HARD = 3 * 1024 * 1024;
export async function decode(blob) {
  if (self.createImageBitmap) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) {}
    try { return await createImageBitmap(blob); } catch (e) {}
  }
  return await new Promise((resolve, reject) => {
    const u = URL.createObjectURL(blob), img = new Image(); img.decoding = 'async';
    img.onload = () => { URL.revokeObjectURL(u); if (!img.naturalWidth || !img.naturalHeight) reject(new Error('empty image')); else resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('cannot decode')); };
    img.src = u;
  });
}
export const dims = (src) => ({ w: src.naturalWidth || src.width, h: src.naturalHeight || src.height });
export const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob((b) => res(b), type, q));
export async function prepare(file) {
  let src; try { src = await decode(file); } catch (e) { return { ok: false, reason: 'cannot_decode' }; }
  try {
    const { w, h } = dims(src); if (!w || !h) return { ok: false, reason: 'cannot_decode' };
    let scale = Math.min(1, MAX_EDGE / Math.max(w, h)), q = 0.85, blob = null, cw = 0, ch = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      cw = Math.max(1, Math.round(w * scale)); ch = Math.max(1, Math.round(h * scale));
      const c = document.createElement('canvas'); c.width = cw; c.height = ch; const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, cw, ch);
      blob = await toBlob(c, 'image/jpeg', q); c.width = c.height = 0;
      if (!blob || !blob.size) return { ok: false, reason: 'cannot_encode' };
      if (blob.size <= TARGET) break;
      if (q > 0.66) q = Math.round((q - 0.1) * 100) / 100; else scale *= 0.8;
    }
    if (blob.size > HARD) return { ok: false, reason: 'cannot_encode' };
    return { ok: true, blob, width: cw, height: ch, sourceWidth: w, sourceHeight: h, quality: q };
  } finally { if (src && src.close) try { src.close(); } catch (e) {} }
}
// Thumbnail of the whole photo (used when the cutout is off or failed).
export async function photoThumb(blob, edge = 480) {
  const src = await decode(blob);
  try {
    const { w, h } = dims(src), s = Math.min(1, edge / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height);
    const b = await toBlob(c, 'image/jpeg', 0.85); c.width = c.height = 0; return b;
  } finally { if (src.close) src.close(); }
}
