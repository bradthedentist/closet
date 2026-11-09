# Closet

Romy's private closet app: a static PWA (GitHub Pages) that stores everything in her own Google Drive.

- **Private storage**: Google Drive REST v3 from the browser, OAuth scope `drive.file` only (the app sees only files it
  created). Folder `Closet (app)` with `Originals` (unchanged bytes), `Cutouts`, `Thumbs`, `Display copies`, `Removed`,
  plus `closet-catalog.json`. `?test=1` uses a separate `Closet (app) TEST` folder; `?local=1` is a device-only demo
  with an in-memory Drive (nothing saved).
- **On-device AI**: clothing type with Marqo-FashionSigLIP + a provisional 0.020 margin policy (uncertain → "Check
  type", never a guess); background removal with IS-Net (fp16-stored, self-hosted) or U²-Net-p fallback. Photos never
  go to any third-party service.
- **Never deletes**: removing an item marks it removed and moves its files to `Removed`.
- No analytics, no third-party hosts beyond Google APIs, jsDelivr (pinned ONNX Runtime) and Hugging Face (pinned model).

This repository is public and contains **code only** — no photos, no wardrobe data, no secrets. The OAuth client ID in
`config.js` is a public browser client identifier (no secret).

Tests: `npm test` (Node, mock Drive). See `models/MODELS.json` and `NOTICE.txt` for model provenance and licenses.
