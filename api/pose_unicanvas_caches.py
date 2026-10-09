"""HTTP adapters for Pose captures, Pose animation and UniCanvas state caches, plus build identity."""
from ..nodes.posestudio import caches as pose_cache
from ..nodes.unicanvas import cache as canvas_cache, build_info
from ..nodes.shared.paths import _vnccs_safe_id

def _vnccs_content_length_ok(request, max_bytes):
    try:
        raw_length = request.headers.get("Content-Length")
        if raw_length is None:
            return not getattr(request, "can_read_body", False)
        length = int(raw_length)
    except Exception:
        return False
    return length <= int(max_bytes or 0)


def _vnccs_register_capture_cache():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.post("/vnccs/pose_captures_upload")
    async def vnccs_pose_captures_upload(request):
        try:
            if not _vnccs_content_length_ok(request, pose_cache._CAPTURE_CACHE_MAX_TOTAL_CHARS + 1024 * 1024):
                return web.json_response({"error": "captured_images payload is too large"}, status=413)
            data = await request.json()
            capture_id = data.get("capture_id")
            if not capture_id:
                return web.json_response({"error": "missing capture_id"}, status=400)
            capture_id = _vnccs_safe_id(capture_id, "capture")
            try:
                captured_images, lighting_prompts = pose_cache._vnccs_validate_capture_payload(data)
            except ValueError as exc:
                return web.json_response({"error": str(exc)}, status=413)

            pose_cache.VNCCS_CAPTURE_CACHE.pop(capture_id, None)
            pose_cache.VNCCS_CAPTURE_CACHE[capture_id] = {
                "captured_images": captured_images,
                "lighting_prompts": lighting_prompts,
            }

            # LRU eviction: keep only last _CAPTURE_CACHE_MAX entries
            while len(pose_cache.VNCCS_CAPTURE_CACHE) > pose_cache._CAPTURE_CACHE_MAX:
                oldest = next(iter(pose_cache.VNCCS_CAPTURE_CACHE))
                del pose_cache.VNCCS_CAPTURE_CACHE[oldest]

            return web.json_response({"status": "ok", "capture_id": capture_id})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/pose_captures/{capture_id}")
    async def vnccs_pose_captures_get(request):
        capture_id = _vnccs_safe_id(request.match_info["capture_id"], "capture")
        entry = pose_cache.vnccs_get_capture_cache(capture_id)
        if not entry:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(entry)


def _vnccs_register_pose_animation_cache():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.post("/vnccs/pose_animation_upload")
    async def vnccs_pose_animation_upload(request):
        try:
            if not _vnccs_content_length_ok(request, pose_cache._POSE_ANIMATION_CACHE_MAX_TOTAL_CHARS + 1024 * 1024):
                return web.json_response({"error": "animation payload is too large"}, status=413)
            data = await request.json()
            animation_id = data.get("animation_id")
            if not animation_id:
                return web.json_response({"error": "missing animation_id"}, status=400)
            animation_id = _vnccs_safe_id(animation_id, "pose_animation")
            try:
                animation, revision = pose_cache._vnccs_validate_pose_animation_payload(data)
            except ValueError as exc:
                return web.json_response({"error": str(exc)}, status=413)

            previous = pose_cache.vnccs_get_pose_animation_cache(animation_id)
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
            pose_cache._vnccs_write_pose_animation_cache_file(animation_id, entry)
            if animation_id in pose_cache.VNCCS_POSE_ANIMATION_CACHE:
                del pose_cache.VNCCS_POSE_ANIMATION_CACHE[animation_id]
            pose_cache.VNCCS_POSE_ANIMATION_CACHE[animation_id] = entry
            while len(pose_cache.VNCCS_POSE_ANIMATION_CACHE) > pose_cache._POSE_ANIMATION_CACHE_MAX:
                oldest = next(iter(pose_cache.VNCCS_POSE_ANIMATION_CACHE))
                del pose_cache.VNCCS_POSE_ANIMATION_CACHE[oldest]

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
        entry = pose_cache.vnccs_get_pose_animation_cache(animation_id)
        if not entry:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(entry, headers={"Cache-Control": "no-store"})


def _vnccs_register_unicanvas_state_cache():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.post("/vnccs/unicanvas_state_upload")
    async def vnccs_unicanvas_state_upload(request):
        try:
            if not _vnccs_content_length_ok(request, canvas_cache._UNICANVAS_STATE_CACHE_MAX_TOTAL_CHARS + 1024 * 1024):
                return web.json_response({"error": "unicanvas state payload is too large"}, status=413)
            data = await request.json()
            state_id = data.get("state_id")
            if not state_id:
                return web.json_response({"error": "missing state_id"}, status=400)
            state_id = _vnccs_safe_id(state_id, "unicanvas")
            try:
                state = canvas_cache._vnccs_validate_unicanvas_state_payload(data)
            except ValueError as exc:
                return web.json_response({"error": str(exc)}, status=413)

            revision = data.get("revision")
            if revision is not None:
                if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
                    return web.json_response({"error": "revision must be a non-negative integer"}, status=400)
                previous = canvas_cache.VNCCS_UNICANVAS_STATE_CACHE.get(state_id)
                if previous is None:
                    previous = canvas_cache._vnccs_read_unicanvas_state_cache_file(state_id)
                previous_revision = previous.get("revision", -1) if isinstance(previous, dict) else -1
                if previous_revision > revision:
                    return web.json_response({"status": "stale_ignored", "state_id": state_id})

            entry = {"state": state}
            if revision is not None:
                entry["revision"] = revision
            canvas_cache._vnccs_write_unicanvas_state_cache_file(state_id, entry)
            if state_id in canvas_cache.VNCCS_UNICANVAS_STATE_CACHE:
                del canvas_cache.VNCCS_UNICANVAS_STATE_CACHE[state_id]
            canvas_cache.VNCCS_UNICANVAS_STATE_CACHE[state_id] = entry
            while len(canvas_cache.VNCCS_UNICANVAS_STATE_CACHE) > canvas_cache._UNICANVAS_STATE_CACHE_MAX:
                oldest = next(iter(canvas_cache.VNCCS_UNICANVAS_STATE_CACHE))
                del canvas_cache.VNCCS_UNICANVAS_STATE_CACHE[oldest]

            return web.json_response({"status": "ok", "state_id": state_id})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/unicanvas/build_info")
    async def vnccs_unicanvas_build_info(request):
        return web.json_response(build_info._vnccs_unicanvas_build_info())

    @PromptServer.instance.routes.get("/vnccs/unicanvas_state/{state_id}")
    async def vnccs_unicanvas_state_get(request):
        state_id = _vnccs_safe_id(request.match_info["state_id"], "unicanvas")
        entry = canvas_cache.VNCCS_UNICANVAS_STATE_CACHE.get(state_id)
        if not entry:
            entry = canvas_cache._vnccs_read_unicanvas_state_cache_file(state_id)
        if not entry:
            return web.json_response({"error": "not found"}, status=404)
        if state_id in canvas_cache.VNCCS_UNICANVAS_STATE_CACHE:
            del canvas_cache.VNCCS_UNICANVAS_STATE_CACHE[state_id]
        canvas_cache.VNCCS_UNICANVAS_STATE_CACHE[state_id] = entry
        while len(canvas_cache.VNCCS_UNICANVAS_STATE_CACHE) > canvas_cache._UNICANVAS_STATE_CACHE_MAX:
            oldest = next(iter(canvas_cache.VNCCS_UNICANVAS_STATE_CACHE))
            del canvas_cache.VNCCS_UNICANVAS_STATE_CACHE[oldest]
        return web.json_response(entry)
