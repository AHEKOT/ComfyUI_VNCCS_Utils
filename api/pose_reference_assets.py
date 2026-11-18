"""HTTP adapters for Pose Studio reference layer images."""
import asyncio

from aiohttp import web

from ..nodes.posestudio import reference_assets
from .pose_capture_sync import expected_content_length


async def upload_reference_asset(request):
    """Stores the raw image in the request body and returns its compact asset name."""
    try:
        if not expected_content_length(request, reference_assets.REFERENCE_ASSET_MAX_BYTES):
            return web.json_response({"error": "The image is too large for a reference layer."}, status=413)
        raw = await request.read()
        return web.json_response(await asyncio.to_thread(reference_assets.store_reference_asset, raw))
    except reference_assets.ReferenceAssetRejected as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


async def get_reference_asset(request):
    try:
        found = await asyncio.to_thread(reference_assets.reference_asset_file, request.match_info["asset_id"])
        if found is None:
            return web.json_response({"error": "Reference image not found on this server."}, status=404)
        path, content_type = found
        # Names are content hashes, so a stored asset never changes.
        return web.FileResponse(path, headers={
            "Content-Type": content_type,
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        })
    except reference_assets.ReferenceAssetRejected as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


def register_routes(routes):
    """Register reference layer image routes (ComfyUI also serves these under /api)."""
    routes.post("/vnccs/pose_reference_asset")(upload_reference_asset)
    routes.get("/vnccs/pose_reference_asset/{asset_id}")(get_reference_asset)
