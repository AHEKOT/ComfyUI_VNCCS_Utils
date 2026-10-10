"""HTTP adapter for durable Prompt Designer state and the shared card library."""

import asyncio
import json

from aiohttp import web

from .pose_capture_sync import expected_content_length
from ..nodes.prompt_designer import MAX_STATE_CHARS
from ..nodes.prompt_designer_storage import RevisionConflict, list_cards, list_prompts, load_document, save_document
from ..nodes.prompt_designer_defaults import list_default_cards


async def document(request):
    try:
        document_id = request.match_info["document_id"]
        if request.method == "GET":
            result = await asyncio.to_thread(load_document, document_id)
        else:
            limit = (MAX_STATE_CHARS + 1024) * 4
            if not expected_content_length(request, limit):
                return web.json_response({"error": "Document is too large."}, status=413)
            raw = await request.read()
            if len(raw) > limit:
                return web.json_response({"error": "Document is too large."}, status=413)
            data = json.loads(raw)
            if not isinstance(data, dict) or set(data) != {"state", "revision"}:
                raise ValueError("Invalid document request.")
            result = await asyncio.to_thread(save_document, document_id, data["state"], data["revision"])
        return web.json_response(result)
    except RevisionConflict as exc:
        return web.json_response({"error": str(exc)}, status=409)
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": f"Disk storage failed: {exc}. Existing data was not reset."}, status=500)


async def library(request):
    try:
        result = await asyncio.to_thread(list_cards, request.query.get("q", ""), int(request.query.get("offset", "0")))
        return web.json_response(result)
    except (ValueError, TypeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": f"Library could not be read: {exc}. Existing data was not reset."}, status=500)


async def defaults(request):
    try:
        result = await asyncio.to_thread(list_default_cards, request.query.get("q", ""), int(request.query.get("offset", "0")))
        return web.json_response(result)
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": f"Bundled cards could not be read: {exc}. User cards were not changed."}, status=500)


async def prompts(request):
    try:
        result = await asyncio.to_thread(list_prompts, request.query.get("q", ""), int(request.query.get("offset", "0")))
        return web.json_response(result)
    except (ValueError, TypeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": f"Saved prompts could not be read: {exc}. Existing data was not reset."}, status=500)


def register_routes(app):
    # Register both frontend URL forms directly, like the neighboring Pose Library.
    for prefix in ("/vnccs", "/api/vnccs"):
        root = prefix + "/prompt_designer"
        app.router.add_get(root + "/documents/{document_id}", document)
        app.router.add_put(root + "/documents/{document_id}", document)
        app.router.add_get(root + "/library", library)
        app.router.add_get(root + "/defaults", defaults)
        app.router.add_get(root + "/prompts", prompts)
