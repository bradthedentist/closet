// OAuth redirect landing page: hand the fragment to the app via sessionStorage (same origin), then return to the app.
// Nothing is logged; the fragment is removed from the address bar immediately.
(function () {
  var h = location.hash || '';
  try { if (h) sessionStorage.setItem('closet.oauth.return', h); } catch (e) {}
  var back = './';
  try { var p = JSON.parse(sessionStorage.getItem('closet.oauth.pending') || 'null'); if (p && typeof p.returnTo === 'string' && /^\?[A-Za-z0-9=&_-]*$/.test(p.returnTo)) back = './' + p.returnTo; } catch (e) {}
  location.replace(back);
})();
