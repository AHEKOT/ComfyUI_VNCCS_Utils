"""HTTP upload, publication and status of Factory conditioning captures."""
import json
from ..nodes.factory3d import conditioning
from .factory3d_scene_editor import _content_length_ok

def register_routes(routes, backend):
    from aiohttp import web
    import asyncio

    base = backend.API_BASE + "/conditioning/{scene_id}/jobs/{job_id}"

    @routes.get(base)
    async def get_job(request):
        try:
            job = await asyncio.to_thread(conditioning.read_job, backend, request.match_info["scene_id"], request.match_info["job_id"])
            await asyncio.to_thread(conditioning._snapshot, backend, job["handle"], True)
            return web.json_response(job)
        except (ValueError, FileNotFoundError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.post(base + "/shots/{index}")
    async def upload_shot(request):
        try:
            if not _content_length_ok(request, 130 * 1024 * 1024):
                raise ValueError("Conditioning upload is too large")
            post = await request.post()
            sources = {}
            for name in conditioning.PARTS:
                field = post.get(name)
                if not hasattr(field, "file"):
                    raise ValueError(f"Missing {name} capture")
                sources[name] = field.file
            raw_metadata = str(post.get("metadata", ""))
            if len(raw_metadata) > 65536:
                raise ValueError("Capture metadata is too large")
            result = await asyncio.to_thread(conditioning.store_shot, backend, request.match_info["scene_id"],
                                            request.match_info["job_id"], int(request.match_info["index"]),
                                            sources, json.loads(raw_metadata))
            return web.json_response(result, status=201)
        except (ValueError, FileNotFoundError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.post(base + "/publish")
    async def publish(request):
        try:
            result = await asyncio.to_thread(conditioning.publish_capture, backend, request.match_info["scene_id"], request.match_info["job_id"])
            return web.json_response(result, status=201)
        except (ValueError, FileNotFoundError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.post(base + "/error")
    async def error(request):
        try:
            if not _content_length_ok(request, 8192):
                raise ValueError("Capture error is too large")
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("Capture error must be an object")
            await asyncio.to_thread(conditioning.fail_job, backend, request.match_info["scene_id"], request.match_info["job_id"], payload.get("error", "Capture failed"))
            return web.json_response({"status": "recorded"})
        except (ValueError, FileNotFoundError) as exc:
            return web.json_response({"error": str(exc)}, status=400)