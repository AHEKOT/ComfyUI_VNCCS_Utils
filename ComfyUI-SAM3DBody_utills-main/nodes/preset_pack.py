"""Active preset pack resolver.

A *preset pack* is a self-contained folder under `presets/` that bundles:

    presets/<pack>/face_blendshapes.npz        — blend-shape deltas
    presets/<pack>/mhr_reference_vertices.json — MHR rest-pose vertex list
    presets/<pack>/chara_settings_presets/     — character preset JSONs

Which pack the runtime uses is controlled by `active_preset.ini` at the
repo root:

    [active]
    pack = default

This module centralises that resolution so every code path (nodes,
server, tools) agrees on the same location.
"""

from __future__ import annotations

import configparser
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parent.parent
_INI_PATH = _REPO_ROOT / "active_preset.ini"
_DEFAULT_PACK = "default"


def repo_root() -> Path:
    """Repository root (the `ComfyUI-SAM3DBody_utills/` folder)."""
    return _REPO_ROOT


def active_pack_name() -> str:
    """Read the active pack name from active_preset.ini. Falls back to
    `default` if the ini is missing, malformed, or the pack folder
    doesn't exist."""
    name = _DEFAULT_PACK
    if _INI_PATH.exists():
        try:
            cp = configparser.ConfigParser()
            cp.read(_INI_PATH, encoding="utf-8")
            candidate = cp.get("active", "pack", fallback=_DEFAULT_PACK).strip()
            if candidate:
                name = candidate
        except Exception as exc:
            print(f"[SAM3DBody] active_preset.ini parse failed: {exc}; "
                  f"falling back to '{_DEFAULT_PACK}'")
    # Final safety — fall back to default if the named pack isn't on disk.
    if not (_REPO_ROOT / "presets" / name).is_dir():
        fallback_dir = _REPO_ROOT / "presets" / _DEFAULT_PACK
        if fallback_dir.is_dir() and name != _DEFAULT_PACK:
            print(f"[SAM3DBody] preset pack '{name}' not found under "
                  f"{_REPO_ROOT / 'presets'}; falling back to '{_DEFAULT_PACK}'")
            name = _DEFAULT_PACK
    return name


def active_pack_dir() -> Path:
    """Absolute path to the active preset pack's folder."""
    return _REPO_ROOT / "presets" / active_pack_name()


def npz_path() -> Path:
    return active_pack_dir() / "face_blendshapes.npz"


def vertices_json_path(object_name: str) -> Path:
    return active_pack_dir() / f"{object_name}_vertices.json"


def chara_settings_dir() -> Path:
    return active_pack_dir() / "chara_settings_presets"
