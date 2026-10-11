"""HTTP adapters for the UniCanvas document catalog."""
import asyncio
import json

from ..nodes.unicanvas import documents

_MAX_BODY_BYTES = 4096


def register_routes(routes):
    from aiohttp import web

    async def body(request):
        try:
            length = int(request.headers.get("Content-Length", "-1"))
        except (ValueError, TypeError):
            length = -1
        if not 0 <= length <= _MAX_BODY_BYTES:
            raise web.HTTPRequestEntityTooLarge(max_size=_MAX_BODY_BYTES, actual_size=max(length, _MAX_BODY_BYTES + 1))
        chunks, size = [], 0
        while True:
            chunk = await request.content.read(_MAX_BODY_BYTES + 1 - size)
            if not chunk:
                break
            size += len(chunk)
            if size > _MAX_BODY_BYTES:
                raise web.HTTPRequestEntityTooLarge(max_size=_MAX_BODY_BYTES, actual_size=size)
            chunks.append(chunk)
        raw = b"".join(chunks)
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError) as exc:
            raise ValueError("request body must be valid JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("request body must be an object")
        return value

    def error(exc):
        if isinstance(exc, web.HTTPException):
            return web.json_response({"error": exc.reason}, status=exc.status)
        status = 409 if isinstance(exc, documents.CanvasConflict) else 404 if isinstance(exc, FileNotFoundError) else 400 if isinstance(exc, ValueError) else 500
        return web.json_response({"error": str(exc)}, status=status)

    def response(value):
        return web.json_response(value, headers={"Cache-Control": "no-store"})

    @routes.get("/vnccs/unicanvas/documents")
    async def list_documents(request):
        try:
            return response(await asyncio.to_thread(documents.list_documents))
        except Exception as exc:
            return error(exc)

    @routes.post("/vnccs/unicanvas/documents")
    async def register_document(request):
        try:
            data = await body(request)
            if "name" in data and data["name"] is None:
                raise ValueError("name must contain 1 to 160 characters")
            document = await asyncio.to_thread(documents.register_document, data.get("state_id"), data.get("name"))
            return response({"document": document})
        except Exception as exc:
            return error(exc)

    @routes.post("/vnccs/unicanvas/documents/active")
    async def set_active_document(request):
        try:
            data = await body(request)
            active_id = await asyncio.to_thread(documents.set_active_document, data.get("canvas_id"))
            return response({"active_canvas_id": active_id})
        except Exception as exc:
            return error(exc)

    @routes.get("/vnccs/unicanvas/documents/{canvas_id}")
    async def get_document(request):
        try:
            document = await asyncio.to_thread(documents.get_document, request.match_info["canvas_id"])
            return response({"document": document})
        except Exception as exc:
            return error(exc)

    @routes.patch("/vnccs/unicanvas/documents/{canvas_id}")
    async def update_document(request):
        try:
            data = await body(request)
            if any(field in data and data[field] is None for field in ("name", "state_id")):
                raise ValueError("name and state_id cannot be null")
            document = await asyncio.to_thread(documents.update_document, request.match_info["canvas_id"],
                name=data.get("name"), state_id=data.get("state_id"), expected_state_id=data.get("expected_state_id"))
            return response({"document": document})
        except Exception as exc:
            return error(exc)

    @routes.delete("/vnccs/unicanvas/documents/{canvas_id}")
    async def delete_document(request):
        try:
            data = await body(request)
            await asyncio.to_thread(documents.delete_document, request.match_info["canvas_id"], data.get("expected_state_id"))
            return response({"status": "ok"})
        except Exception as exc:
            return error(exc)
