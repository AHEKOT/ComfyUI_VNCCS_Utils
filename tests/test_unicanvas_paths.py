"""Model names must stay relative before any filesystem or ComfyUI lookup."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("vnccs_unicanvas_paths_test", ROOT / "nodes/unicanvas/paths.py")
PATHS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATHS)


@pytest.mark.parametrize("name", [
    "/tmp/model.pt", r"C:\models\model.pt", "C:model.pt", r"\model.pt",
    r"\\host\share\model.pt", "//host/share/model.pt", r"\\?\C:\model.pt",
    "../model.pt", r"sub\..\model.pt", "sub/../model.pt", r"sub\.. \model.pt", "model.pt:stream", "model\x00.pt",
])
def test_unsafe_names_are_rejected_before_any_lookup(name):
    folders = mock.Mock()
    for resolver in (PATHS._get_full_path_agnostic, PATHS._resolve_model_filename):
        with mock.patch.object(PATHS.os.path, "exists") as exists, pytest.raises(ValueError):
            resolver(folders, "checkpoints", name)
        exists.assert_not_called()
    folders.assert_not_called()
    assert not folders.mock_calls


def test_relative_subfolder_names_work_with_both_separator_styles(tmp_path):
    model = tmp_path / "sub" / "model.safetensors"
    model.parent.mkdir()
    model.write_bytes(b"model")
    folders = SimpleNamespace(get_folder_paths=lambda _category: [str(tmp_path)],
                              get_full_path=lambda _category, _name: None)
    for name in ("sub/model.safetensors", r"sub\model.safetensors"):
        assert PATHS._get_full_path_agnostic(folders, "checkpoints", name, require_exists=True) == str(model)
    assert PATHS._get_full_path_agnostic(folders, "checkpoints", "missing.safetensors", require_exists=True) is None


def test_minimax_vae_alternative_is_scoped_to_vae_and_known_filename():
    fp16 = r"MiniMax\minimax_h3_video_vae_fp16.safetensors"
    int8 = "minimax_h3_video_vae_int8_convrot.safetensors"
    folders = SimpleNamespace(get_filename_list=lambda _category: [fp16])
    assert PATHS._resolve_model_filename(folders, "vae", int8) == fp16
    assert PATHS._resolve_model_filename(folders, "loras", int8) == int8
    assert PATHS._resolve_model_filename(folders, "vae", "another_vae.safetensors") == "another_vae.safetensors"
    folders.get_filename_list = lambda _category: ["unrelated.safetensors"]
    assert PATHS._resolve_model_filename(folders, "vae", int8) == int8
