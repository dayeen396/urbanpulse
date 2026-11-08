import io
import wave

import numpy as np
import pytest
import torch
import torch.nn as nn
from fastapi.testclient import TestClient

import app as ml_app
from noise_models import (
    AudioDecodeError,
    NoisePredictor,
    decode_audio,
    estimate_uncalibrated_db,
    extract_classical_features,
    extract_log_mel,
)


client = TestClient(ml_app.app)


def make_wav(duration_seconds: float = 1.0) -> bytes:
    sample_rate = 22_050
    samples = (np.sin(2 * np.pi * 440 * np.arange(int(sample_rate * duration_seconds)) / sample_rate) * 8_000)
    pcm = samples.astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(sample_rate)
        file.writeframes(pcm)
    return output.getvalue()


def test_health_reports_fallback_without_trained_model(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setattr(ml_app, "predictor", NoisePredictor(tmp_path))

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "mode": "fallback",
        "model_version": "noise-fallback-v1",
    }


def test_fallback_classification_returns_explicit_mode_and_indicative_db(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(ml_app, "predictor", NoisePredictor(tmp_path))

    response = client.post("/v1/noise/classify", content=make_wav())

    assert response.status_code == 200
    assert response.json()["predicted_class"] == "other"
    assert response.json()["confidence"] == 0.0
    assert response.json()["mode"] == "fallback"
    assert response.json()["model_version"] == "noise-fallback-v1"
    assert isinstance(response.json()["approximate_db"], float)
    analysis = response.json()["analysis"]
    assert analysis["audio"]["durationSeconds"] == 1.0
    assert analysis["audio"]["sampleRateHz"] == 22_050
    assert analysis["acousticFeatures"]["spectralCentroidHz"] > 0
    assert analysis["models"]["classical"]["available"] is False
    assert analysis["models"]["random_forest"]["available"] is False
    assert analysis["models"]["neural"]["available"] is False
    assert analysis["spectrogram"]["frequencyBins"] == 32
    assert len(analysis["spectrogram"]["values"]) == 32
    assert 0 < analysis["spectrogram"]["timeBins"] <= 48
    assert len(analysis["spectrogram"]["values"][0]) == analysis["spectrogram"]["timeBins"]


def test_audio_features_and_uncalibrated_rms_estimate() -> None:
    waveform = decode_audio(make_wav())

    assert waveform.shape == (22_050,)
    assert extract_classical_features(waveform).shape == (76,)
    assert extract_log_mel(waveform).shape[0] == 128
    assert estimate_uncalibrated_db(waveform) is not None
    assert estimate_uncalibrated_db(np.zeros(10, dtype=np.float32)) is None


def test_invalid_audio_is_rejected_without_fabricated_classification() -> None:
    response = client.post("/v1/noise/classify", content=b"not an audio recording")

    assert response.status_code == 422
    assert "could not be decoded" in response.json()["detail"]
    with pytest.raises(AudioDecodeError):
        decode_audio(b"")


def test_classification_rejects_empty_or_oversized_audio() -> None:
    empty_response = client.post("/v1/noise/classify", content=b"")
    large_response = client.post(
        "/v1/noise/classify",
        content=b"x" * (ml_app.MAX_AUDIO_SIZE_BYTES + 1),
    )

    assert empty_response.status_code == 400
    assert large_response.status_code == 413


def test_audio_validation_uses_decoder_for_duration_and_rejects_long_clips() -> None:
    response = client.post("/v1/noise/validate", content=make_wav())
    long_response = client.post("/v1/noise/validate", content=make_wav(11))
    invalid_response = client.post("/v1/noise/validate", content=b"not an audio recording")

    assert response.status_code == 200
    assert response.json()["duration_seconds"] == 1.0
    assert long_response.status_code == 413
    assert "10 seconds or shorter" in long_response.json()["detail"]
    assert invalid_response.status_code == 422


def test_metrics_are_explicitly_not_evaluated_without_dataset(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setattr(ml_app, "MODEL_DIR", tmp_path)

    response = client.get("/v1/noise/metrics")

    assert response.status_code == 200
    assert response.json()["trained"] is False
    assert response.json()["models"]["classical"]["metrics"] is None


def test_available_classical_and_neural_models_return_comparable_outputs(tmp_path) -> None:
    class FixedClassicalModel:
        classes_ = np.asarray([0, 3])

        def predict_proba(self, _features: np.ndarray) -> np.ndarray:
            return np.asarray([[0.2, 0.8]])

    class FixedNeuralModel(nn.Module):
        def forward(self, mel: torch.Tensor) -> torch.Tensor:
            logits = torch.full((mel.shape[0], 7), -3.0)
            logits[:, 3] = 3.0
            return logits

    predictor = NoisePredictor(tmp_path)
    predictor.classical = FixedClassicalModel()
    predictor.random_forest = FixedClassicalModel()
    predictor.neural = FixedNeuralModel().eval()
    predictor.versions = {"classical": "test-svm", "random_forest": "test-rf", "neural": "test-resnet"}

    result = predictor.classify(make_wav())

    assert result["predicted_class"] == "traffic"
    assert result["mode"] == "classical"
    assert result["analysis"]["modelAgreement"] == "agree"
    assert result["analysis"]["models"]["classical"]["classProbabilities"]["traffic"] == 0.8
    assert result["analysis"]["models"]["random_forest"]["modelVersion"] == "test-rf"
    assert result["analysis"]["models"]["neural"]["modelVersion"] == "test-resnet"
    assert result["analysis"]["inferenceDurationMs"] >= 0
