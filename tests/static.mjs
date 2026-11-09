// Static checks on the shipped files: service-worker shell list complete, CSP present, scope is drive.file only,
// no sharing/permission calls, no photos or wardrobe data in the public repo, model files match their pinned SHA-256.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sw = rd('sw.js'); const shell = JSON.parse(sw.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
for (const f of shell) if (f !== './') assert.ok(fs.existsSync(path.join(root, f)), 'missing shell file ' + f);
const js = []; (function walk(d) { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) js.push(p); } })('js');
for (const f of js) if (!shell.includes(f.split(path.sep).join('/'))) throw new Error('not in SW shell: ' + f);
const idx = rd('index.html'); assert.match(idx, /Content-Security-Policy/); assert.match(idx, /apple-mobile-web-app-capable/); assert.match(idx, /viewport-fit=cover/);
const csp = idx.match(/Content-Security-Policy" content="([^"]+)"/)[1];
for (const host of csp.match(/https:\/\/[^ ;]+/g)) assert.ok(['https://cdn.jsdelivr.net', 'https://www.googleapis.com', 'https://oauth2.googleapis.com', 'https://huggingface.co', 'https://*.huggingface.co', 'https://*.hf.co'].includes(host), 'unexpected host in CSP ' + host);
const all = js.map((f) => [f, rd(f)]);
for (const [f, src] of all) {
  const scopes = src.match(/https:\/\/www\.googleapis\.com\/auth\/[a-z.]+/g) || [];
  if (f.endsWith('auth.js')) assert.ok(src.includes("SCOPE = 'https://www.googleapis.com/auth/drive.file'"));
  else assert.equal(scopes.length, 0, f + ' mentions an OAuth scope');
  if (!f.endsWith('mock-drive.js')) assert.ok(!/\/permissions/.test(src), f + ' calls permissions');
  assert.ok(!/method: 'DELETE'|"DELETE"/.test(src), f + ' uses DELETE');
  assert.ok(!/console\.(log|info|debug)\([^)]*token/i.test(src), f + ' logs a token');
}
const banned = []; (function walk(d) { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { if (e.name === '.git' || e.name === 'node_modules') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(jpe?g|heic|heif|webp|gif)$/i.test(p) || (/\.png$/i.test(p) && !p.startsWith('icons'))) banned.push(p); } })('.');
assert.deepEqual(banned, [], 'photo files in repo');
const models = JSON.parse(rd('models/MODELS.json'));
for (const m of models.selfHosted) { const b = fs.readFileSync(path.join(root, m.path)); assert.equal(b.length, m.bytes, m.path); assert.equal(crypto.createHash('sha256').update(b).digest('hex'), m.sha256, m.path); }
const cut = rd('js/ml/cutout.js'); for (const m of models.selfHosted.filter((x) => x.path.endsWith('.onnx'))) assert.ok(cut.includes(m.sha256), 'cutout.js pin ' + m.path);
assert.ok(rd('js/ml/classifier.js').includes(models.selfHosted.find((x) => x.path.endsWith('text-bank.f16.json')).sha256));
console.log('static checks ok (' + shell.length + ' shell files, ' + js.length + ' js files)');
