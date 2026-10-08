"""Pose captures and durable workflow assets, independent of model runtimes."""

import json
import os
import re

_EXTENSION_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]+")
_CAPTURE_CACHE_MAX_IMAGES = 600
_CAPTURE_CACHE_MAX_TOTAL_CHARS = 64 * 1024 * 1024
_POSE_ANIMATION_CACHE_MAX = 24
_POSE_ANIMATION_CACHE_MAX_TOTAL_CHARS = 48 * 1024 * 1024
_POSE_ANIMATION_CACHE_MAX_KEYS = 300_000

def _vnccs_runtime_temp_root():
    try:
        import folder_paths

        root = folder_paths.get_temp_directory()
    except Exception:
        root = os.path.join(_EXTENSION_ROOT, ".runtime_cache")
    os.makedirs(root, exist_ok=True)
    return root

_UNICANVAS_STATE_CACHE_MAX = 10
_UNICANVAS_STATE_CACHE_MAX_TOTAL_CHARS = 96 * 1024 * 1024

def _vnccs_user_data_root():
    # ComfyUI wipes its temp directory on every start, so anything that must survive a restart
    # lives in the user directory instead.
    try:
        import folder_paths

        root = folder_paths.get_user_directory()
    except Exception:
        root = os.path.join(_EXTENSION_ROOT, ".runtime_cache", "user")
    root = os.path.join(root, "vnccs")
    os.makedirs(root, exist_ok=True)
    return root

_UNICANVAS_STATE_CACHE_DIR = os.path.join(_vnccs_user_data_root(), "unicanvas_state_cache")
_POSE_ANIMATION_CACHE_DIR = os.path.join(_vnccs_user_data_root(), "pose_animation_cache")
_POSE_ANIMATION_LEGACY_CACHE_DIR = os.path.join(_vnccs_runtime_temp_root(), "vnccs_pose_animation_cache")
_UNICANVAS_LEGACY_STATE_CACHE_DIR = os.path.join(_vnccs_runtime_temp_root(), "vnccs_unicanvas_state_cache")

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
    return cleaned[:128].rstrip("_") or fallback

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
    total_keys = 0
    animations = [animation]
    character_animations = animation.get("characterAnimations", [])
    if character_animations is not None:
        if not isinstance(character_animations, list) or len(character_animations) > 3:
            raise ValueError("animation.characterAnimations must contain at most three entries")
        for entry in character_animations:
            nested = entry.get("animation") if isinstance(entry, dict) else None
            if not isinstance(nested, dict):
                raise ValueError("character animation must be an object")
            animations.append(nested)
    for clip in animations:
        tracks = clip.get("tracks", {})
        if not isinstance(tracks, dict):
            raise ValueError("animation.tracks must be an object")
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

def _vnccs_read_pose_animation_cache_file(animation_id):
    path = _vnccs_pose_animation_cache_path(animation_id)
    from_legacy = False
    if not os.path.exists(path):
        legacy = os.path.join(_POSE_ANIMATION_LEGACY_CACHE_DIR, os.path.basename(path))
        if not os.path.exists(legacy):
            return None
        path = legacy
        from_legacy = True
    with open(path, "r", encoding="utf-8") as handle:
        entry = json.load(handle)
    if from_legacy:
        _vnccs_write_pose_animation_cache_file(animation_id, entry)
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

def _vnccs_read_unicanvas_state_cache_file(state_id):
    path = _vnccs_unicanvas_state_cache_path(state_id)
    from_legacy = False
    if not os.path.exists(path):
        legacy = os.path.join(_UNICANVAS_LEGACY_STATE_CACHE_DIR, os.path.basename(path))
        if not os.path.exists(legacy):
            return None
        path = legacy
        from_legacy = True
    with open(path, "r", encoding="utf-8") as handle:
        entry = json.load(handle)
    if from_legacy:
        _vnccs_write_unicanvas_state_cache_file(state_id, entry)
    try:
        os.utime(path, None)
    except OSError:
        pass
    return entry

def _vnccs_read_git_short_commit(repo_dir):
    # Resolve HEAD by reading .git files directly (no process execution).
    try:
        git_dir = os.path.join(repo_dir, ".git")
        if os.path.isfile(git_dir):
            with open(git_dir, "r", encoding="utf-8") as handle:
                pointer = handle.read().strip()
            if not pointer.startswith("gitdir:"):
                return ""
            git_dir = os.path.normpath(os.path.join(repo_dir, pointer[len("gitdir:"):].strip()))
        with open(os.path.join(git_dir, "HEAD"), "r", encoding="utf-8") as handle:
            head = handle.read().strip()
        sha = head
        if head.startswith("ref:"):
            ref = head[len("ref:"):].strip()
            sha = ""
            ref_path = os.path.normpath(os.path.join(git_dir, ref))
            if ref_path.startswith(os.path.normpath(git_dir) + os.sep) and os.path.isfile(ref_path):
                with open(ref_path, "r", encoding="utf-8") as handle:
                    sha = handle.read().strip()
            else:
                packed = os.path.join(git_dir, "packed-refs")
                if os.path.isfile(packed):
                    with open(packed, "r", encoding="utf-8") as handle:
                        for line in handle:
                            parts = line.strip().split(" ", 1)
                            if len(parts) == 2 and parts[1] == ref:
                                sha = parts[0]
                                break
        if len(sha) >= 7 and all(c in "0123456789abcdef" for c in sha.lower()):
            return sha[:7]
    except Exception:
        pass
    return ""

def _vnccs_unicanvas_build_info():
    # Debug identity for the UI: git commit (when the checkout has .git) plus the
    # same newest-mtime version the frontend staleness gate compares against.
    # The commit is read per call (cheap, once per popover open) so it can never
    # go stale after new commits land without a server restart.
    commit = _vnccs_read_git_short_commit(_EXTENSION_ROOT)
    version = 0
    try:
        import re
        web_dir = os.path.join(_EXTENSION_ROOT, "web")
        pattern = re.compile(r"^vnccs_(unicanvas|custom_select|pose_studio).*\.(js|mjs)$")
        for name in os.listdir(web_dir):
            if pattern.match(name):
                version = max(version, int(os.stat(os.path.join(web_dir, name)).st_mtime * 1000))
    except Exception:
        pass
    return {"commit": commit or None, "version": str(version)}

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

            revision = data.get("revision")
            if revision is not None:
                if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
                    return web.json_response({"error": "revision must be a non-negative integer"}, status=400)
                previous = VNCCS_UNICANVAS_STATE_CACHE.get(state_id)
                if previous is None:
                    previous = _vnccs_read_unicanvas_state_cache_file(state_id)
                previous_revision = previous.get("revision", -1) if isinstance(previous, dict) else -1
                if previous_revision > revision:
                    return web.json_response({"status": "stale_ignored", "state_id": state_id})

            entry = {"state": state}
            if revision is not None:
                entry["revision"] = revision
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

    @PromptServer.instance.routes.get("/vnccs/unicanvas/build_info")
    async def vnccs_unicanvas_build_info(request):
        return web.json_response(_vnccs_unicanvas_build_info())

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
