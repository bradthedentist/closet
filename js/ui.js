// Small UI helpers: escaping, icons (from the approved mockup), toasts, sheets.
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const ICON = {
  closet: '<svg viewBox="0 0 24 24"><path d="M12 4a2 2 0 0 1 1 3.7c-.6.4-1 .8-1 1.3v.6L21 15a1.5 1.5 0 0 1-.8 2.8H3.8A1.5 1.5 0 0 1 3 15l9-5.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  outfits: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="13.5" y="3.5" width="7" height="5" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="13.5" y="11.5" width="7" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="3.5" y="15.5" width="7" height="5" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
  plusDark: '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="#5E554C" stroke-width="2" stroke-linecap="round"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="#1E1A16" stroke-width="1.8"/><path d="M16 16l4 4" stroke="#1E1A16" stroke-width="1.8" stroke-linecap="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.5" fill="none" stroke="#1E1A16" stroke-width="1.8"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" fill="none" stroke="#1E1A16" stroke-width="1.8" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="#1E1A16" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" fill="#1E1A16"/><circle cx="12" cy="12" r="1.8" fill="#1E1A16"/><circle cx="19" cy="12" r="1.8" fill="#1E1A16"/></svg>',
  spark: '<svg class="spark" viewBox="0 0 24 24" fill="#7E8C74"><path d="M12 2l2.2 6.3L20 10l-5.8 1.7L12 18l-2.2-6.3L4 10l5.8-1.7z"/></svg>',
  pen: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z" fill="none" stroke="#5E554C" stroke-width="2" stroke-linejoin="round"/></svg>',
  penTitle: '<svg width="16" height="16" viewBox="0 0 24 24" style="vertical-align:middle"><path d="M4 20h4L19 9l-4-4L4 16z" fill="none" stroke="#9A9086" stroke-width="2" stroke-linejoin="round"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  undo: '<svg width="16" height="16" viewBox="0 0 24 24"><path d="M9 14l-5-5 5-5M4 9h10a6 6 0 0 1 0 12h-3" fill="none" stroke="#1E1A16" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  front: '<svg width="16" height="16" viewBox="0 0 24 24"><rect x="4" y="9" width="11" height="11" rx="2" fill="none" stroke="#1E1A16" stroke-width="1.8"/><path d="M9 9V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3" fill="none" stroke="#1E1A16" stroke-width="1.8"/></svg>',
  trash: '<svg width="16" height="16" viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" fill="none" stroke="#1E1A16" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
let toastTimer = null;
export function toast(msg, ms = 3200) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
// Bottom sheet. Returns {el, close}. onClose runs when dismissed by tapping the scrim.
export function sheet(html, { onClose, dismissable = true } = {}) {
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  scrim.innerHTML = '<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>' + html + '</div>';
  document.body.appendChild(scrim);
  const close = () => { scrim.remove(); };
  scrim.addEventListener('click', (e) => { if (e.target === scrim && dismissable && scrim.dataset.busy !== '1') { close(); onClose && onClose(); } });
  return { el: scrim.querySelector('.sheet'), scrim, close };
}
export const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(iso).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }); } catch (e) { return ''; } };
export const fmtMB = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
