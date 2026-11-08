# Architecture decisions

## Phase 0

- Use npm workspaces for the TypeScript monorepo so local development and CI share one lockfile.
- Use Express 5, Zod, PostgreSQL/PostGIS, `node-pg-migrate`, BullMQ, and a small FastAPI service as the initial boundaries.
- Keep uploaded media out of the web root and access it only through the storage interface.
- Issue short-lived JWT access tokens and rotating refresh tokens. Store only SHA-256 hashes of refresh tokens; assign newly registered accounts the citizen role.
- Require secrets in `.env` rather than committing Compose defaults. The `.env.example` contains placeholders, not usable credentials.
- Build an initial relational schema for the full product domain so later phases can add behavior without repeatedly replacing the database foundation.
- Keep ML inference in explicitly identified stub mode until actual data and model evaluation exist. No synthetic scores or performance metrics are displayed.
- Seed only an administrator configured through environment variables; no default accounts or simulated observations are inserted.

## Phase 1

- Accept only recognized audio containers and parse their metadata server-side; reject unreadable clips and any clip longer than 10 seconds, regardless of browser-reported duration.
- Keep raw media in a private local-storage implementation mounted only into API/worker containers. Never serve raw audio from a public URL. Deleting a report removes its source file; `DELETE_AUDIO_AFTER_PROCESSING=true` enables automatic cleanup after classification.
- Publish only report summaries (coordinates rounded to four decimal places, labels, status, and estimate metadata) over the public map and Socket.IO; raw filenames, storage paths, and audio bytes never enter realtime events.
- Keep upload, queue, model service, and API boundaries separate. Workers publish progress/result events via Redis Pub/Sub, which the API forwards to Socket.IO.
- Treat the Phase 1 classifier response (`other`, stub mode, no dB estimate) as an integration placeholder, not a model prediction or a measured accuracy result.

## Phase 2

- Use a standardized MFCC/spectral/chroma feature vector with an RBF SVM and class-balanced random forest as classical baselines, and fine-tune an ImageNet ResNet-18 on log-mel spectrograms as the neural comparison.
- Only report held-out evaluation metrics from a real labeled manifest. Dataset preparation is explicit opt-in; no dataset or synthetic performance result is bundled.
- Return `mode=fallback` and a dedicated model version when no trained artifacts are present. The fallback class has zero confidence and is not described as an inference result.
- Estimate a phone-relative level from waveform RMS using a conventional reference offset, but label it uncalibrated everywhere; it is not SPL or an official measurement.
- Persist citizen-confirmed/corrected labels separately from model output and accept corrections only for the authenticated owner's processed report.
- Keep model artifacts and source datasets in ignored `data/` directories, mounted into the ML container rather than committed to the repository.
- Persist compact signal-analysis outputs privately with the report; public map APIs and realtime events deliberately omit this detailed feature payload.

## Deferred to later phases

Air-quality station/photo flows, forecasting, hotspots, official dashboards, exports, and simulated demo data remain deferred.
