"""Local reconstruction and CG jobs; background authoring belongs to VNCCS."""

import copy
import io
import threading
import uuid
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

from . import cg_creator_generation as generation
from . import cg_creator_storage as library
from .factory3d import runtime, storage as factory

API_BASE = "/vnccs/cg-creator"
MAX_REQUEST_BYTES = 34 * 1024 * 1024
_WORKER = ThreadPoolExecutor(max_workers=1, thread_name_prefix="vnccs-cg")
_JOBS = {}
_LOCK = threading.RLock()


def public_document(document):
    value = copy.deepcopy(document)
    base = f"{API_BASE}/backgrounds/{value['background_id']}"
    latest = value.get("models", [])[-1] if value.get("models") else {}
    value["model_settings"] = model_settings(value.get("model_settings", latest.get("settings", {})))
    legacy_prompt = value.get("editor", {}).get("cg_prompt")
    fallback = {"prompt": legacy_prompt} if isinstance(legacy_prompt, str) and legacy_prompt.strip() else {}
    value["cg_settings"] = generation.normalize_settings(value.get("cg_settings", fallback))
    for image in value["images"]:
        image["url"] = f"{base}/images/{image['image_id']}"
        if "preview_revision" in image:
            image["url"] += f"?v={image['preview_revision']}"
    for cg in value["cgs"]:
        cg["url"] = f"{base}/cg/{cg['cg_id']}/image"
    return value


def public_model(background_id, model_id):
    scene = library.model_scene(background_id, model_id)
    for item in scene.get("objects", []):
        item["urls"] = {"splat": f"{API_BASE}/backgrounds/{background_id}/models/{model_id}/objects/{item['object_id']}/splat"}
        item["locked"] = True
        item.pop("files", None)
    return scene


def model_settings(value):
    if not isinstance(value, dict):
        raise ValueError("TripoSplat settings must be an object")
    return factory._generation_settings({**value, "remove_background": "0", "provider": "triposplat"})


def ensure_idle(background_id):
    with _LOCK:
        if any(job["background_id"] == background_id and job["status"] in {"queued", "running"} for job in _JOBS.values()):
            raise RuntimeError("This CG workspace is busy. Wait for the job or stop it first.")
    owner = library.background_owner()
    if owner is not None and callable(getattr(owner, "ensure_idle", None)):
        owner.ensure_idle(background_id)


@contextmanager
def _inference_slot(job):
    owner = library.background_owner()
    lock = getattr(owner, "inference_lock", None)
    acquired = False
    try:
        if lock is not None:
            while not lock.acquire(timeout=0.25):
                runtime._check_cancel(job)
            acquired = True
        runtime._check_cancel(job)
        yield
    finally:
        if acquired:
            lock.release()


def save_settings(background_id, payload):
    if not isinstance(payload, dict):
        raise ValueError("CG settings must be an object")
    ensure_idle(background_id)
    return public_document(library.save_settings(background_id, model_settings(payload.get("model_settings", {})),
        generation.normalize_settings(payload.get("cg_settings", {})), payload.get("revision")))


def start_job(background_id, payload, raw_image=None):
    if not isinstance(payload, dict):
        raise ValueError("CG job must be an object")
    action = payload.get("action")
    if action not in {"model", "cg"}:
        raise ValueError("CG Creator supports only model reconstruction and CG refinement")
    document = library.load_background(background_id)
    if document.get("_recovery") or document.get("archived"):
        raise ValueError("This saved background is read-only")
    revision = payload.get("revision")
    if type(revision) is not int or revision != document["revision"]:
        raise library.BackgroundConflictError("The scene changed. Reload it before starting this job.")
    image_id = payload.get("image_id", "")
    library.image_path(background_id, image_id)
    values = {"revision": revision, "image_id": image_id, "model_settings": model_settings(payload.get("model_settings", {})),
              "settings": generation.normalize_settings(payload.get("settings", {}))}
    if action == "cg":
        values.update(name=library._name(payload.get("name", "View")), camera=library._camera(payload.get("camera")), model_id=payload.get("model_id", ""))
        scene = library.model_scene(background_id, values["model_id"])
        if scene["source_image_id"] != image_id:
            raise ValueError("The model belongs to another background variant")
        raw = factory._decode_image(raw_image or b"").convert("RGB")
        if min(raw.size) < 64 or max(raw.size) > 4096 or raw.width % 16 or raw.height % 16 or raw.width * raw.height > 16_000_000:
            raise ValueError("CG frame must be 64–4096 pixels, aligned to 16 pixels, at most 16 MP")
        values["raw"] = raw
    with _LOCK:
        ensure_idle(background_id)
        for old_id in list(_JOBS):
            if len(_JOBS) < 64:
                break
            if _JOBS[old_id]["status"] not in {"queued", "running"}:
                del _JOBS[old_id]
        if len(_JOBS) >= 64:
            raise RuntimeError("CG job queue is full. Wait for a job to finish before trying again.")
        job = runtime._new_job(f"cg_creator_{action}")
        job.update(background_id=background_id, action=action)
        _JOBS[job["job_id"]] = job
        _WORKER.submit(runtime._run_job, job, lambda current: _execute(current, values))
    return job_status(job["job_id"])


def _execute(job, values):
    try:
        with _inference_slot(job):
            if job["action"] == "cg":
                image, settings = generation.generate_image(values["settings"], job["job_id"], job["cancel_event"], values["raw"])
                runtime._check_cancel(job)
                document = library.commit_cg(job["background_id"], values["name"], values["raw"], image, values["camera"],
                    settings, values["model_id"], values["revision"])
            else:
                scene = factory.create_scene("CG Creator")
                job["scene_id"] = scene["scene_id"]
                with Image.open(library.image_path(job["background_id"], values["image_id"])) as source:
                    encoded = io.BytesIO()
                    source.convert("RGB").save(encoded, format="PNG")
                runtime._generate_object(job, encoded.getvalue(), uuid.uuid4().hex, "Background", {**values["model_settings"], "capture_source_camera": True})
                runtime._check_cancel(job)
                scene = factory.load_scene(scene["scene_id"])
                scene = factory.update_scene(scene["scene_id"], {"camera": scene["objects"][0]["source_camera"], "lighting": {"preset": "off", "background": "#000000"}})
                document = library.commit_model(job["background_id"], values["image_id"], factory.resolve_scene_dir(scene["scene_id"]),
                    scene, values["model_settings"], values["revision"])
                job["scene_id"] = ""
                factory.delete_scene(scene["scene_id"])
        return {"document": public_document(document)}
    except generation.GenerationCancelled as exc:
        raise runtime.JobCancelled(str(exc)) from exc


def job_status(job_id):
    with _LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            raise FileNotFoundError("CG job was not found")
        value = runtime._job_public(job)
    if job["status"] == "running" and job["action"] == "cg":
        progress = generation.progress(job_id)
        if progress.get("stage") != "unknown":
            value.update(message=progress.get("message", value["message"]), progress=100 * progress.get("progress", 0))
    return value


def cancel_job(job_id):
    with _LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            raise FileNotFoundError("CG job was not found")
        job["cancel_event"].set()
        if job["action"] == "cg":
            generation.interrupt(job_id)
    return job_status(job_id)
