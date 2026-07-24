"""Persistent Gaussian asset library for VNCCS 3D Factory.

The library deliberately stores native Factory data instead of converting it:
each entry is a small metadata record, an automatic PNG preview, and a
``.vnccs3d`` ZIP containing Gaussian PLY/SPLAT files plus scene metadata.
Repositories use the same manifest-driven Hugging Face workflow as Pose
Studio, but keep their state in a separate namespace.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import threading
import time
import urllib.parse
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from PIL import Image

from . import factory3d as factory


API_BASE = "/vnccs/3d-factory/library"
LOCAL_REPOSITORY = "local_user_models"
DEFAULT_CATEGORY = "Uncategorized"
MANIFEST_NAME = "vnccs_3d_library.json"
PACKAGE_SUFFIX = ".vnccs3d"
SCHEMA = "vnccs-3d-factory-library/v1"
MAX_REQUEST_BYTES = 20 * 1024 * 1024
MAX_PREVIEW_BYTES = 16 * 1024 * 1024
MAX_PACKAGE_FILES = 4096
MAX_EXTRACTED_BYTES = 16 * 1024 * 1024 * 1024
_SAFE_PART = re.compile(r"[^A-Za-z0-9._ -]+")


def _pose_library_call(name: str, *args: Any, **kwargs: Any) -> Any:
    # Reuse Pose Studio's existing private credential store and progress
    # registry without making aiohttp a module-import requirement for the
    # package and offline tooling.
    from . import pose_library

    return getattr(pose_library, name)(*args, **kwargs)


def get_hf_token() -> str:
    return str(_pose_library_call("get_hf_token") or "")


def get_vnccs_user_config() -> dict[str, Any]:
    value = _pose_library_call("get_vnccs_user_config")
    return value if isinstance(value, dict) else {}


def save_vnccs_user_config(value: dict[str, Any]) -> None:
    _pose_library_call("save_vnccs_user_config", value)


def repository_progress_start(*args: Any, **kwargs: Any) -> None:
    _pose_library_call("repository_progress_start", *args, **kwargs)


def repository_progress_update(*args: Any, **kwargs: Any) -> None:
    _pose_library_call("repository_progress_update", *args, **kwargs)


def repository_progress_finish(*args: Any, **kwargs: Any) -> None:
    _pose_library_call("repository_progress_finish", *args, **kwargs)


def repository_progress_fail(*args: Any, **kwargs: Any) -> None:
    _pose_library_call("repository_progress_fail", *args, **kwargs)


def get_repository_progress(task_id: str) -> dict[str, Any]:
    value = _pose_library_call("get_repository_progress", task_id)
    return value if isinstance(value, dict) else {}


def _root() -> Path:
    root = (Path(__file__).resolve().parents[1] / "ModelLibrary").resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _repo_dir(repo_id: str) -> str:
    if repo_id == LOCAL_REPOSITORY:
        return LOCAL_REPOSITORY
    return re.sub(r"[^A-Za-z0-9._-]+", "__", str(repo_id or "")).strip("._")[:160]


def _category(value: Any) -> str:
    text = _SAFE_PART.sub("", str(value or "")).strip(" .")
    return text[:80] or DEFAULT_CATEGORY


def _name(value: Any, fallback: str = "Gaussian asset") -> str:
    text = _SAFE_PART.sub("", str(value or "")).strip(" .")
    return text[:96] or fallback


def _asset_id(value: Any = "") -> str:
    text = str(value or "").lower()
    if not text:
        return secrets.token_hex(12)
    if re.fullmatch(r"[a-f0-9]{24}", text):
        return text
    raise ValueError("invalid library asset id")


def _asset_dir(repository: str, category: str) -> Path:
    target = (_root() / _repo_dir(repository) / _category(category)).resolve()
    if _root() not in target.parents:
        raise ValueError("library path escaped its root")
    target.mkdir(parents=True, exist_ok=True)
    return target


def _paths(repository: str, category: str, asset_id: str) -> dict[str, Path]:
    root = _asset_dir(repository, category)
    safe_id = _asset_id(asset_id)
    return {
        "meta": root / f"{safe_id}.json",
        "package": root / f"{safe_id}{PACKAGE_SUFFIX}",
        "preview": root / f"{safe_id}.png",
    }


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    try:
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _decode_preview(value: Any) -> bytes:
    text = str(value or "")
    if not text:
        return b""
    if "," in text and text.startswith("data:"):
        header, text = text.split(",", 1)
        if ";base64" not in header or not header.startswith("data:image/"):
            raise ValueError("preview must be a base64 image")
    try:
        raw = base64.b64decode(text, validate=True)
    except Exception as exc:
        raise ValueError("preview is not valid base64") from exc
    if len(raw) > MAX_PREVIEW_BYTES:
        raise ValueError("preview is too large")
    with Image.open(io.BytesIO(raw)) as image:
        image.verify()
    with Image.open(io.BytesIO(raw)) as image:
        if image.width * image.height > 4096 * 4096:
            raise ValueError("preview dimensions are too large")
        image = image.convert("RGBA")
        image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="PNG", optimize=True)
        return output.getvalue()


def _fallback_preview(scene: dict[str, Any], object_id: str = "") -> bytes:
    path: Path | None = None
    if object_id:
        item = factory._object_by_id(scene, object_id)
        for key in ("prepared", "reference"):
            try:
                path = factory._object_file(scene["scene_id"], item, key)
                break
            except FileNotFoundError:
                pass
    else:
        try:
            path = factory._scene_preview_file(scene)
        except FileNotFoundError:
            path = None
    return path.read_bytes() if path and path.is_file() else b""


def _zip_write_file(archive: zipfile.ZipFile, source: Path, target: str) -> None:
    if not source.is_file():
        raise FileNotFoundError(source)
    archive.write(source, target, compress_type=zipfile.ZIP_STORED)


def _object_payload(
    archive: zipfile.ZipFile,
    scene: dict[str, Any],
    item: dict[str, Any],
    prefix: str,
) -> dict[str, Any]:
    output = json.loads(json.dumps(item))
    files: dict[str, str] = {}
    for key in ("reference", "prepared", "ply", "splat"):
        try:
            source = factory._object_file(scene["scene_id"], item, key)
        except FileNotFoundError:
            if key in {"ply", "splat"}:
                raise
            continue
        target = f"{prefix}/{source.name}"
        _zip_write_file(archive, source, target)
        files[key] = target
    output["files"] = files
    return output


def _build_package(
    scene: dict[str, Any],
    target: Path,
    *,
    asset_type: str,
    object_id: str = "",
) -> dict[str, Any]:
    temporary = target.with_name(f".{target.name}.{secrets.token_hex(6)}.tmp")
    item_count = 0
    gaussian_count = 0
    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as archive:
            if asset_type == "object":
                item = factory._object_by_id(scene, object_id)
                stored = _object_payload(archive, scene, item, "payload/object")
                payload = {"object": stored}
                item_count = 1
                gaussian_count = int(item.get("gaussians", 0) or 0)
            else:
                stored_objects = []
                for item in scene.get("objects", []):
                    stored_objects.append(
                        _object_payload(
                            archive,
                            scene,
                            item,
                            f"payload/objects/{item['object_id']}",
                        )
                    )
                    gaussian_count += int(item.get("gaussians", 0) or 0)
                snapshot = json.loads(json.dumps(scene))
                snapshot["objects"] = stored_objects
                snapshot.pop("preview", None)
                snapshot["exports"] = {}
                if isinstance(snapshot.get("reference"), dict):
                    try:
                        reference = factory._scene_reference_file(scene)
                        reference_member = "payload/reference/source.png"
                        _zip_write_file(archive, reference, reference_member)
                        snapshot["reference"]["file"] = reference_member
                    except FileNotFoundError:
                        snapshot.pop("reference", None)
                payload = {"scene": snapshot}
                item_count = len(stored_objects)
            manifest = {
                "schema": SCHEMA,
                "asset_type": asset_type,
                "created_at": time.time(),
                "payload": payload,
            }
            archive.writestr(
                "manifest.json",
                json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"),
            )
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return {
        "object_count": item_count,
        "gaussians": gaussian_count,
        "bytes": target.stat().st_size,
        "sha256": _sha256(target),
    }


def _public_record(record: dict[str, Any]) -> dict[str, Any]:
    value = json.loads(json.dumps(record))
    query = "?" + urllib.parse.urlencode(
        {
            "repository": value["repository"],
            "category": value["category"],
            "v": int(value.get("updated_at", 0)),
        }
    )
    value["preview_url"] = f"{API_BASE}/items/{value['asset_id']}/preview{query}"
    value["download_url"] = f"{API_BASE}/items/{value['asset_id']}/download{query}"
    return value


def _read_records() -> list[dict[str, Any]]:
    enabled = {
        item["repo_id"]
        for item in _repositories()
        if item.get("enabled", True)
    }
    enabled.add(LOCAL_REPOSITORY)
    records = []
    for path in _root().glob("*/*/*.json"):
        if path.name == MANIFEST_NAME:
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if (
                isinstance(value, dict)
                and value.get("schema") == SCHEMA
                and value.get("repository") in enabled
            ):
                paths = _paths(
                    value["repository"],
                    value["category"],
                    value["asset_id"],
                )
                if paths["package"].is_file():
                    records.append(value)
        except Exception:
            continue
    records.sort(
        key=lambda item: (-float(item.get("updated_at", 0)), item.get("name", ""))
    )
    return records


def _find_record(
    asset_id: str,
    repository: str = "",
    category: str = "",
) -> tuple[dict[str, Any], dict[str, Path]]:
    safe_id = _asset_id(asset_id)
    if repository and category:
        paths = _paths(repository, category, safe_id)
        candidates = [paths["meta"]]
    else:
        candidates = list(_root().glob(f"*/*/{safe_id}.json"))
    for path in candidates:
        if not path.is_file():
            continue
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or value.get("schema") != SCHEMA:
            continue
        paths = _paths(value["repository"], value["category"], safe_id)
        if paths["package"].is_file():
            return value, paths
    raise FileNotFoundError("library asset was not found")


def save_asset(payload: dict[str, Any]) -> dict[str, Any]:
    scene = factory.load_scene(str(payload.get("scene_id") or ""))
    asset_type = str(payload.get("asset_type") or "object").lower()
    if asset_type not in {"object", "scene"}:
        raise ValueError("asset_type must be object or scene")
    object_id = str(payload.get("object_id") or "") if asset_type == "object" else ""
    item = factory._object_by_id(scene, object_id) if object_id else None
    repository = LOCAL_REPOSITORY
    category = _category(payload.get("category"))
    asset_id = _asset_id()
    paths = _paths(repository, category, asset_id)
    display_name = _name(
        payload.get("name"),
        item.get("name", "Gaussian object") if item else scene.get("name", "Gaussian scene"),
    )
    preview = _decode_preview(payload.get("preview")) or _fallback_preview(scene, object_id)
    stats = _build_package(
        scene,
        paths["package"],
        asset_type=asset_type,
        object_id=object_id,
    )
    timestamp = time.time()
    record = {
        "schema": SCHEMA,
        "asset_id": asset_id,
        "asset_type": asset_type,
        "name": display_name,
        "description": str(payload.get("description") or "")[:2000],
        "category": category,
        "tags": [
            str(tag).strip()[:48]
            for tag in (
                payload.get("tags")
                if isinstance(payload.get("tags"), list)
                else []
            )
            if str(tag).strip()
        ][:32],
        "repository": repository,
        "created_at": timestamp,
        "updated_at": timestamp,
        "has_preview": bool(preview),
        "package": paths["package"].name,
        **stats,
    }
    try:
        if preview:
            paths["preview"].write_bytes(preview)
        _atomic_json(paths["meta"], record)
    except Exception:
        paths["package"].unlink(missing_ok=True)
        paths["preview"].unlink(missing_ok=True)
        raise
    return record


def update_asset(asset_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    record, paths = _find_record(
        asset_id,
        str(payload.get("repository") or ""),
        str(payload.get("old_category") or payload.get("category") or ""),
    )
    if record.get("repository") != LOCAL_REPOSITORY:
        raise ValueError("downloaded repository assets are read-only")
    category = _category(payload.get("category") or record.get("category"))
    target_paths = _paths(LOCAL_REPOSITORY, category, record["asset_id"])
    preview_value = payload.get("preview")
    if preview_value:
        target_paths["preview"].write_bytes(_decode_preview(preview_value))
    elif paths["preview"].is_file() and paths["preview"] != target_paths["preview"]:
        target_paths["preview"].parent.mkdir(parents=True, exist_ok=True)
        shutil.move(paths["preview"], target_paths["preview"])
    for kind in ("package",):
        if paths[kind] != target_paths[kind]:
            target_paths[kind].parent.mkdir(parents=True, exist_ok=True)
            shutil.move(paths[kind], target_paths[kind])
    record.update(
        {
            "name": _name(payload.get("name"), record.get("name") or "Gaussian asset"),
            "description": str(payload.get("description") or "")[:2000],
            "category": category,
            "tags": [
                str(tag).strip()[:48]
                for tag in (payload.get("tags") if isinstance(payload.get("tags"), list) else [])
                if str(tag).strip()
            ][:32],
            "updated_at": time.time(),
            "has_preview": target_paths["preview"].is_file(),
        }
    )
    _atomic_json(target_paths["meta"], record)
    if paths["meta"] != target_paths["meta"]:
        paths["meta"].unlink(missing_ok=True)
    if paths["preview"] != target_paths["preview"]:
        paths["preview"].unlink(missing_ok=True)
    return record


def _safe_member(member: zipfile.ZipInfo) -> PurePosixPath:
    path = PurePosixPath(member.filename)
    if path.is_absolute() or ".." in path.parts or "\\" in member.filename:
        raise ValueError("library package contains an unsafe path")
    return path


def _read_package(paths: dict[str, Path]) -> tuple[zipfile.ZipFile, dict[str, Any]]:
    archive = zipfile.ZipFile(paths["package"], "r", allowZip64=True)
    members = archive.infolist()
    if len(members) > MAX_PACKAGE_FILES:
        archive.close()
        raise ValueError("library package contains too many files")
    if sum(item.file_size for item in members) > MAX_EXTRACTED_BYTES:
        archive.close()
        raise ValueError("library package is too large")
    for member in members:
        _safe_member(member)
    try:
        manifest = json.loads(archive.read("manifest.json"))
    except Exception:
        archive.close()
        raise ValueError("library package manifest is invalid")
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
        archive.close()
        raise ValueError("unsupported library package")
    return archive, manifest


def _install_object(
    archive: zipfile.ZipFile,
    stored: dict[str, Any],
    scene: dict[str, Any],
) -> str:
    object_id = factory._new_id()
    root = factory.resolve_scene_dir(scene["scene_id"])
    object_root = root / "objects" / object_id
    object_root.mkdir(parents=True, exist_ok=False)
    installed: dict[str, str] = {}
    try:
        for key, member_name in (stored.get("files") or {}).items():
            if key not in {"reference", "prepared", "ply", "splat"}:
                continue
            member = archive.getinfo(str(member_name))
            _safe_member(member)
            suffix = Path(member.filename).suffix.lower()
            target_name = {
                "reference": "reference.png",
                "prepared": "prepared.png",
                "ply": "model.ply",
                "splat": "model.splat",
            }[key]
            target = object_root / target_name
            with archive.open(member) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output, length=4 * 1024 * 1024)
            if suffix and key in {"reference", "prepared"} and suffix != ".png":
                with Image.open(target) as image:
                    image.convert("RGBA").save(target, "PNG")
            installed[key] = str(target.relative_to(root))
        if not {"ply", "splat"}.issubset(installed):
            raise ValueError("Gaussian object package is incomplete")
        item = json.loads(json.dumps(stored))
        item["object_id"] = object_id
        item["name"] = factory._duplicate_object_name(scene, stored.get("name"))
        item["created_at"] = time.time()
        item["transform"] = factory.normalize_transform(stored.get("transform"))
        item["files"] = installed
        scene["objects"].append(item)
        scene["layers"].append({"type": "object", "object_id": object_id})
        return object_id
    except Exception:
        shutil.rmtree(object_root, ignore_errors=True)
        raise


def load_asset(
    asset_id: str,
    *,
    repository: str = "",
    category: str = "",
    scene_id: str = "",
) -> dict[str, Any]:
    record, paths = _find_record(asset_id, repository, category)
    archive, manifest = _read_package(paths)
    try:
        asset_type = manifest.get("asset_type")
        payload = manifest.get("payload") or {}
        if asset_type == "object":
            with factory._STATE_LOCK:
                scene = factory.load_scene(scene_id)
                object_id = _install_object(archive, payload.get("object") or {}, scene)
                factory._object_by_id(scene, object_id)["name"] = _name(
                    record.get("name"),
                    "Gaussian object",
                )
                scene["exports"] = {}
                factory._save_scene(scene)
            return {
                "scene": factory._public_scene(scene),
                "object_id": object_id,
                "created_scene": False,
            }
        if asset_type != "scene":
            raise ValueError("unsupported library asset type")
        stored_scene = payload.get("scene")
        if not isinstance(stored_scene, dict):
            raise ValueError("scene package is incomplete")
        scene = factory.create_scene(record.get("name") or stored_scene.get("name"))
        id_map: dict[str, str] = {}
        try:
            with factory._STATE_LOCK:
                scene = factory.load_scene(scene["scene_id"])
                for stored in stored_scene.get("objects", []):
                    old_id = str(stored.get("object_id") or "")
                    id_map[old_id] = _install_object(archive, stored, scene)
                scene["layers"] = []
                for layer in stored_scene.get("layers", []):
                    if layer.get("type") == "object" and layer.get("object_id") in id_map:
                        scene["layers"].append(
                            {"type": "object", "object_id": id_map[layer["object_id"]]}
                        )
                    elif layer.get("type") == "group":
                        children = [
                            id_map[item]
                            for item in layer.get("children", [])
                            if item in id_map
                        ]
                        if children:
                            copied = json.loads(json.dumps(layer))
                            copied["group_id"] = factory._new_id()
                            copied["children"] = children
                            scene["layers"].append(copied)
                scene["render"] = factory._normalize_render_settings(stored_scene.get("render"))
                scene["camera"] = factory._normalize_camera(stored_scene.get("camera"))
                scene["lighting"] = factory._normalize_lighting(stored_scene.get("lighting"))
                stored_reference = stored_scene.get("reference")
                if isinstance(stored_reference, dict) and stored_reference.get("file"):
                    member = archive.getinfo(str(stored_reference["file"]))
                    _safe_member(member)
                    reference_root = factory.resolve_scene_dir(scene["scene_id"]) / "reference"
                    reference_root.mkdir(parents=True, exist_ok=True)
                    reference_path = reference_root / "source.png"
                    with archive.open(member) as source, reference_path.open("wb") as output:
                        shutil.copyfileobj(source, output, length=4 * 1024 * 1024)
                    scene["reference"] = {
                        **json.loads(json.dumps(stored_reference)),
                        "file": str(reference_path.relative_to(
                            factory.resolve_scene_dir(scene["scene_id"])
                        )),
                    }
                scene["exports"] = {}
                factory._save_scene(scene)
            return {
                "scene": factory._public_scene(scene),
                "object_id": next(iter(id_map.values()), ""),
                "created_scene": True,
            }
        except Exception:
            shutil.rmtree(factory.resolve_scene_dir(scene["scene_id"]), ignore_errors=True)
            raise
    finally:
        archive.close()


def _default_repositories() -> list[dict[str, Any]]:
    path = Path(__file__).resolve().parents[1] / "config" / "default_factory3d_repositories.json"
    if path.is_file():
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
        except Exception:
            pass
    return []


def _repository_config_path() -> Path:
    return _root() / "repositories.user.json"


def _user_repositories() -> list[dict[str, Any]]:
    path = _repository_config_path()
    if not path.is_file():
        return []
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, list):
            return [item for item in loaded if isinstance(item, dict)]
    except Exception:
        pass
    return []


def _repositories() -> list[dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    for item in _default_repositories():
        repo_id = str(item.get("repo_id") or "").strip()
        if repo_id.count("/") != 1 or " " in repo_id:
            continue
        output[repo_id] = {
            "repo_id": repo_id,
            "title": str(item.get("title") or repo_id),
            "description": str(item.get("description") or ""),
            "enabled": item.get("enabled") is not False,
            "builtin": item.get("builtin") is True,
            "manifest_path": MANIFEST_NAME,
        }
    for item in _user_repositories():
        repo_id = str(item.get("repo_id") or "").strip()
        if repo_id.count("/") != 1 or " " in repo_id:
            continue
        if repo_id in output:
            output[repo_id]["enabled"] = item.get("enabled") is not False
            continue
        output[repo_id] = {
            "repo_id": repo_id,
            "title": str(item.get("title") or repo_id),
            "description": str(item.get("description") or ""),
            "enabled": item.get("enabled") is not False,
            "builtin": False,
            "manifest_path": MANIFEST_NAME,
        }
    return list(output.values())


def _save_user_repositories(values: list[dict[str, Any]]) -> None:
    _atomic_json(_repository_config_path(), values)


def _write_local_manifest() -> Path:
    records = [
        item for item in _read_records() if item.get("repository") == LOCAL_REPOSITORY
    ]
    root = _root() / LOCAL_REPOSITORY
    assets = []
    for record in records:
        paths = _paths(LOCAL_REPOSITORY, record["category"], record["asset_id"])
        assets.append(
            {
                **record,
                "meta_path": str(paths["meta"].relative_to(root)).replace(os.sep, "/"),
                "package_path": str(paths["package"].relative_to(root)).replace(os.sep, "/"),
                "preview_path": (
                    str(paths["preview"].relative_to(root)).replace(os.sep, "/")
                    if paths["preview"].is_file()
                    else ""
                ),
                "package_sha256": _sha256(paths["package"]),
            }
        )
    manifest = {
        "schema": SCHEMA,
        "title": "VNCCS 3D Factory Library",
        "updated_at": time.time(),
        "assets": assets,
    }
    path = root / MANIFEST_NAME
    _atomic_json(path, manifest)
    return path


def _sync_repository(
    repo_id: str,
    task_id: str,
    *,
    manage_progress: bool = True,
) -> None:
    if manage_progress:
        repository_progress_start(task_id, f"Reading {repo_id} manifest…")
    try:
        from huggingface_hub import hf_hub_download

        token = get_hf_token() or None
        manifest_path = Path(
            hf_hub_download(
                repo_id=repo_id,
                filename=MANIFEST_NAME,
                repo_type="model",
                token=token,
            )
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        assets = manifest.get("assets") or []
        if not isinstance(assets, list):
            raise ValueError("repository manifest has no assets list")
        root = _root() / _repo_dir(repo_id)
        expected: set[Path] = set()
        total = max(1, len(assets) * 3)
        completed = 0
        for raw in assets:
            if not isinstance(raw, dict):
                continue
            category = _category(raw.get("category"))
            asset_id = _asset_id(raw.get("asset_id"))
            paths = _paths(repo_id, category, asset_id)
            mapping = {
                "meta": raw.get("meta_path"),
                "package": raw.get("package_path"),
                "preview": raw.get("preview_path"),
            }
            for kind, remote_path in mapping.items():
                if not remote_path:
                    completed += 1
                    continue
                repository_progress_update(
                    task_id,
                    message=f"Downloading {raw.get('name') or asset_id}",
                    current_file=str(remote_path),
                    progress=completed / total * 100,
                )
                cached = Path(
                    hf_hub_download(
                        repo_id=repo_id,
                        filename=str(remote_path),
                        repo_type="model",
                        token=token,
                    )
                )
                paths[kind].parent.mkdir(parents=True, exist_ok=True)
                temporary = paths[kind].with_suffix(paths[kind].suffix + ".tmp")
                shutil.copy2(cached, temporary)
                os.replace(temporary, paths[kind])
                if (
                    kind == "package"
                    and raw.get("package_sha256")
                    and _sha256(paths[kind]).lower()
                    != str(raw["package_sha256"]).lower()
                ):
                    paths[kind].unlink(missing_ok=True)
                    raise ValueError(
                        f"SHA256 mismatch for {raw.get('name') or asset_id}"
                    )
                expected.add(paths[kind].resolve())
                completed += 1
            if paths["meta"].is_file():
                record = json.loads(paths["meta"].read_text(encoding="utf-8"))
                record["repository"] = repo_id
                record["category"] = category
                _atomic_json(paths["meta"], record)
        for path in root.glob("*/*"):
            if path.is_file() and path.name != MANIFEST_NAME and path.resolve() not in expected:
                path.unlink(missing_ok=True)
        if manage_progress:
            repository_progress_finish(task_id, f"{len(assets)} Gaussian assets synchronized.")
    except Exception as exc:
        if manage_progress:
            repository_progress_fail(task_id, exc)
            return
        raise


def _sync_repositories(repo_ids: list[str], task_id: str) -> None:
    repository_progress_start(task_id, "Synchronizing Gaussian repositories…")
    try:
        for index, repo_id in enumerate(repo_ids):
            repository_progress_update(
                task_id,
                message=f"Synchronizing {repo_id} ({index + 1}/{len(repo_ids)})…",
                progress=index / max(1, len(repo_ids)) * 100,
            )
            _sync_repository(repo_id, task_id, manage_progress=False)
        repository_progress_finish(
            task_id,
            f"{len(repo_ids)} Gaussian repositories synchronized.",
        )
    except Exception as exc:
        repository_progress_fail(task_id, exc)


def _publish_local(
    repo_id: str,
    task_id: str,
    token: str = "",
    create: bool = False,
    private: bool = False,
) -> None:
    repository_progress_start(task_id, f"Publishing Gaussian library to {repo_id}…")
    try:
        from huggingface_hub import HfApi

        token = token or get_hf_token()
        if not token:
            raise ValueError("Hugging Face token is not configured")
        _write_local_manifest()
        api = HfApi(token=token)
        if create:
            api.create_repo(
                repo_id=repo_id,
                repo_type="model",
                exist_ok=True,
                private=bool(private),
            )
        else:
            api.repo_info(repo_id=repo_id, repo_type="model", token=token)
        root = _root() / LOCAL_REPOSITORY
        repository_progress_update(task_id, message="Uploading packages and previews…", progress=20)
        api.upload_folder(
            repo_id=repo_id,
            repo_type="model",
            folder_path=str(root),
            commit_message="Update VNCCS 3D Factory Gaussian library",
        )
        result = {"repo_id": repo_id, "published_at": time.time()}
        save_vnccs_user_config(
            {
                "hf_token": token,
                "factory3d_library_publish_repo_id": repo_id,
                "factory3d_library_last_publish": result["published_at"],
                "factory3d_library_last_publish_result": result,
            }
        )
        repository_progress_finish(task_id, f"Published to {repo_id}.")
    except Exception as exc:
        repository_progress_fail(task_id, exc)


async def _json(request: Any) -> dict[str, Any]:
    from aiohttp import web

    raw = request.headers.get("Content-Length")
    if raw and int(raw) > MAX_REQUEST_BYTES:
        raise web.HTTPRequestEntityTooLarge(
            max_size=MAX_REQUEST_BYTES,
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
        return web.json_response(
            {
                "schema": SCHEMA,
                "items": [
                    _public_record(item)
                    for item in await asyncio.to_thread(_read_records)
                ],
            }
        )

    async def save_item(request: Any) -> web.Response:
        try:
            record = await asyncio.to_thread(save_asset, await _json(request))
            return web.json_response({"success": True, "item": _public_record(record)})
        except Exception as exc:
            return _error(exc)

    async def update_item(request: Any) -> web.Response:
        try:
            record = await asyncio.to_thread(
                update_asset,
                request.match_info["asset_id"],
                await _json(request),
            )
            return web.json_response({"success": True, "item": _public_record(record)})
        except Exception as exc:
            return _error(exc)

    async def load_item(request: Any) -> web.Response:
        try:
            payload = await _json(request)
            result = await asyncio.to_thread(
                load_asset,
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
            _record, paths = _find_record(
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
            record, paths = _find_record(
                request.match_info["asset_id"],
                request.query.get("repository", ""),
                request.query.get("category", ""),
            )
            filename = f"{_name(record.get('name'))}{PACKAGE_SUFFIX}"
            return web.FileResponse(
                paths["package"],
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )
        except Exception as exc:
            return _error(exc)

    async def delete_item(request: Any) -> web.Response:
        try:
            record, paths = _find_record(
                request.match_info["asset_id"],
                request.query.get("repository", ""),
                request.query.get("category", ""),
            )
            if record.get("repository") != LOCAL_REPOSITORY:
                raise ValueError("downloaded repository assets are read-only")
            for path in paths.values():
                path.unlink(missing_ok=True)
            return web.json_response({"success": True})
        except Exception as exc:
            return _error(exc)

    async def list_repositories(_request: Any) -> web.Response:
        config = get_vnccs_user_config()
        records = _read_records()
        repos = []
        for item in _repositories():
            entry = dict(item)
            entry["asset_count"] = sum(
                record.get("repository") == item["repo_id"] for record in records
            )
            repos.append(entry)
        local_count = sum(record.get("repository") == LOCAL_REPOSITORY for record in records)
        return web.json_response(
            {
                "repositories": repos,
                "local": {
                    "repo_id": LOCAL_REPOSITORY,
                    "title": "Local Gaussian Library",
                    "asset_count": local_count,
                    "has_hf_token": bool(get_hf_token()),
                    "publish_repo_id": config.get("factory3d_library_publish_repo_id", ""),
                    "last_publish": config.get("factory3d_library_last_publish"),
                },
            }
        )

    async def add_repository(request: Any) -> web.Response:
        try:
            payload = await _json(request)
            repo_id = str(payload.get("repo_id") or "").strip()
            if repo_id.count("/") != 1 or " " in repo_id:
                raise ValueError("repository must be owner/name")
            users = [item for item in _user_repositories() if item.get("repo_id") != repo_id]
            users.append(
                {
                    "repo_id": repo_id,
                    "title": str(payload.get("title") or repo_id),
                    "description": str(payload.get("description") or ""),
                    "enabled": True,
                }
            )
            _save_user_repositories(users)
            task_id = secrets.token_hex(12)
            threading.Thread(
                target=_sync_repository,
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
            users = _user_repositories()
            existing = next((item for item in users if item.get("repo_id") == repo_id), None)
            if existing is None:
                if not any(item["repo_id"] == repo_id for item in _repositories()):
                    raise FileNotFoundError("repository was not found")
                users.append({"repo_id": repo_id, "enabled": enabled})
            else:
                existing["enabled"] = enabled
            _save_user_repositories(users)
            return web.json_response({"success": True})
        except Exception as exc:
            return _error(exc)

    async def delete_repository(request: Any) -> web.Response:
        try:
            repo_id = request.match_info["repo_id"]
            if any(item["repo_id"] == repo_id and item.get("builtin") for item in _repositories()):
                raise ValueError("built-in repository cannot be removed")
            users = [item for item in _user_repositories() if item.get("repo_id") != repo_id]
            _save_user_repositories(users)
            shutil.rmtree(_root() / _repo_dir(repo_id), ignore_errors=True)
            return web.json_response({"success": True})
        except Exception as exc:
            return _error(exc)

    async def refresh_repository(request: Any) -> web.Response:
        try:
            payload = await _json(request)
            repo_ids = payload.get("repo_ids")
            if not isinstance(repo_ids, list):
                repo_ids = [
                    item["repo_id"] for item in _repositories() if item.get("enabled", True)
                ]
            task_id = secrets.token_hex(12)

            threading.Thread(
                target=_sync_repositories,
                args=([str(repo_id) for repo_id in repo_ids], task_id),
                daemon=True,
            ).start()
            return web.json_response({"success": True, "task_id": task_id})
        except Exception as exc:
            return _error(exc)

    async def publish_repository(request: Any) -> web.Response:
        try:
            payload = await _json(request)
            repo_id = str(
                payload.get("repo_id")
                or get_vnccs_user_config().get("factory3d_library_publish_repo_id")
                or ""
            ).strip()
            if repo_id.count("/") != 1 or " " in repo_id:
                raise ValueError("publish repository must be owner/name")
            task_id = secrets.token_hex(12)
            token = str(payload.get("hf_token") or get_hf_token() or "")
            if not token:
                raise ValueError("Hugging Face token is required")
            threading.Thread(
                target=_publish_local,
                args=(
                    repo_id,
                    task_id,
                    token,
                    bool(payload.get("create")),
                    bool(payload.get("private", False)),
                ),
                daemon=True,
            ).start()
            return web.json_response({"success": True, "task_id": task_id})
        except Exception as exc:
            return _error(exc)

    async def repository_progress(request: Any) -> web.Response:
        return web.json_response(get_repository_progress(request.match_info["task_id"]))

    async def auto_refresh_repositories(_request: Any) -> web.Response:
        repo_ids = [
            item["repo_id"] for item in _repositories() if item.get("enabled", True)
        ]
        if not repo_ids:
            return web.json_response({"success": True, "task_id": ""})
        task_id = secrets.token_hex(12)

        threading.Thread(
            target=_sync_repositories,
            args=(repo_ids, task_id),
            daemon=True,
        ).start()
        return web.json_response({"success": True, "task_id": task_id})

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
