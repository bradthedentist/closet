// Add-photos pipeline (client). Pure orchestration with injected dependencies so the SAME code runs in the app and in
// the Node tests against a mock Drive.
//   Phase A (per photo): hash ORIGINAL bytes -> skip if already in closet -> downsized display JPEG on device ->
//                        on-device clothing type (Marqo fashionSigLIP + provisional 0.020 policy).
//   (recognizer released to free memory before the cutout model loads - iPhone memory)
//   Phase B (per photo): background removal on device -> upload ORIGINAL unchanged (resumable, verified by size +
//                        Drive sha256/md5) -> display copy, cutout, mask, thumb -> one catalog commit.
// Idempotence: a request ID is kept per (photo SHA-256, destination) until Drive + catalog confirm. Every Drive file
// carries appProperties {closetRequestId, closetRole}; a retry finds and reuses what already exists, and the catalog
// ledger maps request ID -> item, so a retry never makes a second item or a second original.
import { findLiveBySha, addItem, CatalogError } from './catalog.js';
import { AuthError, DriveError } from './drive.js';
export const ORIGINAL_MAX = 100 * 1024 * 1024;
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const baseName = (n) => String(n || 'photo').replace(/\.[^.]{1,6}$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'photo';

// Find-or-replace a derived file (display/cutout/mask/thumb) for one request + role: never a second file.
export async function putDerivedFile(drive, appProperties, folder, name, blob) {
  const existing = await drive.findByProps(appProperties, folder);
  let f = existing[0];
  if (f && Number(f.size) === blob.size) return { id: f.id, size: blob.size, mimeType: blob.type };
  if (f) f = await drive.updateMedia(f.id, blob, blob.type);
  else f = await drive.createSmall({ name, mimeType: blob.type, parents: [folder], appProperties }, blob);
  return { id: f.id, size: blob.size, mimeType: blob.type };
}
export const fileProps = (mode, requestId, role) => ({ closetApp: 'file-v1', closetMode: mode, closetRequestId: requestId, closetRole: role });
export const ROLE_FOLDER = { original: 'originals', display: 'display', cutout: 'cutouts', mask: 'cutouts', thumb: 'thumbs' };

export function createImportQueue(d) {
  const { drive, layout, store, pending, mode } = d;
  const pkey = (sha, status) => mode + ':' + sha + ':' + status;
  const props = (job, role) => fileProps(mode, job.requestId, role);

  async function verifyOriginal(job, file) {
    for (let i = 0; i < 4; i++) {
      const m = await drive.getMeta(file.id);
      if (Number(m.size) !== job.file.size) return { ok: false, why: 'size ' + m.size + ' != ' + job.file.size };
      if (m.sha256Checksum) return m.sha256Checksum.toLowerCase() === job.sha256 ? { ok: true, by: 'sha256', meta: m } : { ok: false, why: 'sha256 mismatch' };
      if (m.md5Checksum) { const md5 = job.md5 || (job.md5 = await d.md5(job.file)); return m.md5Checksum.toLowerCase() === md5 ? { ok: true, by: 'md5', meta: m, md5 } : { ok: false, why: 'md5 mismatch' }; }
      await d.sleep(800 * (i + 1)); // checksums can appear a moment after upload
    }
    const m = await drive.getMeta(file.id);
    return { ok: true, by: 'size_only', meta: m };
  }
  async function quarantine(fileId, parent) { try { await drive.move(fileId, layout.removed, parent); } catch (e) {} }

  async function putOriginal(job) {
    const existing = (await drive.findByProps(props(job, 'original'), layout.originals));
    let file = existing.find((f) => Number(f.size) === job.file.size) || null;
    for (const f of existing) if (f !== file) await quarantine(f.id, layout.originals);
    if (!file) {
      const meta = { name: job.file.name || baseName(job.file.name), mimeType: job.file.type || 'application/octet-stream', parents: [layout.originals], appProperties: { ...props(job, 'original'), closetSha256: job.sha256 } };
      file = await drive.resumable({ meta, blob: job.file, session: job.pend.session,
        saveSession: async (s) => { job.pend.session = s; await pending.set(job.pend.key, job.pend); },
        onProgress: (o, t) => d.onStatus(job.index, 'Saving original ' + Math.floor((o * 100) / t) + '% of ' + mb(t)) });
    }
    const v = await verifyOriginal(job, file);
    if (!v.ok) {
      await quarantine(file.id, layout.originals);
      job.pend.session = null; await pending.set(job.pend.key, job.pend);
      throw new DriveError('The saved original did not match the photo (' + v.why + '); it was moved to Removed. Try adding it again.', 0, 'verify');
    }
    job.pend.session = null;
    return { id: file.id, name: v.meta.name || file.name, size: job.file.size, mimeType: v.meta.mimeType || job.file.type || '', sha256: job.sha256, md5: v.md5 || (v.meta.md5Checksum || null), verifiedBy: v.by };
  }
  const putDerived = (job, role, folder, name, blob) => putDerivedFile(drive, props(job, role), folder, name, blob);

  async function run(files, status, { signal } = {}) {
    const results = [];
    const jobs = [];
    const cat0 = store.get();
    // ---- Phase A ----
    for (let i = 0; i < files.length; i++) {
      const file = files[i], r = { name: file.name, index: i };
      results.push(r);
      if (signal && signal.aborted) { r.outcome = 'skipped'; r.message = 'Stopped'; continue; }
      if (!file.size) { r.outcome = 'skipped'; r.message = 'Empty file (0 bytes)'; continue; }
      if (file.size > ORIGINAL_MAX) { r.outcome = 'skipped'; r.message = 'Over the ' + mb(ORIGINAL_MAX) + ' limit (' + mb(file.size) + ')'; continue; }
      d.onStatus(i, 'Reading photo…');
      const sha256 = await d.sha256(file);
      const already = findLiveBySha(store.get() || cat0, sha256) || jobs.find((j) => j.sha256 === sha256);
      if (already) { r.outcome = 'duplicate'; r.message = 'Already in your closet'; r.itemId = already.id || null; continue; }
      const key = pkey(sha256, status);
      let pend = await pending.get(key);
      if (!pend) { pend = { key, requestId: d.uuid(), itemId: d.uuid(), sha256, size: file.size, name: file.name, status, since: d.now(), session: null }; await pending.set(key, pend); }
      d.onStatus(i, 'Preparing photo…');
      let prep; try { prep = await d.prepare(file); } catch (e) { prep = { ok: false }; }
      let analysis = null, unavailable = null;
      if (prep && prep.ok) {
        d.onStatus(i, 'Recognizing type…');
        try { analysis = await d.classify(prep.blob); } catch (e) { unavailable = 'recognizer unavailable: ' + String(e && e.message || e).slice(0, 120); }
      } else analysis = { status: 'needs_review', category: null, reason: 'could_not_decode', margin: null, ranking: [] };
      jobs.push({ index: i, file, sha256, requestId: pend.requestId, itemId: pend.itemId, pend, prep, analysis, unavailable, status, r });
    }
    if (d.releaseClassifier) await d.releaseClassifier();
    // ---- Phase B ----
    for (const job of jobs) {
      const r = job.r;
      if (signal && signal.aborted) { r.outcome = 'skipped'; r.message = 'Stopped before saving (nothing saved)'; continue; }
      try {
        let cut = null, cutErr = null;
        if (job.prep && job.prep.ok) {
          d.onStatus(job.index, 'Removing background…');
          try { cut = await d.cutout(job.prep.blob); } catch (e) { cutErr = String(e && e.message || e).slice(0, 160); }
        }
        d.onStatus(job.index, 'Saving original…');
        const original = await putOriginal(job);
        const files = { original };
        const nm = baseName(job.file.name);
        if (job.prep && job.prep.ok) {
          files.display = await putDerived(job, 'display', layout.display, nm + ' (downsized display copy).jpg', job.prep.blob);
          if (cut) {
            d.onStatus(job.index, 'Saving cutout…');
            files.cutout = await putDerived(job, 'cutout', layout.cutouts, nm + '.cutout.png', cut.cutoutBlob);
            files.mask = await putDerived(job, 'mask', layout.cutouts, nm + '.mask.png', cut.maskBlob);
            files.thumb = await putDerived(job, 'thumb', layout.thumbs, nm + '.thumb.png', cut.thumbBlob);
          } else {
            files.thumb = await putDerived(job, 'thumb', layout.thumbs, nm + '.thumb.jpg', await d.photoThumb(job.prep.blob));
          }
        }
        d.onStatus(job.index, 'Adding to closet…');
        const res = await store.apply((c) => addItem(c, { requestId: job.requestId, itemId: job.itemId, status: job.status, analysis: job.analysis, unavailableReason: job.unavailable,
          files, view: cut ? 'cutout' : 'original', cutoutInfo: cut ? cut.info : { failed: true, error: cutErr },
          source: { filename: job.file.name, width: job.prep && job.prep.sourceWidth || null, height: job.prep && job.prep.sourceHeight || null, mimeType: job.file.type } }, d.now()));
        await pending.delete(job.pend.key);
        r.itemId = res.item.id;
        if (res.duplicate) { r.outcome = 'duplicate'; r.message = res.reason === 'same_request' ? 'Already saved' : 'Already in your closet'; continue; }
        r.outcome = 'added'; r.review = res.item.category.value === null; r.unreadable = !(job.prep && job.prep.ok); r.cutoutFailed = !cut; r.cutoutError = cutErr;
        d.onItem && d.onItem(res.item);
      } catch (e) {
        if (e instanceof AuthError) { r.outcome = 'failed'; r.message = 'Google sign-in expired - sign in again, then re-add this photo (it will resume).'; for (const j of jobs) if (!j.r.outcome) { j.r.outcome = 'skipped'; j.r.message = 'Not saved yet - sign in and add again'; } return { results, stopped: 'auth' }; }
        r.outcome = 'failed'; r.message = String(e && e.message || e).slice(0, 220);
        if (e instanceof CatalogError && e.code === 'request_conflict') await pending.delete(job.pend.key);
      }
    }
    return { results, stopped: null };
  }
  return { run };
}
