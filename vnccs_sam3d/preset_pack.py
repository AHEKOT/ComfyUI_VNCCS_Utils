"""Fallback preset-pack paths for the vendored SAM3D bridge.

The upstream SAM3DBody project can be configured with external preset packs.
VNCCS vendors only the inference bridge, so these helpers provide stable local
paths and let blendshape features no-op when optional preset assets are absent.
"""

from __future__ import annotations

from pathlib import Path


_ROOT = Path(__file__).resolve().parent
_DEFAULT_PACK = _ROOT / "presets" / "default"


def active_pack_dir() -> Path:
    return _DEFAULT_PACK


def body_preset_settings_dir() -> Path:
    return active_pack_dir() / "body_preset_settings"


def npz_path() -> Path:
    return active_pack_dir() / "face_blendshapes.npz"

