"""HTTP live preview using the same resolver as Prompt Designer execution."""

import asyncio

from aiohttp import web

from .pose_capture_sync import expected_content_length
from ..nodes.prompt_designer import MAX_STATE_CHARS, preview_block, resolve_prompt


async def preview_prompt(request):
    if not expected_content_length(request, MAX_STATE_CHARS * 4):
        return web.json_response({"error": "Prompt Designer state is too large."}, status=413)
    try:
        raw = await request.read()
        if len(raw) > MAX_STATE_CHARS * 4:
            return web.json_response({"error": "Prompt Designer state is too large."}, status=413)
        state = raw.decode("utf-8")
        block_id = request.query.get("block_id")
        if block_id is not None:
            result = await asyncio.to_thread(preview_block, state, block_id)
        else:
            result = await asyncio.to_thread(resolve_prompt, state)
        return web.json_response(result)
    except (ValueError, TypeError, RecursionError, UnicodeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


def register_routes(app):
    for prefix in ("/vnccs", "/api/vnccs"):
        app.router.add_post(prefix + "/prompt_designer/preview", preview_prompt)
