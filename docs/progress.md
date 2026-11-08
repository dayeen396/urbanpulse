# UrbanPulse progress

## Phase 0 — foundation

- [x] Monorepo structure for web, API, worker, ML service, infrastructure, and docs.
- [x] Docker Compose services for React/Vite, Express API, FastAPI ML service, BullMQ worker, PostgreSQL/PostGIS, Redis, and database migration.
- [x] Initial PostGIS schema and spatial indexes for reports, readings, zones, hotspots, alerts, and flagged zones.
- [x] JWT registration/login/refresh/logout foundation with citizen/official/admin roles and password hashing.
- [x] API liveness/readiness checks, validation/error format, security headers, CORS, rate limiting, and Swagger UI.
- [x] Configurable admin seed script; no default credentials or sample measurements.
- [x] CI workflow and API tests.
- [x] Visible indicative-estimates / no-medical-advice disclaimer in the web shell.

## Phase 1 — noise vertical slice

- [x] Citizen registration/login UI connected to the API, session tokens, refresh rotation, and logout.
- [x] Browser microphone recording (5–10 seconds) and audio file upload with GPS or manually entered coordinates.
- [x] Server-enforced audio container, file-size, and parsed-duration checks (10 seconds maximum).
- [x] Private local audio storage shared only between API and worker; report deletion removes the raw clip.
- [x] BullMQ noise-classification jobs, ML stub calls, persisted status/result, and Socket.IO report/progress events.
- [x] Public Leaflet noise map with live markers; private report history and deletion controls.
- [x] Stub results identify `mode` and `model_version`; dB is unavailable rather than fabricated.
- [x] API tests cover upload validation, queue handoff, safe map fields, and authentication; ML stub tests run in CI.

## Phase 2 — noise models and label feedback

- [x] Classical SVM and class-balanced random-forest baselines using MFCC, spectral, and chroma features; ResNet-18 neural model using log-mel spectrograms.
- [x] Python 3.11 inference service reports loaded model version and `classical`, `neural`, or `fallback` mode.
- [x] Explicit no-model fallback; no trained model or fake metrics are produced when labeled data is absent.
- [x] RMS-derived indicative dB estimate with uncalibrated labeling in citizen history.
- [x] Opt-in UrbanSound8K/ESC-50/custom-data manifest preparation and stratified held-out SVM/random-forest/ResNet evaluation with accuracy, macro-F1, and confusion matrices.
- [x] Admin-only model comparison page and metrics endpoint; shows no-evaluation state until actual metrics exist.
- [x] Citizens can confirm/correct labels on owned processed reports; corrected labels are stored separately from model predictions.
- [x] API (19 tests) and ML (8 tests) suites, Python 3.11 image build, lint, typecheck, and monorepo build verified.
- [x] Full Compose stack rebuilt; migration `003_noise_analysis` applied; API, ML, and web health checks passed.
- [x] Live registration → audio upload → BullMQ processing → fallback inference → private analysis persistence → label correction → report/audio deletion was exercised end to end; public map results omitted analysis and raw-file paths.
- [x] Citizen report form requests device geolocation with low-accuracy then high-accuracy attempts, shows GPS accuracy, and clearly fills the Dhaka demo center as an explicitly approximate fallback when the device cannot provide a fix.
- [x] Noise reports persist analysis provenance, signal-quality/acoustic features, compact spectrogram data, available model outputs, class probabilities, agreement, and measured inference time; private report history visualizes the analysis. Details are omitted from public map/realtime payloads.
- [x] Microphone errors now explain permission, missing-device, busy-device, and secure-context remedies; GPS fallback is shown inline as a location notice rather than a general red audio/upload error.
- [x] Browser capture was exercised on the shared app page and produced a 9.8-second recording.
- [x] Fixed real browser recording uploads: MediaRecorder WebM clips can omit container duration metadata, so API validation now uses the ML service's FFmpeg decoder as a fallback and still rejects unreadable or >10-second audio. A recorded clip was uploaded, processed, then deleted after the end-to-end check.

### Stubbed / deferred

- No labeled clips or trained model artifacts are present; live noise predictions therefore remain in explicitly marked fallback mode. No accuracy or macro-F1 results are available yet.
- Noise class corrections are persisted for later training, but no automated retraining trigger is wired yet.
- Air-quality readings, map layers, and ML are not yet implemented.
- Official dashboards, hotspots, forecasts, and alerts remain deferred.

### Known issues / next

- Downloading UrbanSound8K/ESC-50 is opt-in and may require significant storage and time.
- Neural training may take substantial CPU/GPU time; provide enough labeled examples across classes before running evaluation.
- Continue with Phase 3 only after user confirmation.
