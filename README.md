# UrbanPulse

UrbanPulse is a community sensing prototype for indicative urban noise and air-quality signals in Dhaka, Bangladesh. Mobile microphones and cameras are not calibrated instruments; all community values are estimates, not official measurements. Air-quality information is not medical advice.

## Local quick start

Requirements: Docker Compose v2 and Node.js 22+ for local checks.

1. Copy `.env.example` to `.env`.
2. Replace the database password and both JWT secrets with local random values. Keep `.env` private. The default CORS allowlist supports both `localhost:5173` and `127.0.0.1:5173`.
3. Run `docker compose up --build`.
4. Open <http://localhost:5173> for the public noise map and citizen app, <http://localhost:3000/health/ready> for API readiness, and <http://localhost:3000/api/docs> for Swagger UI.

Compose starts the database, Redis, ML service, database migrations, API, queue worker, and web application. Database data persists in the `postgres_data` volume; private raw clips are kept in the `audio_data` volume and are never exposed by a public file URL. Use `docker compose down -v` only when you intentionally want to erase local data.

To provision an administrator, set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` in `.env`, then run `docker compose exec api npm run seed`. The seed script does nothing without both settings.

## Noise reporting and Phase 2 models

1. Register a citizen account or sign in.
2. Record an ambient clip (recording is limited to 5–10 seconds) or upload a supported clip no larger than 10 MB.
3. The app requests browser location access and fills in latitude/longitude automatically. If the device/browser cannot provide a GPS fix, it fills the Dhaka demo center and clearly labels it approximate—not your actual position. Tap the map to place the pin at the recording location or enter coordinates manually. Browser geolocation requires permission and a secure context (localhost is supported for local development).
4. The API validates the audio container and parsed duration, stores the file privately, and returns a report/job ID.
5. BullMQ sends the report to the ML service. The page receives `report:new`, `job:progress`, and `report:processed` events through Socket.IO; the public Dhaka map displays only rounded coordinates and safe report summaries. Tap the map to set a manual report pin if GPS is unavailable.
6. Open **Full analysis** in private report history to inspect signal-quality metadata, acoustic descriptors, MFCC values, a log-mel spectrogram, available SVM/random-forest/ResNet model outputs and class probabilities, model agreement, selected model version, and measured ML inference time. The raw audio remains private.
7. In private report history, confirm or correct a processed noise label; the corrected label is saved for future training.

### Location and microphone troubleshooting

- The GPS message is separate from audio capture. If the browser cannot determine your location, the Dhaka coordinates are only an approximate fallback; tap the map or enter the recording coordinates manually. The report can still be recorded and submitted.
- Microphone recording requires browser permission and a secure context: use `http://localhost:5173`, `http://127.0.0.1:5173`, or HTTPS. An HTTP address using your computer's LAN IP does not normally allow microphone access.
- If permission was denied, open the browser's site settings for UrbanPulse, set **Microphone** to **Allow**, select the correct input device, reload, and try again. On macOS, also check **System Settings → Privacy & Security → Microphone** for the browser and restart it after changing access.
- If the browser says no microphone was found or it is busy, connect/enable the input, check OS privacy settings, and close other apps or tabs using the microphone. Audio file upload remains available as an alternative.

The service supports MFCC/spectral-feature SVM and random-forest baselines plus a ResNet-18 model fine-tuned on log-mel spectrograms. Each model produces its own class probabilities when trained artifacts exist; the configured model selects the report label, while the UI shows agreement/disagreement across available models. With no trained artifact, it returns an explicit `mode=fallback` result (`other`, zero confidence) and does not claim that result is a model prediction. RMS-derived dB estimates are uncalibrated phone-relative estimates, not sound-level measurements. The admin model page shows held-out metrics only after a real evaluation has completed; there are currently no bundled datasets or evaluation results.

### Optional noise model training

Training requires labeled clips; do not interpret fallback output as training data. Public datasets are not downloaded automatically:

```sh
# Optional, large downloads: choose either or both supported public datasets.
docker compose exec ml python prepare_noise_data.py --download urbansound8k esc50

# Or add data/custom/noise_labels.csv with audio,label columns and audio files under data/custom/.
docker compose exec ml python prepare_noise_data.py
docker compose exec ml python train_noise.py --csv data/noise/manifest.csv --output-dir models
```

Artifacts and evaluation JSON are written under ignored `data/ml-models/`, mounted as the model directory. Inference prefers the configured `NOISE_MODEL_METHOD` when its artifact exists and otherwise uses an available trained artifact; if neither exists, it stays in fallback mode. Set `DELETE_AUDIO_AFTER_PROCESSING=true` to remove private audio automatically after classification; citizens can also delete a report and its raw clip from their history.

## Local checks

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

The API tests cover liveness, request validation, authenticated audio upload, duration limits, queue handoff, safe map responses, and owner-only label corrections. Run ML tests in the Python 3.11 image with `docker compose run --rm --no-deps ml pytest -q`. Database-dependent paths require the Compose PostgreSQL service.

## Repository map

- `apps/web`: Vite, React, React Router, Tailwind, Leaflet, Recharts, and Socket.IO client dependencies.
- `apps/api`: typed Express REST API, JWT auth, Zod validation, OpenAPI docs, and PostGIS migrations.
- `apps/worker`: BullMQ audio-classification worker and Redis-to-Socket.IO progress events.
- `services/ml`: Python 3.11 FastAPI noise inference, explicit no-model fallback, SVM/random-forest/ResNet-18 training and evaluation, dataset preparation, and ML tests.
- `infra`: local infrastructure and database/seed workflow notes.
- `docs/decisions.md`: architecture decisions.
- `docs/progress.md`: phase status, stubs, and known issues.
- API docs are served at <http://localhost:3000/api/docs>.

## Roadmap

See [docs/progress.md](docs/progress.md) for phase completion and deferred work.
