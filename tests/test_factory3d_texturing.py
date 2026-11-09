"""Automatic texturing settings, model resolution and safe progress publication."""

import math
from pathlib import Path
from unittest import mock

import pytest
from helpers.backend_package import service_package

load = service_package("vnccs_factory_texturing_test")
generation = load("nodes.factory3d.generation")
texturing = load("nodes.factory3d.texturing")
runtime = load("nodes.factory3d.runtime")
materials = load("nodes.factory3d.materials")


def test_refinement_defaults_off_and_needs_no_prompt():
    settings = generation.normalize_mesh_settings({"provider": "trellis2"})
    restored = generation.normalize_mesh_settings({"provider": "trellis2", "texture_pass": "0",
                                                   "texture_prompt": "old prompt"})
    assert settings == restored
    assert settings["refine_textures"] is False
    assert generation.normalize_mesh_settings({"refine_textures": "1"})["refine_textures"] is True
    assert generation.normalize_mesh_settings({"refine_textures": "0"})["refine_textures"] is False
    assert "texture_prompt" not in settings


def test_refinement_increases_atlas_detail_without_changing_mesh_quality():
    for quality in ("preview", "balanced", "high"):
        base = generation.normalize_mesh_settings({"quality": quality})
        refined = generation.normalize_mesh_settings({"quality": quality, "refine_textures": True})
        assert refined["texture_resolution"] >= 2048
        assert {key: value for key, value in refined.items() if key not in {"refine_textures", "texture_resolution"}} == {
            key: value for key, value in base.items() if key not in {"refine_textures", "texture_resolution"}
        }
    assert generation.normalize_mesh_settings({"quality": "preview"})["texture_resolution"] == 1024


@pytest.mark.parametrize("scale,resolution", [(0, 1024), (1, 1024), (1.5, 1248), (2, 1440), (3, 1760), (4, 2048), (5, 2048)])
def test_refine_resolution_uses_vnccs_megapixel_scale(scale, resolution):
    settings = generation.normalize_mesh_settings({"refine_textures": True, "refine_resolution_mp": str(scale)})
    assert settings["refine_resolution"] == resolution
    assert generation.normalize_mesh_settings({})["refine_resolution"] == 2048


@pytest.mark.parametrize("scale", ["nan", "inf", "-inf", "invalid"])
def test_refine_resolution_rejects_invalid_values(scale):
    with pytest.raises(ValueError):
        generation.normalize_mesh_settings({"refine_resolution_mp": scale})


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("fail", [False, True])
def test_direct_node_calls_release_dynamic_vram_before_next_call(monkeypatch, asynchronous, fail):
    import sys
    from contextlib import nullcontext
    from types import ModuleType, SimpleNamespace

    events = []
    occupied = False
    def finish():
        nonlocal occupied
        events.append("queues")
        occupied = False
    comfy, aimdo = ModuleType("comfy"), ModuleType("comfy_aimdo")
    comfy.memory_management = SimpleNamespace(aimdo_enabled=True)
    comfy.model_prefetch = SimpleNamespace(cleanup_prefetch_queues=finish)
    comfy.model_management = SimpleNamespace(reset_cast_buffers=lambda: events.append("buffers"))
    aimdo.model_vbar = SimpleNamespace(vbars_reset_watermark_limits=lambda: events.append("limits"))
    for name, module in {
        "comfy": comfy, "comfy.memory_management": comfy.memory_management,
        "comfy.model_prefetch": comfy.model_prefetch, "comfy.model_management": comfy.model_management,
        "comfy_aimdo": aimdo, "comfy_aimdo.model_vbar": aimdo.model_vbar,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)
    def run():
        nonlocal occupied
        assert not occupied, "previous node left DynamicVRAM state alive"
        occupied = True
        events.append("run")
        if fail: raise RuntimeError("inference failed")
        return ("result",)
    class Node:
        FUNCTION = "execute"
        def execute(self): return run()
    class AsyncNode:
        FUNCTION = "execute"
        async def execute(self): return run()
    monkeypatch.setitem(sys.modules, "nodes", SimpleNamespace(NODE_CLASS_MAPPINGS={"Synthetic": AsyncNode if asynchronous else Node}))
    monkeypatch.setattr(generation, "_comfy_execution_context", lambda _name: nullcontext())
    monkeypatch.setattr(generation, "_SuppressComfyProgress", nullcontext)
    for _ in range(2):
        if fail:
            with pytest.raises(RuntimeError, match="inference failed"):
                generation._call_node("Synthetic")
        else:
            assert generation._call_node("Synthetic") == ("result",)
    assert events == ["run", "queues", "buffers", "limits"] * 2
    assert not occupied


def test_cameras_cover_axes_and_fit_bounding_sphere():
    center, radius = (2, 3, -4), 2.5
    plan = texturing.build_view_plan(center, radius)
    directions = set()
    for _label, eye, distance in plan:
        offset = tuple(eye[i] - center[i] for i in range(3))
        assert math.dist(eye, center) == pytest.approx(distance)
        assert math.asin(radius / distance) < texturing.VIEW_FOV_RADIANS / 2
        directions.add(tuple(round(v / distance) for v in offset))
    assert directions == {(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)}
    extra = texturing.build_view_plan(center, radius, extra=True)
    assert all(all(abs(eye[i] - center[i]) > 0 for i in range(3)) for _, eye, _ in extra)


def test_native_turbo_and_materials_are_required_only_when_refinement_is_enabled():
    for provider in generation.MESH_PROVIDER_KEYS:
        base = runtime._provider_weight_files(provider)
        files = runtime._provider_weight_files(provider, refine_textures=True)
        assert set(base).isdisjoint(generation.REFINEMENT_WEIGHT_FILES)
        assert set(base).issubset(files)
        assert "diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors" in files
        assert f"{materials.MARIGOLD_DIRECTORY}/model_index.json" in files
        assert all(not name.endswith(".bin") for name in files)
        for name in files:
            assert len(generation.WEIGHT_SPECS[name]["revision"]) == 40
    assert texturing.REFINE_STEPS == 8
    assert texturing.REFINE_CFG == 1
    assert not any("qwen" in path for path in runtime._provider_weight_files("triposplat"))


def test_material_download_preserves_local_pipeline_tree(tmp_path, monkeypatch):
    calls = []
    import sys
    from types import SimpleNamespace
    cached = tmp_path / "hub-model"
    cached.write_bytes(b"cached model component")
    def download(**kwargs):
        calls.append(kwargs)
        return str(cached)
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(hf_hub_download=download))
    root = tmp_path / "models"
    monkeypatch.setattr(runtime.backend, "_model_root", lambda: root)
    monkeypatch.setattr(runtime.backend, "_category_roots", lambda _category: [])
    monkeypatch.setattr(runtime, "_provider_weight_files", lambda _key, **_options: tuple(materials.MARIGOLD_WEIGHT_SPECS))
    monkeypatch.setattr(runtime, "_emit", lambda *args, **kwargs: None)
    monkeypatch.setattr(runtime, "_check_cancel", lambda _job: None)
    monkeypatch.setattr(runtime, "_provider_weights_status", lambda _key, **_options: {"ready": True})
    runtime._download_provider_weights({}, "trellis2", refine_textures=True)
    assert calls
    for call in calls:
        assert call["token"] is False
        assert "local_dir" not in call
        assert (root / materials.MARIGOLD_DIRECTORY / call["filename"]).read_bytes() == cached.read_bytes()
        assert call["revision"] == "e7280a0a0fc5a0df0b36050882b3d8b77da22fd9"


@pytest.mark.parametrize("location", ["standard", "extra", "legacy"])
def test_installer_downloads_only_missing_materials_and_reuses_existing_models(tmp_path, monkeypatch, location):
    import sys
    from types import SimpleNamespace

    root, extra = tmp_path / "models", tmp_path / "extra"
    monkeypatch.setattr(runtime.backend, "_model_root", lambda: root)
    monkeypatch.setattr(runtime.backend, "_category_roots", lambda category: [extra / category])
    installed_root = {"standard": root, "extra": extra, "legacy": root / "TripoSplat"}[location]
    installed = []
    for relative in (*generation.PROVIDER_WEIGHT_FILES["pixal3d"], *generation.QI2_WEIGHT_FILES):
        path = installed_root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"existing model")
        installed.append(path)
    calls = []

    def download(**kwargs):
        calls.append(kwargs)
        assert "local_dir" not in kwargs
        path = tmp_path / "hub" / kwargs["filename"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"new material component")
        return str(path)

    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(hf_hub_download=download))
    monkeypatch.setattr(runtime, "_emit", lambda *args, **kwargs: None)
    monkeypatch.setattr(runtime, "_check_cancel", lambda _job: None)
    result = runtime._download_provider_weights({}, "pixal3d", refine_textures=True)
    assert result["weights"]["ready"]
    assert {call["filename"] for call in calls} == set(materials.MARIGOLD_FILES)
    assert all(call["repo_id"] == "prs-eth/marigold-iid-appearance-v1-1" for call in calls)
    assert all(path.read_bytes() == b"existing model" for path in installed)
    if location != "standard":
        assert not (root / generation.QI2_WEIGHT_FILES[0]).exists()
    calls.clear()
    assert runtime._download_provider_weights({}, "pixal3d", refine_textures=True)["weights"]["ready"]
    assert calls == []


def test_progress_publishes_only_saved_files_and_copies_snapshot(tmp_path, monkeypatch):
    scene_id, object_id = "a" * 32, "b" * 32
    monkeypatch.setattr(runtime.backend, "resolve_scene_dir", lambda _scene: tmp_path)
    directory = tmp_path / "objects" / object_id / "texturing"
    directory.mkdir(parents=True)
    (directory / "preview.glb").write_bytes(b"glTF")
    job = {"scene_id": scene_id}
    snapshot = {"preview": "preview.glb", "views": [{"label": "front", "state": "rendering"}]}
    runtime._publish_texturing(job, object_id, snapshot)
    first = job["texturing"]
    snapshot["views"][0]["base"] = "view_0_base.png"
    with pytest.raises(FileNotFoundError):
        runtime._publish_texturing(job, object_id, snapshot)
    assert job["texturing"] is first
    assert "base_url" not in first["views"][0]
    (directory / "view_0_base.png").write_bytes(b"png")
    runtime._publish_texturing(job, object_id, snapshot)
    assert job["texturing"]["views"][0]["base_url"].endswith("file=view_0_base.png")
    assert "base_url" not in first["views"][0]
    for name in ("../scene.json", "view_0_base.png/../../scene.json", "model.glb", "atlas_0_bad.png"):
        with pytest.raises(FileNotFoundError):
            runtime.texturing_asset_path(scene_id, object_id, name)
    outside = tmp_path.parent / f"outside-{object_id}.png"
    outside.write_bytes(b"private")
    try:
        (directory / "view_1_base.png").symlink_to(outside)
        with pytest.raises(FileNotFoundError):
            runtime.texturing_asset_path(scene_id, object_id, "view_1_base.png")
    finally:
        outside.unlink()


def test_runtime_reports_missing_material_dependency(monkeypatch):
    import sys
    from types import SimpleNamespace
    monkeypatch.setitem(sys.modules, "nodes", SimpleNamespace(NODE_CLASS_MAPPINGS={
        name: object for name in (*generation.PROVIDER_NODE_TYPES["trellis2"], *generation.REFINEMENT_NODE_TYPES)
    }))
    with mock.patch.object(generation, "find_spec", return_value=None):
        assert generation.runtime_status("trellis2")["ready"]
        status = generation.runtime_status("trellis2", refine_textures=True)
    assert not status["ready"]
    assert status["missing_nodes"] == []
    assert status["missing_packages"] == ["diffusers>=0.35.2"]


def test_material_pipeline_files_must_share_one_model_directory(tmp_path, monkeypatch):
    extra = tmp_path / "extra"
    monkeypatch.setattr(runtime.backend, "_model_root", lambda: tmp_path / "models")
    monkeypatch.setattr(runtime.backend, "_category_roots", lambda _key: [extra])
    for index, (relative, spec) in enumerate(materials.MARIGOLD_WEIGHT_SPECS.items()):
        path = (tmp_path / "models" / relative if index % 2 else extra / "marigold-iid-appearance-v1-1" / spec["filename"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"model")
    resolved = runtime._provider_weight_paths("trellis2", refine_textures=True)
    assert not all(runtime._valid_weight(resolved[name]) for name in materials.MARIGOLD_WEIGHT_SPECS)
    for spec in materials.MARIGOLD_WEIGHT_SPECS.values():
        path = extra / "marigold-iid-appearance-v1-1" / spec["filename"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"model")
    resolved = runtime._provider_weight_paths("trellis2", refine_textures=True)
    assert all(path.is_relative_to(extra) for name, path in resolved.items() if name in materials.MARIGOLD_WEIGHT_SPECS)


def test_base_generator_ready_without_refinement_weights_or_nodes(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace
    monkeypatch.setattr(runtime.backend, "_model_root", lambda: tmp_path)
    monkeypatch.setattr(runtime.backend, "_category_roots", lambda _category: [])
    for relative in runtime._provider_weight_files("trellis2"):
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"base model")
    assert runtime._provider_weights_status("trellis2")["ready"]
    assert not runtime._provider_weights_status("trellis2", refine_textures=True)["ready"]
    monkeypatch.setitem(sys.modules, "nodes", SimpleNamespace(NODE_CLASS_MAPPINGS={
        name: object for name in generation.PROVIDER_NODE_TYPES["trellis2"]
    }))
    with mock.patch.object(generation, "find_spec", return_value=None):
        assert generation.runtime_status("trellis2")["ready"]
        status = generation.runtime_status("trellis2", refine_textures=True)
    assert not status["ready"]
    assert "TextEncodeQwenImage21" in status["missing_nodes"]


@pytest.mark.parametrize("scenario", ["download_error", "cancel_download", "copy_error", "cancel_copy", "appears_during_download", "publish_race"])
def test_model_installation_cannot_replace_user_files(tmp_path, monkeypatch, scenario):
    import sys
    from types import SimpleNamespace

    root = tmp_path / "models"
    relative = generation.QI2_WEIGHT_FILES[0]
    target = root / relative
    target.parent.mkdir(parents=True)
    unrelated = target.parent / "user-model.safetensors"
    unrelated.write_bytes(b"untouched user model")
    cached = tmp_path / "hub-model"
    cached.write_bytes(b"new" * (1024 * 1024))
    monkeypatch.setattr(runtime.backend, "_model_root", lambda: root)
    monkeypatch.setattr(runtime.backend, "_category_roots", lambda _category: [])
    monkeypatch.setattr(runtime, "_provider_weight_files", lambda *_args, **_kwargs: (relative,))
    monkeypatch.setattr(runtime, "_emit", lambda *_args, **_kwargs: None)
    downloading = False

    def download(**kwargs):
        nonlocal downloading
        assert "local_dir" not in kwargs
        assert "force_download" not in kwargs
        assert kwargs["token"] is False
        downloading = True
        if scenario == "download_error":
            raise OSError("network interrupted")
        if scenario == "appears_during_download":
            target.write_bytes(b"user's current version")
        return str(cached)

    def check_cancel(_job):
        if scenario == "cancel_download" and downloading:
            raise runtime.JobCancelled("cancelled")
        if scenario == "cancel_copy" and any(p.stat().st_size > 0 for p in target.parent.glob("*.part")):
            raise runtime.JobCancelled("cancelled")

    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(hf_hub_download=download))
    monkeypatch.setattr(runtime, "_check_cancel", check_cancel)
    if scenario == "copy_error":
        def fail_flush(_descriptor): raise OSError("disk write failed")
        monkeypatch.setattr(runtime.os, "fsync", fail_flush)
    if scenario == "publish_race":
        link = runtime.os.link
        def racing_link(source, destination):
            assert Path(source).parent == target.parent
            target.write_bytes(b"user's current version")
            return link(source, destination)
        monkeypatch.setattr(runtime.os, "link", racing_link)
    if scenario in {"appears_during_download", "publish_race"}:
        result = runtime._download_provider_weights({}, "pixal3d", refine_textures=True)
        assert result["weights"]["ready"]
        assert target.read_bytes() == b"user's current version"
    else:
        with pytest.raises((OSError, runtime.JobCancelled)):
            runtime._download_provider_weights({}, "pixal3d", refine_textures=True)
        assert not target.exists()
    assert unrelated.read_bytes() == b"untouched user model"
    assert not list(target.parent.glob("*.part"))
    assert not any(p.is_dir() for p in target.parent.iterdir())


def test_empty_existing_file_is_not_deleted_or_sent_to_downloader(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace

    relative = generation.QI2_WEIGHT_FILES[0]
    target = tmp_path / relative
    target.parent.mkdir(parents=True)
    target.touch()
    download = mock.Mock(side_effect=AssertionError("existing files must never reach HF"))
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(hf_hub_download=download))
    monkeypatch.setattr(runtime.backend, "_model_root", lambda: tmp_path)
    monkeypatch.setattr(runtime.backend, "_category_roots", lambda _category: [])
    monkeypatch.setattr(runtime, "_provider_weight_files", lambda *_args, **_kwargs: (relative,))
    monkeypatch.setattr(runtime, "_emit", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runtime, "_check_cancel", lambda _job: None)
    with pytest.raises(RuntimeError, match="left unchanged"):
        runtime._download_provider_weights({}, "pixal3d")
    download.assert_not_called()
    assert target.is_file() and target.stat().st_size == 0
