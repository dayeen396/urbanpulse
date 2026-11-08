import argparse
import csv
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

URBANSOUND8K_URL = "https://zenodo.org/record/1203745/files/UrbanSound8K.tar.gz"
ESC50_URL = "https://github.com/karolpiczak/ESC-50/archive/refs/heads/master.zip"
URBANSOUND_LABELS = {
    "car_horn": "horn",
    "children_playing": "crowd",
    "drilling": "construction",
    "engine_idling": "engine",
    "gun_shot": "other",
    "jackhammer": "construction",
    "siren": "siren",
    "air_conditioner": "other",
    "dog_bark": "other",
    "street_music": "other",
}
ESC50_LABELS = {
    "crowd": "crowd",
    "children_playing": "crowd",
    "engine": "engine",
    "chainsaw": "construction",
    "hand_saw": "construction",
    "car_horn": "horn",
    "siren": "siren",
}
AUDIO_SUFFIXES = {".wav", ".webm", ".ogg", ".mp3", ".m4a", ".aac", ".flac"}


def download_archive(url: str, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        return destination
    request = urllib.request.Request(url, headers={"User-Agent": "UrbanPulse-data-preparer/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".download-", delete=False) as temporary:
            temporary_path = Path(temporary.name)
            while chunk := response.read(8 * 1024 * 1024):
                temporary.write(chunk)
    temporary_path.replace(destination)
    return destination


def safe_extract_tar(archive_path: Path, destination: Path) -> None:
    root = destination.resolve()
    with tarfile.open(archive_path, mode="r:gz") as archive:
        for member in archive.getmembers():
            resolved = (root / member.name).resolve()
            if resolved != root and root not in resolved.parents:
                raise ValueError(f"Dataset archive contains an unsafe path: {member.name}")
            if member.issym() or member.islnk():
                raise ValueError(f"Dataset archive contains an unsupported link: {member.name}")
        archive.extractall(destination, filter="data")


def safe_extract_zip(archive_path: Path, destination: Path) -> None:
    root = destination.resolve()
    with zipfile.ZipFile(archive_path) as archive:
        for name in archive.namelist():
            resolved = (root / PurePosixPath(name)).resolve()
            if resolved != root and root not in resolved.parents:
                raise ValueError(f"Dataset archive contains an unsafe path: {name}")
        archive.extractall(destination)


def locate_urbansound(root: Path) -> Path | None:
    candidates = [root, *root.glob("**/UrbanSound8K")]
    return next((candidate for candidate in candidates if (candidate / "metadata/UrbanSound8K.csv").is_file()), None)


def locate_esc50(root: Path) -> Path | None:
    candidates = [root, *root.glob("**/ESC-50-master"), *root.glob("**/ESC-50")]
    return next((candidate for candidate in candidates if (candidate / "meta/esc50.csv").is_file()), None)


def read_urbansound(root: Path) -> list[dict[str, str]]:
    metadata = root / "metadata/UrbanSound8K.csv"
    records: list[dict[str, str]] = []
    with metadata.open(newline="", encoding="utf-8") as file:
        for row in csv.DictReader(file):
            label = URBANSOUND_LABELS.get(row["class"])
            if label is None:
                continue
            audio_path = root / "audio" / f"fold{row['fold']}" / row["slice_file_name"]
            if audio_path.is_file():
                records.append({
                    "audio": str(audio_path.resolve()),
                    "label": label,
                    "source": "UrbanSound8K",
                    "source_label": row["class"],
                })
    return records


def read_esc50(root: Path) -> list[dict[str, str]]:
    metadata = root / "meta/esc50.csv"
    records: list[dict[str, str]] = []
    with metadata.open(newline="", encoding="utf-8") as file:
        for row in csv.DictReader(file):
            label = ESC50_LABELS.get(row["category"])
            if label is None:
                continue
            audio_path = root / "audio" / row["filename"]
            if audio_path.is_file():
                records.append({
                    "audio": str(audio_path.resolve()),
                    "label": label,
                    "source": "ESC-50",
                    "source_label": row["category"],
                })
    return records


def read_custom_labels(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    records: list[dict[str, str]] = []
    with path.open(newline="", encoding="utf-8") as file:
        reader = csv.DictReader(file)
        if not {"audio", "label"}.issubset(reader.fieldnames or set()):
            raise ValueError(f"{path} must have audio,label columns")
        for row in reader:
            label = row["label"].strip().lower()
            if label not in URBANSOUND_LABELS.values():
                raise ValueError(f"Unsupported UrbanPulse class '{row['label']}' in {path}")
            audio_path = Path(row["audio"])
            if not audio_path.is_absolute():
                audio_path = path.parent / audio_path
            if not audio_path.is_file() or audio_path.suffix.lower() not in AUDIO_SUFFIXES:
                raise ValueError(f"Custom audio file is missing or unsupported: {audio_path}")
            records.append({
                "audio": str(audio_path.resolve()),
                "label": label,
                "source": "custom",
                "source_label": label,
            })
    return records


def write_manifest(records: list[dict[str, str]], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=["audio", "label", "source", "source_label"])
        writer.writeheader()
        writer.writerows(records)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Prepare a labeled noise manifest; public datasets are opt-in and are not committed."
    )
    parser.add_argument("--data-dir", type=Path, default=Path("data/noise"))
    parser.add_argument("--urbansound8k", type=Path, default=Path("data/noise/UrbanSound8K"))
    parser.add_argument("--esc50", type=Path, default=Path("data/noise/ESC-50"))
    parser.add_argument("--custom-labels", type=Path, default=Path("data/custom/noise_labels.csv"))
    parser.add_argument("--download", nargs="*", choices=["urbansound8k", "esc50"], default=[])
    args = parser.parse_args()

    args.data_dir.mkdir(parents=True, exist_ok=True)
    if "urbansound8k" in args.download and locate_urbansound(args.urbansound8k) is None:
        archive = download_archive(URBANSOUND8K_URL, args.data_dir / "UrbanSound8K.tar.gz")
        safe_extract_tar(archive, args.data_dir)
    if "esc50" in args.download and locate_esc50(args.esc50) is None:
        archive = download_archive(ESC50_URL, args.data_dir / "ESC-50.zip")
        safe_extract_zip(archive, args.data_dir)

    records: list[dict[str, str]] = []
    urban_root = locate_urbansound(args.urbansound8k)
    if urban_root:
        records.extend(read_urbansound(urban_root))
    esc_root = locate_esc50(args.esc50)
    if esc_root:
        records.extend(read_esc50(esc_root))
    records.extend(read_custom_labels(args.custom_labels))

    if not records:
        raise SystemExit(
            "No labeled audio found. Download with --download urbansound8k esc50, "
            "or add labeled clips under data/custom and create data/custom/noise_labels.csv."
        )
    write_manifest(records, args.data_dir / "manifest.csv")
    counts: dict[str, int] = {}
    for row in records:
        counts[row["label"]] = counts.get(row["label"], 0) + 1
    print(f"Wrote {len(records)} labeled records to {args.data_dir / 'manifest.csv'}")
    print(f"Class counts: {counts}")


if __name__ == "__main__":
    main()
