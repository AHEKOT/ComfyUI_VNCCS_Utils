"""Preset downloads must never replace a model installed during the transfer."""

import sys
import types
from pathlib import Path
from unittest import mock

import pytest

from helpers.unicanvas_package import load_unicanvas_package


torch_stub = types.ModuleType("torch")
torch_stub.Tensor = object
presets = load_unicanvas_package("vnccs_preset_install_test", torch_module=torch_stub).presets


@pytest.fixture(autouse=True)
def fake_download_progress(monkeypatch):
    # These tests fake the Hub transport; the real progress adapter has its own contract test.
    monkeypatch.setattr(presets, "_unicanvas_download_progress_class", lambda _key: object)


@pytest.fixture
def comfy_paths(tmp_path, monkeypatch):
    folders = types.ModuleType("folder_paths")
    folders.models_dir = str(tmp_path / "models")
    roots = {key: tmp_path / "external" / key for key in ("unet", "clip", "vae", "loras")}
    folders.get_folder_paths = lambda key: [str(roots[key])] if key in roots else []
    folders.get_filename_list = lambda key: [str(path.relative_to(roots[key])) for path in roots[key].rglob("*.safetensors")] if key in roots else []
    folders.get_full_path = lambda key, name: None
    monkeypatch.setitem(sys.modules, "folder_paths", folders)
    monkeypatch.setattr(presets, "_PRESET_DOWNLOAD_STATUS", {})
    return roots


@pytest.mark.parametrize("lora_folder", ["QI2/Viggle", "viggle", "custom\\qwen"])
def test_qi21_detects_the_vnccs_stack_in_configured_roots_without_outpaint(comfy_paths, lora_folder):
    qi = next(preset for preset in presets._unicanvas_load_preset_registry()["presets"] if preset["id"] == "qwen_image21")
    aliases = {"diffusion_model": "unet", "clip": "clip", "vae": "vae"}
    for asset in qi["assets"]:
        target = comfy_paths[aliases[asset["role"]]] / "Qwen" / Path(asset["local_path"]).name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"installed")
    turbo = comfy_paths["loras"] / lora_folder.replace("\\", "/") / Path(qi["turbo"]["asset"]["local_path"]).name
    turbo.parent.mkdir(parents=True, exist_ok=True)
    turbo.write_bytes(b"installed")

    result = next(preset for preset in presets._get_unicanvas_presets()["presets"] if preset["id"] == "qwen_image21")
    assert result["title"] == "Qwen Edit 2.1"
    assert result["installed"] and result["status"] == "installed"
    assert [asset["role"] for asset in result["assets"]] == ["diffusion_model", "clip", "vae"]
    assert all(asset["relative_name"].startswith("Qwen/") for asset in result["assets"])
    assert result["turbo"]["asset"]["installed"]
    assert result["turbo"]["asset"]["relative_name"] == str(turbo.relative_to(comfy_paths["loras"]))

    # One genuinely missing core weight must still require installation.
    target.unlink()
    result = next(preset for preset in presets._get_unicanvas_presets()["presets"] if preset["id"] == "qwen_image21")
    assert not result["installed"] and result["status"] == "missing"


def test_queue_and_worker_reuse_an_installed_lora_in_an_external_root(comfy_paths, monkeypatch):
    target = comfy_paths["loras"] / "QI2" / "Viggle" / "turbo.safetensors"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"installed")
    asset = {"local_path": "models/loras/viggle/turbo.safetensors"}
    start = mock.Mock()
    queue = mock.Mock()
    monkeypatch.setattr(presets, "_ensure_unicanvas_download_worker", start)
    monkeypatch.setattr(presets, "_PRESET_DOWNLOAD_QUEUE", queue)
    presets._enqueue_preset_download("turbo", asset)
    start.assert_not_called()
    queue.put.assert_not_called()
    queue.get.side_effect = [("turbo", asset), StopIteration]
    with pytest.raises(StopIteration):
        presets._unicanvas_download_worker_loop()
    assert presets._PRESET_DOWNLOAD_STATUS["turbo"]["status"] == "success"
    assert not Path(presets._unicanvas_models_root()).exists()
    assert target.read_bytes() == b"installed"


def test_asset_lookup_accepts_windows_catalog_and_listed_names(comfy_paths, monkeypatch):
    target = comfy_paths["loras"] / "nested" / "turbo.safetensors"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"installed")
    monkeypatch.setattr(sys.modules["folder_paths"], "get_filename_list", lambda _key: [r"nested\turbo.safetensors"])
    found, name = presets._unicanvas_find_installed_asset(r"models\loras\QI2\Viggle\turbo.safetensors")
    assert found == str(target)
    assert name == r"nested\turbo.safetensors"


@pytest.mark.parametrize("path", ["models/loras/../turbo.safetensors", "C:\\models\\loras\\turbo.safetensors", "models/loras/C:turbo.safetensors"])
def test_asset_lookup_rejects_unsafe_names_before_searching(comfy_paths, path):
    with pytest.raises(ValueError):
        presets._unicanvas_find_installed_asset(path)


def test_qie2511_preset_is_removed():
    assert all(preset["id"] != "qwen_image_edit" for preset in presets._unicanvas_load_preset_registry()["presets"])


def test_download_uses_the_configured_lora_root_and_vnccs_subfolder(comfy_paths, monkeypatch, tmp_path):
    asset = next(preset for preset in presets._unicanvas_load_preset_registry()["presets"] if preset["id"] == "qwen_image21")["turbo"]["asset"]
    target = comfy_paths["loras"] / "QI2" / "Viggle" / Path(asset["local_path"]).name
    cached = tmp_path / "cached.safetensors"
    cached.write_bytes(bytes(2048))
    hub = types.ModuleType("huggingface_hub")

    def download(**kwargs):
        assert kwargs["token"] is False
        assert kwargs["revision"] == asset["hf_revision"]
        return str(cached)

    hub.hf_hub_download = download
    queue = mock.Mock()
    queue.get.side_effect = [("turbo", asset), StopIteration]
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)
    monkeypatch.setattr(presets, "_PRESET_DOWNLOAD_QUEUE", queue)
    with pytest.raises(StopIteration):
        presets._unicanvas_download_worker_loop()
    assert target.read_bytes() == cached.read_bytes()
    assert list(target.parent.iterdir()) == [target]
    assert not Path(presets._unicanvas_models_root()).exists()


@pytest.mark.parametrize("race", [False, True])
def test_install_is_atomic_and_preserves_a_concurrently_installed_model(tmp_path, monkeypatch, race):
    cached = tmp_path / "cached.safetensors"
    cached.write_bytes(b"download" * 256)
    target = tmp_path / "models" / "test.safetensors"
    target.parent.mkdir()

    def download(**kwargs):
        assert kwargs["token"] is False
        if race:
            target.write_bytes(b"installed by someone else")
        return str(cached)

    hub = types.ModuleType("huggingface_hub")
    hub.hf_hub_download = download
    queue = mock.Mock()
    queue.get.side_effect = [("test", {"local_path": "models/loras/test.safetensors", "hf_repo": "artist/models", "hf_path": "test.safetensors"}), StopIteration]
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)
    monkeypatch.setattr(presets, "_PRESET_DOWNLOAD_QUEUE", queue)
    monkeypatch.setattr(presets, "_PRESET_DOWNLOAD_STATUS", {})
    monkeypatch.setattr(presets, "_unicanvas_resolve_local_model_path", lambda path: str(target))
    with pytest.raises(StopIteration):
        presets._unicanvas_download_worker_loop()
    assert target.read_bytes() == (b"installed by someone else" if race else cached.read_bytes())
    assert presets._PRESET_DOWNLOAD_STATUS["test"]["status"] == "success"
    assert list(target.parent.iterdir()) == [target]
    assert cached.exists()
    queue.task_done.assert_called_once()


def test_failed_stage_copy_leaves_no_installed_model_or_partial_file(tmp_path, monkeypatch):
    cached = tmp_path / "cached.safetensors"
    cached.write_bytes(bytes(2048))
    target = tmp_path / "models" / "test.safetensors"
    hub = types.ModuleType("huggingface_hub")
    hub.hf_hub_download = lambda **kwargs: str(cached)
    queue = mock.Mock()
    queue.get.side_effect = [("test", {"local_path": "models/loras/test.safetensors", "hf_repo": "artist/models", "hf_path": "test.safetensors"}), StopIteration]

    def fail_copy(_source, destination):
        Path(destination).write_bytes(b"partial")
        raise OSError("disk full")

    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)
    monkeypatch.setattr(presets, "_PRESET_DOWNLOAD_QUEUE", queue)
    monkeypatch.setattr(presets, "_PRESET_DOWNLOAD_STATUS", {})
    monkeypatch.setattr(presets, "_unicanvas_resolve_local_model_path", lambda path: str(target))
    monkeypatch.setattr(presets.shutil, "copy2", fail_copy)
    with pytest.raises(StopIteration):
        presets._unicanvas_download_worker_loop()
    assert list(target.parent.iterdir()) == []
    assert presets._PRESET_DOWNLOAD_STATUS["test"] == {"status": "error", "message": "disk full"}
