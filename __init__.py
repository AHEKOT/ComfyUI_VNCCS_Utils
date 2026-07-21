from .nodes.vnccs_nodes import VNCCS_PositionControl, VNCCS_VisualPositionControl
from .nodes.vnccs_qwen_detailer import VNCCS_QWEN_Detailer, VNCCS_BBox_Extractor
from .nodes.vnccs_model_manager import VNCCS_ModelManager, VNCCS_ModelSelector
from .nodes.pose_studio import VNCCS_PoseStudio
from .nodes.unicanvas import VNCCS_UniCanvas, register_unicanvas_routes

NODE_CLASS_MAPPINGS = {
    "VNCCS_PositionControl": VNCCS_PositionControl,
    "VNCCS_VisualPositionControl": VNCCS_VisualPositionControl,
    "VNCCS_QWEN_Detailer": VNCCS_QWEN_Detailer,
    "VNCCS_BBox_Extractor": VNCCS_BBox_Extractor,
    "VNCCS_ModelManager": VNCCS_ModelManager,
    "VNCCS_ModelSelector": VNCCS_ModelSelector,
    "VNCCS_PoseStudio": VNCCS_PoseStudio,
    "VNCCS_UniCanvas": VNCCS_UniCanvas,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VNCCS_PositionControl": "VNCCS Position Control",
    "VNCCS_VisualPositionControl": "VNCCS Visual Camera Control",
    "VNCCS_QWEN_Detailer": "VNCCS QWEN Detailer",
    "VNCCS_BBox_Extractor": "VNCCS BBox Extractor",
    "VNCCS_ModelManager": "VNCCS Model Manager",
    "VNCCS_ModelSelector": "VNCCS Model Selector",
    "VNCCS_PoseStudio": "VNCCS Pose Studio",
    "VNCCS_UniCanvas": "VNCCS UniCanvas",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]


# === API Endpoint Registration for Pose Studio ===
import os
import json
import re
import numpy as np
import tempfile
import time

_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]+")
_CAPTURE_CACHE_MAX_IMAGES = 600
_CAPTURE_CACHE_MAX_TOTAL_CHARS = 64 * 1024 * 1024
_POSE_ANIMATION_CACHE_MAX = 24
_POSE_ANIMATION_CACHE_MAX_TOTAL_CHARS = 48 * 1024 * 1024
_POSE_ANIMATION_CACHE_MAX_KEYS = 300_000
_POSE_ANIMATION_CACHE_DIR = os.path.join(tempfile.gettempdir(), "vnccs_pose_animation_cache")
_POSE_ANIMATION_DISK_CACHE_MAX_FILES = 256
_POSE_ANIMATION_DISK_CACHE_MAX_BYTES = 512 * 1024 * 1024
_UNICANVAS_STATE_CACHE_MAX = 10
_UNICANVAS_STATE_CACHE_MAX_TOTAL_CHARS = 96 * 1024 * 1024
_UNICANVAS_STATE_CACHE_DIR = os.path.join(tempfile.gettempdir(), "vnccs_unicanvas_state_cache")
_UNICANVAS_STATE_DISK_CACHE_MAX_FILES = 64
_UNICANVAS_STATE_DISK_CACHE_MAX_BYTES = 1024 * 1024 * 1024
_DISK_CACHE_TTL_SECONDS = 180 * 24 * 60 * 60
_SAM3D_MAX_UPLOAD_BYTES = 32 * 1024 * 1024
_SAM3D_MAX_PIXELS = 4096 * 4096


def _vnccs_content_length_ok(request, max_bytes):
    try:
        raw_length = request.headers.get("Content-Length")
        if raw_length is None:
            return not getattr(request, "can_read_body", False)
        length = int(raw_length)
    except Exception:
        return False
    return length <= int(max_bytes or 0)

def _vnccs_safe_id(value, fallback="item"):
    cleaned = _SAFE_ID_RE.sub("_", str(value or "")).strip("_")
    return cleaned[:128] or fallback

def _vnccs_prune_cache_dir(directory, max_files, max_total_bytes, protected_path=None):
    """Bound temporary disk caches without removing the file just written."""
    now = time.time()
    protected_path = os.path.abspath(protected_path) if protected_path else None
    files = []
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return
    for entry in entries:
        try:
            if not entry.is_file(follow_symlinks=False):
                continue
            stat = entry.stat(follow_symlinks=False)
            path = os.path.abspath(entry.path)
            age = max(0.0, now - stat.st_mtime)
            if entry.name.endswith(".tmp"):
                if age > 60 * 60:
                    os.unlink(entry.path)
                continue
            if not entry.name.endswith(".json"):
                continue
            if path != protected_path and age > _DISK_CACHE_TTL_SECONDS:
                os.unlink(entry.path)
                continue
            files.append([stat.st_mtime, stat.st_size, entry.path, path])
        except OSError:
            continue

    files.sort(key=lambda item: item[0])
    total_bytes = sum(item[1] for item in files)
    blocked_paths = set()
    while len(files) > max_files or total_bytes > max_total_bytes:
        removable_index = next((
            index
            for index, item in enumerate(files)
            if item[3] != protected_path and item[3] not in blocked_paths
        ), None)
        if removable_index is None:
            break
        _, size, path, absolute_path = files[removable_index]
        try:
            os.unlink(path)
            files.pop(removable_index)
            total_bytes -= size
        except OSError:
            blocked_paths.add(absolute_path)

def _vnccs_validate_capture_payload(data):
    captured_images = data.get("captured_images", [])
    lighting_prompts = data.get("lighting_prompts", [])
    if not isinstance(captured_images, list):
        raise ValueError("captured_images must be a list")
    if len(captured_images) > _CAPTURE_CACHE_MAX_IMAGES:
        raise ValueError(f"captured_images limit is {_CAPTURE_CACHE_MAX_IMAGES}")
    total_chars = 0
    for image in captured_images:
        if not isinstance(image, str):
            raise ValueError("captured_images entries must be strings")
        total_chars += len(image)
        if total_chars > _CAPTURE_CACHE_MAX_TOTAL_CHARS:
            raise ValueError("captured_images payload is too large")
    if not isinstance(lighting_prompts, list):
        lighting_prompts = []
    lighting_prompts = [str(prompt)[:4096] for prompt in lighting_prompts[:_CAPTURE_CACHE_MAX_IMAGES]]
    return captured_images, lighting_prompts

def _vnccs_validate_pose_animation_payload(data):
    animation = data.get("animation")
    if not isinstance(animation, dict):
        raise ValueError("animation must be an object")
    tracks = animation.get("tracks", {})
    if not isinstance(tracks, dict):
        raise ValueError("animation.tracks must be an object")
    total_keys = 0
    for track in tracks.values():
        if not isinstance(track, dict):
            continue
        keys = track.get("keys", [])
        if not isinstance(keys, list):
            raise ValueError("animation track keys must be a list")
        total_keys += len(keys)
        if total_keys > _POSE_ANIMATION_CACHE_MAX_KEYS:
            raise ValueError(f"animation key limit is {_POSE_ANIMATION_CACHE_MAX_KEYS}")
    raw = json.dumps(animation, ensure_ascii=False, separators=(",", ":"))
    if len(raw) > _POSE_ANIMATION_CACHE_MAX_TOTAL_CHARS:
        raise ValueError("animation payload is too large")
    try:
        revision = max(0, int(data.get("revision", 0) or 0))
    except (TypeError, ValueError):
        revision = 0
    return animation, revision

def _vnccs_validate_unicanvas_state_payload(data):
    state = data.get("state")
    if not isinstance(state, dict):
        raise ValueError("state must be an object")
    layers = state.get("layers", [])
    if not isinstance(layers, list):
        raise ValueError("state.layers must be a list")
    raw = json.dumps(state, ensure_ascii=False)
    if len(raw) > _UNICANVAS_STATE_CACHE_MAX_TOTAL_CHARS:
        raise ValueError("unicanvas state payload is too large")
    return state

# Register Pose Library API
def _vnccs_register_pose_library():
    try:
        from server import PromptServer
        from .api.pose_library import register_routes
        register_routes(PromptServer.instance.app)
    except Exception as e:
        print(f"[VNCCS] Failed to register Pose Library API: {e}")

_vnccs_register_pose_library()


# Register Pose Studio runtime synchronization API
def _vnccs_register_pose_sync():
    try:
        from server import PromptServer
        from .api.pose_sync import register_routes
        register_routes(PromptServer.instance.app)
    except Exception as e:
        print(f"[VNCCS] Failed to register Pose Sync API: {e}")

_vnccs_register_pose_sync()


# === Pose Studio Capture Cache ===
VNCCS_CAPTURE_CACHE = {}
_CAPTURE_CACHE_MAX = 10

def vnccs_get_capture_cache(capture_id):
    capture_id = _vnccs_safe_id(capture_id, "capture")
    entry = VNCCS_CAPTURE_CACHE.pop(capture_id, None)
    if entry is not None:
        VNCCS_CAPTURE_CACHE[capture_id] = entry
    return entry

def _vnccs_register_capture_cache():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.post("/vnccs/pose_captures_upload")
    async def vnccs_pose_captures_upload(request):
        try:
            if not _vnccs_content_length_ok(request, _CAPTURE_CACHE_MAX_TOTAL_CHARS + 1024 * 1024):
                return web.json_response({"error": "captured_images payload is too large"}, status=413)
            data = await request.json()
            capture_id = data.get("capture_id")
            if not capture_id:
                return web.json_response({"error": "missing capture_id"}, status=400)
            capture_id = _vnccs_safe_id(capture_id, "capture")
            try:
                captured_images, lighting_prompts = _vnccs_validate_capture_payload(data)
            except ValueError as exc:
                return web.json_response({"error": str(exc)}, status=413)

            VNCCS_CAPTURE_CACHE.pop(capture_id, None)
            VNCCS_CAPTURE_CACHE[capture_id] = {
                "captured_images": captured_images,
                "lighting_prompts": lighting_prompts,
            }

            # LRU eviction: keep only last _CAPTURE_CACHE_MAX entries
            while len(VNCCS_CAPTURE_CACHE) > _CAPTURE_CACHE_MAX:
                oldest = next(iter(VNCCS_CAPTURE_CACHE))
                del VNCCS_CAPTURE_CACHE[oldest]

            return web.json_response({"status": "ok", "capture_id": capture_id})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/pose_captures/{capture_id}")
    async def vnccs_pose_captures_get(request):
        capture_id = _vnccs_safe_id(request.match_info["capture_id"], "capture")
        entry = vnccs_get_capture_cache(capture_id)
        if not entry:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(entry)

_vnccs_register_capture_cache()


# === Pose Studio Animation Cache ===
VNCCS_POSE_ANIMATION_CACHE = {}

def _vnccs_pose_animation_cache_path(animation_id):
    safe_id = _vnccs_safe_id(animation_id, "pose_animation")
    return os.path.join(_POSE_ANIMATION_CACHE_DIR, f"{safe_id}.json")

def _vnccs_write_pose_animation_cache_file(animation_id, entry):
    os.makedirs(_POSE_ANIMATION_CACHE_DIR, exist_ok=True)
    path = _vnccs_pose_animation_cache_path(animation_id)
    temp_path = f"{path}.tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(entry, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temp_path, path)
    _vnccs_prune_cache_dir(
        _POSE_ANIMATION_CACHE_DIR,
        _POSE_ANIMATION_DISK_CACHE_MAX_FILES,
        _POSE_ANIMATION_DISK_CACHE_MAX_BYTES,
        protected_path=path,
    )

def _vnccs_read_pose_animation_cache_file(animation_id):
    path = _vnccs_pose_animation_cache_path(animation_id)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        entry = json.load(handle)
    try:
        os.utime(path, None)
    except OSError:
        pass
    return entry if isinstance(entry, dict) else None

def vnccs_get_pose_animation_cache(animation_id):
    animation_id = _vnccs_safe_id(animation_id, "pose_animation")
    entry = VNCCS_POSE_ANIMATION_CACHE.get(animation_id)
    if entry is None:
        entry = _vnccs_read_pose_animation_cache_file(animation_id)
    if not isinstance(entry, dict):
        return None
    if animation_id in VNCCS_POSE_ANIMATION_CACHE:
        del VNCCS_POSE_ANIMATION_CACHE[animation_id]
    VNCCS_POSE_ANIMATION_CACHE[animation_id] = entry
    while len(VNCCS_POSE_ANIMATION_CACHE) > _POSE_ANIMATION_CACHE_MAX:
        oldest = next(iter(VNCCS_POSE_ANIMATION_CACHE))
        del VNCCS_POSE_ANIMATION_CACHE[oldest]
    return entry

def _vnccs_register_pose_animation_cache():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.post("/vnccs/pose_animation_upload")
    async def vnccs_pose_animation_upload(request):
        try:
            if not _vnccs_content_length_ok(request, _POSE_ANIMATION_CACHE_MAX_TOTAL_CHARS + 1024 * 1024):
                return web.json_response({"error": "animation payload is too large"}, status=413)
            data = await request.json()
            animation_id = data.get("animation_id")
            if not animation_id:
                return web.json_response({"error": "missing animation_id"}, status=400)
            animation_id = _vnccs_safe_id(animation_id, "pose_animation")
            try:
                animation, revision = _vnccs_validate_pose_animation_payload(data)
            except ValueError as exc:
                return web.json_response({"error": str(exc)}, status=413)

            previous = vnccs_get_pose_animation_cache(animation_id)
            previous_revision = int(previous.get("revision", -1)) if isinstance(previous, dict) else -1
            if previous_revision > revision:
                return web.json_response({
                    "status": "stale_ignored",
                    "animation_id": animation_id,
                    "revision": previous_revision,
                })

            entry = {
                "animation": animation,
                "revision": revision,
            }
            if animation_id in VNCCS_POSE_ANIMATION_CACHE:
                del VNCCS_POSE_ANIMATION_CACHE[animation_id]
            VNCCS_POSE_ANIMATION_CACHE[animation_id] = entry
            _vnccs_write_pose_animation_cache_file(animation_id, entry)
            while len(VNCCS_POSE_ANIMATION_CACHE) > _POSE_ANIMATION_CACHE_MAX:
                oldest = next(iter(VNCCS_POSE_ANIMATION_CACHE))
                del VNCCS_POSE_ANIMATION_CACHE[oldest]

            return web.json_response({
                "status": "ok",
                "animation_id": animation_id,
                "revision": revision,
            })
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/pose_animation/{animation_id}")
    async def vnccs_pose_animation_get(request):
        animation_id = _vnccs_safe_id(request.match_info["animation_id"], "pose_animation")
        entry = vnccs_get_pose_animation_cache(animation_id)
        if not entry:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(entry, headers={"Cache-Control": "no-store"})

_vnccs_register_pose_animation_cache()


# === UniCanvas State Cache ===
VNCCS_UNICANVAS_STATE_CACHE = {}

def _vnccs_unicanvas_state_cache_path(state_id):
    safe_id = _vnccs_safe_id(state_id, "unicanvas")
    return os.path.join(_UNICANVAS_STATE_CACHE_DIR, f"{safe_id}.json")

def _vnccs_write_unicanvas_state_cache_file(state_id, entry):
    os.makedirs(_UNICANVAS_STATE_CACHE_DIR, exist_ok=True)
    path = _vnccs_unicanvas_state_cache_path(state_id)
    temp_path = f"{path}.tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(entry, handle, ensure_ascii=False)
    os.replace(temp_path, path)
    _vnccs_prune_cache_dir(
        _UNICANVAS_STATE_CACHE_DIR,
        _UNICANVAS_STATE_DISK_CACHE_MAX_FILES,
        _UNICANVAS_STATE_DISK_CACHE_MAX_BYTES,
        protected_path=path,
    )

def _vnccs_read_unicanvas_state_cache_file(state_id):
    path = _vnccs_unicanvas_state_cache_path(state_id)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        entry = json.load(handle)
    try:
        os.utime(path, None)
    except OSError:
        pass
    return entry

def _vnccs_register_unicanvas_state_cache():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.post("/vnccs/unicanvas_state_upload")
    async def vnccs_unicanvas_state_upload(request):
        try:
            if not _vnccs_content_length_ok(request, _UNICANVAS_STATE_CACHE_MAX_TOTAL_CHARS + 1024 * 1024):
                return web.json_response({"error": "unicanvas state payload is too large"}, status=413)
            data = await request.json()
            state_id = data.get("state_id")
            if not state_id:
                return web.json_response({"error": "missing state_id"}, status=400)
            state_id = _vnccs_safe_id(state_id, "unicanvas")
            try:
                state = _vnccs_validate_unicanvas_state_payload(data)
            except ValueError as exc:
                return web.json_response({"error": str(exc)}, status=413)

            entry = {"state": state}
            if state_id in VNCCS_UNICANVAS_STATE_CACHE:
                del VNCCS_UNICANVAS_STATE_CACHE[state_id]
            VNCCS_UNICANVAS_STATE_CACHE[state_id] = entry
            _vnccs_write_unicanvas_state_cache_file(state_id, entry)
            while len(VNCCS_UNICANVAS_STATE_CACHE) > _UNICANVAS_STATE_CACHE_MAX:
                oldest = next(iter(VNCCS_UNICANVAS_STATE_CACHE))
                del VNCCS_UNICANVAS_STATE_CACHE[oldest]

            return web.json_response({"status": "ok", "state_id": state_id})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/unicanvas_state/{state_id}")
    async def vnccs_unicanvas_state_get(request):
        state_id = _vnccs_safe_id(request.match_info["state_id"], "unicanvas")
        entry = VNCCS_UNICANVAS_STATE_CACHE.get(state_id)
        if not entry:
            entry = _vnccs_read_unicanvas_state_cache_file(state_id)
        if not entry:
            return web.json_response({"error": "not found"}, status=404)
        if state_id in VNCCS_UNICANVAS_STATE_CACHE:
            del VNCCS_UNICANVAS_STATE_CACHE[state_id]
        VNCCS_UNICANVAS_STATE_CACHE[state_id] = entry
        while len(VNCCS_UNICANVAS_STATE_CACHE) > _UNICANVAS_STATE_CACHE_MAX:
            oldest = next(iter(VNCCS_UNICANVAS_STATE_CACHE))
            del VNCCS_UNICANVAS_STATE_CACHE[oldest]
        return web.json_response(entry)

_vnccs_register_unicanvas_state_cache()
register_unicanvas_routes()


def _vnccs_register_sam3d_pose_import():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.get("/vnccs/sam3d/import_status/{task_id}")
    async def vnccs_sam3d_import_status(request):
        try:
            from .vnccs_sam3d import progress

            return web.json_response(progress.get_task(request.match_info["task_id"]))
        except Exception as e:
            return web.json_response({
                "status": "unknown",
                "message": str(e),
                "progress": 0,
            })

    @PromptServer.instance.routes.post("/vnccs/sam3d/process_image_to_pose_json")
    async def vnccs_sam3d_process_image_to_pose_json(request):
        try:
            import io
            import json
            import asyncio
            import torch
            from PIL import Image

            if not _vnccs_content_length_ok(request, _SAM3D_MAX_UPLOAD_BYTES + 1024 * 1024):
                return web.json_response({"error": "image upload is too large"}, status=413)
            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                return web.json_response({"error": "missing image"}, status=400)
            task_id = str(post.get("task_id") or "")

            image_bytes = image_field.file.read()
            if len(image_bytes) > _SAM3D_MAX_UPLOAD_BYTES:
                return web.json_response({"error": "image upload is too large"}, status=413)
            pil_image = Image.open(io.BytesIO(image_bytes))
            if pil_image.width * pil_image.height > _SAM3D_MAX_PIXELS:
                return web.json_response({"error": "image dimensions are too large"}, status=413)
            pil_image = pil_image.convert("RGB")
            image_np = np.asarray(pil_image).astype(np.float32) / 255.0
            image_tensor = torch.from_numpy(image_np).unsqueeze(0)

            def run_sam3d_process():
                from .vnccs_sam3d import process_image_to_pose_json, progress

                progress.start_task(task_id)
                with progress.task_context(task_id):
                    progress.update("Step 1/6: Image uploaded. Preparing SAM 3D Body import...", 2)
                    return process_image_to_pose_json(image_tensor)

            pose_json = await asyncio.to_thread(run_sam3d_process)

            try:
                pose_data = json.loads(pose_json)
            except Exception:
                pose_data = None

            return web.json_response({
                "status": "success",
                "pose_json": pose_json,
                "pose_data": pose_data,
            })
        except Exception as e:
            try:
                from .vnccs_sam3d import progress
                with progress.task_context(task_id if "task_id" in locals() else ""):
                    progress.fail(str(e))
            except Exception:
                pass
            import traceback
            traceback.print_exc()
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/vnccs/sam3d/render_mesh_overlay")
    async def vnccs_sam3d_render_mesh_overlay(request):
        try:
            import asyncio

            if not _vnccs_content_length_ok(request, 32 * 1024 * 1024):
                return web.json_response({"error": "mesh overlay payload is too large"}, status=413)
            data = await request.json()
            pose_data = data.get("pose_data")
            if not isinstance(pose_data, dict):
                return web.json_response({"error": "missing pose_data"}, status=400)
            body_preset = data.get("body_preset") if isinstance(data.get("body_preset"), dict) else {}
            pose_adjust = float(data.get("pose_adjust") or 0.0)

            def build_overlay():
                from .vnccs_sam3d.pose_import import process_pose_json_to_overlay_mesh

                return process_pose_json_to_overlay_mesh(
                    pose_data,
                    body_preset=body_preset,
                    pose_adjust=pose_adjust,
                )

            mesh_data = await asyncio.to_thread(build_overlay)
            return web.json_response({"status": "success", "mesh": mesh_data})
        except Exception as e:
            import traceback
            traceback.print_exc()
            return web.json_response({"error": str(e)}, status=500)


_vnccs_register_sam3d_pose_import()
