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
