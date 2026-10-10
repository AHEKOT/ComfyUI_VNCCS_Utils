"""Factory scene editor HTTP routes: scenes, objects, assets, exports and generation jobs."""
from __future__ import annotations
import asyncio
import json
from typing import Any
from ..nodes.factory3d import storage as factory, runtime, generation as factory3d_generation

_REGISTERED = False


def _json_error(web: Any, exc: Exception, status: int = 400) -> Any:
    return web.json_response({"error": str(exc), "type": type(exc).__name__}, status=status)


def _content_length_ok(request: Any, maximum: int) -> bool:
    raw = request.headers.get("Content-Length")
    if raw is None:
        return True
    try:
        return 0 <= int(raw) <= maximum
    except (TypeError, ValueError):
        return False


def register_routes(routes: Any) -> None:
    global _REGISTERED
    if _REGISTERED:
        return
    from aiohttp import web
    from . import factory3d_conditioning_captures
    factory3d_conditioning_captures.register_routes(routes, factory)

    @routes.get(f"{factory.API_BASE}/capabilities")
    async def factory_capabilities(_request: Any) -> Any:
        return web.json_response(await asyncio.to_thread(runtime.capabilities))

    @routes.get(f"{factory.API_BASE}/splat-cache")
    async def factory_splat_cache_status(_request: Any) -> Any:
        return web.json_response(await asyncio.to_thread(factory.splat_cache_status))

    @routes.post(f"{factory.API_BASE}/splat-cache/settings")
    async def factory_splat_cache_settings(request: Any) -> Any:
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("SPLAT cache settings must be an object")
            status = await asyncio.to_thread(
                factory.configure_splat_cache,
                payload.get("limit_gb"),
            )
            return web.json_response(status)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/splat-cache/clear")
    async def factory_splat_cache_clear(_request: Any) -> Any:
        try:
            return web.json_response(await asyncio.to_thread(factory.clear_splat_cache))
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/weights/download")
    async def factory_weights_download(_request: Any) -> Any:
        try:
            job = runtime._new_job("weights")
            runtime._track_task(asyncio.to_thread(runtime._run_job, job, runtime._download_weights))
            return web.json_response(runtime._job_public(job), status=202)
        except Exception as exc:
            return _json_error(web, exc, 409)

    @routes.post(f"{factory.API_BASE}/generators/{{provider}}/weights/download")
    async def factory_generator_weights_download(request: Any) -> Any:
        try:
            provider = factory3d_generation.normalize_provider(request.match_info["provider"])
            job = runtime._new_job("weights")
            job["provider"] = provider
            runtime._track_task(
                asyncio.to_thread(
                    runtime._run_job,
                    job,
                    lambda current: runtime._download_provider_weights(current, provider),
                )
            )
            return web.json_response(runtime._job_public(job), status=202)
        except Exception as exc:
            return _json_error(web, exc, 409)

    @routes.post(f"{factory.API_BASE}/scenes")
    async def factory_scene_create(request: Any) -> Any:
        try:
            payload = await request.json() if request.can_read_body else {}
            scene = await asyncio.to_thread(factory.create_scene, payload.get("name") if isinstance(payload, dict) else "")
            return web.json_response(factory._public_scene(scene), status=201)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/scenes/{{scene_id}}/upgrade")
    async def factory_scene_upgrade(request: Any) -> Any:
        try:
            scene = await asyncio.to_thread(factory.upgrade_scene, request.match_info["scene_id"])
            return web.json_response(factory._public_scene(scene))
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{factory.API_BASE}/scenes")
    async def factory_scene_list(request: Any) -> Any:
        try:
            limit = int(request.query.get("limit", 100))
            return web.json_response({"scenes": await asyncio.to_thread(factory.list_scenes, limit)})
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{factory.API_BASE}/scenes/{{scene_id}}")
    async def factory_scene_get(request: Any) -> Any:
        try:
            return web.json_response(factory._public_scene(await asyncio.to_thread(factory.load_scene, request.match_info["scene_id"])))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.patch(f"{factory.API_BASE}/scenes/{{scene_id}}")
    async def factory_scene_update(request: Any) -> Any:
        try:
            if not _content_length_ok(request, factory.MAX_SCENE_JSON_BYTES):
                return web.json_response({"error": "scene update is too large"}, status=413)
            payload = await request.json()
            if not isinstance(payload, dict) or "edit_revision" not in payload:
                raise ValueError("Scene saves require edit_revision; reload the extension before saving")
            scene = await asyncio.to_thread(factory.update_scene, request.match_info["scene_id"], payload)
            return web.json_response(factory._public_scene(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except RuntimeError as exc:
            return _json_error(web, exc, 409)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.delete(f"{factory.API_BASE}/scenes/{{scene_id}}")
    async def factory_scene_delete(request: Any) -> Any:
        try:
            result = await asyncio.to_thread(
                factory.delete_scene,
                request.match_info["scene_id"],
            )
            return web.json_response(result)
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except RuntimeError as exc:
            return _json_error(web, exc, 409)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/scenes/{{scene_id}}/reference")
    async def factory_scene_reference_upload(request: Any) -> Any:
        try:
            if not _content_length_ok(request, factory.MAX_UPLOAD_BYTES + 1024 * 1024):
                return web.json_response({"error": "image upload is too large"}, status=413)
            scene_id = factory._validate_id(request.match_info["scene_id"], "scene id")
            await asyncio.to_thread(factory.load_scene, scene_id)
            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                raise ValueError("missing image")
            image_bytes = await asyncio.to_thread(
                image_field.file.read,
                factory.MAX_UPLOAD_BYTES + 1,
            )
            scene = await asyncio.to_thread(
                factory.store_scene_reference,
                scene_id,
                image_bytes,
                getattr(image_field, "filename", "reference.png"),
            )
            reference = factory._public_scene(scene)["reference"]
            reference["edit_revision"] = scene.get("edit_revision", 0)
            return web.json_response(reference, status=201)
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{factory.API_BASE}/scenes/{{scene_id}}/reference")
    async def factory_scene_reference_get(request: Any) -> Any:
        try:
            scene = await asyncio.to_thread(factory.load_scene, request.match_info["scene_id"])
            return web.FileResponse(factory._scene_reference_file(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{factory.API_BASE}/scenes/{{scene_id}}/reference/preview")
    async def factory_scene_reference_preview_get(request: Any) -> Any:
        try:
            scene = await asyncio.to_thread(factory.load_scene, request.match_info["scene_id"])
            return web.FileResponse(
                await asyncio.to_thread(factory._ensure_scene_reference_preview, scene),
                headers={"Cache-Control": "private, max-age=31536000, immutable"},
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/scenes/{{scene_id}}/skydome")
    async def factory_scene_skydome_upload(request: Any) -> Any:
        try:
            if not _content_length_ok(request, factory.MAX_SKYDOME_BYTES + 1024 * 1024):
                return web.json_response({"error": "skydome upload is too large"}, status=413)
            scene_id = factory._validate_id(request.match_info["scene_id"], "scene id")
            await asyncio.to_thread(factory.load_scene, scene_id)
            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                raise ValueError("missing skydome image")
            image_bytes = await asyncio.to_thread(
                image_field.file.read,
                factory.MAX_SKYDOME_BYTES + 1,
            )
            scene = await asyncio.to_thread(
                factory.store_scene_skydome,
                scene_id,
                image_bytes,
                getattr(image_field, "filename", "skydome.jpg"),
            )
            return web.json_response(factory._public_scene(scene), status=201)
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{factory.API_BASE}/scenes/{{scene_id}}/skydome")
    async def factory_scene_skydome_get(request: Any) -> Any:
        try:
            scene = await asyncio.to_thread(factory.load_scene, request.match_info["scene_id"])
            return web.FileResponse(factory._scene_skydome_file(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{factory.API_BASE}/scenes/{{scene_id}}/skydome/viewport")
    async def factory_scene_skydome_viewport_get(request: Any) -> Any:
        try:
            scene = await asyncio.to_thread(factory.load_scene, request.match_info["scene_id"])
            return web.FileResponse(
                await asyncio.to_thread(factory._ensure_scene_skydome_viewport, scene),
                headers={"Cache-Control": "private, max-age=31536000, immutable"},
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.delete(f"{factory.API_BASE}/scenes/{{scene_id}}/skydome")
    async def factory_scene_skydome_delete(request: Any) -> Any:
        try:
            scene = await asyncio.to_thread(factory.remove_scene_skydome, request.match_info["scene_id"])
            return web.json_response(factory._public_scene(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/scenes/{{scene_id}}/textures")
    async def factory_scene_texture_upload(request: Any) -> Any:
        try:
            if not _content_length_ok(request, factory.MAX_TEXTURE_BYTES + 1024 * 1024):
                return web.json_response({"error": "texture upload is too large"}, status=413)
            scene_id = factory._validate_id(request.match_info["scene_id"], "scene id")
            await asyncio.to_thread(factory.load_scene, scene_id)
            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                raise ValueError("missing texture image")
            image_bytes = await asyncio.to_thread(
                image_field.file.read,
                factory.MAX_TEXTURE_BYTES + 1,
            )
            scene, entry = await asyncio.to_thread(
                factory.store_scene_texture,
                scene_id,
                image_bytes,
                getattr(image_field, "filename", "texture.png"),
            )
            public_scene = factory._public_scene(scene)
            public_entry = next(
                item for item in public_scene.get("textures", [])
                if item.get("texture_id") == entry["texture_id"]
            )
            return web.json_response({"texture": public_entry, "scene": public_scene}, status=201)
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{factory.API_BASE}/scenes/{{scene_id}}/textures/{{texture_id}}")
    async def factory_scene_texture_get(request: Any) -> Any:
        try:
            scene = await asyncio.to_thread(factory.load_scene, request.match_info["scene_id"])
            return web.FileResponse(
                factory._scene_texture_file(scene, request.match_info["texture_id"]),
                headers={"Cache-Control": "private, max-age=31536000, immutable"},
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.delete(f"{factory.API_BASE}/scenes/{{scene_id}}/textures/{{texture_id}}")
    async def factory_scene_texture_delete(request: Any) -> Any:
        try:
            scene = await asyncio.to_thread(
                factory.remove_scene_texture,
                request.match_info["scene_id"],
                request.match_info["texture_id"],
            )
            return web.json_response(factory._public_scene(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/scenes/{{scene_id}}/preview")
    async def factory_scene_preview_upload(request: Any) -> Any:
        try:
            if not _content_length_ok(request, factory.MAX_PREVIEW_BYTES + 1024 * 1024):
                return web.json_response({"error": "preview upload is too large"}, status=413)
            scene_id = factory._validate_id(request.match_info["scene_id"], "scene id")
            await asyncio.to_thread(factory.load_scene, scene_id)
            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                raise ValueError("missing scene preview image")
            image_bytes = await asyncio.to_thread(image_field.file.read, factory.MAX_PREVIEW_BYTES + 1)
            scene = await asyncio.to_thread(
                factory.store_scene_preview,
                scene_id,
                image_bytes,
                post.get("revision"),
                post.get("render_revision"),
                post.get("capture_token"),
            )
            return web.json_response(factory._public_scene(scene)["preview"], status=201)
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/scenes/{{scene_id}}/capture-set")
    async def factory_scene_capture_set_upload(request: Any) -> Any:
        try:
            maximum = (factory.MAX_SCENE_CAMERAS + 1) * factory.MAX_PREVIEW_BYTES + 2 * 1024 * 1024
            if not _content_length_ok(request, maximum):
                return web.json_response(
                    {"error": "camera capture set upload is too large"},
                    status=413,
                )
            scene_id = factory._validate_id(request.match_info["scene_id"], "scene id")
            await asyncio.to_thread(factory.load_scene, scene_id)
            post = await request.post()
            current_field = post.get("current")
            if current_field is None or not hasattr(current_field, "file"):
                raise ValueError("missing current viewport capture")
            try:
                camera_ids = json.loads(str(post.get("camera_ids", "[]")))
            except json.JSONDecodeError as exc:
                raise ValueError("scene camera capture ids are invalid") from exc
            if not isinstance(camera_ids, list):
                raise ValueError("scene camera capture ids are invalid")
            normalized_ids = [
                factory._validate_id(camera_id, "camera id") for camera_id in camera_ids
            ]
            camera_images: dict[str, Any] = {}
            for camera_id in normalized_ids:
                image_field = post.get(f"camera_{camera_id}")
                if image_field is None or not hasattr(image_field, "file"):
                    raise ValueError(f"missing capture for camera {camera_id}")
                camera_images[camera_id] = image_field.file
            scene = await asyncio.to_thread(
                factory.store_scene_capture_set,
                scene_id,
                current_field.file,
                camera_images,
                normalized_ids,
                post.get("revision"),
                post.get("render_revision"),
                post.get("capture_token"),
            )
            public_scene = factory._public_scene(scene)
            return web.json_response(
                {
                    "preview": public_scene.get("preview"),
                    "camera_count": len(normalized_ids),
                    "capture_token": scene["preview_sync"]["capture_token"],
                },
                status=201,
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{factory.API_BASE}/scenes/{{scene_id}}/preview")
    async def factory_scene_preview_get(request: Any) -> Any:
        try:
            scene = await asyncio.to_thread(factory.load_scene, request.match_info["scene_id"])
            return web.FileResponse(factory._scene_preview_file(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/scenes/{{scene_id}}/preview/error")
    async def factory_scene_preview_error(request: Any) -> Any:
        try:
            scene_id = factory._validate_id(request.match_info["scene_id"], "scene id")
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("scene preview failure payload must be an object")
            scene = await asyncio.to_thread(factory.store_scene_preview_error, scene_id, payload.get("capture_token"), payload.get("error"))
            return web.json_response(
                {
                    "status": "recorded",
                    "capture_token": scene["preview_sync"]["capture_token"],
                },
                status=201,
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/scenes/{{scene_id}}/generate")
    async def factory_generate(request: Any) -> Any:
        try:
            if not _content_length_ok(request, factory.MAX_UPLOAD_BYTES + 1024 * 1024):
                return web.json_response({"error": "image upload is too large"}, status=413)
            scene_id = factory._validate_id(request.match_info["scene_id"], "scene id")
            await asyncio.to_thread(factory.load_scene, scene_id)
            post = await request.post()
            image_field = post.get("image")
            if image_field is not None and hasattr(image_field, "file"):
                image_bytes = await asyncio.to_thread(image_field.file.read, factory.MAX_UPLOAD_BYTES + 1)
            elif str(post.get("use_scene_reference", "")) == "1":
                reference = await asyncio.to_thread(factory._scene_reference_file, await asyncio.to_thread(factory.load_scene, scene_id))
                image_bytes = await asyncio.to_thread(reference.read_bytes)
            else:
                raise ValueError("missing image")
            await asyncio.to_thread(factory._decode_image, image_bytes)
            settings = factory._generation_settings(post)
            object_id = factory._new_id()
            name = factory._clean_name(post.get("name"), f"Object {object_id[:6]}", 80)
            job = runtime._new_job("generation", scene_id)
            provider = settings["provider"]
            job["provider"] = provider
            generator = (
                runtime._generate_mesh_object
                if provider in factory3d_generation.MESH_PROVIDER_KEYS
                else runtime._generate_object
            )
            runtime._track_task(
                asyncio.to_thread(
                    runtime._run_job,
                    job,
                    lambda current: generator(
                        current,
                        image_bytes,
                        object_id,
                        name,
                        settings,
                    ),
                )
            )
            return web.json_response(runtime._job_public(job), status=202)
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{factory.API_BASE}/jobs/{{job_id}}")
    async def factory_job_get(request: Any) -> Any:
        try:
            job_id = factory._validate_id(request.match_info["job_id"], "job id")
            with factory._STATE_LOCK:
                job = factory._JOBS.get(job_id)
            if job is None:
                raise FileNotFoundError(f"Factory job {job_id} was not found")
            return web.json_response(runtime._job_public(job))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/jobs/{{job_id}}/cancel")
    async def factory_job_cancel(request: Any) -> Any:
        try:
            job_id = factory._validate_id(request.match_info["job_id"], "job id")
            with factory._STATE_LOCK:
                job = factory._JOBS.get(job_id)
                if job is None:
                    raise FileNotFoundError(f"Factory job {job_id} was not found")
                job["cancel_event"].set()
            runtime._emit(job, "cancelling", job.get("progress", 0), "Cancellation requested", level="warning")
            return web.json_response(runtime._job_public(job))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{factory.API_BASE}/jobs/{{job_id}}/log")
    async def factory_job_log(request: Any) -> Any:
        try:
            job_id = factory._validate_id(request.match_info["job_id"], "job id")
            with factory._STATE_LOCK:
                job = factory._JOBS.get(job_id)
            if job is None:
                raise FileNotFoundError(f"Factory job {job_id} was not found")
            path = runtime._job_log_path(job)
            if not path.is_file():
                raise FileNotFoundError("job log is not available")
            return web.FileResponse(path, headers={"Content-Disposition": f'attachment; filename="factory-{job_id}.log"'})
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{factory.API_BASE}/scenes/{{scene_id}}/objects/{{object_id}}/asset/{{kind}}")
    async def factory_object_asset(request: Any) -> Any:
        try:
            kind = request.match_info["kind"]
            if kind not in {
                "ply", "splat", "prepared", "reference", "thumbnail", "model", "resource",
            }:
                raise FileNotFoundError("unknown object asset")
            scene = await asyncio.to_thread(factory.load_scene, request.match_info["scene_id"])
            item = factory._object_by_id(scene, request.match_info["object_id"])
            if kind == "splat":
                path = await asyncio.to_thread(
                    factory._ensure_object_splat,
                    scene["scene_id"],
                    item["object_id"],
                )
            elif kind == "thumbnail":
                path = await asyncio.to_thread(
                    factory._ensure_object_thumbnail,
                    scene["scene_id"],
                    item,
                )
            elif kind == "resource":
                path = factory._object_model_resource(
                    scene["scene_id"],
                    item,
                    request.query.get("path", ""),
                )
            else:
                path = factory._object_file(scene["scene_id"], item, kind)
            headers = {"Cache-Control": "private, max-age=31536000, immutable"}
            if kind == "model":
                filename = factory._clean_name(item.get("source", {}).get("filename"), path.name, 160)
                headers["Content-Disposition"] = (
                    "inline; filename*=UTF-8''" + urllib.parse.quote(filename, safe="")
                )
            return web.FileResponse(
                path,
                headers=headers,
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/scenes/{{scene_id}}/objects/import")
    async def factory_object_import(request: Any) -> Any:
        try:
            if not _content_length_ok(request, factory.MAX_PLY_UPLOAD_BYTES + 1024 * 1024):
                return web.json_response({"error": "PLY upload is too large"}, status=413)
            scene_id = factory._validate_id(request.match_info["scene_id"], "scene id")
            await asyncio.to_thread(factory.load_scene, scene_id)
            post = await request.post()
            ply_field = post.get("ply")
            if ply_field is None or not hasattr(ply_field, "file"):
                raise ValueError("missing PLY file")
            result = await asyncio.to_thread(
                factory.import_ply_object,
                scene_id,
                ply_field.file,
                getattr(ply_field, "filename", "model.ply"),
                post.get("name"),
            )
            return web.json_response(
                {
                    "scene": factory._public_scene(result["scene"]),
                    "object_id": result["object_id"],
                },
                status=201,
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/scenes/{{scene_id}}/objects/import-model")
    async def factory_model_import(request: Any) -> Any:
        try:
            if not _content_length_ok(request, factory.MAX_MODEL_UPLOAD_TOTAL_BYTES + 2 * 1024 * 1024):
                return web.json_response({"error": "3D model upload is too large"}, status=413)
            scene_id = factory._validate_id(request.match_info["scene_id"], "scene id")
            await asyncio.to_thread(factory.load_scene, scene_id)
            post = await request.post()
            fields = [field for field in post.getall("files", []) if hasattr(field, "file")]
            if not fields:
                raise ValueError("missing 3D model files")
            try:
                paths = json.loads(str(post.get("paths") or "[]"))
            except json.JSONDecodeError as exc:
                raise ValueError("3D model file paths are invalid") from exc
            if not isinstance(paths, list) or any(not isinstance(path, str) for path in paths):
                raise ValueError("3D model file paths are invalid")
            result = await asyncio.to_thread(
                factory.import_model_object,
                scene_id,
                [
                    (getattr(field, "filename", f"asset-{index + 1}"), field.file)
                    for index, field in enumerate(fields)
                ],
                paths=paths,
                main_path=str(post.get("main_path") or ""),
                object_name=post.get("name"),
            )
            return web.json_response(
                {"scene": factory._public_scene(result["scene"]), "object_id": result["object_id"]},
                status=201,
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/scenes/{{scene_id}}/objects/primitive")
    async def factory_primitive_create(request: Any) -> Any:
        try:
            if not _content_length_ok(request, 256 * 1024):
                return web.json_response({"error": "primitive request is too large"}, status=413)
            payload = await request.json()
            result = await asyncio.to_thread(
                factory.create_primitive_object,
                request.match_info["scene_id"],
                payload,
            )
            return web.json_response({
                "scene": factory._public_scene(result["scene"]),
                "object_id": result["object_id"],
            }, status=201)
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.patch(f"{factory.API_BASE}/scenes/{{scene_id}}/objects/{{object_id}}")
    async def factory_object_update(request: Any) -> Any:
        try:
            if not _content_length_ok(request, factory.MAX_SCENE_JSON_BYTES):
                return web.json_response({"error": "object update is too large"}, status=413)
            payload = await request.json()
            object_id = factory._validate_id(request.match_info["object_id"], "object id")
            if not isinstance(payload, dict) or "edit_revision" not in payload:
                raise ValueError("Object saves require edit_revision; reload the extension before saving")
            update = {key: payload[key] for key in ("schema_version", "edit_revision") if key in payload}
            changes = {key: value for key, value in payload.items() if key not in {"schema_version", "edit_revision", "object_id"}}
            update["objects"] = [{**changes, "object_id": object_id}]
            scene = await asyncio.to_thread(factory.update_scene, request.match_info["scene_id"], update)
            return web.json_response(factory._public_scene(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except RuntimeError as exc:
            return _json_error(web, exc, 409)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/scenes/{{scene_id}}/objects/{{object_id}}/duplicate")
    async def factory_object_duplicate(request: Any) -> Any:
        try:
            result = await asyncio.to_thread(
                factory.duplicate_object,
                request.match_info["scene_id"],
                request.match_info["object_id"],
            )
            return web.json_response({
                "scene": factory._public_scene(result["scene"]),
                "object_id": result["object_id"],
            })
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.delete(f"{factory.API_BASE}/scenes/{{scene_id}}/objects/{{object_id}}")
    async def factory_object_delete(request: Any) -> Any:
        try:
            scene = await asyncio.to_thread(
                factory.delete_object, request.match_info["scene_id"], request.match_info["object_id"],
            )
            return web.json_response(factory._public_scene(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{factory.API_BASE}/scenes/{{scene_id}}/objects/{{object_id}}/export/ply")
    async def factory_object_export(request: Any) -> Any:
        try:
            path = await asyncio.to_thread(
                factory._ensure_object_ply_export,
                request.match_info["scene_id"],
                request.match_info["object_id"],
            )
            download_name = f"{factory._validate_id(request.match_info['object_id'], 'object id')}.ply"
            return web.FileResponse(
                path,
                headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{factory.API_BASE}/scenes/{{scene_id}}/export")
    async def factory_scene_export(request: Any) -> Any:
        try:
            scene_id = factory._validate_id(request.match_info["scene_id"], "scene id")
            result = await asyncio.to_thread(factory.ensure_scene_ply_export, scene_id)
            return web.json_response(factory._public_scene(result["scene"]))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{factory.API_BASE}/scenes/{{scene_id}}/exports/ply")
    async def factory_scene_export_download(request: Any) -> Any:
        try:
            result = await asyncio.to_thread(
                factory.ensure_scene_ply_export,
                request.match_info["scene_id"],
            )
            path = result["ply"]
            scene_id = factory._validate_id(request.match_info["scene_id"], "scene id")
            return web.FileResponse(
                path,
                headers={
                    "Content-Disposition":
                    f'attachment; filename="scene-{scene_id}.ply"'
                },
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    # The model library is part of the Factory API and must be added to the
    # exact same ComfyUI RouteTableDef. Keeping this call inside the proven
    # Factory registrar prevents a second, late aiohttp registration path.
    from .factory3d_library import register_routes as register_library_routes

    register_library_routes(routes)
    _REGISTERED = True
