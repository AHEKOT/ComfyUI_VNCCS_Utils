"""ARDY model specifications bundled with the standalone inference package."""

from __future__ import annotations

import json
from pathlib import Path

from .base import MotionModelSpec


def _ardy():
    from .ardy_backend import ArdyBackend

    return ArdyBackend


# Backend name used in the model JSON -> loader of its MotionBackend class.
BACKENDS = {
    "ardy": _ardy,
}

MODELS_CONFIG_DIR = Path(__file__).resolve().parent / "config" / "motion_models"
_MAX_SPEC_BYTES = 256 * 1024


def load_specs(directory: Path = MODELS_CONFIG_DIR) -> dict:
    """Read every model JSON; broken files are skipped with a console warning."""
    specs = {}
    for path in sorted(Path(directory).glob("*.json")):
        try:
            if path.stat().st_size > _MAX_SPEC_BYTES:
                raise ValueError("file is too large")
            spec = MotionModelSpec.from_dict(json.loads(path.read_text(encoding="utf-8")))
            if spec.backend not in BACKENDS:
                raise ValueError(f"unknown backend {spec.backend!r}")
            if spec.id in specs:
                raise ValueError(f"duplicate model id {spec.id!r}")
        except (OSError, ValueError) as exc:
            print(f"[VNCCS] Skipping text-to-motion model {path.name}: {exc}")
            continue
        specs[spec.id] = spec
    return dict(sorted(specs.items(), key=lambda item: (item[1].order, item[1].name)))


def backend_class(name: str):
    return BACKENDS[name]()


def default_models_dir() -> Path:
    """``<ComfyUI>/models/text_to_motion`` (falls back next to this package outside ComfyUI)."""
    try:
        import folder_paths

        return Path(folder_paths.models_dir) / "text_to_motion"
    except Exception:
        return Path(__file__).resolve().parent / "models" / "text_to_motion"
