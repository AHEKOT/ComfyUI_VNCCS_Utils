"""CG Creator HTTP actions and read-only access to existing background sources."""

import asyncio
import json

from .factory3d_scene_editor import _content_length_ok
from ..nodes import cg_creator_generation as generation
from ..nodes import cg_creator_service as service
from ..nodes import cg_creator_storage as library

_REGISTERED = False


def register_routes(routes):
    global _REGISTERED
    if _REGISTERED:
        return
    from aiohttp import web
    base = service.API_BASE

    async def perform(callback, *args):
        try:
            return web.json_response(await asyncio.to_thread(callback, *args))
        except library.BackgroundConflictError as exc:
            return web.json_response({"error": str(exc)}, status=409)
        except FileNotFoundError as exc:
            return web.json_response({"error": str(exc)}, status=404)
        except (ValueError, TypeError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except RuntimeError as exc:
            return web.json_response({"error": str(exc)}, status=409)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    def respond(callback):
        async def handler(request):
            if not _content_length_ok(request, service.MAX_REQUEST_BYTES):
                raise web.HTTPRequestEntityTooLarge(max_size=service.MAX_REQUEST_BYTES, actual_size=request.content_length or 0)
            try:
                if request.content_type == "multipart/form-data":
                    post = await request.post()
                    raw = str(post.get("data", "{}"))
                    field = post.get("image")
                    image = await asyncio.to_thread(field.file.read, service.MAX_REQUEST_BYTES + 1) if hasattr(field, "file") else None
                    if image is not None and len(image) > service.MAX_REQUEST_BYTES:
                        raise ValueError("Camera frame upload is too large")
                else:
                    raw, image = await request.read(), None
                if len(raw) > 256 * 1024:
                    raise ValueError("CG settings are too large")
                payload = json.loads(raw or "{}")
                if not isinstance(payload, dict):
                    raise ValueError("CG request must be an object")
            except (ValueError, TypeError) as exc:
                return web.json_response({"error": str(exc)}, status=400)
            return await perform(callback, request.match_info, payload, image)
        return handler

    @routes.get(base + "/config")
    async def config(request):
        return await perform(generation.configuration)

    @routes.get(base + "/backgrounds")
    async def backgrounds(request):
        return await perform(lambda: {"backgrounds": [service.public_document(item) for item in library.list_backgrounds()]})

    @routes.get(base + "/backgrounds/{background_id}")
    async def background(request):
        return await perform(lambda: service.public_document(library.load_background(request.match_info["background_id"])))

    @routes.patch(base + "/backgrounds/{background_id}")
    @respond
    def save(info, payload, image):
        return service.save_settings(info["background_id"], payload)

    @routes.post(base + "/backgrounds/{background_id}/jobs")
    @respond
    def job(info, payload, image):
        return service.start_job(info["background_id"], payload, image)

    @routes.get(base + "/jobs/{job_id}")
    async def status(request):
        return await perform(service.job_status, request.match_info["job_id"])

    @routes.post(base + "/jobs/{job_id}/cancel")
    @respond
    def cancel(info, payload, image):
        return service.cancel_job(info["job_id"])

    async def serve(request, callback):
        try:
            return web.FileResponse(await asyncio.to_thread(callback), headers={"Cache-Control": "private, max-age=31536000, immutable"})
        except (ValueError, TypeError, FileNotFoundError) as exc:
            return web.json_response({"error": str(exc)}, status=404)

    @routes.get(base + "/backgrounds/{background_id}/images/{image_id}")
    async def source_image(request):
        info = request.match_info
        return await serve(request, lambda: library.image_path(info["background_id"], info["image_id"]))

    @routes.get(base + "/backgrounds/{background_id}/models/{model_id}")
    async def model(request):
        return await perform(service.public_model, request.match_info["background_id"], request.match_info["model_id"])

    @routes.get(base + "/backgrounds/{background_id}/models/{model_id}/objects/{object_id}/{kind}")
    async def asset(request):
        info = request.match_info
        return await serve(request, lambda: library.model_asset_path(info["background_id"], info["model_id"], info["object_id"], info["kind"]))

    @routes.get(base + "/backgrounds/{background_id}/cg/{cg_id}/{kind}")
    async def cg_image(request):
        info = request.match_info
        return await serve(request, lambda: library.cg_image_path(info["background_id"], info["cg_id"], info["kind"]))

    _REGISTERED = True
