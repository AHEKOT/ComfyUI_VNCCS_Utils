"""Model registry: one JSON file per model in ``config/motion_models``.

To add a model, drop a JSON file there. If it runs on an existing backend (for
example another Kimodo checkpoint) nothing else is needed; a new model family adds
a ``MotionBackend`` subclass and one entry in ``BACKENDS``.
"""

from __future__ import annotations

import json
from pathlib import Path

from .base import MotionModelSpec


def _kimodo():
    from .kimodo_backend import KimodoBackend

    return KimodoBackend


def _ardy():
    from .ardy_backend import ArdyBackend

    return ArdyBackend


def _hymotion():
    from .hymotion_backend import HYMotionBackend

    return HYMotionBackend


def _unimate():
    from .unimate_backend import UniMateBackend

    return UniMateBackend


# Backend name used in the model JSON -> loader of its MotionBackend class.
BACKENDS = {
    "kimodo": _kimodo,
    "ardy": _ardy,
    "hymotion": _hymotion,
    "unimate": _unimate,
}

MODELS_CONFIG_DIR = Path(__file__).resolve().parents[2] / "config" / "motion_models"
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
        return Path(__file__).resolve().parents[2] / "models" / "text_to_motion"
