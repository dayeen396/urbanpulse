import argparse
import csv
import json
import math
import os
import random
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import torch
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import RandomForestClassifier
from sklearn.svm import SVC
from torch.utils.data import DataLoader, Dataset

from noise_models import (
    CLASS_LABELS,
    LABEL_TO_INDEX,
    SAMPLE_RATE,
    SpectrogramResNet,
    extract_classical_features,
    extract_log_mel,
    freeze_resnet_for_transfer,
    load_audio_file,
    torch_device,
)


class NoiseAudioDataset(Dataset[tuple[torch.Tensor, torch.Tensor]]):
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        row = self.rows[index]
        waveform = load_audio_file(row["audio"])
        mel = torch.from_numpy(extract_log_mel(waveform))
        return mel, torch.tensor(row["label_index"], dtype=torch.long)


def load_manifest(csv_path: Path) -> list[dict[str, Any]]:
    if not csv_path.is_file():
        raise FileNotFoundError(f"Labeled noise manifest not found: {csv_path}")
    records: list[dict[str, Any]] = []
    with csv_path.open(newline="", encoding="utf-8") as file:
        reader = csv.DictReader(file)
        if not {"audio", "label"}.issubset(reader.fieldnames or set()):
            raise ValueError(f"{csv_path} must contain audio,label columns")
        for line_number, row in enumerate(reader, start=2):
            label = row["label"].strip().lower()
            if label not in LABEL_TO_INDEX:
                raise ValueError(f"Unknown noise class '{row['label']}' at {csv_path}:{line_number}")
            audio_path = Path(row["audio"])
            if not audio_path.is_absolute():
                audio_path = csv_path.parent / audio_path
            if not audio_path.is_file():
                raise FileNotFoundError(f"Audio file in manifest does not exist: {audio_path}")
            records.append({
                "audio": audio_path,
                "label": label,
                "label_index": LABEL_TO_INDEX[label],
                "source": row.get("source", "unspecified") or "unspecified",
            })
    if not records:
        raise ValueError(f"Labeled noise manifest is empty: {csv_path}")
    return records


def split_records(records: list[dict[str, Any]], seed: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    indices = np.array([record["label_index"] for record in records])
    classes, counts = np.unique(indices, return_counts=True)
    if len(classes) < 2:
        raise ValueError("Training requires labeled examples from at least two UrbanPulse classes.")
    if int(counts.min()) < 2:
        raise ValueError("Each class needs at least two labeled clips for a stratified train/test split.")
    test_count = max(math.ceil(len(records) * 0.2), len(classes))
    if test_count >= len(records):
        raise ValueError("Not enough labeled clips to create separate training and evaluation sets.")
    train_indices, test_indices = train_test_split(
        np.arange(len(records)),
        test_size=test_count,
        random_state=seed,
        stratify=indices,
    )
    return [records[int(index)] for index in train_indices], [records[int(index)] for index in test_indices]


def calculate_metrics(y_true: np.ndarray, y_predicted: np.ndarray) -> dict[str, Any]:
    return {
        "accuracy": float(accuracy_score(y_true, y_predicted)),
        "macro_f1": float(f1_score(y_true, y_predicted, labels=np.arange(len(CLASS_LABELS)), average="macro", zero_division=0)),
        "confusion_matrix": confusion_matrix(y_true, y_predicted, labels=np.arange(len(CLASS_LABELS))).tolist(),
        "class_labels": list(CLASS_LABELS),
    }


def build_classical_features(records: list[dict[str, Any]]) -> np.ndarray:
    return np.stack([extract_classical_features(load_audio_file(record["audio"])) for record in records])


def evaluate_neural(
    model: SpectrogramResNet,
    records: list[dict[str, Any]],
    batch_size: int,
    device: torch.device,
) -> np.ndarray:
    model.eval()
    loader = DataLoader(NoiseAudioDataset(records), batch_size=batch_size, shuffle=False, num_workers=0)
    predictions: list[int] = []
    with torch.inference_mode():
        for mel, _labels in loader:
            logits = model(mel.to(device))
            predictions.extend(torch.argmax(logits, dim=1).cpu().tolist())
    return np.asarray(predictions, dtype=np.int64)


def train_neural(
    train_records: list[dict[str, Any]],
    test_records: list[dict[str, Any]],
    epochs: int,
    batch_size: int,
    pretrained: bool,
    device: torch.device,
) -> tuple[SpectrogramResNet, dict[str, Any]]:
    model = SpectrogramResNet(pretrained=pretrained).to(device)
    freeze_resnet_for_transfer(model)
    optimizer = torch.optim.AdamW(
        (parameter for parameter in model.parameters() if parameter.requires_grad),
        lr=1e-4,
        weight_decay=1e-4,
    )
    criterion = torch.nn.CrossEntropyLoss()
    train_loader = DataLoader(NoiseAudioDataset(train_records), batch_size=batch_size, shuffle=True, num_workers=0)
    for epoch in range(epochs):
        model.train()
        model.backbone.eval()
        model.backbone.layer4.train()
        model.backbone.fc.train()
        running_loss = 0.0
        examples = 0
        for mel, labels in train_loader:
            mel = mel.to(device)
            labels = labels.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(model(mel), labels)
            loss.backward()
            optimizer.step()
            running_loss += float(loss.item()) * len(labels)
            examples += len(labels)
        if not examples:
            raise ValueError("Neural training split contains no examples.")
        print(f"Epoch {epoch + 1}/{epochs} — train loss {running_loss / examples:.4f}")

    test_labels = np.asarray([record["label_index"] for record in test_records], dtype=np.int64)
    predictions = evaluate_neural(model, test_records, batch_size, device)
    return model, calculate_metrics(test_labels, predictions)


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as file:
        temporary_path = Path(file.name)
        json.dump(payload, file, indent=2)
        file.write("\n")
    temporary_path.replace(path)


def atomic_save_joblib(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
        temporary_path = Path(file.name)
    joblib.dump(payload, temporary_path)
    temporary_path.replace(path)


def atomic_save_torch(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
        temporary_path = Path(file.name)
    torch.save(payload, temporary_path)
    temporary_path.replace(path)


def train(args: argparse.Namespace) -> dict[str, Any]:
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    records = load_manifest(args.csv)
    train_records, test_records = split_records(records, args.seed)
    y_train = np.asarray([record["label_index"] for record in train_records], dtype=np.int64)
    y_test = np.asarray([record["label_index"] for record in test_records], dtype=np.int64)

    print(f"Loading {len(train_records)} train and {len(test_records)} held-out evaluation clips at {SAMPLE_RATE} Hz.")
    x_train = build_classical_features(train_records)
    x_test = build_classical_features(test_records)
    classical_model = make_pipeline(
        StandardScaler(),
        SVC(kernel="rbf", probability=True, class_weight="balanced", random_state=args.seed),
    )
    classical_model.fit(x_train, y_train)
    classical_metrics = calculate_metrics(y_test, classical_model.predict(x_test))

    random_forest = RandomForestClassifier(
        n_estimators=300,
        class_weight="balanced_subsample",
        max_features="sqrt",
        random_state=args.seed,
        n_jobs=-1,
    )
    random_forest.fit(x_train, y_train)
    random_forest_metrics = calculate_metrics(y_test, random_forest.predict(x_test))

    device = torch_device()
    print(f"Fine-tuning ResNet-18 on log-mel spectrograms using {device}.")
    neural_model, neural_metrics = train_neural(
        train_records,
        test_records,
        args.epochs,
        args.batch_size,
        args.pretrained,
        device,
    )

    trained_at = datetime.now(timezone.utc).isoformat()
    classical_version = f"noise-svm-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    random_forest_version = f"noise-random-forest-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    neural_version = f"noise-resnet18-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    sources = sorted({str(record["source"]) for record in records})
    class_counts = {
        label: sum(record["label"] == label for record in records)
        for label in CLASS_LABELS
        if any(record["label"] == label for record in records)
    }
    report: dict[str, Any] = {
        "task": "noise-classification",
        "trained": True,
        "trained_at": trained_at,
        "dataset": {
            "manifest": str(args.csv),
            "samples": len(records),
            "training_samples": len(train_records),
            "evaluation_samples": len(test_records),
            "class_counts": class_counts,
            "sources": sources,
            "evaluation": "stratified holdout, random_state=" + str(args.seed),
        },
        "models": {
            "classical": {
                "available": True,
                "algorithm": "MFCC + spectral/chroma summary features; StandardScaler + RBF SVM",
                "version": classical_version,
                "metrics": classical_metrics,
            },
            "random_forest": {
                "available": True,
                "algorithm": "MFCC + spectral/chroma summary features; class-balanced 300-tree random forest",
                "version": random_forest_version,
                "metrics": random_forest_metrics,
            },
            "neural": {
                "available": True,
                "algorithm": "ImageNet-pretrained ResNet-18 fine-tuned on log-mel spectrograms",
                "pretrained_weights": "ImageNet ResNet-18" if args.pretrained else None,
                "version": neural_version,
                "metrics": neural_metrics,
            },
        },
    }
    atomic_save_joblib(
        args.output_dir / "noise_classical.joblib",
        {"model": classical_model, "version": classical_version},
    )
    atomic_save_joblib(
        args.output_dir / "noise_random_forest.joblib",
        {"model": random_forest, "version": random_forest_version},
    )
    atomic_save_torch(
        args.output_dir / "noise_resnet18.pt",
        {"state_dict": neural_model.cpu().state_dict(), "version": neural_version},
    )
    atomic_write_json(args.output_dir / "noise_metrics.json", report)
    print(f"Saved trained models and real held-out metrics to {args.output_dir}")
    print(json.dumps({name: model["metrics"] for name, model in report["models"].items()}, indent=2))
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train and compare SVM, random forest, and neural UrbanPulse noise classifiers."
    )
    parser.add_argument("--csv", type=Path, default=Path("data/noise/manifest.csv"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/ml-models"))
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--no-pretrained", dest="pretrained", action="store_false")
    parser.set_defaults(pretrained=True)
    args = parser.parse_args()
    if args.epochs < 1 or args.batch_size < 1:
        parser.error("--epochs and --batch-size must be positive.")
    return args


if __name__ == "__main__":
    train(parse_args())
