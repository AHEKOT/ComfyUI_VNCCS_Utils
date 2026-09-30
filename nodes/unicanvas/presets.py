"""Model presets registry and the background preset download worker."""

from __future__ import annotations

import contextlib
import json
import os
import queue
import re
import shutil
import threading
from typing import Any

from .paths import _EXTENSION_ROOT, _is_absolute_any_os, _unicanvas_runtime_temp_root


_PRESET_DOWNLOAD_STATUS: dict[str, dict[str, Any]] = {}
_PRESET_DOWNLOAD_QUEUE: queue.Queue[tuple[str, dict[str, Any]]] = queue.Queue()
_PRESET_DOWNLOAD_WORKER_LOCK = threading.Lock()
_PRESET_DOWNLOAD_WORKER: threading.Thread | None = None
_PRESET_DOWNLOAD_TIMEOUT = (10, 60)
_PRESET_MODEL_FILE_EXTENSIONS = {".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin"}
_PRESET_MODEL_SETTING_KEYS = {
    "generation_mode",
    "model_loader",
    "ckpt_name",
    "diffusion_model_name",
    "gguf_model_name",
    "clip_name",
    "vae_name",
    "clip_type",
    "krea2_edit_lora_name",
}
_PRESET_MIN_MODEL_FILE_SIZE = 1024
_PRESET_DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024 * 1024


def _unicanvas_presets_path() -> str:
    return os.path.join(_EXTENSION_ROOT, "config", "unicanvas_presets.json")


def _unicanvas_models_root() -> str:
    try:
        import folder_paths

        base = getattr(folder_paths, "base_path", os.getcwd())
        return os.path.abspath(getattr(folder_paths, "models_dir", os.path.join(base, "models")))
    except Exception:
        return os.path.abspath(os.path.join(os.getcwd(), "models"))


def _unicanvas_temp_dir() -> str:
    try:
        import folder_paths

        base = getattr(folder_paths, "base_path", os.getcwd())
        temp_dir = getattr(folder_paths, "get_temp_directory", lambda: os.path.join(base, "temp"))()
        return os.path.abspath(temp_dir)
    except Exception:
        return _unicanvas_runtime_temp_root()


def _unicanvas_max_download_bytes() -> int:
    return _PRESET_DEFAULT_MAX_DOWNLOAD_BYTES


def _unicanvas_validate_model_filename(path: str) -> None:
    ext = os.path.splitext(str(path or ""))[1].lower()
    if ext not in _PRESET_MODEL_FILE_EXTENSIONS:
        allowed = ", ".join(sorted(_PRESET_MODEL_FILE_EXTENSIONS))
        raise ValueError(f"Unsupported model file extension '{ext}'. Allowed: {allowed}")


def _unicanvas_resolve_local_model_path(local_path: str) -> str:
    normalized = str(local_path or "").strip().replace("\\", "/")
    if not normalized:
        raise ValueError("Preset asset local_path is required")
    if _is_absolute_any_os(normalized):
        raise ValueError("Preset asset local_path must be relative")
    parts = [part for part in normalized.split("/") if part]
    if len(parts) < 3 or parts[0] != "models":
        raise ValueError("Preset asset local_path must use 'models/<folder>/<file>'")
    if any(part in {".", ".."} for part in parts):
        raise ValueError("Preset asset local_path contains path traversal")
    _unicanvas_validate_model_filename(parts[-1])
    root = _unicanvas_models_root()
    target = os.path.abspath(os.path.join(root, *parts[1:]))
    if os.path.commonpath([root, target]) != root:
        raise ValueError("Preset asset local_path escapes ComfyUI models directory")
    return target


def _unicanvas_asset_rel_name(local_path: str) -> str:
    normalized = str(local_path or "").strip().replace("\\", "/")
    parts = [part for part in normalized.split("/") if part]
    if len(parts) < 3 or parts[0] != "models":
        return os.path.basename(normalized)
    folder = parts[1]
    tail = "/".join(parts[2:])
    if folder in {"checkpoints", "loras"}:
        return tail
    return os.path.basename(tail)


def _unicanvas_load_preset_registry() -> dict[str, Any]:
    path = _unicanvas_presets_path()
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    presets = data.get("presets") if isinstance(data, dict) else None
    if not isinstance(presets, list):
        raise ValueError("unicanvas_presets.json must contain a presets array")
    return {"presets": presets}


def _unicanvas_enrich_asset(entry: dict[str, Any], download_key: str) -> dict[str, Any]:
    enriched = dict(entry)
    local_path = str(enriched.get("local_path") or "")
    target_path = _unicanvas_resolve_local_model_path(local_path) if local_path else ""
    status = _PRESET_DOWNLOAD_STATUS.get(download_key) or {}
    enriched["download_key"] = download_key
    enriched["relative_name"] = _unicanvas_asset_rel_name(local_path)
    enriched["installed"] = bool(target_path and os.path.exists(target_path))
    enriched["status"] = status.get("status") or ("installed" if enriched["installed"] else "missing")
    enriched["message"] = status.get("message") or ("Installed" if enriched["installed"] else "Missing")
    if "progress" in status:
        enriched["progress"] = status.get("progress")
    return enriched


def _get_unicanvas_presets() -> dict[str, Any]:
    registry = _unicanvas_load_preset_registry()
    presets = []
    for raw_preset in registry.get("presets", []):
        if not isinstance(raw_preset, dict):
            continue
        preset = dict(raw_preset)
        preset_id = str(preset.get("id") or "")
        assets = []
        for index, raw_asset in enumerate(preset.get("assets") or []):
            if isinstance(raw_asset, dict):
                assets.append(_unicanvas_enrich_asset(raw_asset, f"{preset_id}:asset:{index}"))
        preset["assets"] = assets
        turbo = preset.get("turbo")
        if isinstance(turbo, dict) and isinstance(turbo.get("asset"), dict):
            turbo = dict(turbo)
            turbo["asset"] = _unicanvas_enrich_asset(turbo["asset"], f"{preset_id}:turbo")
            preset["turbo"] = turbo
        preset["installed"] = bool(assets) and all(bool(asset.get("installed")) for asset in assets)
        if not assets:
            preset["installed"] = False
            preset["status"] = "manual"
            preset["message"] = "Preset only"
        elif any(asset.get("status") in {"queued", "downloading"} for asset in assets):
            preset["status"] = "downloading"
            preset["message"] = "Downloading"
        elif preset["installed"]:
            preset["status"] = "installed"
            preset["message"] = "Installed"
        else:
            preset["status"] = "missing"
            preset["message"] = "Missing"
        presets.append(preset)
    return {"presets": presets, "downloads": dict(_PRESET_DOWNLOAD_STATUS)}


def _unicanvas_find_preset_asset(preset_id: str, asset_kind: str, asset_index: int = 0) -> tuple[str, dict[str, Any]]:
    registry = _unicanvas_load_preset_registry()
    for preset in registry.get("presets", []):
        if not isinstance(preset, dict) or str(preset.get("id") or "") != preset_id:
            continue
        if asset_kind == "turbo":
            turbo = preset.get("turbo")
            asset = turbo.get("asset") if isinstance(turbo, dict) else None
            if isinstance(asset, dict):
                return f"{preset_id}:turbo", asset
            raise ValueError("Preset has no turbo asset")
        assets = preset.get("assets") or []
        if asset_index < 0 or asset_index >= len(assets) or not isinstance(assets[asset_index], dict):
            raise ValueError("Preset asset not found")
        return f"{preset_id}:asset:{asset_index}", assets[asset_index]
    raise ValueError(f"Preset '{preset_id}' not found")


def _unicanvas_validate_download_response(response: Any, expected_name: str) -> tuple[int, int]:
    url = str(getattr(response, "url", "") or "")
    if not url.startswith("https://"):
        raise ValueError("Preset download URL must use HTTPS")
    total_size = int(response.headers.get("content-length", 0) or 0)
    max_bytes = _unicanvas_max_download_bytes()
    if total_size > max_bytes:
        raise ValueError(
            f"{expected_name} is too large to download safely "
            f"({total_size / (1024 * 1024 * 1024):.1f} GB, limit {max_bytes / (1024 * 1024 * 1024):.1f} GB)"
        )
    return total_size, max_bytes


def _unicanvas_validate_downloaded_file(path: str, expected_name: str) -> None:
    size = os.path.getsize(path)
    if size < _PRESET_MIN_MODEL_FILE_SIZE:
        raise ValueError(f"{expected_name} is too small to be a valid model file ({size} bytes)")
    _unicanvas_validate_model_filename(expected_name)


def _unicanvas_download_worker_loop() -> None:
    while True:
        download_key, asset = _PRESET_DOWNLOAD_QUEUE.get()
        temp_path = ""
        try:
            target_path = _unicanvas_resolve_local_model_path(str(asset.get("local_path") or ""))
            if os.path.exists(target_path):
                _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "success", "message": "Installed", "progress": 100}
                continue
            _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "downloading", "message": "Initializing", "progress": 0}
            if asset.get("url"):
                raise ValueError("Direct preset URLs are disabled; use a public Hugging Face repository asset")
            from huggingface_hub import hf_hub_download

            repo_id = str(asset.get("hf_repo") or "")
            filename = str(asset.get("hf_path") or "")
            if not repo_id or not filename:
                raise ValueError("Preset asset needs hf_repo and hf_path")
            if filename.startswith(f"{repo_id}/"):
                filename = filename[len(repo_id) + 1 :]

            expected_name = os.path.basename(target_path)
            temp_dir = _unicanvas_temp_dir()
            os.makedirs(temp_dir, exist_ok=True)
            temp_path = os.path.join(temp_dir, f"vnccs_unicanvas_{re.sub(r'[^A-Za-z0-9]+', '_', download_key)}.tmp")
            cached_path = hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                repo_type="model",
                revision=asset.get("hf_revision") or None,
                token=False,
            )
            size = os.path.getsize(cached_path)
            if size > _unicanvas_max_download_bytes():
                raise ValueError(f"{expected_name} exceeded max download size")
            shutil.copy2(cached_path, temp_path)
            _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "downloading", "message": "Validating", "progress": 99}
            _unicanvas_validate_downloaded_file(temp_path, expected_name)
            os.makedirs(os.path.dirname(target_path), exist_ok=True)
            shutil.move(temp_path, target_path)
            _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "success", "message": "Installed", "progress": 100}
        except Exception as exc:
            if temp_path and os.path.exists(temp_path):
                with contextlib.suppress(Exception):
                    os.remove(temp_path)
            _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "error", "message": str(exc)}
        finally:
            _PRESET_DOWNLOAD_QUEUE.task_done()


def _ensure_unicanvas_download_worker() -> None:
    """Start the single daemon download worker on first use instead of at import time."""
    global _PRESET_DOWNLOAD_WORKER
    with _PRESET_DOWNLOAD_WORKER_LOCK:
        if _PRESET_DOWNLOAD_WORKER is not None and _PRESET_DOWNLOAD_WORKER.is_alive():
            return
        _PRESET_DOWNLOAD_WORKER = threading.Thread(
            target=_unicanvas_download_worker_loop,
            name="vnccs-unicanvas-preset-download",
            daemon=True,
        )
        _PRESET_DOWNLOAD_WORKER.start()


def _enqueue_preset_download(download_key: str, asset: dict[str, Any]) -> None:
    _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "queued", "message": "Queued", "progress": 0}
    _ensure_unicanvas_download_worker()
    _PRESET_DOWNLOAD_QUEUE.put((download_key, asset))
