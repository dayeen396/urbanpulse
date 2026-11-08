import json
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from noise_models import AudioDecodeError, NoisePredictor, MAX_AUDIO_SIZE_BYTES, SAMPLE_RATE, decode_audio

MODEL_DIR = Path(os.environ.get("MODEL_DIR", "models"))
predictor = NoisePredictor(MODEL_DIR, os.environ.get("NOISE_MODEL_METHOD", "classical"))

app = FastAPI(title="UrbanPulse ML Service", version="0.2.0")


@app.get("/health")
def health() -> dict[str, str]:
    status = predictor.status()
    return {
        "status": "ok",
        "mode": status["mode"],
        "model_version": status["model_version"] or "noise-fallback-v1",
    }


@app.get("/v1/noise/metrics")
def noise_metrics() -> dict[str, object]:
    metrics_path = MODEL_DIR / "noise_metrics.json"
    if not metrics_path.is_file():
        return {
            "task": "noise-classification",
            "trained": False,
            "mode": "fallback",
            "model_version": "noise-fallback-v1",
            "message": "No real labeled evaluation has been run yet. Add labeled clips and run the training script.",
            "models": {
                "classical": {"available": False, "metrics": None},
                "random_forest": {"available": False, "metrics": None},
                "neural": {"available": False, "metrics": None},
            },
        }
    try:
        metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=503, detail="Noise model evaluation metrics are unavailable.") from error
    if not isinstance(metrics, dict) or metrics.get("task") != "noise-classification":
        raise HTTPException(status_code=503, detail="Noise model evaluation metrics have an invalid format.")
    return metrics


@app.post("/v1/noise/classify")
async def classify_noise(request: Request) -> dict[str, object]:
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="Audio payload is empty")
    if len(audio) > MAX_AUDIO_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="Audio payload exceeds the upload limit")
    try:
        return await run_in_threadpool(predictor.classify, audio)
    except AudioDecodeError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/noise/validate")
async def validate_noise_audio(request: Request) -> dict[str, float]:
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="Audio payload is empty")
    if len(audio) > MAX_AUDIO_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="Audio payload exceeds the upload limit")
    try:
        waveform = await run_in_threadpool(decode_audio, audio)
    except AudioDecodeError as error:
        status_code = 413 if "10 seconds or shorter" in str(error) else 422
        raise HTTPException(status_code=status_code, detail=str(error)) from error
    return {"duration_seconds": round(waveform.size / SAMPLE_RATE, 3)}
