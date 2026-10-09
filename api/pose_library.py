"""HTTP adapters for the Pose and animation library."""
import asyncio
import threading
import time
import uuid
from aiohttp import web
from ..nodes.posestudio import library
from ..nodes.shared import repository_progress as progress

def expected_content_length(request, max_chars):
    try:
        raw_length = request.headers.get("Content-Length")
        if raw_length is None:
            return not getattr(request, "can_read_body", False)
        length = int(raw_length)
    except Exception:
        return False
    return length <= int(max_chars or 0)


async def list_pose_repositories(request):
    return web.json_response({
        "local_repository": library.get_local_repository_info(),
        "repositories": library.load_pose_repositories(),
    })


async def repository_progress_status(request):
    return web.json_response(progress.get_repository_progress(request.match_info.get("task_id")))


async def add_pose_repository(request):
    try:
        if not expected_content_length(request, 1024 * 1024):
            return web.json_response({"error": "Request body is too large"}, status=413)
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    repo_id = library.normalize_repo_id(data.get("repo_id"))
    task_id = str(data.get("task_id") or uuid.uuid4())
    if not repo_id:
        return web.json_response({"error": "Invalid Hugging Face repo id"}, status=400)
    repos = library.load_pose_repositories()
    if any(repo["repo_id"] == repo_id for repo in repos):
        return web.json_response({"error": "Repository already exists"}, status=400)
    user_repos = library.load_user_repositories()
    new_repository = {
        "repo_id": repo_id,
        "title": data.get("title") or repo_id,
        "description": data.get("description") or "",
        "manifest_path": data.get("manifest_path") or "pose_library.json",
        "enabled": True,
        "builtin": False,
        "asset_count": 0,
        "pose_count": 0,
        "animation_count": 0,
    }
    user_repos.append(new_repository)
    library.save_user_repositories(user_repos)

    # Add is a complete user action: registering a repository also downloads
    # its manifest, poses, and previews. The response is held until the cache is
    # ready, while the existing progress endpoint keeps the UI responsive.
    refreshed = await asyncio.to_thread(
        library.refresh_pose_repository,
        new_repository,
        task_id=task_id,
    )
    library.persist_refreshed_repositories([refreshed])
    return web.json_response({
        "success": True,
        "task_id": task_id,
        "repositories": library.load_pose_repositories(),
        "refreshed": refreshed,
    })


async def toggle_pose_repository(request):
    try:
        if not expected_content_length(request, 1024 * 1024):
            return web.json_response({"error": "Request body is too large"}, status=413)
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    repo_id = library.normalize_repo_id(data.get("repo_id"))
    enabled = bool(data.get("enabled"))
    task_id = str(data.get("task_id") or "")
    progress.repository_progress_start(task_id, f"{'Enabling' if enabled else 'Disabling'} {repo_id}...")
    progress.repository_progress_update(task_id, progress=20, message="Loading repository settings...")
    default_repos = library.load_default_repositories()
    user_repos = library.load_user_repositories()
    if any(repo["repo_id"] == repo_id for repo in default_repos):
        progress.repository_progress_update(task_id, progress=45, message="Updating default repository override...")
        existing = next((repo for repo in user_repos if repo["repo_id"] == repo_id), None)
        if existing is None:
            base = next(repo for repo in default_repos if repo["repo_id"] == repo_id)
            existing = {**base, "builtin": False}
            user_repos.append(existing)
        existing["enabled"] = enabled
    else:
        progress.repository_progress_update(task_id, progress=45, message="Updating user repository...")
        for repo in user_repos:
            if repo["repo_id"] == repo_id:
                repo["enabled"] = enabled
                break
        else:
            progress.repository_progress_fail(task_id, "Repository not found")
            return web.json_response({"error": "Repository not found"}, status=404)
    progress.repository_progress_update(task_id, progress=75, message="Saving repository settings...")
    library.save_user_repositories(user_repos)
    progress.repository_progress_finish(task_id, f"{repo_id} {'enabled' if enabled else 'disabled'}.")
    return web.json_response({"success": True, "repositories": library.load_pose_repositories()})


async def delete_pose_repository(request):
    repo_id = library.normalize_repo_id(request.match_info.get("repo_id"))
    if not repo_id:
        return web.json_response({"error": "Repository required"}, status=400)
    if any(repo["repo_id"] == repo_id for repo in library.load_default_repositories()):
        return web.json_response({"error": "Default repositories can be disabled, not deleted"}, status=400)
    user_repos = [repo for repo in library.load_user_repositories() if repo["repo_id"] != repo_id]
    removed_count = library.remove_local_repository_cache(repo_id)
    library.save_user_repositories(user_repos)
    return web.json_response({"success": True, "repositories": library.load_pose_repositories(), "removed_count": removed_count})


async def auto_refresh_enabled_pose_repositories(request):
    now = time.time()
    try:
        if not expected_content_length(request, 1024 * 1024):
            return web.json_response({"error": "Request body is too large"}, status=413)
        data = await request.json()
    except Exception:
        data = {}
    force = bool(data.get("force"))
    with library._BACKGROUND_REFRESH_LOCK:
        if library._BACKGROUND_REFRESH_STATE["running"]:
            return web.json_response({
                "success": True,
                "started": False,
                "running": True,
                "task_id": library._BACKGROUND_REFRESH_STATE["task_id"],
            })
        if not force and now - float(library._BACKGROUND_REFRESH_STATE.get("last_started") or 0) < 300:
            return web.json_response({
                "success": True,
                "started": False,
                "running": False,
                "task_id": library._BACKGROUND_REFRESH_STATE["task_id"],
            })
        task_id = f"repo-auto-{uuid.uuid4()}"
        library._BACKGROUND_REFRESH_STATE.update({
            "running": True,
            "task_id": task_id,
            "last_started": now,
        })
    progress.repository_progress_start(task_id, "Refreshing enabled pose repositories in background...")
    thread = threading.Thread(
        target=library.run_background_enabled_repository_refresh,
        args=(task_id,),
        daemon=True,
    )
    thread.start()
    return web.json_response({
        "success": True,
        "started": True,
        "running": True,
        "task_id": task_id,
    })


async def refresh_pose_repositories(request):
    try:
        if not expected_content_length(request, 1024 * 1024):
            return web.json_response({"error": "Request body is too large"}, status=413)
        data = await request.json()
    except Exception:
        data = {}
    repo_id = library.normalize_repo_id(data.get("repo_id"))
    task_id = str(data.get("task_id") or uuid.uuid4())
    repos = library.load_pose_repositories()
    targets = [repo for repo in repos if (not repo_id or repo["repo_id"] == repo_id)]
    refreshed = await asyncio.to_thread(
        lambda: [library.refresh_pose_repository(repo, task_id=task_id if len(targets) == 1 else f"{task_id}-{index}") for index, repo in enumerate(targets)]
    )
    library.persist_refreshed_repositories(refreshed)
    return web.json_response({"success": all(repo.get("status") != "error" for repo in refreshed), "task_id": task_id, "repositories": library.load_pose_repositories(), "refreshed": refreshed})


async def publish_local_pose_repository(request):
    return web.json_response(
        {"error": "Remote publishing is disabled by the VNCCS security policy"},
        status=403,
    )


async def list_poses(request):
    full_details = request.query.get("full") == "true"
    return await asyncio.to_thread(lambda: web.json_response({"poses": library.scan_poses(full_details)}))


def register_routes(app):
    """Register Pose Library API routes."""
    app.router.add_get("/vnccs/pose_library/list", list_poses)
    app.router.add_get("/vnccs/pose_library/get/{name}", get_pose)
    app.router.add_post("/vnccs/pose_library/save", save_pose)
    app.router.add_delete("/vnccs/pose_library/delete/{name}", delete_pose)
    app.router.add_get("/vnccs/pose_library/preview/{name}", get_preview)
    app.router.add_get("/vnccs/pose_library/repositories", list_pose_repositories)
    app.router.add_get("/vnccs/pose_library/repositories/progress/{task_id}", repository_progress_status)
    app.router.add_post("/vnccs/pose_library/repositories/add", add_pose_repository)
    app.router.add_post("/vnccs/pose_library/repositories/toggle", toggle_pose_repository)
    app.router.add_delete("/vnccs/pose_library/repositories/delete/{repo_id:.+}", delete_pose_repository)
    app.router.add_post("/vnccs/pose_library/repositories/refresh", refresh_pose_repositories)
    app.router.add_post("/vnccs/pose_library/repositories/auto_refresh", auto_refresh_enabled_pose_repositories)
    app.router.add_post("/vnccs/pose_library/repositories/local/publish", publish_local_pose_repository)


async def save_pose(request):
    try:
        if not expected_content_length(request, library.MAX_LIBRARY_SAVE_REQUEST_BYTES):
            return web.json_response({"error": "Request body is too large"}, status=413)
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    payload, status = await asyncio.to_thread(library.save_pose, data)
    return web.json_response(payload, status=status)

async def get_pose(request):
    payload, status = await asyncio.to_thread(library.get_pose, request.match_info.get("name"), request.query)
    return web.json_response(payload, status=status)

async def delete_pose(request):
    payload, status = await asyncio.to_thread(library.delete_pose, request.match_info.get("name"), request.query)
    return web.json_response(payload, status=status)

async def get_preview(request):
    payload, content_type, status = await asyncio.to_thread(library.get_preview, request.match_info.get("name"), request.query)
    if isinstance(payload, dict):
        return web.json_response(payload, status=status)
    return web.Response(body=payload, content_type=content_type, status=status)
