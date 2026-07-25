"""Runtime synchronization API for Pose Studio browser captures."""

import json
import os
import re

from aiohttp import web


SAFE_NODE_ID_RE = re.compile(r"[^A-Za-z0-9_-]+")
MAX_SYNC_CAPTURE_CHARS = 64 * 1024 * 1024


def expected_content_length(request, max_chars):
    try:
        raw_length = request.headers.get("Content-Length")
        if raw_length is None:
            return not getattr(request, "can_read_body", False)
        length = int(raw_length)
    except Exception:
        return False
    return length <= int(max_chars or 0)


def sanitize_node_id(value):
    cleaned = SAFE_NODE_ID_RE.sub("_", str(value or "")).strip("_")
    return cleaned[:128]


async def upload_pose_sync(request):
    """Save browser-rendered Pose Studio captures for the current execution."""
    try:
        if not expected_content_length(request, MAX_SYNC_CAPTURE_CHARS):
            return web.json_response({"error": "capture payload is too large"}, status=413)
        data = await request.json()
        node_id = sanitize_node_id(data.get("node_id"))
        if not node_id:
            return web.json_response({"error": "No node_id"}, status=400)
        if len(json.dumps(data, separators=(",", ":"))) > MAX_SYNC_CAPTURE_CHARS:
            return web.json_response({"error": "capture payload is too large"}, status=413)

        import folder_paths

        temp_dir = folder_paths.get_temp_directory()
        # The backend reader still uses this historical filename prefix.
        filepath = os.path.join(temp_dir, f"vnccs_debug_{node_id}.json")
        temp_abs = os.path.abspath(temp_dir)
        file_abs = os.path.abspath(filepath)
        if file_abs != temp_abs and not file_abs.startswith(temp_abs + os.sep):
            return web.json_response({"error": "Invalid node_id"}, status=400)

        with open(filepath, "w") as f:
            json.dump(data, f)

        return web.json_response({"status": "ok"})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


def register_routes(app):
    """Register Pose Studio runtime synchronization routes."""
    app.router.add_post("/vnccs/pose_sync/upload_capture", upload_pose_sync)
    app.router.add_post("/vnccs/debug/upload_capture", upload_pose_sync)
