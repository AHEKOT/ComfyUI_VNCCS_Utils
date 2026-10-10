"""Model presets registry and the background preset download worker."""

from __future__ import annotations

import contextlib
import json
import os
import queue
import re
import shutil
import threading
import tempfile
from typing import Any

from .paths import (
    _EXTENSION_ROOT, _get_full_path_agnostic, _is_absolute_any_os,
    _resolve_model_filename, _safe_get_folder_paths, _validate_model_name,
)


_PRESET_DOWNLOAD_STATUS: dict[str, dict[str, Any]] = {}
_PRESET_DOWNLOAD_QUEUE: queue.Queue[tuple[str, dict[str, Any]]] = queue.Queue()
_PRESET_DOWNLOAD_WORKER_LOCK = threading.Lock()
_PRESET_DOWNLOAD_WORKER: threading.Thread | None = None
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
_PRESET_FOLDER_ALIASES = {
    "diffusion_models": ("diffusion_models", "unet"),
    "unet": ("unet", "diffusion_models"),
    "text_encoders": ("text_encoders", "clip"),
}


def _unicanvas_presets_path() -> str:
    return os.path.join(_EXTENSION_ROOT, "config", "unicanvas_presets.json")


def _unicanvas_models_root() -> str:
    try:
        import folder_paths

        base = getattr(folder_paths, "base_path", os.getcwd())
        return os.path.abspath(getattr(folder_paths, "models_dir", os.path.join(base, "models")))
    except Exception:
        return os.path.abspath(os.path.join(os.getcwd(), "models"))


def _unicanvas_max_download_bytes() -> int:
    return _PRESET_DEFAULT_MAX_DOWNLOAD_BYTES


def _unicanvas_validate_model_filename(path: str) -> None:
    ext = os.path.splitext(str(path or ""))[1].lower()
    if ext not in _PRESET_MODEL_FILE_EXTENSIONS:
        allowed = ", ".join(sorted(_PRESET_MODEL_FILE_EXTENSIONS))
        raise ValueError(f"Unsupported model file extension '{ext}'. Allowed: {allowed}")


def _unicanvas_resolve_local_model_path(local_path: str) -> str:
    _validate_model_name(local_path)
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
    root = os.path.join(_unicanvas_models_root(), parts[1])
    try:
        import folder_paths
    except ImportError:
        pass
    else:
        for category in _PRESET_FOLDER_ALIASES.get(parts[1], (parts[1],)):
            folders = _safe_get_folder_paths(folder_paths, category)
            if folders:
                root = os.path.abspath(folders[0])
                break
    target = os.path.abspath(os.path.join(root, *parts[2:]))
    if os.path.commonpath([root, target]) != root:
        raise ValueError("Preset asset local_path escapes ComfyUI models directory")
    return target


def _unicanvas_asset_rel_name(local_path: str) -> str:
    normalized = str(local_path or "").strip().replace("\\", "/")
    parts = [part for part in normalized.split("/") if part]
    if len(parts) < 3 or parts[0] != "models":
        return os.path.basename(normalized)
    return "/".join(parts[2:])


def _unicanvas_find_installed_asset(local_path: str) -> tuple[str, str]:
    target = _unicanvas_resolve_local_model_path(local_path)
    relative_name = _unicanvas_asset_rel_name(local_path)
    category = [part for part in local_path.strip().replace("\\", "/").split("/") if part][1]
    categories = _PRESET_FOLDER_ALIASES.get(category, (category,))
    try:
        import folder_paths
    except ImportError:
        return target, relative_name
    for key in categories:
        found = _get_full_path_agnostic(folder_paths, key, relative_name, require_exists=True)
        if found and os.path.isfile(found):
            return found, relative_name
    name = _resolve_model_filename(folder_paths, categories, relative_name, allow_subfolder_fallback=True)
    for key in categories:
        found = _get_full_path_agnostic(folder_paths, key, name, require_exists=True)
        if found and os.path.isfile(found):
            return found, name
    return target, relative_name


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
    target_path, relative_name = _unicanvas_find_installed_asset(local_path) if local_path else ("", "")
    status = _PRESET_DOWNLOAD_STATUS.get(download_key) or {}
    enriched["download_key"] = download_key
    enriched["relative_name"] = relative_name
    enriched["installed"] = bool(target_path and os.path.isfile(target_path))
    if not enriched["installed"] and status.get("status") == "success":
        _PRESET_DOWNLOAD_STATUS.pop(download_key, None)
        status = {}
    enriched["status"] = "installed" if enriched["installed"] else status.get("status") or "missing"
    enriched["message"] = "Installed" if enriched["installed"] else status.get("message") or "Missing"
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


def _get_unicanvas_dependencies(generation_mode: str, preset_id: str = "", clip_name: str = "", vae_name: str = "") -> dict[str, Any]:
    from .models.registry import _get_unicanvas_model_module

    module = _get_unicanvas_model_module(generation_mode)
    candidates = [preset for preset in _unicanvas_load_preset_registry()["presets"]
                  if preset.get("settings", {}).get("generation_mode") == module.key
                  and (not preset_id or preset.get("id") == preset_id)]
    if preset_id and not candidates:
        raise ValueError("Preset does not belong to the selected model family")
    custom_installed = set()
    if not preset_id:
        for role, category, name in (("clip", "text_encoders", clip_name), ("vae", "vae", vae_name)):
            if name:
                name = _validate_model_name(name)
                import folder_paths

                categories = _PRESET_FOLDER_ALIASES.get(category, (category,))
                resolved = _resolve_model_filename(folder_paths, categories, name)
                path = _unicanvas_resolve_local_model_path(f"models/{category}/{name}")
                for key in categories:
                    found = _get_full_path_agnostic(folder_paths, key, resolved, require_exists=True)
                    if found:
                        path = found
                        break
                if path and os.path.isfile(path):
                    custom_installed.add(role)
    assets = {}
    for preset in candidates:
        entries = [(f"{preset['id']}:asset:{index}", asset, True)
                   for index, asset in enumerate(preset.get("assets") or [])
                   if asset.get("role") not in {"checkpoint", "diffusion_model", "gguf"}]
        entries.extend((f"{preset['id']}:dependency:{index}", asset, bool(asset.get("required")))
                       for index, asset in enumerate(preset.get("dependencies") or []))
        turbo = preset.get("turbo", {}).get("asset")
        if turbo:
            entries.append((f"{preset['id']}:turbo", turbo, False))
        for key, asset, required in entries:
            if asset.get("role") in custom_installed:
                continue
            identity = str(asset.get("local_path") or "").replace("\\", "/").lower()
            if identity not in assets:
                enriched = _unicanvas_enrich_asset(asset, key)
                enriched["required"] = required
                assets[identity] = enriched
    return {"generation_mode": module.key, "label": module.label, "assets": list(assets.values())}


def _download_unicanvas_dependencies(payload: dict[str, Any]) -> list[str]:
    catalog = _get_unicanvas_dependencies(
        str(payload.get("generation_mode") or ""), str(payload.get("preset_id") or ""),
        str(payload.get("clip_name") or ""), str(payload.get("vae_name") or ""))
    allowed = {asset["download_key"]: asset for asset in catalog["assets"]}
    keys = payload.get("download_keys")
    if not isinstance(keys, list) or not keys or any(not isinstance(key, str) or key not in allowed for key in keys):
        raise ValueError("Select dependencies from the selected model family's catalog")
    queued = list(dict.fromkeys(keys))
    for key in queued:
        _enqueue_preset_download(key, allowed[key])
    return queued


def _unicanvas_download_progress_class(download_key: str):
    from tqdm.auto import tqdm

    class DownloadProgress(tqdm):
        def __init__(self, *args, **kwargs):
            kwargs.pop("name", None)
            kwargs["disable"] = False  # Hub transfers must keep counting even when console bars are disabled.
            super().__init__(*args, **kwargs)
            self._publish()

        def _publish(self):
            total = self.total or 0
            _PRESET_DOWNLOAD_STATUS[download_key] = {
                "status": "downloading", "message": "Downloading",
                "progress": min(98, 98 * self.n / total) if total else 0,
                "downloaded_bytes": self.n, "total_bytes": total,
            }

        def update(self, n=1):
            result = super().update(n)
            self._publish()
            return result

    return DownloadProgress


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
            installed_path, _ = _unicanvas_find_installed_asset(str(asset.get("local_path") or ""))
            if os.path.isfile(installed_path) or os.path.lexists(target_path):
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
            cached_path = hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                repo_type="model",
                revision=asset.get("hf_revision") or None,
                token=False,
                tqdm_class=_unicanvas_download_progress_class(download_key),
            )
            size = os.path.getsize(cached_path)
            if size > _unicanvas_max_download_bytes():
                raise ValueError(f"{expected_name} exceeded max download size")
            os.makedirs(os.path.dirname(target_path), exist_ok=True)
            fd, temp_path = tempfile.mkstemp(prefix=".vnccs_preset_", dir=os.path.dirname(target_path))
            os.close(fd)
            _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "downloading", "message": "Installing", "progress": 98}
            shutil.copy2(cached_path, temp_path)
            _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "downloading", "message": "Validating", "progress": 99}
            _unicanvas_validate_downloaded_file(temp_path, expected_name)
            try:
                os.link(temp_path, target_path)  # Never replace a model installed while this download was running.
            except FileExistsError:
                pass
            _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "success", "message": "Installed", "progress": 100}
        except Exception as exc:
            _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "error", "message": str(exc)}
        finally:
            if temp_path and os.path.exists(temp_path):
                with contextlib.suppress(Exception):
                    os.remove(temp_path)
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
    installed_path, _ = _unicanvas_find_installed_asset(str(asset.get("local_path") or ""))
    if os.path.isfile(installed_path):
        _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "success", "message": "Installed", "progress": 100}
        return
    if _PRESET_DOWNLOAD_STATUS.get(download_key, {}).get("status") in {"queued", "downloading"}:
        return
    _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "queued", "message": "Queued", "progress": 0}
    _ensure_unicanvas_download_worker()
    _PRESET_DOWNLOAD_QUEUE.put((download_key, asset))
