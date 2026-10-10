"""HTTP adapters for the 3D asset library."""
from __future__ import annotations
import asyncio
import secrets
import shutil
import threading
import time
from typing import Any
from ..nodes.factory3d import library
from ..nodes.shared.user_config import get_vnccs_user_config
from ..nodes.shared.repository_progress import get_repository_progress

API_BASE = "/vnccs/3d-factory/library"


async def _json(request: Any) -> dict[str, Any]:
    from aiohttp import web

    raw = request.headers.get("Content-Length")
    if raw and int(raw) > library.MAX_REQUEST_BYTES:
        raise web.HTTPRequestEntityTooLarge(
            max_size=library.MAX_REQUEST_BYTES,
            actual_size=int(raw),
        )
    value = await request.json()
    if not isinstance(value, dict):
        raise ValueError("request body must be an object")
    return value


def _error(exc: Exception, status: int = 400) -> web.Response:
    from aiohttp import web

    if isinstance(exc, FileNotFoundError):
        status = 404
    return web.json_response({"error": str(exc)}, status=status)


def register_routes(routes: Any) -> None:
    from aiohttp import web

    async def list_items(_request: Any) -> web.Response:
        try:
            return web.json_response(
                {
                    "schema": library.SCHEMA,
                    "items": [
                        library._public_record(item)
                        for item in await asyncio.to_thread(library._read_records)
                    ],
                }
            )
        except Exception as exc:
            return _error(exc, status=500)

    async def save_item(request: Any) -> web.Response:
        try:
            record = await asyncio.to_thread(library.save_asset, await _json(request))
            return web.json_response({"success": True, "item": library._public_record(record)})
        except Exception as exc:
            return _error(exc)

    async def update_item(request: Any) -> web.Response:
        try:
            record = await asyncio.to_thread(
                library.update_asset,
                request.match_info["asset_id"],
                await _json(request),
            )
            return web.json_response({"success": True, "item": library._public_record(record)})
        except Exception as exc:
            return _error(exc)

    async def load_item(request: Any) -> web.Response:
        try:
            payload = await _json(request)
            result = await asyncio.to_thread(
                library.load_asset,
                request.match_info["asset_id"],
                repository=str(payload.get("repository") or ""),
                category=str(payload.get("category") or ""),
                scene_id=str(payload.get("scene_id") or ""),
            )
            return web.json_response(result)
        except Exception as exc:
            return _error(exc)

    async def preview_item(request: Any) -> web.StreamResponse:
        try:
            _record, paths = await asyncio.to_thread(
                library._find_record,
                request.match_info["asset_id"],
                request.query.get("repository", ""),
                request.query.get("category", ""),
            )
            if not paths["preview"].is_file():
                raise FileNotFoundError("preview was not found")
            return web.FileResponse(paths["preview"])
        except Exception as exc:
            return _error(exc)

    async def download_item(request: Any) -> web.StreamResponse:
        try:
            record, paths = await asyncio.to_thread(
                library._find_record,
                request.match_info["asset_id"],
                request.query.get("repository", ""),
                request.query.get("category", ""),
            )
            filename = f"{library._name(record.get('name'))}{library.PACKAGE_SUFFIX}"
            return web.FileResponse(
                paths["package"],
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )
        except Exception as exc:
            return _error(exc)

    async def delete_item(request: Any) -> web.Response:
        try:
            record, paths = await asyncio.to_thread(
                library._find_record,
                request.match_info["asset_id"],
                request.query.get("repository", ""),
                request.query.get("category", ""),
            )
            if record.get("repository") != library.LOCAL_REPOSITORY:
                raise ValueError("downloaded repository assets are read-only")
            for path in paths.values():
                path.unlink(missing_ok=True)
            return web.json_response({"success": True})
        except Exception as exc:
            return _error(exc)

    async def list_repositories(_request: Any) -> web.Response:
        try:
            config = get_vnccs_user_config()
            records = await asyncio.to_thread(library._read_records)
            repos = []
            for item in library._repositories():
                entry = dict(item)
                entry["asset_count"] = sum(
                    record.get("repository") == item["repo_id"] for record in records
                )
                repos.append(entry)
            local_count = sum(record.get("repository") == library.LOCAL_REPOSITORY for record in records)
            return web.json_response(
                {
                    "repositories": repos,
                    "local": {
                        "repo_id": library.LOCAL_REPOSITORY,
                        "title": "Local 3D Model Library",
                        "asset_count": local_count,
                        "publishing_enabled": False,
                        "publish_repo_id": config.get("factory3d_library_publish_repo_id", ""),
                        "last_publish": config.get("factory3d_library_last_publish"),
                    },
                }
            )
        except Exception as exc:
            return _error(exc, status=500)

    async def add_repository(request: Any) -> web.Response:
        try:
            payload = await _json(request)
            repo_id = str(payload.get("repo_id") or "").strip()
            if repo_id.count("/") != 1 or " " in repo_id:
                raise ValueError("repository must be owner/name")
            library._validate_repository_directory(repo_id)
            users = [item for item in library._user_repositories() if item.get("repo_id") != repo_id]
            users.append(
                {
                    "repo_id": repo_id,
                    "title": str(payload.get("title") or repo_id),
                    "description": str(payload.get("description") or ""),
                    "enabled": True,
                }
            )
            library._save_user_repositories(users)
            task_id = secrets.token_hex(12)
            threading.Thread(
                target=library._sync_repository,
                args=(repo_id, task_id),
                daemon=True,
            ).start()
            return web.json_response({"success": True, "task_id": task_id})
        except Exception as exc:
            return _error(exc)

    async def toggle_repository(request: Any) -> web.Response:
        try:
            payload = await _json(request)
            repo_id = str(payload.get("repo_id") or "")
            enabled = payload.get("enabled") is True
            users = library._user_repositories()
            existing = next((item for item in users if item.get("repo_id") == repo_id), None)
            if existing is None:
                if not any(item["repo_id"] == repo_id for item in library._repositories()):
                    raise FileNotFoundError("repository was not found")
                users.append({"repo_id": repo_id, "enabled": enabled})
            else:
                existing["enabled"] = enabled
            library._save_user_repositories(users)
            return web.json_response({"success": True})
        except Exception as exc:
            return _error(exc)

    async def delete_repository(request: Any) -> web.Response:
        try:
            repo_id = str(request.match_info.get("repo_id") or "").strip()
            repository_dir = library._repo_dir(repo_id)
            if repo_id.count("/") != 1 or not repository_dir or repository_dir.casefold() == library.LOCAL_REPOSITORY.casefold():
                raise ValueError("A remote repository is required; the local library cannot be removed")
            if any(item["repo_id"] == repo_id and item.get("builtin") for item in library._repositories()):
                raise ValueError("built-in repository cannot be removed")
            library._validate_repository_directory(repo_id)
            users = [item for item in library._user_repositories() if item.get("repo_id") != repo_id]
            library._save_user_repositories(users)
            shutil.rmtree(library._root() / repository_dir, ignore_errors=True)
            return web.json_response({"success": True})
        except Exception as exc:
            return _error(exc)

    async def refresh_repository(request: Any) -> web.Response:
        try:
            payload = await _json(request)
            repo_ids = payload.get("repo_ids")
            if not isinstance(repo_ids, list):
                repo_ids = [
                    item["repo_id"] for item in library._repositories() if item.get("enabled", True)
                ]
            task_id = secrets.token_hex(12)

            threading.Thread(
                target=library._sync_repositories,
                args=([str(repo_id) for repo_id in repo_ids], task_id),
                daemon=True,
            ).start()
            return web.json_response({"success": True, "task_id": task_id})
        except Exception as exc:
            return _error(exc)

    async def publish_repository(request: Any) -> web.Response:
        return web.json_response(
            {"error": "Remote publishing is disabled by the VNCCS security policy"},
            status=403,
        )


    async def repository_progress(request: Any) -> web.Response:
        return web.json_response(get_repository_progress(request.match_info["task_id"]))

    async def auto_refresh_repositories(_request: Any) -> web.Response:
        try:
            repo_ids = [
                item["repo_id"] for item in library._repositories() if item.get("enabled", True)
            ]
            if not repo_ids:
                return web.json_response({"success": True, "task_id": ""})
            with library._BACKGROUND_REFRESH_LOCK:
                state = library._BACKGROUND_REFRESH_STATE
                if state["running"]:
                    return web.json_response({"success": True, "task_id": state["task_id"]})
                if time.time() - state["last_started"] < 300:
                    return web.json_response({"success": True, "task_id": ""})
                task_id = secrets.token_hex(12)
                state.update(running=True, task_id=task_id, last_started=time.time())
                try:
                    threading.Thread(
                        target=library._sync_repositories,
                        args=(repo_ids, task_id), kwargs={"auto_refresh": True}, daemon=True,
                    ).start()
                except Exception:
                    state.update(running=False, last_started=0)
                    raise
            return web.json_response({"success": True, "task_id": task_id})
        except Exception as exc:
            return _error(exc)

    routes.get(f"{API_BASE}/items")(list_items)
    routes.post(f"{API_BASE}/items")(save_item)
    routes.put(f"{API_BASE}/items/{{asset_id}}")(update_item)
    routes.post(f"{API_BASE}/items/{{asset_id}}/load")(load_item)
    routes.get(f"{API_BASE}/items/{{asset_id}}/preview")(preview_item)
    routes.get(f"{API_BASE}/items/{{asset_id}}/download")(download_item)
    routes.delete(f"{API_BASE}/items/{{asset_id}}")(delete_item)
    routes.get(f"{API_BASE}/repositories")(list_repositories)
    routes.post(f"{API_BASE}/repositories/add")(add_repository)
    routes.post(f"{API_BASE}/repositories/toggle")(toggle_repository)
    routes.delete(f"{API_BASE}/repositories/{{repo_id:.+}}")(delete_repository)
    routes.post(f"{API_BASE}/repositories/refresh")(refresh_repository)
    routes.post(f"{API_BASE}/repositories/auto_refresh")(auto_refresh_repositories)
    routes.post(f"{API_BASE}/repositories/publish")(publish_repository)
    routes.get(f"{API_BASE}/repositories/progress/{{task_id}}")(repository_progress)
