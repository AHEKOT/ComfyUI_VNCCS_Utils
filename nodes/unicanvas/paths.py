"""OS-agnostic model path resolution against ComfyUI ``folder_paths``."""

from __future__ import annotations

import ntpath
import os
from typing import Any


# Repository root of the VNCCS-Utils extension (nodes/unicanvas/paths.py -> ../../..).
_EXTENSION_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _unicanvas_runtime_temp_root() -> str:
    try:
        import folder_paths

        root = folder_paths.get_temp_directory()
    except Exception:
        root = os.path.join(_EXTENSION_ROOT, ".runtime_cache")
    os.makedirs(root, exist_ok=True)
    return os.path.abspath(root)


def _unicanvas_state_cache_dir() -> str:
    """Where the server writes UniCanvas state caches (ComfyUI user dir, so they survive a restart)."""
    try:
        import folder_paths

        root = folder_paths.get_user_directory()
    except Exception:
        root = os.path.join(_EXTENSION_ROOT, ".runtime_cache", "user")
    return os.path.join(root, "vnccs", "unicanvas_state_cache")


def _normalize_path(value: str) -> str:
    return str(value or "").strip().replace("\\", os.sep).replace("/", os.sep)


def _is_absolute_any_os(value: str) -> bool:
    raw = str(value or "").strip()
    return os.path.isabs(raw) or ntpath.isabs(raw) or bool(ntpath.splitdrive(raw)[0])


def _path_variants(name: str) -> list[str]:
    raw = str(name or "").strip()
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


def _is_under_any_folder(path: str, folders: list[str]) -> bool:
    try:
        path_abs = os.path.abspath(_normalize_path(path))
        for folder in folders:
            folder_abs = os.path.abspath(_normalize_path(folder))
            if os.path.commonpath([folder_abs, path_abs]) == folder_abs:
                return True
    except Exception:
        return False
    return False


def _get_full_path_agnostic(folder_paths: Any, category: str, name: str, require_exists: bool = False) -> str | None:
    folders = _safe_get_folder_paths(folder_paths, category)
    first_match = None

    for candidate in _path_variants(name):
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

        if _is_absolute_any_os(candidate) and _is_under_any_folder(candidate, folders):
            normalized_candidate = _normalize_path(candidate)
            if os.path.exists(normalized_candidate):
                return normalized_candidate
            if first_match is None:
                first_match = normalized_candidate

    return None if require_exists else first_match


def _resolve_model_filename(folder_paths: Any, categories: str | tuple[str, ...], name: Any) -> str:
    """The installed file ``name`` refers to, as ComfyUI lists it (subfolder included).

    Family defaults and presets name files without a subfolder ("qwen_image_vae.safetensors")
    while users keep them in one ("qwen/qwen_image_vae.safetensors"). An exact entry wins;
    otherwise the first listed entry with the same file name (case-insensitive). Unknown names come back unchanged so the loader reports them.
    """
    raw = str(name or "").strip()
    if not raw:
        return raw
    wanted = raw.replace("\\", "/").rsplit("/", 1)[-1].lower()
    for category in (categories,) if isinstance(categories, str) else categories:
        try:
            listed = list(folder_paths.get_filename_list(category) or [])
        except Exception:
            listed = []
        if raw in listed:
            return raw
        for entry in listed:
            if str(entry).replace("\\", "/").rsplit("/", 1)[-1].lower() == wanted:
                return str(entry)
    return raw
