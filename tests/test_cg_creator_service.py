"""CG jobs and HTTP routes preserve the main extension's scene ownership."""

import asyncio
import copy
import io
import json
import sys
import types
from unittest import mock

import pytest
from aiohttp import web
from PIL import Image

from helpers.backend_package import service_package


load = service_package("vnccs_cg_service_test")
service = load("nodes.cg_creator_service")
library = load("nodes.cg_creator_storage")
generation = load("nodes.cg_creator_generation")
routes_module = load("api.cg_creator_workspace")
CAMERA = {"position": [0, 0, 3], "target": [0, 0, 0], "up": [0, 1, 0], "fov": 42}
MAIN_FIELDS = ("editor", "images", "selected_image_id", "generator_settings", "generated_sets", "future_owner_data")


def png(size=(128, 64), color="red"):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format="PNG")
    return output.getvalue()


def write_document(document):
    path = library.root() / document["name"] / f"{document['name']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(document, ensure_ascii=False, indent=2).encode() + b"\n"
    path.write_bytes(encoded)
    path.with_suffix(".json.backup").write_bytes(encoded)
    return path


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    monkeypatch.setattr(library, "root", lambda: tmp_path / "VNCCS" / "scenes")
    monkeypatch.setattr(sys.modules["nodes"], "NODE_CLASS_MAPPINGS", {}, raising=False)
    monkeypatch.setattr(service.factory, "_factory_root", lambda: tmp_path / "factory")
    monkeypatch.setattr(service, "_JOBS", {})
    factory_jobs = {}
    monkeypatch.setattr(service.runtime, "_JOBS", factory_jobs)
    monkeypatch.setattr(service.factory, "_JOBS", factory_jobs)
    worker = mock.Mock()
    monkeypatch.setattr(service, "_WORKER", worker)
    monkeypatch.setattr(service.runtime, "_emit", mock.Mock())
    monkeypatch.setattr(generation, "progress", lambda _job_id: {"stage": "unknown"})
    monkeypatch.setattr(generation, "interrupt", mock.Mock(return_value=False))
    generated = mock.Mock(return_value=(Image.new("RGB", (128, 64), "blue"),
        {"settings": generation.normalize_settings({}), "prompt": "Finished camera frame", "model": "qi2"}))
    monkeypatch.setattr(generation, "generate_image", generated)
    document = {"schema_version": 2, "background_id": "a" * 32, "name": "Quiet room", "revision": 7,
        "archived": False, "editor": {"description": "Keep the main generator scene", "future": {"x": 3}},
        "images": [{"image_id": "b" * 32, "width": 128, "height": 64,
            "settings": {"generator": "main", "seed": 3}, "preview_revision": 4},
            {"image_id": "c" * 32, "width": 128, "height": 64,
            "settings": {"generator": "main", "seed": 4}, "preview_revision": 1}],
        "selected_image_id": "c" * 32, "models": [], "cgs": [],
        "generator_settings": {"model": "qi2", "sampling": {"steps": 25}, "future": [1, 2]},
        "generated_sets": [{"name": "Original set", "unknown_field": {"keep": True}}],
        "future_owner_data": {"revision": "unrelated", "values": ["keep", "all"]}}
    write_document(document)
    for index, image in enumerate(document["images"]):
        target = library.root() / document["name"] / "background" / f"{image['image_id']}.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(png(color="red" if index == 0 else "green"))

    def run_pending():
        function, job, callback = worker.submit.call_args.args
        assert function is service.runtime._run_job
        function(job, callback)
        return job

    return types.SimpleNamespace(document=document, worker=worker, generated=generated,
                                 run_pending=run_pending, tmp_path=tmp_path)


def with_model(workspace, document=None, image_id=None):
    document = document or workspace.document
    source = workspace.tmp_path / "source-scene"
    object_id = "d" * 32
    assets = source / "objects" / object_id
    assets.mkdir(parents=True, exist_ok=True)
    (assets / "model.ply").write_bytes(b"immutable Gaussian fixture")
    scene = {"schema_version": 11, "scene_id": "e" * 32, "camera": CAMERA,
        "objects": [{"object_id": object_id, "source_camera": CAMERA,
                     "files": {"ply": f"objects/{object_id}/model.ply"}}]}
    return library.commit_model(document["background_id"], image_id or document["images"][0]["image_id"],
                                source, scene, {"seed": 1}, document["revision"])


def job_payload(document, action="cg", **changes):
    model = document["models"][-1] if document["models"] else {}
    return {"action": action, "revision": document["revision"],
        "image_id": model.get("source_image_id", document["images"][0]["image_id"]),
        "model_id": model.get("model_id", ""), "name": "Window", "camera": copy.deepcopy(CAMERA),
        "settings": copy.deepcopy(generation.DEFAULT_SETTINGS), **changes}


def assert_main_fields_preserved(before, after):
    assert {key: after[key] for key in MAIN_FIELDS} == {key: before[key] for key in MAIN_FIELDS}


@pytest.mark.parametrize("payload", [None, [], {"action": "background"}, {"action": "wizard"},
    {"action": "upload"}, {"action": "create"}, {"action": "export"}, {"action": "unknown"}])
def test_only_model_and_cg_actions_are_accepted(workspace, payload):
    with pytest.raises(ValueError):
        service.start_job(workspace.document["background_id"], payload)
    workspace.worker.submit.assert_not_called()
    workspace.generated.assert_not_called()
    assert library.load_background(workspace.document["background_id"]) == workspace.document


@pytest.mark.parametrize("revision", [None, True, 0, 999])
def test_job_requires_current_integer_revision(workspace, revision):
    with pytest.raises(library.BackgroundConflictError):
        service.start_job(workspace.document["background_id"], job_payload(workspace.document, "model", revision=revision))
    workspace.worker.submit.assert_not_called()


@pytest.mark.parametrize("condition", ["archived", "recovered"])
def test_read_only_scene_fails_before_inference(workspace, condition):
    document = workspace.document
    if condition == "archived":
        write_document({**document, "archived": True})
    else:
        (library.root() / document["name"] / f"{document['name']}.json").write_bytes(b"{damaged")
    with pytest.raises(ValueError, match="read-only"):
        service.start_job(document["background_id"], job_payload(document, "model"))
    workspace.worker.submit.assert_not_called()


def test_settings_save_changes_only_cg_owned_settings(workspace):
    document = workspace.document
    updated = service.save_settings(document["background_id"], {"revision": document["revision"],
        "model_settings": {"seed": 12, "provider": "trellis2", "remove_background": "1"},
        "cg_settings": {"prompt": "Repair the captured room", "generation": {"steps": 12}},
        "editor": {"description": "must not overwrite"}, "images": [], "generated_sets": []})
    saved = library.load_background(document["background_id"])
    assert_main_fields_preserved(document, saved)
    assert saved["revision"] == document["revision"] + 1
    assert saved["model_settings"]["seed"] == 12
    assert saved["model_settings"]["provider"] == "triposplat"
    assert saved["model_settings"]["remove_background"] is False
    assert saved["cg_settings"]["prompt"] == "Repair the captured room"
    assert updated["cg_settings"]["generation"]["steps"] == 12


def test_cg_job_captures_settings_camera_and_frame_without_changing_main_variants(workspace):
    document = with_model(workspace)
    payload = job_payload(document)
    payload["settings"]["generation"]["steps"] = 12
    service.start_job(document["background_id"], payload, png())
    payload["camera"]["position"][0] = 99
    payload["settings"]["generation"]["steps"] = 99
    job = workspace.run_pending()
    assert job["status"] == "completed", job["error"]
    settings, _job_id, _event, reference = workspace.generated.call_args.args
    assert settings["generation"]["steps"] == 12
    assert reference.size == (128, 64) and reference.getpixel((0, 0)) == (255, 0, 0)
    saved = library.load_background(document["background_id"])
    assert_main_fields_preserved(document, saved)
    assert saved["models"] == document["models"]
    cg = saved["cgs"][-1]
    assert cg["camera"] == CAMERA and cg["model_id"] == document["models"][-1]["model_id"]
    assert cg["source_image_id"] == document["models"][-1]["source_image_id"]
    assert cg["source_image_id"] != document["selected_image_id"]
    with Image.open(library.cg_image_path(document["background_id"], cg["cg_id"])) as image:
        assert image.getpixel((0, 0)) == (0, 0, 255)
    assert job["result"]["document"]["cgs"][-1]["url"].endswith(f"/{cg['cg_id']}/image")


def test_cg_rejects_model_from_another_source_variant(workspace):
    document = with_model(workspace)
    with pytest.raises(ValueError, match="another background variant"):
        service.start_job(document["background_id"], job_payload(document, image_id=document["images"][1]["image_id"]), png())
    workspace.worker.submit.assert_not_called()
    assert library.load_background(document["background_id"]) == document


def test_cg_rejects_model_owned_by_another_background(workspace):
    document = with_model(workspace)
    other = {**copy.deepcopy(workspace.document), "background_id": "9" * 32, "name": "Other room"}
    write_document(other)
    other = with_model(workspace, other)
    with pytest.raises(FileNotFoundError):
        service.start_job(document["background_id"], job_payload(document, model_id=other["models"][-1]["model_id"]), png())
    workspace.worker.submit.assert_not_called()
    workspace.generated.assert_not_called()


@pytest.mark.parametrize("camera,frame,name", [(None, png(), "View"), ({}, png(), "View"),
    (CAMERA, None, "View"), (CAMERA, png((127, 64)), "View"), (CAMERA, png((32, 16)), "View"),
    (CAMERA, png(), "../bad")])
def test_invalid_cg_inputs_never_queue_inference(workspace, camera, frame, name):
    document = with_model(workspace)
    with pytest.raises((ValueError, TypeError)):
        service.start_job(document["background_id"], job_payload(document, camera=camera, name=name), frame)
    workspace.worker.submit.assert_not_called()
    workspace.generated.assert_not_called()


def test_busy_workspace_rejects_another_job_and_settings_save(workspace):
    document = with_model(workspace)
    service.start_job(document["background_id"], job_payload(document), png())
    with pytest.raises(RuntimeError, match="busy"):
        service.start_job(document["background_id"], job_payload(document), png())
    with pytest.raises(RuntimeError, match="busy"):
        service.save_settings(document["background_id"], {"revision": document["revision"]})
    assert workspace.worker.submit.call_count == 1


def test_full_active_queue_rejects_work_without_dropping_jobs(workspace):
    service._JOBS.update({str(index): {"background_id": "other", "status": "queued"} for index in range(64)})
    with pytest.raises(RuntimeError, match="queue is full"):
        service.start_job(workspace.document["background_id"], job_payload(workspace.document, "model"))
    assert len(service._JOBS) == 64
    workspace.worker.submit.assert_not_called()


def test_cancelled_queued_cg_job_never_calls_models_or_writes(workspace):
    document = with_model(workspace)
    status = service.start_job(document["background_id"], job_payload(document), png())
    service.cancel_job(status["job_id"])
    job = workspace.run_pending()
    assert job["status"] == "cancelled"
    generation.interrupt.assert_called_once_with(status["job_id"])
    workspace.generated.assert_not_called()
    assert library.load_background(document["background_id"]) == document


def test_sampling_cancellation_is_translated_to_factory_job_cancellation(workspace):
    document = with_model(workspace)
    workspace.generated.side_effect = generation.GenerationCancelled("CG generation cancelled")
    service.start_job(document["background_id"], job_payload(document), png())
    job = workspace.run_pending()
    assert job["status"] == "cancelled" and job["error"] == "CG generation cancelled"
    assert library.load_background(document["background_id"]) == document


def test_stop_after_sampling_prevents_committing_a_finished_frame(workspace):
    document = with_model(workspace)
    def generate(_settings, _job_id, event, _reference):
        event.set()
        return Image.new("RGB", (128, 64)), {}
    workspace.generated.side_effect = generate
    service.start_job(document["background_id"], job_payload(document), png())
    assert workspace.run_pending()["status"] == "cancelled"
    assert library.load_background(document["background_id"]) == document


def test_late_cg_cannot_replace_a_new_main_scene_revision(workspace):
    document = with_model(workspace)
    service.start_job(document["background_id"], job_payload(document), png())
    newer = copy.deepcopy(document)
    newer["revision"] += 1
    newer["editor"]["new_main_edit"] = "Keep the newest main scene"
    write_document(newer)
    job = workspace.run_pending()
    assert job["status"] == "failed" and "changed" in job["error"]
    assert library.load_background(document["background_id"]) == newer


def test_model_job_copies_snapshot_and_releases_active_factory_scene_before_cleanup(workspace, monkeypatch):
    document = workspace.document
    created = service.factory.create_scene("Temporary CG reconstruction")
    monkeypatch.setattr(service.factory, "create_scene", lambda _name: created)
    source = service.factory.resolve_scene_dir(created["scene_id"])
    def reconstruct(job, encoded, object_id, name, settings):
        assert name == "Background" and settings["provider"] == "triposplat"
        assert settings["remove_background"] is False and settings["capture_source_camera"] is True
        with Image.open(io.BytesIO(encoded)) as image:
            assert image.getpixel((0, 0)) == (255, 0, 0)
        manifest = service.factory.load_scene(job["scene_id"])
        path = source / "objects" / object_id / "model.ply"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"committed Gaussian fixture")
        manifest["objects"] = [{"object_id": object_id, "source_camera": CAMERA,
            "files": {"ply": f"objects/{object_id}/model.ply"}}]
        service.factory._save_scene(manifest)
    monkeypatch.setattr(service.runtime, "_generate_object", mock.Mock(side_effect=reconstruct))
    service.start_job(document["background_id"], job_payload(document, "model", model_settings={"seed": 3}))
    job = workspace.run_pending()
    assert job["status"] == "completed", job["error"]
    assert job["scene_id"] == "" and not source.exists()
    saved = library.load_background(document["background_id"])
    assert len(saved["models"]) == 1
    model = library.model_scene(document["background_id"], saved["models"][-1]["model_id"])
    assert model["camera"] == CAMERA and model["lighting"]["preset"] == "off"
    assert model["source_image_id"] == document["images"][0]["image_id"]
    object_id = model["objects"][0]["object_id"]
    assert library.model_asset_path(document["background_id"], model["model_id"], object_id, "ply").read_bytes() == b"committed Gaussian fixture"
    assert_main_fields_preserved(document, saved)
    workspace.generated.assert_not_called()


def test_optional_main_owner_busy_guard_is_respected(workspace, monkeypatch):
    owner = types.SimpleNamespace(ensure_idle=mock.Mock(side_effect=RuntimeError("Main background generator is busy")))
    monkeypatch.setattr(library, "background_owner", lambda: owner)
    with pytest.raises(RuntimeError, match="Main background generator"):
        service.start_job(workspace.document["background_id"], job_payload(workspace.document, "model"))
    workspace.worker.submit.assert_not_called()


def test_main_inference_slot_is_held_during_refinement_and_released(workspace, monkeypatch):
    document = with_model(workspace)
    slot = mock.Mock()
    slot.acquire.return_value = True
    monkeypatch.setattr(library, "background_owner", lambda: types.SimpleNamespace(inference_lock=slot))
    generated = workspace.generated.return_value
    def infer(*_args):
        slot.acquire.assert_called_once_with(timeout=0.25)
        slot.release.assert_not_called()
        return generated
    workspace.generated.side_effect = infer
    service.start_job(document["background_id"], job_payload(document), png())
    assert workspace.run_pending()["status"] == "completed"
    slot.release.assert_called_once_with()


def test_waiting_for_main_inference_slot_can_be_cancelled_without_releasing_its_lock(workspace, monkeypatch):
    document = with_model(workspace)
    status = service.start_job(document["background_id"], job_payload(document), png())
    job = service._JOBS[status["job_id"]]
    slot = mock.Mock()
    def acquire(*, timeout):
        job["cancel_event"].set()
        return False
    slot.acquire.side_effect = acquire
    monkeypatch.setattr(library, "background_owner", lambda: types.SimpleNamespace(inference_lock=slot))
    assert workspace.run_pending()["status"] == "cancelled"
    slot.release.assert_not_called()
    workspace.generated.assert_not_called()
    generation.interrupt.assert_not_called()


class Request:
    def __init__(self, payload=None, *, info=None, raw=None, multipart=None, headers=None):
        self.raw = json.dumps({} if payload is None else payload).encode() if raw is None else raw
        self.match_info = info or {}
        self.headers = {"Content-Length": str(len(self.raw)), **(headers or {})}
        self.content_length = len(self.raw)
        self.content_type = "multipart/form-data" if multipart is not None else "application/json"
        self.multipart = multipart

    async def read(self):
        return self.raw

    async def post(self):
        return self.multipart


@pytest.fixture
def routes(workspace, monkeypatch):
    monkeypatch.setattr(routes_module, "_REGISTERED", False)
    table = web.RouteTableDef()
    routes_module.register_routes(table)
    return {(route.method, route.path): route.handler for route in table}


def call(routes, method, suffix, request):
    return asyncio.run(routes[(method, service.API_BASE + suffix)](request))


def test_http_inventory_has_no_background_authoring_actions(routes):
    expected = {("GET", "/config"), ("GET", "/backgrounds"), ("GET", "/backgrounds/{background_id}"),
        ("PATCH", "/backgrounds/{background_id}"), ("POST", "/backgrounds/{background_id}/jobs"),
        ("GET", "/jobs/{job_id}"), ("POST", "/jobs/{job_id}/cancel"),
        ("GET", "/backgrounds/{background_id}/images/{image_id}"),
        ("GET", "/backgrounds/{background_id}/models/{model_id}"),
        ("GET", "/backgrounds/{background_id}/models/{model_id}/objects/{object_id}/{kind}"),
        ("GET", "/backgrounds/{background_id}/cg/{cg_id}/{kind}")}
    assert set(routes) == {(method, service.API_BASE + path) for method, path in expected}


def test_http_config_library_read_and_cg_settings_save(routes, workspace, monkeypatch):
    monkeypatch.setattr(generation, "configuration", lambda: {"settings": generation.DEFAULT_SETTINGS, "model": "QI2"})
    response = call(routes, "GET", "/config", Request())
    assert response.status == 200 and json.loads(response.text)["model"] == "QI2"
    response = call(routes, "GET", "/backgrounds", Request())
    public = json.loads(response.text)["backgrounds"][0]
    assert public["images"][0]["url"].endswith(f"/{workspace.document['images'][0]['image_id']}?v=4")
    info = {"background_id": workspace.document["background_id"]}
    response = call(routes, "PATCH", "/backgrounds/{background_id}", Request({
        "revision": workspace.document["revision"], "cg_settings": {"prompt": "Keep the camera"},
        "editor": {"description": "Do not overwrite"}}, info=info))
    assert response.status == 200
    saved = library.load_background(info["background_id"])
    assert_main_fields_preserved(workspace.document, saved)
    response = call(routes, "PATCH", "/backgrounds/{background_id}",
        Request({"revision": workspace.document["revision"]}, info=info))
    assert response.status == 409
    response = call(routes, "GET", "/backgrounds/{background_id}", Request(info=info))
    assert json.loads(response.text)["revision"] == saved["revision"]


@pytest.mark.parametrize("action", ["background", "wizard", "upload", "create", "delete"])
def test_http_jobs_cannot_author_backgrounds(routes, workspace, action):
    response = call(routes, "POST", "/backgrounds/{background_id}/jobs",
        Request(job_payload(workspace.document, action), info={"background_id": workspace.document["background_id"]}))
    assert response.status == 400
    workspace.worker.submit.assert_not_called()


@pytest.mark.parametrize("raw", [b"[]", b"null", b"false", b"{invalid"])
def test_http_invalid_json_is_rejected_before_work(routes, workspace, raw):
    response = call(routes, "PATCH", "/backgrounds/{background_id}",
        Request(raw=raw, info={"background_id": workspace.document["background_id"]}))
    assert response.status == 400 and json.loads(response.text)["error"]
    workspace.worker.submit.assert_not_called()
    assert library.load_background(workspace.document["background_id"]) == workspace.document


def test_http_request_size_limits_apply_before_work(routes, workspace):
    info = {"background_id": workspace.document["background_id"]}
    with pytest.raises(web.HTTPRequestEntityTooLarge):
        call(routes, "PATCH", "/backgrounds/{background_id}",
            Request(info=info, headers={"Content-Length": str(service.MAX_REQUEST_BYTES + 1)}))
    response = call(routes, "PATCH", "/backgrounds/{background_id}", Request(info=info, raw=b" " * (256 * 1024 + 1)))
    assert response.status == 400
    workspace.worker.submit.assert_not_called()


def test_http_capture_job_status_and_cancel_use_cg_only_actions(routes, workspace):
    document = with_model(workspace)
    form = {"data": json.dumps(job_payload(document)), "image": types.SimpleNamespace(file=io.BytesIO(png()))}
    response = call(routes, "POST", "/backgrounds/{background_id}/jobs",
        Request(info={"background_id": document["background_id"]}, multipart=form))
    assert response.status == 200
    status = json.loads(response.text)
    job_info = {"job_id": status["job_id"]}
    response = call(routes, "GET", "/jobs/{job_id}", Request(info=job_info))
    assert json.loads(response.text)["status"] == "queued"
    response = call(routes, "POST", "/jobs/{job_id}/cancel", Request(info=job_info))
    assert response.status == 200 and service._JOBS[status["job_id"]]["cancel_event"].is_set()
    assert workspace.run_pending()["status"] == "cancelled"
    response = call(routes, "GET", "/jobs/{job_id}", Request(info={"job_id": "missing"}))
    assert response.status == 404


def test_http_owned_assets_are_immutable_and_do_not_expose_model_paths(routes, workspace):
    document = with_model(workspace)
    model = document["models"][-1]
    raw = Image.new("RGB", (128, 64), "red")
    document = library.commit_cg(document["background_id"], "Window", raw, raw, CAMERA, {}, model["model_id"], document["revision"])
    info = {"background_id": document["background_id"], "image_id": document["images"][0]["image_id"],
            "model_id": model["model_id"], "object_id": "d" * 32, "kind": "ply", "cg_id": document["cgs"][-1]["cg_id"]}
    response = call(routes, "GET", "/backgrounds/{background_id}/images/{image_id}", Request(info=info))
    assert isinstance(response, web.FileResponse) and response.headers["Cache-Control"].endswith("immutable")
    response = call(routes, "GET", "/backgrounds/{background_id}/models/{model_id}", Request(info=info))
    item = json.loads(response.text)["objects"][0]
    assert item["locked"] is True and "files" not in item
    assert item["urls"]["splat"].startswith(service.API_BASE)
    response = call(routes, "GET", "/backgrounds/{background_id}/models/{model_id}/objects/{object_id}/{kind}", Request(info=info))
    assert isinstance(response, web.FileResponse) and response.headers["Cache-Control"].endswith("immutable")
    response = call(routes, "GET", "/backgrounds/{background_id}/cg/{cg_id}/{kind}", Request(info={**info, "kind": "image"}))
    assert isinstance(response, web.FileResponse) and response.headers["Cache-Control"].endswith("immutable")
    response = call(routes, "GET", "/backgrounds/{background_id}/images/{image_id}", Request(info={**info, "image_id": "../outside"}))
    assert response.status == 404
