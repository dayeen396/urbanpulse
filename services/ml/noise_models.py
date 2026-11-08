import math
import os
import subprocess
import time
from pathlib import Path
from typing import Any

import joblib
import librosa
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as functional
from torchvision.models import ResNet18_Weights, resnet18

SAMPLE_RATE = 22_050
MAX_AUDIO_SECONDS = 10
MAX_AUDIO_SIZE_BYTES = 10_000_000
N_MELS = 128
CLASS_LABELS = ("horn", "construction", "siren", "traffic", "engine", "crowd", "other")
LABEL_TO_INDEX = {label: index for index, label in enumerate(CLASS_LABELS)}


class AudioDecodeError(ValueError):
    """Raised when an audio payload cannot be decoded into a valid short clip."""


def decode_audio(audio: bytes) -> np.ndarray:
    if not audio:
        raise AudioDecodeError("Audio payload is empty")
    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-i",
                "pipe:0",
                "-vn",
                "-ac",
                "1",
                "-ar",
                str(SAMPLE_RATE),
                "-t",
                str(MAX_AUDIO_SECONDS + 0.1),
                "-f",
                "f32le",
                "pipe:1",
            ],
            input=audio,
            capture_output=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise AudioDecodeError("Audio could not be decoded; upload a supported audio recording.") from error
    if result.returncode != 0 or not result.stdout:
        raise AudioDecodeError("Audio could not be decoded; upload a supported audio recording.")
    waveform = np.frombuffer(result.stdout, dtype="<f4")
    if waveform.size == 0:
        raise AudioDecodeError("Audio clip contains no samples.")
    if waveform.size > SAMPLE_RATE * MAX_AUDIO_SECONDS:
        raise AudioDecodeError("Audio clips must be 10 seconds or shorter.")
    if not np.isfinite(waveform).all():
        raise AudioDecodeError("Audio clip contains invalid sample values.")
    return np.clip(waveform.astype(np.float32, copy=False), -1.0, 1.0)


def load_audio_file(path: Path) -> np.ndarray:
    try:
        data = path.read_bytes()
    except OSError as error:
        raise AudioDecodeError(f"Unable to read training audio: {path}") from error
    return decode_audio(data)


def extract_classical_features(waveform: np.ndarray) -> np.ndarray:
    if waveform.size == 0:
        raise AudioDecodeError("Audio clip contains no samples.")
    mfcc = librosa.feature.mfcc(y=waveform, sr=SAMPLE_RATE, n_mfcc=20, n_fft=2048, hop_length=512)
    spectral = np.vstack(
        [
            librosa.feature.spectral_centroid(y=waveform, sr=SAMPLE_RATE, n_fft=2048, hop_length=512),
            librosa.feature.spectral_bandwidth(y=waveform, sr=SAMPLE_RATE, n_fft=2048, hop_length=512),
            librosa.feature.spectral_rolloff(y=waveform, sr=SAMPLE_RATE, n_fft=2048, hop_length=512),
            librosa.feature.zero_crossing_rate(y=waveform, frame_length=2048, hop_length=512),
            librosa.feature.rms(y=waveform, frame_length=2048, hop_length=512),
            librosa.feature.spectral_flatness(y=waveform, n_fft=2048, hop_length=512),
        ]
    )
    chroma = librosa.feature.chroma_stft(y=waveform, sr=SAMPLE_RATE, n_fft=2048, hop_length=512)
    features = np.concatenate(
        [
            mfcc.mean(axis=1),
            mfcc.std(axis=1),
            spectral.mean(axis=1),
            spectral.std(axis=1),
            chroma.mean(axis=1),
            chroma.std(axis=1),
        ]
    )
    return np.nan_to_num(features, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)


def extract_log_mel(waveform: np.ndarray) -> np.ndarray:
    mel = librosa.feature.melspectrogram(
        y=waveform,
        sr=SAMPLE_RATE,
        n_fft=2048,
        hop_length=512,
        n_mels=N_MELS,
        power=2.0,
    )
    decibels = librosa.power_to_db(mel, ref=np.max)
    return np.clip((decibels + 80.0) / 80.0, 0.0, 1.0).astype(np.float32)


def estimate_uncalibrated_db(waveform: np.ndarray) -> float | None:
    rms = float(np.sqrt(np.mean(np.square(waveform, dtype=np.float64))))
    if not math.isfinite(rms) or rms <= 0.0:
        return None
    # 94 dB is a conventional reference offset, not a calibration for any phone microphone.
    estimate = 94.0 + 20.0 * math.log10(rms)
    return round(min(150.0, max(0.0, estimate)), 1)


def build_audio_analysis(waveform: np.ndarray, mel: np.ndarray) -> dict[str, Any]:
    rms = float(np.sqrt(np.mean(np.square(waveform, dtype=np.float64))))
    peak = float(np.max(np.abs(waveform)))
    clipped_percent = float(np.mean(np.abs(waveform) >= 0.999) * 100.0)
    mfcc = librosa.feature.mfcc(y=waveform, sr=SAMPLE_RATE, n_mfcc=13, n_fft=2048, hop_length=512)
    centroid = librosa.feature.spectral_centroid(y=waveform, sr=SAMPLE_RATE, n_fft=2048, hop_length=512)
    bandwidth = librosa.feature.spectral_bandwidth(y=waveform, sr=SAMPLE_RATE, n_fft=2048, hop_length=512)
    rolloff = librosa.feature.spectral_rolloff(y=waveform, sr=SAMPLE_RATE, n_fft=2048, hop_length=512)
    flatness = librosa.feature.spectral_flatness(y=waveform, n_fft=2048, hop_length=512)
    zero_crossing = librosa.feature.zero_crossing_rate(y=waveform, frame_length=2048, hop_length=512)

    def mean_value(values: np.ndarray) -> float:
        return round(float(np.mean(values)), 4)

    def downsample(matrix: np.ndarray, rows: int = 32, columns: int = 48) -> list[list[float]]:
        row_indices = np.linspace(0, matrix.shape[0] - 1, min(rows, matrix.shape[0])).astype(int)
        column_indices = np.linspace(0, matrix.shape[1] - 1, min(columns, matrix.shape[1])).astype(int)
        return np.round(matrix[np.ix_(row_indices, column_indices)], 3).tolist()

    return {
        "audio": {
            "durationSeconds": round(waveform.size / SAMPLE_RATE, 3),
            "sampleRateHz": SAMPLE_RATE,
            "channelsAnalyzed": 1,
            "sampleCount": int(waveform.size),
            "rmsAmplitude": round(rms, 6),
            "peakAmplitude": round(peak, 6),
            "clippedSamplesPercent": round(clipped_percent, 3),
        },
        "acousticFeatures": {
            "zeroCrossingRate": mean_value(zero_crossing),
            "spectralCentroidHz": round(mean_value(centroid), 2),
            "spectralBandwidthHz": round(mean_value(bandwidth), 2),
            "spectralRolloffHz": round(mean_value(rolloff), 2),
            "spectralFlatness": mean_value(flatness),
            "mfccMeans": np.round(np.mean(mfcc, axis=1), 3).tolist(),
        },
        "spectrogram": {
            "scale": "normalized_log_mel",
            "frequencyBins": min(32, mel.shape[0]),
            "timeBins": min(48, mel.shape[1]),
            "values": downsample(mel),
        },
        "provenance": {
            "analysisVersion": "noise-analysis-v1",
            "resampling": "ffmpeg mono PCM at 22050 Hz",
            "spectrogram": "128-bin log-mel, 2048-sample FFT, 512-sample hop",
            "dbEstimate": "RMS amplitude with conventional 94 dB offset; uncalibrated",
        },
    }


class SpectrogramResNet(nn.Module):
    def __init__(self, pretrained: bool = False) -> None:
        super().__init__()
        weights = ResNet18_Weights.DEFAULT if pretrained else None
        self.backbone = resnet18(weights=weights)
        input_features = self.backbone.fc.in_features
        self.backbone.fc = nn.Linear(input_features, len(CLASS_LABELS))
        mean = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
        std = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)
        self.register_buffer("image_mean", mean)
        self.register_buffer("image_std", std)

    def forward(self, mel: torch.Tensor) -> torch.Tensor:
        image = mel.unsqueeze(1).repeat(1, 3, 1, 1)
        image = functional.interpolate(image, size=(224, 224), mode="bilinear", align_corners=False)
        image = (image - self.image_mean) / self.image_std
        return self.backbone(image)


class NoisePredictor:
    def __init__(self, model_dir: Path, preferred_method: str = "classical") -> None:
        self.model_dir = model_dir
        self.preferred_method = preferred_method if preferred_method in {"classical", "random_forest", "neural"} else "classical"
        self.classical: Any | None = None
        self.random_forest: Any | None = None
        self.neural: SpectrogramResNet | None = None
        self.versions: dict[str, str] = {}
        self._load_models()

    def _load_models(self) -> None:
        classical_path = self.model_dir / "noise_classical.joblib"
        if classical_path.is_file():
            bundle = joblib.load(classical_path)
            if not isinstance(bundle, dict) or "model" not in bundle:
                raise RuntimeError(f"Invalid classical noise model artifact: {classical_path}")
            self.classical = bundle["model"]
            self.versions["classical"] = str(bundle.get("version", "noise-classical-unknown"))

        forest_path = self.model_dir / "noise_random_forest.joblib"
        if forest_path.is_file():
            bundle = joblib.load(forest_path)
            if not isinstance(bundle, dict) or "model" not in bundle:
                raise RuntimeError(f"Invalid random forest noise model artifact: {forest_path}")
            self.random_forest = bundle["model"]
            self.versions["random_forest"] = str(bundle.get("version", "noise-random-forest-unknown"))

        neural_path = self.model_dir / "noise_resnet18.pt"
        if neural_path.is_file():
            checkpoint = torch.load(neural_path, map_location="cpu", weights_only=True)
            if not isinstance(checkpoint, dict) or "state_dict" not in checkpoint:
                raise RuntimeError(f"Invalid neural noise model artifact: {neural_path}")
            self.neural = SpectrogramResNet()
            self.neural.load_state_dict(checkpoint["state_dict"])
            self.neural.eval()
            self.versions["neural"] = str(checkpoint.get("version", "noise-resnet18-unknown"))

    def _selected_model(self) -> str | None:
        availability = {
            "classical": self.classical is not None,
            "random_forest": self.random_forest is not None,
            "neural": self.neural is not None,
        }
        if availability[self.preferred_method]:
            return self.preferred_method
        return next((name for name in ("classical", "random_forest", "neural") if availability[name]), None)

    def status(self) -> dict[str, str | None]:
        method = self._selected_model()
        return {
            "mode": method or "fallback",
            "model_version": self.versions.get(method) if method else None,
        }

    def _model_result(
        self,
        method: str,
        mel: np.ndarray,
        features: np.ndarray,
    ) -> dict[str, Any]:
        if method in {"classical", "random_forest"}:
            estimator = self.classical if method == "classical" else self.random_forest
            if estimator is None:
                return {"available": False, "reason": "No trained model artifact is installed."}
            probabilities = estimator.predict_proba(features.reshape(1, -1))[0]
            estimator_classes = estimator.classes_
            model_version = self.versions[method]
        elif method == "neural" and self.neural is not None:
            tensor = torch.from_numpy(mel).unsqueeze(0)
            with torch.inference_mode():
                logits = self.neural(tensor)
                probabilities = torch.softmax(logits, dim=1)[0].cpu().numpy()
            estimator_classes = np.arange(len(CLASS_LABELS))
            model_version = self.versions["neural"]
        else:
            return {"available": False, "reason": "No trained model artifact is installed."}

        class_probabilities = {label: 0.0 for label in CLASS_LABELS}
        for estimator_class, probability in zip(estimator_classes, probabilities, strict=True):
            class_index = int(estimator_class)
            if 0 <= class_index < len(CLASS_LABELS):
                class_probabilities[CLASS_LABELS[class_index]] = round(float(probability), 6)
        predicted_class = max(class_probabilities, key=class_probabilities.__getitem__)
        return {
            "available": True,
            "predictedClass": predicted_class,
            "confidence": class_probabilities[predicted_class],
            "modelVersion": model_version,
            "classProbabilities": class_probabilities,
        }

    def classify(self, audio: bytes) -> dict[str, Any]:
        inference_started = time.perf_counter()
        waveform = decode_audio(audio)
        method = self._selected_model()
        approximate_db = estimate_uncalibrated_db(waveform)
        mel = extract_log_mel(waveform)
        features = extract_classical_features(waveform)
        model_results = {
            "classical": self._model_result("classical", mel, features),
            "random_forest": self._model_result("random_forest", mel, features),
            "neural": self._model_result("neural", mel, features),
        }
        selected_result = model_results.get(method or "")
        is_fallback = method is None or selected_result is None or not selected_result.get("available")
        predicted_class = "other" if is_fallback else str(selected_result["predictedClass"])
        confidence = 0.0 if is_fallback else float(selected_result["confidence"])
        model_version = "noise-fallback-v1" if is_fallback else str(selected_result["modelVersion"])
        analysis = build_audio_analysis(waveform, mel)
        analysis["models"] = model_results
        available_predictions = [
            result["predictedClass"]
            for result in model_results.values()
            if result.get("available")
        ]
        analysis["modelAgreement"] = (
            "agree" if len(available_predictions) > 1 and len(set(available_predictions)) == 1
            else "disagree" if len(available_predictions) > 1
            else "comparison_unavailable"
        )
        analysis["inferenceDurationMs"] = round((time.perf_counter() - inference_started) * 1000.0, 2)
        return {
            "predicted_class": predicted_class,
            "confidence": round(confidence, 4),
            "approximate_db": approximate_db,
            "model_version": model_version,
            "mode": "fallback" if is_fallback else method,
            "analysis": analysis,
        }


def freeze_resnet_for_transfer(model: SpectrogramResNet) -> None:
    for parameter in model.backbone.parameters():
        parameter.requires_grad = False
    for parameter in model.backbone.layer4.parameters():
        parameter.requires_grad = True
    for parameter in model.backbone.fc.parameters():
        parameter.requires_grad = True


def torch_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available() and os.environ.get("URBANPULSE_USE_MPS") == "true":
        return torch.device("mps")
    return torch.device("cpu")
