"""CG Creator access to shared scene metadata and immutable model/CG assets."""

from __future__ import annotations

import io
import hashlib
import json
import math
import os
import re
import sys
import threading
import unicodedata
import uuid
from pathlib import Path
from contextlib import contextmanager

from PIL import Image


MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_IMAGE_BYTES = 64 * 1024 * 1024
MAX_IMAGE_PIXELS = 4096 * 4096
MAX_MODEL_BYTES = 4 * 1024 * 1024 * 1024
MAX_IMAGES = 256
MAX_CGS = 512
MAX_MODELS = 512
_LOCAL_LOCK = threading.RLock()
_ID = re.compile(r"^[a-f0-9]{32}$")
_ASSET_KINDS = {"ply", "splat", "reference", "prepared"}


class BackgroundConflictError(RuntimeError):
    """The document changed after the caller loaded it."""


class BackgroundStorageError(ValueError):
    """Authored metadata could not be read safely."""


def background_owner():
    """Find the installed background owner without importing the main extension."""
    mappings = getattr(sys.modules.get("nodes"), "NODE_CLASS_MAPPINGS", None)
    owner = mappings.get("VNCCS_BackgroundCreator") if isinstance(mappings, dict) else None
    return sys.modules.get(getattr(owner, "__module__", ""))


@contextmanager
def _LOCK():
    with _LOCAL_LOCK:
        lock = getattr(background_owner(), "_LOCK", None)
        if lock is None:
            yield
        else:
            with lock:
                yield


def root():
    import folder_paths

    return Path(folder_paths.get_output_directory()).resolve() / "VNCCS" / "scenes"


def _id(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError("Invalid CG Creator asset ID")
    return value


def _name(value):
    if not isinstance(value, str):
        raise ValueError("A background or CG name is required")
    name = unicodedata.normalize("NFC", value.strip())
    if (not name or len(name) > 96 or name in {".", ".."} or name.endswith(".")
            or any(ord(char) < 32 or ord(char) == 127 or char in '<>:"/\\|?*' for char in name)
            or re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", name, re.I)):
        raise ValueError("Invalid background or CG name")
    return name


def _contained(base, *parts):
    base = Path(base)
    target = base.joinpath(*parts)
    if any(part in {"", ".", ".."} for item in parts for part in str(item).replace("\\", "/").split("/")):
        raise ValueError("Invalid CG Creator asset path")
    if any(path.is_symlink() for path in (base, *target.parents, target)):
        raise ValueError("CG Creator paths cannot contain symbolic links")
    if not target.resolve().is_relative_to(base.resolve()):
        raise ValueError("CG Creator asset path escaped its directory")
    return target


def _path(*parts):
    return _contained(root(), *parts)


def _json_bytes(value):
    try:
        payload = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8")
    except (TypeError, ValueError, OverflowError, RecursionError) as exc:
        raise ValueError("CG Creator metadata must contain finite JSON values") from exc
    if len(payload) > MAX_JSON_BYTES:
        raise ValueError("CG Creator metadata is too large")
    return payload


def _object(value, label):
    if not isinstance(value, dict):
        raise ValueError(f"CG Creator {label} must be an object")
    return json.loads(_json_bytes(value))


def _atomic(path, payload):
    _contained(root(), path.relative_to(root()).as_posix())
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _copy_asset(source, target, maximum):
    """Publish a complete copy; retries may reuse only identical immutable files."""
    _contained(root(), target.relative_to(root()).as_posix())
    if not source.is_file() or source.stat().st_size > maximum:
        raise ValueError("CG Creator source asset is missing or too large")
    if target.exists():
        def digest(path):
            value = hashlib.sha256()
            with path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    value.update(chunk)
            return value.digest()
        if not target.is_file() or target.stat().st_size != source.stat().st_size or digest(target) != digest(source):
            raise BackgroundConflictError("An existing background asset differs; both copies are preserved")
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    try:
        count = 0
        with source.open("rb") as incoming, temporary.open("xb") as outgoing:
            while chunk := incoming.read(1024 * 1024):
                count += len(chunk)
                if count > maximum:
                    raise ValueError("CG Creator source asset is too large")
                outgoing.write(chunk)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _read_json(path):
    with path.open("rb") as stream:
        payload = stream.read(MAX_JSON_BYTES + 1)
    if len(payload) > MAX_JSON_BYTES:
        raise ValueError("CG Creator metadata is too large")
    value = json.loads(payload)
    _json_bytes(value)
    return value, payload


def _dimensions(width, height):
    if (type(width) is not int or type(height) is not int or not 1 <= width <= 16384
            or not 1 <= height <= 16384 or width * height > MAX_IMAGE_PIXELS):
        raise ValueError("CG Creator image dimensions are invalid or too large")


def _camera(value):
    camera = _object(value, "camera")
    for key in ("position", "target", "up"):
        vector = camera.get(key)
        if (not isinstance(vector, list) or len(vector) != 3
                or any(type(number) not in (float, int) or not math.isfinite(number)
                       or abs(number) > 1e6 for number in vector)):
            raise ValueError("Invalid CG Creator camera vector")
    fov = camera.get("fov")
    if type(fov) not in (int, float) or not math.isfinite(fov) or not 5 <= fov <= 120:
        raise ValueError("Invalid CG Creator camera FOV")
    if math.dist(camera["position"], camera["target"]) < 1e-7 or math.hypot(*camera["up"]) < 1e-7:
        raise ValueError("CG Creator camera is degenerate")
    return camera


def _validate(document, directory_name, *, legacy=False):
    if not isinstance(document, dict) or type(document.get("schema_version")) is not int or document["schema_version"] != (1 if legacy else 2):
        raise ValueError("Unsupported shared scene document version")
    _id(document.get("background_id"))
    if _name(document.get("name")) != directory_name:
        raise ValueError("Scene name does not match its directory")
    if type(document.get("revision")) is not int or document["revision"] < 1:
        raise ValueError("Invalid shared scene document revision")
    if type(document.get("archived")) is not bool or not isinstance(document.get("editor"), dict):
        raise ValueError("Invalid shared scene document state")
    images, cgs = document.get("images"), document.get("cgs")
    if not isinstance(images, list) or len(images) > MAX_IMAGES or not isinstance(cgs, list) or len(cgs) > MAX_CGS:
        raise ValueError("Invalid shared scene asset list")
    image_ids, cg_ids = set(), set()
    for image in images:
        if not isinstance(image, dict) or _id(image.get("image_id")) in image_ids:
            raise ValueError("Invalid or duplicate background image")
        image_ids.add(image["image_id"])
        _dimensions(image.get("width"), image.get("height"))
        _object(image.get("settings"), "image settings")
        if "preview_revision" in image and (type(image["preview_revision"]) is not int or image["preview_revision"] < 1):
            raise ValueError("Invalid background image preview revision")
    if document.get("selected_image_id") not in image_ids | {""}:
        raise ValueError("Selected background image does not exist")
    models = ([document["model"]] if document.get("model") else []) if legacy else document.get("models")
    if not isinstance(models, list) or len(models) > MAX_MODELS:
        raise ValueError("Invalid CG Creator model list")
    model_sources = {}
    for model in models:
        if not isinstance(model, dict):
            raise ValueError("Invalid CG Creator model")
        model_id = _id(model.get("model_id"))
        if model_id in model_sources:
            raise ValueError("Duplicate CG Creator model")
        if model.get("source_image_id") not in image_ids:
            raise ValueError("Model source image does not exist")
        model_sources[model_id] = model["source_image_id"]
        _object(model.get("settings"), "model settings")
    for cg in cgs:
        if not isinstance(cg, dict) or _id(cg.get("cg_id")) in cg_ids:
            raise ValueError("Invalid or duplicate background CG")
        cg_ids.add(cg["cg_id"])
        _name(cg.get("name"))
        model_id = _id(cg.get("model_id"))
        if not legacy and (model_id not in model_sources or cg.get("source_image_id") != model_sources[model_id]):
            raise ValueError("CG does not match its background and model variant")
        _dimensions(cg.get("width"), cg.get("height"))
        _camera(cg.get("camera"))
    return document


def _read_document(directory, *, legacy=False):
    filename = "background.json" if legacy else f"{directory.name}.json"
    path = _contained(directory, filename)
    try:
        document, payload = _read_json(path)
        return _validate(document, directory.name, legacy=legacy), payload
    except (OSError, ValueError, TypeError, KeyError, RecursionError) as primary_error:
        try:
            backup = _contained(directory, filename + ".backup")
            document, payload = _read_json(backup)
            _validate(document, directory.name, legacy=legacy)
        except (OSError, ValueError, TypeError, KeyError, RecursionError) as backup_error:
            raise BackgroundStorageError(f"Cannot restore background '{directory.name}'; original files are preserved") from backup_error
        document["_recovery"] = {"source": filename + ".backup", "error": str(primary_error)}
        return document, payload


def _directories():
    base = root()
    if not base.exists():
        return []
    result = []
    for directory in base.iterdir():
        if directory.is_symlink():
            raise BackgroundStorageError("Background library contains a symbolic link")
        if directory.is_dir():
            _name(directory.name)
            if (directory / f"{directory.name}.json").exists() or (directory / f"{directory.name}.json.backup").exists():
                result.append(directory)
    return result


def _migrate_layout():
    """Copy the earlier split library without changing its IDs, revisions or originals."""
    legacy_root = _path("backgrounds")
    if not legacy_root.is_dir():
        return
    for source in sorted(legacy_root.iterdir()):
        if source.is_symlink():
            raise BackgroundStorageError("Background library contains a symbolic link")
        if not source.is_dir() or not any((source / filename).exists() for filename in ("background.json", "background.json.backup")):
            continue
        old, payload = _read_document(source, legacy=True)
        marker = {"background_id": old["background_id"], "sha256": hashlib.sha256(payload).hexdigest()}
        target = _path(old["name"])
        if any(entry.name != old["name"] and entry.name.casefold() == old["name"].casefold() for entry in root().iterdir()):
            raise BackgroundConflictError("Background name conflicts with an existing scene directory")
        path = _contained(target, f"{target.name}.json")
        backup = _contained(target, f"{target.name}.json.backup")
        journal = _contained(target, ".background-migration.json")
        if path.exists() or backup.exists():
            current, _previous = _read_document(target)
            if current["background_id"] != old["background_id"] or current.get("_legacy") != marker:
                raise BackgroundConflictError("The old background library changed or its name conflicts; both copies are preserved")
            if journal.exists():
                if _read_json(journal)[0] != marker:
                    raise BackgroundConflictError("Background migration journal does not match its source")
                if not path.exists() and not old.get("_recovery"):
                    current.pop("_recovery", None)
                    _atomic(path, _json_bytes(current))
                journal.unlink(missing_ok=True)
            continue
        if target.exists() and any(target.iterdir()):
            if not journal.is_file() or _read_json(journal)[0] != marker:
                raise BackgroundConflictError("Background migration destination already contains other data")
        _atomic(journal, _json_bytes(marker))
        document = _object(old, "legacy document")
        recovered = document.pop("_recovery", None)
        latest = document.pop("model", None)
        document.update(schema_version=2, models=[], _legacy=marker)
        for image in document["images"]:
            _copy_asset(_contained(source, "images", f"{image['image_id']}.png"),
                        _contained(target, "background", f"{image['image_id']}.png"), MAX_IMAGE_BYTES)
        models_root = _path("models", document["name"])
        scenes = []
        if models_root.is_dir():
            for model_directory in sorted(models_root.iterdir()):
                if model_directory.is_symlink():
                    raise BackgroundStorageError("Background models contain a symbolic link")
                if not model_directory.is_dir() or not (model_directory / "scene.json").exists():
                    continue
                model_id = _id(model_directory.name)
                scene, _raw = _read_json(_contained(model_directory, "scene.json"))
                if not isinstance(scene, dict) or scene.get("background_id") != document["background_id"] or scene.get("model_id") != model_id:
                    raise BackgroundStorageError("Legacy model manifest does not match its owner")
                scenes.append((model_directory, scene))
        # The previous selected model remains last; other variants retain creation order.
        scenes.sort(key=lambda item: (item[1]["model_id"] == (latest or {}).get("model_id"), str(item[1].get("created_at", ""))))
        for model_directory, scene in scenes:
            model = {"model_id": scene["model_id"], "source_image_id": scene.get("source_image_id"),
                     "scene_id": scene.get("scene_id", ""), "settings": scene.get("background_settings", {})}
            if latest and model["model_id"] == latest["model_id"]:
                if model["source_image_id"] != latest["source_image_id"]:
                    raise BackgroundStorageError("Legacy model source does not match its background variant")
                model.update(latest)
            document["models"].append(model)
            _copy_model(model_directory, scene, _model_directory(document, model["model_id"]))
        model_sources = {model["model_id"]: model["source_image_id"] for model in document["models"]}
        if latest and latest["model_id"] not in model_sources:
            raise BackgroundStorageError("Legacy background model is missing; original files are preserved")
        for cg in document["cgs"]:
            if cg["model_id"] not in model_sources:
                raise BackgroundStorageError("Legacy CG model is missing; original files are preserved")
            cg["source_image_id"] = model_sources[cg["model_id"]]
            for kind in ("raw", "image"):
                _copy_asset(_path("cg", document["name"], cg["name"], cg["cg_id"], f"{kind}.png"),
                            _contained(target, "CG", cg["name"], cg["cg_id"], f"{kind}.png"), MAX_IMAGE_BYTES)
        _validate(document, target.name)
        encoded = _json_bytes(document)
        # Publish metadata only after every referenced asset is complete and the source is unchanged.
        if _read_document(source, legacy=True)[1] != payload:
            raise BackgroundConflictError("Background changed during migration; original files are preserved")
        _atomic(backup, encoded)
        if not recovered:
            _atomic(path, encoded)
        journal.unlink(missing_ok=True)


def _locate(background_id):
    _id(background_id)
    _migrate_layout()
    for directory in _directories():
        document, payload = _read_document(directory)
        if document["background_id"] == background_id:
            return directory, document, payload
    raise FileNotFoundError("Background does not exist")


def _editable(background_id, expected_revision):
    directory, document, payload = _locate(background_id)
    if "_recovery" in document:
        raise BackgroundStorageError("Background metadata is damaged; the recovered backup is read-only")
    if type(expected_revision) is not int or expected_revision != document["revision"]:
        raise BackgroundConflictError("Background changed in another editor; reload before saving")
    if document["archived"]:
        raise ValueError("Background is archived")
    return directory, document, payload


def _commit(directory, document, previous):
    document["revision"] += 1
    _validate(document, directory.name)
    encoded = _json_bytes(document)
    _atomic(_contained(directory, f"{directory.name}.json.backup"), previous)
    _atomic(_contained(directory, f"{directory.name}.json"), encoded)
    return document


def list_backgrounds():
    with _LOCK():
        _migrate_layout()
        documents = [_read_document(directory)[0] for directory in _directories()]
        return sorted((item for item in documents if not item["archived"]), key=lambda item: item["name"].casefold())


def load_background(background_id):
    with _LOCK():
        return _locate(background_id)[1]


def save_settings(background_id, model_settings, cg_settings, expected_revision):
    model_settings = _object(model_settings, "model settings")
    cg_settings = _object(cg_settings, "CG settings")
    with _LOCK():
        directory, document, previous = _editable(background_id, expected_revision)
        document["model_settings"] = model_settings
        document["cg_settings"] = cg_settings
        return _commit(directory, document, previous)


def _image_bytes(image):
    if not isinstance(image, Image.Image):
        raise ValueError("CG Creator requires a PIL image")
    _dimensions(*image.size)
    encoded = io.BytesIO()
    image.convert("RGB").save(encoded, format="PNG")
    payload = encoded.getvalue()
    if len(payload) > MAX_IMAGE_BYTES:
        raise ValueError("CG Creator image is too large")
    return payload


def image_path(background_id, image_id):
    _id(image_id)
    with _LOCK():
        directory, document, _previous = _locate(background_id)
        if not any(image["image_id"] == image_id for image in document["images"]):
            raise FileNotFoundError("Background image does not exist")
        path = _contained(directory, "background", f"{image_id}.png")
        if not path.is_file():
            raise FileNotFoundError("Background image file is missing")
        return path


def _model_directory(document, model_id):
    return _path(document["name"], "model", _id(model_id))


def _copy_model(source, scene, target):
    objects = scene.get("objects")
    if not isinstance(objects, list) or not 1 <= len(objects) <= 32:
        raise ValueError("Background model must contain Gaussian objects")
    copies, total, object_ids = [], 0, set()
    for item in objects:
        if not isinstance(item, dict) or _id(item.get("object_id")) in object_ids:
            raise ValueError("Background model object is invalid or duplicated")
        object_id = item["object_id"]
        object_ids.add(object_id)
        files = item.get("files")
        if not isinstance(files, dict) or not files.get("ply"):
            raise ValueError("Background model PLY is missing")
        retained = {}
        for kind in _ASSET_KINDS:
            relative = files.get(kind)
            if not relative:
                continue
            if not isinstance(relative, str) or Path(relative).is_absolute() or ":" in relative or relative.startswith("\\"):
                raise ValueError("Invalid background model asset path")
            source_file = _contained(source, relative.replace("\\", "/"))
            if not source_file.is_file():
                raise FileNotFoundError("Background model asset is missing")
            total += source_file.stat().st_size
            if total > MAX_MODEL_BYTES:
                raise ValueError("Background model assets are too large")
            suffix = {"ply": ".ply", "splat": ".splat", "reference": ".png", "prepared": ".png"}[kind]
            target_relative = f"objects/{object_id}/{kind}{suffix}"
            retained[kind] = target_relative
            copies.append((source_file, target_relative))
        item["files"] = retained
        item.pop("urls", None)
    encoded = _json_bytes(scene)
    copied_bytes = 0
    for source_file, relative in copies:
        copied_bytes += source_file.stat().st_size
        if copied_bytes > MAX_MODEL_BYTES:
            raise ValueError("Background model assets are too large")
        _copy_asset(source_file, _contained(target, relative), MAX_MODEL_BYTES)
    _atomic(_contained(target, "scene.json"), encoded)


def commit_model(background_id, image_id, scene_directory, scene, settings, expected_revision):
    _id(image_id)
    scene = _object(scene, "model scene")
    settings = _object(settings, "model settings")
    with _LOCK():
        directory, document, previous = _editable(background_id, expected_revision)
        if not any(image["image_id"] == image_id for image in document["images"]):
            raise ValueError("Model source image does not exist")
        if len(document["models"]) >= MAX_MODELS:
            raise ValueError("Background model limit reached")
        model_id = uuid.uuid4().hex
        target = _model_directory(document, model_id)
        if target.exists():
            raise FileExistsError("Background model variant already exists")
        scene.update(background_id=background_id, model_id=model_id, source_image_id=image_id,
                     background_settings=settings)
        for key in ("exports", "preview", "capture_set", "reference", "skydome", "textures"):
            scene.pop(key, None)
        _copy_model(Path(scene_directory), scene, target)
        document["models"].append({"model_id": model_id, "source_image_id": image_id,
                                   "scene_id": scene.get("scene_id", ""), "settings": settings})
        return _commit(directory, document, previous)


def model_scene(background_id, model_id):
    with _LOCK():
        _directory, document, _previous = _locate(background_id)
        model = next((model for model in document["models"] if model["model_id"] == model_id), None)
        if model is None:
            raise FileNotFoundError("Background model variant does not exist")
        path = _contained(_model_directory(document, model_id), "scene.json")
        scene, _payload = _read_json(path)
        if (not isinstance(scene, dict) or scene.get("background_id") != background_id or scene.get("model_id") != model_id
                or scene.get("source_image_id") != model["source_image_id"]):
            raise BackgroundStorageError("Background model manifest does not match its owner")
        return scene


def model_asset_path(background_id, model_id, object_id, kind):
    _id(object_id)
    if kind not in _ASSET_KINDS:
        raise ValueError("Unsupported background model asset kind")
    with _LOCK():
        scene = model_scene(background_id, model_id)
        item = next((item for item in scene.get("objects", []) if item.get("object_id") == object_id), None)
        if item is None:
            raise FileNotFoundError("Background model object does not exist")
        _directory, document, _previous = _locate(background_id)
        directory = _model_directory(document, model_id)
        relative = item.get("files", {}).get(kind)
        if kind == "splat" and not relative:
            from .factory3d.storage import _ensure_cached_splat

            ply = model_asset_path(background_id, model_id, object_id, "ply")
            return _ensure_cached_splat(ply, ply_sha256=str(item.get("checksums", {}).get("ply_sha256") or ""))
        if not isinstance(relative, str):
            raise FileNotFoundError("Background model asset does not exist")
        path = _contained(directory, relative)
        if not path.is_file():
            raise FileNotFoundError("Background model asset file is missing")
        return path


def commit_cg(background_id, name, raw, finished, camera, settings, model_id, expected_revision):
    name, model_id = _name(name), _id(model_id)
    camera, settings = _camera(camera), _object(settings, "CG settings")
    raw_bytes, finished_bytes = _image_bytes(raw), _image_bytes(finished)
    with _LOCK():
        directory, document, previous = _editable(background_id, expected_revision)
        model = model_scene(background_id, model_id)
        if len(document["cgs"]) >= MAX_CGS:
            raise ValueError("Background CG limit reached")
        cg_id = uuid.uuid4().hex
        target = _path(document["name"], "CG", name, cg_id)
        metadata = {"cg_id": cg_id, "name": name, "background_id": background_id,
                    "model_id": model_id, "source_image_id": model["source_image_id"], "camera": camera, "settings": settings,
                    "width": finished.width, "height": finished.height}
        _json_bytes(metadata)
        target.mkdir(parents=True, exist_ok=False)
        _atomic(_contained(target, "raw.png"), raw_bytes)
        _atomic(_contained(target, "image.png"), finished_bytes)
        document["cgs"].append(metadata)
        return _commit(directory, document, previous)


def cg_image_path(background_id, cg_id, kind="image"):
    _id(cg_id)
    if kind not in {"image", "raw"}:
        raise ValueError("Unsupported background CG image kind")
    with _LOCK():
        _directory, document, _previous = _locate(background_id)
        cg = next((item for item in document["cgs"] if item["cg_id"] == cg_id), None)
        if cg is None:
            raise FileNotFoundError("Background CG does not exist")
        path = _path(document["name"], "CG", cg["name"], cg_id, f"{kind}.png")
        if not path.is_file():
            raise FileNotFoundError("Background CG image file is missing")
        return path
