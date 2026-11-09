// One-tap touch-up: erase / restore brush on the cutout mask. The photo pixels are never edited; only the mask
// (alpha) changes. The faint photo underneath shows what "Restore" can bring back.
import { decode } from './ml/photo-prep.js';
import { esc, ICON } from './ui.js';
export async function openTouchup({ displayBlob, maskBlob, title, onSave }) {
  const src = await decode(displayBlob), mimg = await decode(maskBlob);
  const W = mimg.width || mimg.naturalWidth, H = mimg.height || mimg.naturalHeight;
  const mask = document.createElement('canvas'); mask.width = W; mask.height = H; const mg = mask.getContext('2d', { willReadFrequently: true }); mg.drawImage(mimg, 0, 0);
  const auto = mg.getImageData(0, 0, W, H); if (mimg.close) mimg.close();
  const comp = document.createElement('canvas'); comp.width = W; comp.height = H; const cg = comp.getContext('2d');
  const root = document.createElement('div'); root.className = 'tu';
  root.innerHTML = '<div class="mtop"><button class="iconbtn" data-a="cancel" aria-label="Cancel">' + ICON.close + '</button><div style="font-weight:600">' + esc(title || 'Touch up') + '</div><button class="btn dark small" data-a="save">Save</button></div>' +
    '<div class="cv"><canvas></canvas></div>' +
    '<div class="tools"><button data-m="erase" class="on">Erase</button><button data-m="restore">Restore</button><input type="range" min="6" max="120" value="36" aria-label="Brush size"><button data-a="undo">Undo</button><button data-a="reset">Reset</button></div>';
  document.body.appendChild(root);
  const view = root.querySelector('canvas'); view.width = W; view.height = H; const vg = view.getContext('2d');
  let mode = 'erase', stack = [], drawing = null, raf = 0;
  const redraw = () => { raf = 0; cg.globalCompositeOperation = 'source-over'; cg.clearRect(0, 0, W, H); cg.drawImage(src, 0, 0, W, H); cg.globalCompositeOperation = 'destination-in'; cg.drawImage(mask, 0, 0);
    vg.clearRect(0, 0, W, H); vg.globalAlpha = mode === 'restore' ? 0.32 : 0.14; vg.drawImage(src, 0, 0, W, H); vg.globalAlpha = 1; vg.drawImage(comp, 0, 0); };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(redraw); };
  redraw();
  const brush = () => { const r = view.getBoundingClientRect(); return (Number(root.querySelector('input').value) * W) / Math.max(1, r.width); };
  const at = (e) => { const r = view.getBoundingClientRect(); return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height }; };
  function stroke(a, b) { mg.save(); mg.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over'; mg.strokeStyle = '#fff'; mg.fillStyle = '#fff'; mg.lineWidth = brush(); mg.lineCap = 'round'; mg.lineJoin = 'round';
    mg.beginPath(); mg.moveTo(a.x, a.y); mg.lineTo(b.x + 0.01, b.y); mg.stroke(); mg.restore(); schedule(); }
  view.addEventListener('pointerdown', (e) => { if (drawing) return; e.preventDefault(); view.setPointerCapture(e.pointerId); stack.push(mg.getImageData(0, 0, W, H)); if (stack.length > 6) stack.shift(); drawing = { id: e.pointerId, last: at(e) }; stroke(drawing.last, drawing.last); });
  view.addEventListener('pointermove', (e) => { if (!drawing || e.pointerId !== drawing.id) return; const p = at(e); stroke(drawing.last, p); drawing.last = p; });
  const up = (e) => { if (drawing && e.pointerId === drawing.id) drawing = null; };
  view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
  return await new Promise((resolve) => {
    const close = (v) => { root.remove(); if (src.close) src.close(); resolve(v); };
    root.addEventListener('click', async (e) => {
      const m = e.target.closest('[data-m]'), a = e.target.closest('[data-a]');
      if (m) { mode = m.dataset.m; root.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b === m)); schedule(); }
      if (!a) return;
      if (a.dataset.a === 'cancel') close(null);
      if (a.dataset.a === 'undo' && stack.length) { mg.putImageData(stack.pop(), 0, 0); schedule(); }
      if (a.dataset.a === 'reset') { stack.push(mg.getImageData(0, 0, W, H)); mg.putImageData(auto, 0, 0); schedule(); }
      if (a.dataset.a === 'save') { a.disabled = true; a.textContent = 'Saving…'; try { await onSave(mask, displayBlob); close(true); } catch (err) { a.disabled = false; a.textContent = 'Save'; alert('Not saved: ' + (err && err.message || err)); } }
    });
  });
}
