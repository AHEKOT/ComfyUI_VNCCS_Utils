"""Shared scene persistence without ComfyUI, the main extension or model weights."""

import copy
import json
import sys
import threading
import types
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from PIL import Image

from helpers.backend_package import service_package


load = service_package("vnccs_cg_storage_test")
storage = load("nodes.cg_creator_storage")
CAMERA = {"position": [0, 0, 3], "target": [0, 0, 0], "up": [0, 1, 0], "fov": 42}


def path_for(document):
    return storage.root() / document["name"] / f"{document['name']}.json"


def files(directory):
    return {path.relative_to(directory).as_posix(): path.read_bytes()
            for path in directory.rglob("*") if path.is_file()}


def write_document(document):
    path = path_for(document)
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(document, ensure_ascii=False, indent=2).encode() + b"\n"
    path.write_bytes(encoded)
    path.with_suffix(".json.backup").write_bytes(encoded)
    return path


@pytest.fixture
def scene(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "root", lambda: tmp_path / "VNCCS" / "scenes")
    monkeypatch.setattr(sys.modules["nodes"], "NODE_CLASS_MAPPINGS", {}, raising=False)
    document = {"schema_version": 2, "background_id": "a" * 32, "name": "Quiet room", "revision": 7,
                "archived": False, "editor": {"description": "Keep this scene", "new_generator_option": {"x": 3}},
                "images": [{"image_id": "b" * 32, "width": 64, "height": 32,
                            "settings": {"generator": "main", "seed": 3}, "preview_revision": 4},
                           {"image_id": "c" * 32, "width": 64, "height": 32,
                            "settings": {"generator": "main", "seed": 4}, "preview_revision": 1}],
                "selected_image_id": "c" * 32, "models": [], "cgs": [],
                "generator_settings": {"model": "qi2", "sampling": {"steps": 25}, "future": [1, 2]},
                "generated_sets": [{"name": "Original set", "unknown_field": {"keep": True}}],
                "future_owner_data": {"revision": "unrelated", "values": ["keep", "all"]}}
    write_document(document)
    for index, image in enumerate(document["images"]):
        path = storage.root() / document["name"] / "background" / f"{image['image_id']}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (64, 32), "red" if index == 0 else "blue").save(path)
    return document


def factory_source(tmp_path):
    source = tmp_path / "factory-source"
    object_id = "d" * 32
    assets = source / "objects" / object_id
    assets.mkdir(parents=True, exist_ok=True)
    (assets / "model.ply").write_bytes(b"immutable Gaussian fixture")
    Image.new("RGB", (64, 32), "green").save(assets / "reference.png")
    manifest = {"schema_version": 11, "scene_id": "e" * 32, "camera": CAMERA,
                "objects": [{"object_id": object_id, "source_camera": CAMERA,
                             "files": {"ply": f"objects/{object_id}/model.ply",
                                       "reference": f"objects/{object_id}/reference.png"}}]}
    return source, manifest


def add_model(document, tmp_path, image_id=None):
    source, manifest = factory_source(tmp_path)
    return storage.commit_model(document["background_id"], image_id or document["images"][0]["image_id"],
                                source, manifest, {"seed": 4}, document["revision"])


def test_no_background_generation_or_document_authoring_api(scene):
    for name in ("create_background", "add_image", "archive_background", "save_background", "save_editor"):
        assert not hasattr(storage, name)
    assert storage.list_backgrounds() == [scene]
    assert storage.load_background(scene["background_id"]) == scene


def test_save_only_cg_owned_settings_and_preserve_all_main_fields(scene):
    previous = path_for(scene).read_bytes()
    originals = {image["image_id"]: storage.image_path(scene["background_id"], image["image_id"]).read_bytes()
                 for image in scene["images"]}
    model_settings = {"seed": 14, "gaussians": 262144}
    cg_settings = {"prompt": "Complete the frame", "camera": copy.deepcopy(CAMERA), "resolution": [128, 64]}
    updated = storage.save_settings(scene["background_id"], model_settings, cg_settings, scene["revision"])
    assert updated == {**scene, "revision": scene["revision"] + 1,
                       "model_settings": model_settings, "cg_settings": cg_settings}
    assert path_for(scene).with_suffix(".json.backup").read_bytes() == previous
    model_settings["seed"] = 999
    cg_settings["camera"]["position"][0] = 999
    assert storage.load_background(scene["background_id"])["model_settings"]["seed"] == 14
    assert storage.load_background(scene["background_id"])["cg_settings"]["camera"] == CAMERA
    for image in scene["images"]:
        assert storage.image_path(scene["background_id"], image["image_id"]).read_bytes() == originals[image["image_id"]]


@pytest.mark.parametrize("preview_revision", [False, 0, -1, 1.5, "2"])
def test_invalid_main_preview_revision_is_not_silently_rewritten(scene, preview_revision):
    scene["images"][0]["preview_revision"] = preview_revision
    write_document(scene)
    before = files(storage.root())
    with pytest.raises(storage.BackgroundStorageError):
        storage.load_background(scene["background_id"])
    assert files(storage.root()) == before


def test_preview_revision_remains_metadata_and_does_not_change_image_path(scene):
    image = scene["images"][0]
    path = storage.image_path(scene["background_id"], image["image_id"])
    assert path == storage.root() / scene["name"] / "background" / f"{image['image_id']}.png"
    assert storage.load_background(scene["background_id"])["images"][0]["preview_revision"] == 4


def test_models_and_cgs_keep_source_links_and_previous_variants(scene, tmp_path):
    original_fields = copy.deepcopy(scene)
    document = add_model(scene, tmp_path)
    first_model = document["models"][-1]
    first_model_path = storage.model_asset_path(document["background_id"], first_model["model_id"], "d" * 32, "ply")
    first_bytes = first_model_path.read_bytes()
    raw, finished = Image.new("RGB", (64, 32), "red"), Image.new("RGB", (128, 64), "blue")
    document = storage.commit_cg(document["background_id"], "Window", raw, finished, CAMERA,
                                 {"seed": 3}, first_model["model_id"], document["revision"])
    first_cg = document["cgs"][-1]
    cg_bytes = storage.cg_image_path(document["background_id"], first_cg["cg_id"]).read_bytes()
    document = add_model(document, tmp_path, scene["images"][1]["image_id"])
    second_model = document["models"][-1]
    document = add_model(document, tmp_path, scene["images"][0]["image_id"])
    rebuilt_model = document["models"][-1]
    assert len(document["models"]) == 3
    assert [(model["model_id"], model["source_image_id"]) for model in document["models"]] == [
        (first_model["model_id"], scene["images"][0]["image_id"]),
        (second_model["model_id"], scene["images"][1]["image_id"]),
        (rebuilt_model["model_id"], scene["images"][0]["image_id"])]
    assert first_cg["source_image_id"] == first_model["source_image_id"]
    assert document["cgs"][0] == first_cg
    assert first_model_path.read_bytes() == first_bytes
    assert storage.cg_image_path(document["background_id"], first_cg["cg_id"]).read_bytes() == cg_bytes
    assert storage.model_scene(document["background_id"], first_model["model_id"])["source_image_id"] == first_model["source_image_id"]
    cg_root = storage.root() / scene["name"] / "CG" / "Window" / first_cg["cg_id"]
    assert set(path.name for path in cg_root.iterdir()) == {"raw.png", "image.png"}
    assert cg_root / "image.png" == storage.cg_image_path(document["background_id"], first_cg["cg_id"])
    for key in ("editor", "images", "selected_image_id", "generated_sets", "generator_settings", "future_owner_data"):
        assert document[key] == original_fields[key]


@pytest.mark.parametrize("operation", ["settings", "model", "cg"])
def test_stale_writes_preserve_every_file_byte(scene, tmp_path, operation):
    document = add_model(scene, tmp_path)
    source, manifest = factory_source(tmp_path)
    before = files(storage.root())
    raw = Image.new("RGB", (64, 32))
    mutations = {
        "settings": lambda: storage.save_settings(document["background_id"], {}, {}, document["revision"] - 1),
        "model": lambda: storage.commit_model(document["background_id"], document["selected_image_id"],
                                               source, manifest, {}, document["revision"] - 1),
        "cg": lambda: storage.commit_cg(document["background_id"], "Stale", raw, raw, CAMERA, {},
                                         document["models"][-1]["model_id"], document["revision"] - 1),
    }
    with pytest.raises(storage.BackgroundConflictError):
        mutations[operation]()
    assert files(storage.root()) == before


def test_archived_scene_assets_still_read_but_mutations_are_blocked(scene, tmp_path):
    scene = add_model(scene, tmp_path)
    scene["archived"] = True
    write_document(scene)
    assert storage.list_backgrounds() == []
    assert storage.load_background(scene["background_id"])["archived"] is True
    assert storage.image_path(scene["background_id"], scene["images"][0]["image_id"]).is_file()
    assert storage.model_scene(scene["background_id"], scene["models"][0]["model_id"])["background_id"] == scene["background_id"]
    before = files(storage.root())
    with pytest.raises(ValueError, match="archived"):
        storage.save_settings(scene["background_id"], {}, {}, scene["revision"])
    assert files(storage.root()) == before


def test_valid_backup_is_read_only_and_damaged_primary_is_preserved(scene):
    path = path_for(scene)
    path.write_bytes(b"{damaged")
    before = files(storage.root())
    recovered = storage.load_background(scene["background_id"])
    assert recovered["editor"] == scene["editor"]
    assert recovered["_recovery"]["source"] == f"{scene['name']}.json.backup"
    with pytest.raises(storage.BackgroundStorageError, match="read-only"):
        storage.save_settings(scene["background_id"], {}, {}, scene["revision"])
    assert files(storage.root()) == before


def test_corrupt_metadata_never_becomes_an_empty_scene_library(scene):
    path = path_for(scene)
    path.write_bytes(b"{bad")
    path.with_suffix(".json.backup").write_bytes(b"[]")
    before = files(storage.root())
    with pytest.raises(storage.BackgroundStorageError):
        storage.list_backgrounds()
    assert files(storage.root()) == before


def test_failed_json_replace_keeps_original_and_cleans_temporary_file(scene, monkeypatch):
    path = path_for(scene)
    original = path.read_bytes()
    replace = storage.os.replace

    def fail_primary(source, destination):
        if Path(destination) == path:
            raise OSError("Disk unavailable")
        replace(source, destination)

    monkeypatch.setattr(storage.os, "replace", fail_primary)
    with pytest.raises(OSError, match="Disk unavailable"):
        storage.save_settings(scene["background_id"], {}, {}, scene["revision"])
    assert path.read_bytes() == original
    assert not list(path.parent.glob("*.tmp"))


def test_installed_background_owner_is_optional_and_discovered_without_imports(scene, monkeypatch):
    assert storage.background_owner() is None
    owner = types.ModuleType("cg_test_installed_background_owner")
    owner._LOCK = threading.RLock()
    node = type("BackgroundCreator", (), {"__module__": owner.__name__})
    monkeypatch.setitem(sys.modules, owner.__name__, owner)
    monkeypatch.setattr(sys.modules["nodes"], "NODE_CLASS_MAPPINGS", {"VNCCS_BackgroundCreator": node})
    assert storage.background_owner() is owner
    with storage._LOCK():
        assert storage.load_background(scene["background_id"]) == scene


def test_shared_main_lock_prevents_cg_overwriting_a_new_main_revision(scene, monkeypatch):
    attempted = threading.Event()
    lock = threading.RLock()

    class MainLock:
        def __enter__(self):
            attempted.set()
            lock.acquire()

        def __exit__(self, *_args):
            lock.release()

    owner = types.ModuleType("cg_test_concurrent_background_owner")
    owner._LOCK = MainLock()
    node = type("BackgroundCreator", (), {"__module__": owner.__name__})
    monkeypatch.setitem(sys.modules, owner.__name__, owner)
    monkeypatch.setattr(sys.modules["nodes"], "NODE_CLASS_MAPPINGS", {"VNCCS_BackgroundCreator": node})
    with ThreadPoolExecutor(max_workers=1) as pool:
        with lock:
            pending = pool.submit(storage.save_settings, scene["background_id"], {"seed": 1}, {}, scene["revision"])
            assert attempted.wait(2), "CG did not acquire the installed owner's lock"
            assert not pending.done()
            newer = copy.deepcopy(scene)
            newer["revision"] += 1
            newer["generator_settings"]["main_edit"] = "Keep the newest settings"
            write_document(newer)
        with pytest.raises(storage.BackgroundConflictError):
            pending.result(timeout=2)
    assert storage.load_background(scene["background_id"]) == newer


def test_local_lock_and_revisions_allow_only_one_concurrent_settings_writer(scene):
    def save(seed):
        try:
            return storage.save_settings(scene["background_id"], {"seed": seed}, {}, scene["revision"])
        except storage.BackgroundConflictError:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, [1, 2]))
    assert sum(result is not None for result in results) == 1
    assert storage.load_background(scene["background_id"])["revision"] == scene["revision"] + 1


def test_source_assets_and_model_paths_reject_symlinks_and_traversal(scene, tmp_path):
    image_id = scene["images"][0]["image_id"]
    image = storage.image_path(scene["background_id"], image_id)
    outside = tmp_path / "outside.png"
    outside.write_bytes(image.read_bytes())
    image.unlink()
    try:
        image.symlink_to(outside)
    except OSError:
        pytest.skip("Symbolic links are not available on this platform")
    with pytest.raises(ValueError, match="symbolic links"):
        storage.image_path(scene["background_id"], image_id)
    source, manifest = factory_source(tmp_path)
    manifest["objects"][0]["files"]["ply"] = "../outside.ply"
    before = files(storage.root())
    with pytest.raises(ValueError, match="path"):
        storage.commit_model(scene["background_id"], image_id, source, manifest, {}, scene["revision"])
    assert files(storage.root()) == before


def test_splat_uses_shared_factory_cache_without_loading_models(scene, tmp_path, monkeypatch):
    document = add_model(scene, tmp_path)
    cache = tmp_path / "cached.splat"
    cache.write_bytes(b"cached SPLAT")
    calls = []
    factory = types.ModuleType("vnccs_cg_storage_test.nodes.factory3d.storage")

    def cached(path, *, ply_sha256=""):
        calls.append((path, ply_sha256))
        return cache

    factory._ensure_cached_splat = cached
    monkeypatch.setitem(sys.modules, factory.__name__, factory)
    result = storage.model_asset_path(document["background_id"], document["models"][0]["model_id"], "d" * 32, "splat")
    assert result == cache and calls[0][0].suffix == ".ply"


@pytest.fixture
def legacy_scene(scene):
    canonical = path_for(scene)
    # Construct the old split layout independently of the new writer.
    canonical.unlink()
    canonical.with_suffix(".json.backup").unlink()
    old_root = storage.root() / "backgrounds" / scene["name"]
    old_images = old_root / "images"
    old_images.mkdir(parents=True)
    for image in scene["images"]:
        source = storage.root() / scene["name"] / "background" / f"{image['image_id']}.png"
        (old_images / source.name).write_bytes(source.read_bytes())
        source.unlink()
    (storage.root() / scene["name"] / "background").rmdir()
    canonical.parent.rmdir()
    document = copy.deepcopy(scene)
    document["schema_version"] = 1
    document.pop("models")
    model_entries = []
    for index, image in enumerate(document["images"], start=1):
        model_id = str(index + 2) * 32
        model_root = storage.root() / "models" / document["name"] / model_id
        assets = model_root / "objects" / ("d" * 32)
        assets.mkdir(parents=True)
        (assets / "ply.ply").write_bytes(f"immutable old PLY {index}".encode())
        manifest = {"schema_version": 11, "background_id": document["background_id"],
                    "model_id": model_id, "source_image_id": image["image_id"], "scene_id": "e" * 32,
                    "background_settings": {"seed": index}, "camera": CAMERA,
                    "objects": [{"object_id": "d" * 32, "source_camera": CAMERA,
                                 "files": {"ply": f"objects/{'d' * 32}/ply.ply"}}]}
        (model_root / "scene.json").write_text(json.dumps(manifest), encoding="utf-8")
        model_entries.append({"model_id": model_id, "source_image_id": image["image_id"],
                              "scene_id": manifest["scene_id"], "settings": {"seed": index}})
    document["model"] = model_entries[-1]
    cg = {"cg_id": "f" * 32, "name": "Window", "background_id": scene["background_id"],
          "model_id": model_entries[0]["model_id"], "camera": CAMERA, "settings": {"seed": 8},
          "width": 64, "height": 32}
    document["cgs"] = [cg]
    old_cg = storage.root() / "cg" / scene["name"] / cg["name"] / cg["cg_id"]
    old_cg.mkdir(parents=True)
    Image.new("RGB", (64, 32), "red").save(old_cg / "raw.png")
    Image.new("RGB", (64, 32), "blue").save(old_cg / "image.png")
    (old_cg / "camera.json").write_text(json.dumps(cg), encoding="utf-8")
    encoded = json.dumps(document, indent=2).encode() + b"\n"
    (old_root / "background.json").write_bytes(encoded)
    (old_root / "background.json.backup").write_bytes(encoded)
    return document, model_entries, files(storage.root())


def assert_migrated(legacy):
    previous, models, originals = legacy
    document = storage.load_background(previous["background_id"])
    assert document["schema_version"] == 2 and document["revision"] == previous["revision"]
    assert {item["model_id"]: item["source_image_id"] for item in document["models"]} == {
        item["model_id"]: item["source_image_id"] for item in models}
    assert document["cgs"][0]["source_image_id"] == models[0]["source_image_id"]
    for key in ("editor", "images", "generated_sets", "generator_settings", "future_owner_data"):
        assert document[key] == previous[key]
    for relative, payload in originals.items():
        assert (storage.root() / relative).read_bytes() == payload
    for model in models:
        assert storage.model_scene(previous["background_id"], model["model_id"])["source_image_id"] == model["source_image_id"]
    assert path_for(document).is_file()
    assert storage.cg_image_path(previous["background_id"], previous["cgs"][0]["cg_id"]).is_file()
    assert storage.list_backgrounds() == [document]
    assert storage.load_background(previous["background_id"]) == document


def test_legacy_split_library_migrates_without_resetting_main_metadata(legacy_scene):
    assert_migrated(legacy_scene)


def test_interrupted_migration_retries_without_losing_originals(legacy_scene, monkeypatch):
    previous = legacy_scene[0]
    target = path_for(previous)
    atomic = storage._atomic
    failed = []

    def fail_once(path, payload):
        if path == target and not failed:
            failed.append(path)
            raise OSError("Migration interrupted")
        atomic(path, payload)

    monkeypatch.setattr(storage, "_atomic", fail_once)
    with pytest.raises(OSError, match="Migration interrupted"):
        storage.load_background(previous["background_id"])
    assert_migrated(legacy_scene)
