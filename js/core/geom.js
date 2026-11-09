// Pure outfit-board geometry (normalized board coordinates: x,y = piece centre as a fraction of board width/height,
// w = piece width as a fraction of board width, rot in degrees). Shared by the board UI and the Node tests.
export const LIMITS = { wMin: 0.08, wMax: 1.4, xyMin: -0.2, xyMax: 1.2 };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const normRot = (r) => { r = ((r + 180) % 360 + 360) % 360 - 180; return Math.round(r * 100) / 100; };
export function fix(p) { return { ...p, x: clamp(p.x, LIMITS.xyMin, LIMITS.xyMax), y: clamp(p.y, LIMITS.xyMin, LIMITS.xyMax), w: clamp(p.w, LIMITS.wMin, LIMITS.wMax), rot: normRot(p.rot) }; }
export function drag(p0, dx, dy, W, H) { return fix({ ...p0, x: p0.x + dx / W, y: p0.y + dy / H }); }
// Two-finger pinch: a0,b0 = start points, a1,b1 = current points (board pixels).
export function pinch(p0, a0, b0, a1, b1, W, H) {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1, d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y) || 1;
  const ang0 = Math.atan2(b0.y - a0.y, b0.x - a0.x), ang1 = Math.atan2(b1.y - a1.y, b1.x - a1.x);
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 }, m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  return fix({ ...p0, w: p0.w * (d1 / d0), rot: p0.rot + ((ang1 - ang0) * 180) / Math.PI, x: p0.x + (m1.x - m0.x) / W, y: p0.y + (m1.y - m0.y) / H });
}
// Corner handle: centre c (board px), v0 = handle start vector from centre, v1 = current vector.
export function handle(p0, c, s0, s1) {
  const v0 = { x: s0.x - c.x, y: s0.y - c.y }, v1 = { x: s1.x - c.x, y: s1.y - c.y };
  const l0 = Math.hypot(v0.x, v0.y) || 1, l1 = Math.hypot(v1.x, v1.y);
  return fix({ ...p0, w: p0.w * (l1 / l0), rot: p0.rot + ((Math.atan2(v1.y, v1.x) - Math.atan2(v0.y, v0.x)) * 180) / Math.PI });
}
const SLOTS = { tops: [0.3, 0.27, 0.42], outerwear: [0.66, 0.25, 0.48], dresses: [0.4, 0.45, 0.42], bottoms: [0.4, 0.62, 0.38], shoes: [0.72, 0.8, 0.3], bags: [0.18, 0.72, 0.26], accessories: [0.72, 0.52, 0.24] };
export function place(category, existing, aspect) {
  const s = SLOTS[category] || [0.5, 0.5, 0.36];
  const n = existing.filter((p) => Math.abs(p.x - s[0]) < 0.08 && Math.abs(p.y - s[1]) < 0.08).length;
  const z = existing.reduce((m, p) => Math.max(m, p.z), 0) + 1;
  let w = s[2]; if (aspect && aspect > 1.6) w = Math.min(w, s[2] * 0.8);
  return fix({ x: s[0] + n * 0.05, y: s[1] + n * 0.05, w, rot: Math.round((Math.random() * 8 - 4) * 10) / 10, z });
}
export function toFront(pieces, itemId) { const z = pieces.reduce((m, p) => Math.max(m, p.z), 0) + 1; return pieces.map((p) => (p.itemId === itemId ? { ...p, z } : p)); }
