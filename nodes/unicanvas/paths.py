"""OS-agnostic model path resolution against ComfyUI ``folder_paths``."""

from __future__ import annotations

import ntpath
import os
from typing import Any


from ..shared.paths import _EXTENSION_ROOT, _vnccs_runtime_temp_root as _unicanvas_runtime_temp_root


def _normalize_path(value: str) -> str:
    return str(value or "").strip().replace("\\", os.sep).replace("/", os.sep)


def _is_absolute_any_os(value: str) -> bool:
    raw = str(value or "").strip()
    return os.path.isabs(raw) or ntpath.isabs(raw) or bool(ntpath.splitdrive(raw)[0])


def _validate_model_name(name: Any) -> str:
    raw = str(name or "").strip()
    if (_is_absolute_any_os(raw) or ":" in raw or "\x00" in raw
            or raw.startswith(("~", "/", "\\"))
            or any(part.rstrip(" ") == ".." for part in raw.replace("\\", "/").split("/"))):
        raise ValueError("Model name must be a relative path without '..', drive or UNC prefixes")
    return raw


def _path_variants(name: str) -> list[str]:
    raw = _validate_model_name(name)
    if not raw:
        return []
    variants = []
    for candidate in (raw, raw.replace("\\", "/"), raw.replace("/", "\\")):
        if candidate and candidate not in variants:
            variants.append(candidate)
    return variants


def _safe_get_folder_paths(folder_paths: Any, category: str) -> list[str]:
    try:
        return folder_paths.get_folder_paths(category) or []
    except Exception:
        return []


def _get_full_path_agnostic(folder_paths: Any, category: str, name: str, require_exists: bool = False) -> str | None:
    variants = _path_variants(name)
    folders = _safe_get_folder_paths(folder_paths, category)
    first_match = None

    for candidate in variants:
        try:
            found = folder_paths.get_full_path(category, candidate)
        except Exception:
            found = None
        if found:
            if os.path.exists(found):
                return found
            if first_match is None:
                first_match = found

        for folder in folders:
            joined = os.path.join(folder, _normalize_path(candidate))
            if os.path.exists(joined):
                return joined
            if first_match is None:
                first_match = joined

    return None if require_exists else first_match


def _resolve_model_filename(folder_paths: Any, categories: str | tuple[str, ...], name: Any, *, allow_subfolder_fallback: bool = False) -> str:
    """The installed file ``name`` refers to, as ComfyUI lists it (subfolder included).

    Family defaults and presets name files without a subfolder ("qwen_image_vae.safetensors")
    while users keep them in one ("qwen/qwen_image_vae.safetensors"). An exact entry wins;
    otherwise a unique basename match is allowed for bare names or known presets.
    Explicit subfolder paths stay exact. Unknown names reach the loader unchanged.
    """
    raw = _validate_model_name(name)
    if not raw:
        return raw
    normalized = raw.replace("\\", "/")
    wanted = normalized.rsplit("/", 1)[-1].lower()
    installed = []
    for category in (categories,) if isinstance(categories, str) else categories:
        try:
            listed = list(folder_paths.get_filename_list(category) or [])
        except Exception:
            listed = []
        installed.extend((category, str(entry)) for entry in listed)
        for entry in listed:
            if str(entry).replace("\\", "/") == normalized:
                return str(entry)
    if "/" in normalized and not allow_subfolder_fallback:
        return raw
    matches = list(dict.fromkeys(entry for _, entry in installed
                                if entry.replace("\\", "/").rsplit("/", 1)[-1].lower() == wanted))
    # MiniMax's full-precision video VAE can replace the preset's quantized VAE.
    if not matches and wanted == "minimax_h3_video_vae_int8_convrot.safetensors":
        matches = list(dict.fromkeys(entry for category, entry in installed if category == "vae"
                                    and entry.replace("\\", "/").rsplit("/", 1)[-1].lower() == "minimax_h3_video_vae_fp16.safetensors"))
    if len(matches) > 1:
        raise ValueError(f"Ambiguous model filename '{raw}'; select its subfolder path")
    if matches:
        return matches[0]
    return raw
