"""Immutable Factory conditioning captures. No renderer or model dependencies."""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import secrets
import shutil
import time
from pathlib import Path

import numpy as np
from PIL import Image

BUILD = "20260907.1"
PROFILE_NAMES = ("Mesh geometry", "Coarse boxes for Gaussian objects")
PARTS = ("rgb", "depth", "normal", "object_id")
_HASH = re.compile(r"^[a-f0-9]{64}$")
_SCENE_FIELDS = ("scene_id", "schema_version", "revision", "render_revision", "objects",
                 "architecture", "levels", "layers", "textures", "lighting", "skydome", "camera", "cameras", "render")


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def _root(backend, scene_id):
    return backend.resolve_scene_dir(backend._validate_id(scene_id, "scene id")) / "conditioning"


def _document(scene):
    return {key: scene[key] for key in _SCENE_FIELDS if key in scene}


def _assets(backend, scene_id):
    root = backend.resolve_scene_dir(scene_id).resolve()
    hashes = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if relative.parts[0] in {"conditioning", "preview", "exports"} or path.name == "scene.json":
            continue
        if any(part.startswith(".") for part in relative.parts) or not path.is_file():
            continue
        if not path.resolve().is_relative_to(root):
            raise ValueError("Scene asset escapes its managed directory")
        with path.open("rb") as source:
            hashes[relative.as_posix()] = hashlib.file_digest(source, "sha256").hexdigest()
    return hashes


def create_scene_handle(backend, scene, owner_node_id=None):
    scene_id = backend._validate_id(scene["scene_id"], "scene id")
    manifest = {"version": 1, "scene": _document(scene), "assets": _assets(backend, scene_id)}
    signature = _digest(manifest)
    path = _root(backend, scene_id) / "snapshots" / f"{signature}.json"
    with backend._STATE_LOCK:
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            backend._atomic_json(path, manifest)
    return {"scene_id": scene_id, "manifest_hash": signature,
            "content_revision": int(scene.get("revision", 0)),
            "render_revision": int(scene.get("render_revision", scene.get("revision", 0))),
            "owner_node_id": str(owner_node_id) if owner_node_id is not None else ""}


def _snapshot(backend, handle, verify_current=False):
    if not isinstance(handle, dict) or not _HASH.fullmatch(str(handle.get("manifest_hash", ""))):
        raise ValueError("Invalid Factory scene handle; connect the scene output of 3D Factory")
    path = _root(backend, handle.get("scene_id")) / "snapshots" / f"{handle['manifest_hash']}.json"
    if not path.is_file():
        raise ValueError("Factory snapshot expired; execute 3D Factory again")
    manifest = json.loads(path.read_text())
    if _digest(manifest) != handle["manifest_hash"]:
        raise ValueError("Factory snapshot integrity check failed")
    if verify_current:
        scene = backend.load_scene(handle["scene_id"])
        if (_digest(_document(scene)) != _digest(manifest["scene"])
                or _assets(backend, handle["scene_id"]) != manifest["assets"]):
            raise ValueError("Factory scene or assets changed; execute 3D Factory again")
    return manifest


def _settings(profile, width, height, depth_min, depth_max):
    if profile not in PROFILE_NAMES:
        raise ValueError("Unknown conditioning profile")
    if any(isinstance(value, bool) or not isinstance(value, int) or not 64 <= value <= 2048
           for value in (width, height)):
        raise ValueError("Conditioning dimensions must be integers from 64 to 2048")
    depth_min, depth_max = float(depth_min), float(depth_max)
    if not math.isfinite(depth_min + depth_max) or not 0 <= depth_min < depth_max <= 1000000:
        raise ValueError("Depth interval must satisfy 0 <= near < far <= 1000000 meters")
    return {"profile": profile, "width": width, "height": height,
            "depth_min": depth_min, "depth_max": depth_max, "renderer_build": BUILD}


def _entity_lut(backend, scene):
    path = _root(backend, scene["scene_id"]) / "entity_ids.json"
    lut = json.loads(path.read_text()) if path.exists() else {}
    keys = [f"object:{item['object_id']}" for item in scene.get("objects", [])]
    for plural, kind, field in [("walls", "wall", "wall_id"), ("rooms", "room", "room_id"),
                                ("openings", "opening", "opening_id")]:
        keys.extend(f"{kind}:{item[field]}" for item in scene.get("architecture", {}).get(plural, []))
    next_id = max(lut.values(), default=0) + 1
    for key in sorted(set(keys)):
        if key not in lut:
            if next_id > 16777215:
                raise ValueError("Scene exceeded RGB24 entity IDs")
            lut[key] = next_id
            next_id += 1
    backend._atomic_json(path, lut)
    return {key: lut[key] for key in keys}


def prepare_capture(backend, handle, profile, width, height, depth_min, depth_max):
    snapshot = _snapshot(backend, handle)
    settings = _settings(profile, width, height, depth_min, depth_max)
    signature = _digest({"snapshot": handle["manifest_hash"], "settings": settings})
    root = _root(backend, handle["scene_id"])
    cleanup_jobs(backend, handle["scene_id"])
    cached = root / "captures" / signature / "manifest.json"
    if cached.is_file():
        return {"capture": {"scene_id": handle["scene_id"], "capture_hash": signature}}
    _snapshot(backend, handle, verify_current=True)
    scene = snapshot["scene"]
    if len(scene.get("cameras", [])) > backend.MAX_SCENE_CAMERAS:
        raise ValueError("Too many capture cameras")
    shots = [{"shot_id": "current", "camera": scene.get("camera", {})}]
    shots += [{"shot_id": camera["camera_id"], "camera": camera} for camera in scene.get("cameras", [])]
    if width * height * len(shots) > 32 * 1024 * 1024:
        raise ValueError("Capture exceeds the 32-megapixel total budget; reduce resolution or saved camera count")
    with backend._STATE_LOCK:
        lut = _entity_lut(backend, scene)
        job_id = secrets.token_hex(16)
        job = {"job_id": job_id, "handle": handle, "signature": signature, "settings": settings,
               "shots": shots, "entity_ids": lut, "status": "pending", "created_at": time.time()}
        directory = root / "jobs" / job_id
        directory.mkdir(parents=True, exist_ok=False)
        backend._atomic_json(directory / "job.json", job)
    return job


def cleanup_jobs(backend, scene_id):
    """Expire only managed staging jobs; never evict published capture handles."""
    directory = _root(backend, scene_id) / "jobs"
    if not directory.exists():
        return
    for child in directory.iterdir():
        if not re.fullmatch(r"[a-f0-9]{32}", child.name) or not (child / "job.json").is_file():
            continue
        with backend._STATE_LOCK:
            job = json.loads((child / "job.json").read_text())
            age = time.time() - job.get("created_at", time.time())
            if job.get("status") == "pending" and age > 600:
                fail_job(backend, scene_id, child.name, "Capture expired")
            if age > 86400:
                shutil.rmtree(child)


def read_job(backend, scene_id, job_id):
    directory = _root(backend, scene_id) / "jobs" / backend._validate_id(job_id, "job id")
    job = json.loads((directory / "job.json").read_text())
    if job["status"] == "pending" and time.time() - job["created_at"] > 600:
        fail_job(backend, scene_id, job_id, "Capture expired; execute Factory Render again")
        job = json.loads((directory / "job.json").read_text())
    return job


def fail_job(backend, scene_id, job_id, error):
    directory = _root(backend, scene_id) / "jobs" / backend._validate_id(job_id, "job id")
    with backend._STATE_LOCK:
        job = json.loads((directory / "job.json").read_text())
        if job["status"] != "pending":
            return
        job.update(status="failed", error=str(error)[:2048])
        backend._atomic_json(directory / "job.json", job)
        for child in directory.iterdir():
            if child.is_dir():
                shutil.rmtree(child)


def _png(source, width, height):
    raw = source.read(32 * 1024 * 1024 + 1) if hasattr(source, "read") else bytes(source)
    if len(raw) > 32 * 1024 * 1024:
        raise ValueError("Conditioning part exceeds 32 MiB")
    with Image.open(io.BytesIO(raw)) as image:
        if image.format != "PNG" or image.size != (width, height):
            raise ValueError("Conditioning part must be a PNG with the requested dimensions")
        return np.array(image.convert("RGBA"))


def _verify_camera(metadata, camera, width, height):
    position = np.asarray(camera.get("position", [0, 2, 4]), dtype=np.float64)
    target = np.asarray(camera.get("target", [0, 0, 0]), dtype=np.float64)
    up = np.asarray(camera.get("up", [0, 1, 0]), dtype=np.float64)
    if any(vector.shape != (3,) or not np.isfinite(vector).all() for vector in (position, target, up)):
        raise ValueError("Snapshot has no valid camera pose")
    if np.linalg.norm(position - target) < 1e-6:
        target = position + [0, 0, -1]
    if np.linalg.norm(up) < 1e-6:
        up = np.array([0.0, 1.0, 0.0])
    up /= np.linalg.norm(up)
    distance = max(float(np.linalg.norm(position - target)), 0.001)
    z_axis = (position - target) / np.linalg.norm(position - target)
    x_axis = np.cross(up, z_axis)
    if np.dot(x_axis, x_axis) == 0:
        z_axis[0 if abs(up[2]) == 1 else 2] += 0.0001
        z_axis /= np.linalg.norm(z_axis)
        x_axis = np.cross(up, z_axis)
    x_axis /= np.linalg.norm(x_axis)
    world = np.eye(4)
    world[:3, :3] = np.column_stack([x_axis, np.cross(z_axis, x_axis), z_axis])
    world[:3, 3] = position
    near, far = max(0.02, min(0.1, distance / 1000)), max(1000, distance * 1000)
    fov = max(5, min(120, float(camera.get("fov", 42))))
    f = 1 / math.tan(math.radians(fov) / 2)
    projection = np.array([[f / (width / height), 0, 0, 0], [0, f, 0, 0],
                           [0, 0, -(far + near) / (far - near), -2 * far * near / (far - near)], [0, 0, -1, 0]])
    if (not np.allclose(world.flatten(order="F"), metadata["camera_world_matrix"], atol=1e-7, rtol=1e-7)
            or not np.allclose(projection.flatten(order="F"), metadata["projection_matrix"], atol=1e-7, rtol=1e-7)
            or not math.isclose(float(metadata.get("clip_near", 0)), near, rel_tol=1e-7)
            or not math.isclose(float(metadata["clip_far"]), far, rel_tol=1e-7)):
        raise ValueError("Captured camera does not match the frozen shot")


def store_shot(backend, scene_id, job_id, shot_index, sources, metadata):
    job = read_job(backend, scene_id, job_id)
    if job["status"] != "pending":
        raise ValueError("Capture job is no longer pending")
    if type(shot_index) is not int or not 0 <= shot_index < len(job["shots"]) or set(sources) != set(PARTS):
        raise ValueError("Capture shot or pass set is invalid")
    settings = job["settings"]
    width, height = settings["width"], settings["height"]
    if not isinstance(metadata, dict) or len(json.dumps(metadata, allow_nan=False)) > 65536:
        raise ValueError("Capture metadata is invalid")
    if metadata.get("renderer_build") != BUILD or metadata.get("shot_id") != job["shots"][shot_index]["shot_id"]:
        raise ValueError("Capture renderer or shot identity mismatch")
    for key in ("projection_matrix", "camera_world_matrix"):
        matrix = metadata.get(key)
        if not isinstance(matrix, list) or len(matrix) != 16 or any(
                isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value)
                for value in matrix):
            raise ValueError("Capture camera matrix is invalid")
    far = metadata.get("clip_far")
    if isinstance(far, bool) or not isinstance(far, (int, float)) or not 0 < far <= 1000000000:
        raise ValueError("Capture clip range is invalid")
    _verify_camera(metadata, job["shots"][shot_index]["camera"], width, height)
    images = {name: _png(sources[name], width, height) for name in PARTS}
    ids_rgb = images["object_id"][:, :, :3].astype(np.uint32)
    ids = ids_rgb[:, :, 0] * 65536 + ids_rgb[:, :, 1] * 256 + ids_rgb[:, :, 2]
    if not np.isin(np.unique(ids), [0, *job["entity_ids"].values()]).all():
        raise ValueError("Capture contains unknown entity IDs")
    valid = ids != 0
    for name in ("depth", "normal", "object_id"):
        if not np.array_equal(images[name][:, :, 3] > 0, valid):
            raise ValueError("Conditioning passes disagree on foreground coverage")
    packed = images["depth"][:, :, :3].astype(np.uint32)
    depth = ((packed[:, :, 0] * 65536 + packed[:, :, 1] * 256 + packed[:, :, 2])
             * (float(far) / 16777215)).astype("<f4")
    if not np.isfinite(depth).all() or np.any(depth[valid] <= 0):
        raise ValueError("Foreground depth must be finite and positive")
    depth[~valid] = 0
    normals = images["normal"][:, :, :3].astype(np.float32) / 127.5 - 1
    if np.any(np.abs(np.linalg.norm(normals[valid], axis=-1) - 1) > 0.03):
        raise ValueError("Foreground normals must encode unit vectors")
    directory = _root(backend, scene_id) / "jobs" / job_id
    temporary = directory / f".shot-{shot_index}-{secrets.token_hex(6)}"
    temporary.mkdir()
    try:
        for name in ("rgb", "normal", "object_id"):
            rgb = images[name][:, :, :3].copy()
            if name == "normal":
                rgb[~valid] = 128
            Image.fromarray(rgb).save(temporary / f"{name}.png")
        Image.fromarray(valid.astype(np.uint8) * 255).save(temporary / "alpha.png")
        (temporary / "depth.f32").write_bytes(depth.tobytes())
        metadata.update(depth_encoding="float32-le", depth_units="meters", depth_axis="camera_forward",
                        quantization_meters=float(far) / 16777215, normal_space="view",
                        row_origin="top_left", coverage="binary", material_policy="surface_alpha_cutout",
                        width=width, height=height, profile=settings["profile"])
        backend._atomic_json(temporary / "metadata.json", metadata)
        with backend._STATE_LOCK:
            if read_job(backend, scene_id, job_id)["status"] != "pending":
                raise ValueError("Capture cancelled while uploading")
            final = directory / str(shot_index)
            if final.exists():
                raise ValueError("Capture shot was already uploaded")
            os.replace(temporary, final)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    return {"shot_index": shot_index, "status": "stored"}


def publish_capture(backend, scene_id, job_id):
    job = read_job(backend, scene_id, job_id)
    directory = _root(backend, scene_id) / "jobs" / job_id
    with backend._STATE_LOCK:
        _snapshot(backend, job["handle"], verify_current=True)
        job = read_job(backend, scene_id, job_id)
        if job["status"] != "pending":
            raise ValueError("Capture job is no longer pending")
        files = {}
        for index in range(len(job["shots"])):
            for name in ("rgb.png", "normal.png", "object_id.png", "alpha.png", "depth.f32", "metadata.json"):
                path = directory / str(index) / name
                if not path.is_file():
                    raise ValueError("Capture is incomplete; previous captures remain available")
                with path.open("rb") as source:
                    files[f"{index}/{name}"] = hashlib.file_digest(source, "sha256").hexdigest()
        target = _root(backend, scene_id) / "captures" / job["signature"]
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            stage = target.parent / f".{job_id}.tmp"
            stage.mkdir()
            try:
                for index in range(len(job["shots"])):
                    shutil.copytree(directory / str(index), stage / str(index))
                manifest = {"version": 1, "scene_id": scene_id, "snapshot": job["handle"]["manifest_hash"],
                            "settings": job["settings"], "shots": job["shots"], "entity_ids": job["entity_ids"],
                            "files": files, "capture_hash": job["signature"]}
                backend._atomic_json(stage / "manifest.json", manifest)
                os.replace(stage, target)
            finally:
                shutil.rmtree(stage, ignore_errors=True)
        job.update(status="complete", capture={"scene_id": scene_id, "capture_hash": job["signature"]})
        backend._atomic_json(directory / "job.json", job)
        for index in range(len(job["shots"])):
            shutil.rmtree(directory / str(index))
        return job["capture"]


def load_capture(backend, handle):
    if not isinstance(handle, dict) or not _HASH.fullmatch(str(handle.get("capture_hash", ""))):
        raise ValueError("Invalid Factory capture handle")
    directory = _root(backend, handle.get("scene_id")) / "captures" / handle["capture_hash"]
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("capture_hash") != handle["capture_hash"]:
        raise ValueError("Capture manifest integrity check failed")
    for name, expected in manifest["files"].items():
        path = (directory / name).resolve()
        if not path.is_relative_to(directory.resolve()):
            raise ValueError("Invalid capture part path")
        with path.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != expected:
                raise ValueError("Capture part integrity check failed")
    return directory, manifest


def register_routes(routes, backend):
    from aiohttp import web
    import asyncio

    base = backend.API_BASE + "/conditioning/{scene_id}/jobs/{job_id}"

    @routes.get(base)
    async def get_job(request):
        try:
            job = read_job(backend, request.match_info["scene_id"], request.match_info["job_id"])
            await asyncio.to_thread(_snapshot, backend, job["handle"], True)
            return web.json_response(job)
        except (ValueError, FileNotFoundError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.post(base + "/shots/{index}")
    async def upload_shot(request):
        try:
            if not backend._content_length_ok(request, 130 * 1024 * 1024):
                raise ValueError("Conditioning upload is too large")
            post = await request.post()
            sources = {}
            for name in PARTS:
                field = post.get(name)
                if not hasattr(field, "file"):
                    raise ValueError(f"Missing {name} capture")
                sources[name] = field.file
            raw_metadata = str(post.get("metadata", ""))
            if len(raw_metadata) > 65536:
                raise ValueError("Capture metadata is too large")
            result = await asyncio.to_thread(store_shot, backend, request.match_info["scene_id"],
                                            request.match_info["job_id"], int(request.match_info["index"]),
                                            sources, json.loads(raw_metadata))
            return web.json_response(result, status=201)
        except (ValueError, FileNotFoundError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.post(base + "/publish")
    async def publish(request):
        try:
            result = await asyncio.to_thread(publish_capture, backend, request.match_info["scene_id"], request.match_info["job_id"])
            return web.json_response(result, status=201)
        except (ValueError, FileNotFoundError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.post(base + "/error")
    async def error(request):
        try:
            if not backend._content_length_ok(request, 8192):
                raise ValueError("Capture error is too large")
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("Capture error must be an object")
            fail_job(backend, request.match_info["scene_id"], request.match_info["job_id"], payload.get("error", "Capture failed"))
            return web.json_response({"status": "recorded"})
        except (ValueError, FileNotFoundError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
