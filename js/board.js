// Outfit board: draggable / pinch-resizable / rotatable cutouts with Pointer Events (touch, pen, mouse).
// One finger drags; two fingers pinch to resize and twist to rotate; the corner handle resizes+rotates with one finger.
import * as G from './core/geom.js';
import { ICON, esc } from './ui.js';
export function createBoard(el, { itemFor, srcFor, onCommit, onSelect }) {
  let pieces = [], sel = null, history = [], gesture = null;
  const pointers = new Map();
  el.innerHTML = '<div class="boardtools"><button data-t="undo" aria-label="Undo">' + ICON.undo + '</button><button data-t="front" aria-label="Bring to front">' + ICON.front + '</button><button data-t="remove" aria-label="Remove from outfit">' + ICON.trash + '</button></div><div class="boardhint">Tap pieces below to add them. Drag to move, pinch or use the corner dot to resize and rotate.</div>';
  const tools = el.querySelector('.boardtools'), hint = el.querySelector('.boardhint');
  const size = () => { const r = el.getBoundingClientRect(); return { W: r.width, H: r.height, L: r.left, T: r.top }; };
  const pt = (e) => { const s = size(); return { x: e.clientX - s.L, y: e.clientY - s.T }; };
  const aspect = (it) => { const b = it && it.view === 'cutout' && it.cutoutInfo && it.cutoutInfo.bbox; if (b && b[2] > 0) return b[3] / b[2]; const s = it && it.source; return s && s.width ? s.height / s.width : 1.2; };
  function styleFor(node, p) {
    const { W, H } = size(), it = itemFor(p.itemId), wpx = p.w * W, hpx = wpx * aspect(it);
    node.style.width = wpx + 'px'; node.style.left = p.x * W - wpx / 2 + 'px'; node.style.top = p.y * H - hpx / 2 + 'px';
    node.style.transform = 'rotate(' + p.rot + 'deg)'; node.style.zIndex = String(10 + p.z);
  }
  function render() {
    el.querySelectorAll('.piece').forEach((n) => n.remove());
    for (const p of pieces) {
      const it = itemFor(p.itemId); if (!it) continue;
      const n = document.createElement('div'); n.className = 'piece' + (p.itemId === sel ? ' sel' : ''); n.dataset.id = p.itemId;
      n.innerHTML = '<img alt="' + esc(it.name) + '" class="' + (it.view === 'cutout' ? '' : 'photo') + '">' + (it.status === 'considering' ? '<span class="ptag">Not owned</span>' : '') + '<span class="h" data-h="1"></span>';
      srcFor(it, n.querySelector('img'));
      styleFor(n, p); el.appendChild(n);
    }
    hint.classList.toggle('hidden', pieces.length > 0);
    tools.querySelector('[data-t=undo]').disabled = !history.length;
    tools.querySelector('[data-t=front]').disabled = tools.querySelector('[data-t=remove]').disabled = !sel;
  }
  const commit = (next) => { history.push(pieces); if (history.length > 40) history.shift(); pieces = next; render(); onCommit && onCommit(pieces); };
  tools.addEventListener('pointerdown', (e) => e.stopPropagation());
  tools.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.t === 'undo' && history.length) { pieces = history.pop(); render(); onCommit && onCommit(pieces); }
    if (t.dataset.t === 'front' && sel) commit(G.toFront(pieces, sel));
    if (t.dataset.t === 'remove' && sel) { const id = sel; sel = null; commit(pieces.filter((p) => p.itemId !== id)); onSelect && onSelect(null); }
  });
  el.addEventListener('pointerdown', (e) => {
    const node = e.target.closest('.piece');
    pointers.set(e.pointerId, pt(e)); try { el.setPointerCapture(e.pointerId); } catch (x) {}
    if (pointers.size === 1) {
      if (!node) { if (sel) { sel = null; render(); onSelect && onSelect(null); } gesture = null; return; }
      const id = node.dataset.id; if (sel !== id) { sel = id; onSelect && onSelect(id); }
      const p0 = pieces.find((p) => p.itemId === id);
      if (e.target.dataset.h) { const { W, H } = size(); gesture = { mode: 'handle', id, p0, c: { x: p0.x * W, y: p0.y * H }, s0: pt(e) }; }
      else gesture = { mode: 'drag', id, p0, s0: pt(e) };
      el.querySelectorAll('.piece').forEach((n) => n.classList.toggle('sel', n.dataset.id === id));
    } else if (pointers.size === 2 && sel) {
      const [a, b] = [...pointers.values()];
      gesture = { mode: 'pinch', id: sel, p0: current(sel), a0: a, b0: b };
    }
    e.preventDefault();
  });
  let live = null;
  const current = (id) => (live && live.itemId === id ? live : pieces.find((p) => p.itemId === id));
  el.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, pt(e));
    const { W, H } = size(); let p = null;
    if (gesture.mode === 'drag') { const q = pointers.get(e.pointerId); p = G.drag(gesture.p0, q.x - gesture.s0.x, q.y - gesture.s0.y, W, H); }
    else if (gesture.mode === 'handle') p = G.handle(gesture.p0, gesture.c, gesture.s0, pointers.get(e.pointerId));
    else if (gesture.mode === 'pinch' && pointers.size >= 2) { const [a, b] = [...pointers.values()]; p = G.pinch(gesture.p0, gesture.a0, gesture.b0, a, b, W, H); }
    if (!p) return;
    live = p; const n = el.querySelector('.piece[data-id="' + CSS.escape(gesture.id) + '"]'); if (n) styleFor(n, p);
  });
  const end = (e) => {
    if (!pointers.has(e.pointerId)) return; pointers.delete(e.pointerId);
    if (pointers.size === 1 && gesture && gesture.mode === 'pinch') { const [q] = [...pointers.values()]; gesture = { mode: 'drag', id: gesture.id, p0: live || current(gesture.id), s0: q, keep: true }; return; }
    if (pointers.size === 0) {
      if (live && gesture) { const p = live; live = null; const moved = JSON.stringify(p) !== JSON.stringify(pieces.find((x) => x.itemId === p.itemId)); if (moved) commit(pieces.map((x) => (x.itemId === p.itemId ? p : x))); else render(); }
      else render();
      gesture = null;
    }
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  window.addEventListener('resize', () => render());
  return {
    set(next, { resetHistory = true } = {}) { pieces = next.map((p) => ({ ...p })); if (resetHistory) history = []; if (sel && !pieces.some((p) => p.itemId === sel)) sel = null; render(); },
    add(item) {
      if (pieces.some((p) => p.itemId === item.id)) { sel = item.id; commit(G.toFront(pieces, item.id)); return false; }
      const p = { itemId: item.id, ...G.place(item.category.value, pieces, aspect(item)) }; sel = item.id; commit([...pieces, p]); return true;
    },
    get: () => pieces.map((p) => ({ ...p })), select: (id) => { sel = id; render(); }, render,
  };
}
