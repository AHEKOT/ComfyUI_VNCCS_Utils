"""Family dependency catalogs, safe selective downloads and continuous transfer progress."""

import sys
import types
from unittest import mock

import pytest

from helpers.unicanvas_package import load_unicanvas_package

UC = load_unicanvas_package("vnccs_dependencies_test")
presets = UC.presets


@pytest.fixture(autouse=True)
def model_root(tmp_path, monkeypatch):
    folders = types.SimpleNamespace(models_dir=str(tmp_path), get_folder_paths=lambda _key: [],
                                    get_filename_list=lambda _key: [], get_full_path=lambda _key, _name: None)
    monkeypatch.setitem(sys.modules, "folder_paths", folders)
    monkeypatch.setattr(presets, "_PRESET_DOWNLOAD_STATUS", {})


def test_card_and_custom_offer_the_same_qwen_dependencies_without_the_base_model():
    card = presets._get_unicanvas_dependencies("qwen_image21", "qwen_image21")
    custom = presets._get_unicanvas_dependencies("qi21")
    assert card == custom
    assert [asset["required"] for asset in card["assets"]] == [True, True, False, False]
    assert all(asset["role"] not in {"diffusion_model", "checkpoint", "gguf"} for asset in card["assets"])
    outpaint = next(asset for asset in card["assets"] if "Outpaint" in asset["name"])
    assert outpaint["hf_revision"] == UC.models.qwen_image21.QWEN21_OUTPAINT_LORA_REVISION
    assert outpaint["local_path"] == "models/loras/" + UC.models.qwen_image21.QWEN21_OUTPAINT_LORA_NAME
    assert not outpaint["installed"]


def test_custom_uses_installed_manually_selected_encoder_and_vae(tmp_path):
    for category in ("text_encoders", "vae"):
        target = tmp_path / category / "custom" / "alternative.safetensors"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"installed")
    catalog = presets._get_unicanvas_dependencies(
        "qwen_image21", clip_name="custom/alternative.safetensors", vae_name="custom/alternative.safetensors")
    assert len(catalog["assets"]) == 2
    assert all(not asset["required"] for asset in catalog["assets"])
    assert len(presets._get_unicanvas_dependencies("qwen_image21", "qwen_image21")["assets"]) == 4
    with pytest.raises(ValueError):
        presets._get_unicanvas_dependencies("qwen_image21", clip_name="../alternative.safetensors")


@pytest.mark.parametrize("family,category,filename", [
    ("anima", "controlnet", UC.models.anima.ANIMA_LLLITE_INPAINT_FILENAME),
    ("z_image", "model_patches", UC.models.z_image.Z_IMAGE_FUN_CONTROLNET_FILENAME),
])
def test_controlnets_use_the_runtime_category_and_filename(family, category, filename):
    assets = presets._get_unicanvas_dependencies(family)["assets"]
    assert any(asset["local_path"] == f"models/{category}/{filename}" and not asset["required"] for asset in assets)


@pytest.mark.parametrize("family,category,filename", [
    ("anima", "controlnet", UC.models.anima.ANIMA_LLLITE_INPAINT_FILENAME),
    ("z_image", "model_patches", UC.models.z_image.Z_IMAGE_FUN_CONTROLNET_FILENAME),
])
def test_popup_and_runtime_reuse_the_same_installed_controlnet(family, category, filename, tmp_path):
    target = tmp_path / "custom" / filename
    target.parent.mkdir(); target.write_bytes(b"installed")
    folders = sys.modules["folder_paths"]
    folders.get_folder_paths = lambda key: [str(tmp_path)] if key == category else []
    folders.get_filename_list = lambda key: [f"custom/{filename}"] if key == category else []
    asset = next(asset for asset in presets._get_unicanvas_dependencies(family)["assets"] if asset["local_path"].endswith(filename))
    assert asset["installed"]
    if family == "anima":
        assert UC.models.anima._ensure_anima_lllite_model(filename) == str(target)
    else:
        assert UC.models.z_image._ensure_z_image_fun_controlnet_model(filename) == f"custom/{filename}"


def test_custom_krea_dependencies_are_deduplicated_across_raw_and_turbo():
    assets = presets._get_unicanvas_dependencies("krea2_edit")["assets"]
    assert len(assets) == 3
    assert all(asset["required"] for asset in assets)


def test_installed_copy_in_configured_subfolder_is_excluded_from_missing(tmp_path, monkeypatch):
    filename = UC.models.qwen_image21.QWEN21_OUTPAINT_LORA_FILENAME
    target = tmp_path / "different" / filename
    target.parent.mkdir(); target.write_bytes(b"installed")
    folders = sys.modules["folder_paths"]
    folders.get_folder_paths = lambda key: [str(tmp_path)] if key == "loras" else []
    folders.get_filename_list = lambda key: [f"different/{filename}"] if key == "loras" else []
    asset = next(asset for asset in presets._get_unicanvas_dependencies("qwen_image21")["assets"] if "Outpaint" in asset["name"])
    assert asset["installed"] and asset["relative_name"] == f"different/{filename}"


@pytest.mark.parametrize("payload", [
    {"generation_mode": "qwen_image21", "preset_id": "anima", "download_keys": ["anima:turbo"]},
    {"generation_mode": "qwen_image21", "download_keys": ["qwen_image21:dependency:0", "anima:turbo"]},
    {"generation_mode": "qwen_image21", "download_keys": ["../model.safetensors"]},
    {"generation_mode": "qwen_image21", "download_keys": "qwen_image21:turbo"},
    {"generation_mode": "qwen_image21", "download_keys": []},
])
def test_invalid_selections_never_queue_any_file(payload, monkeypatch):
    enqueue = mock.Mock()
    monkeypatch.setattr(presets, "_enqueue_preset_download", enqueue)
    with pytest.raises(ValueError):
        presets._download_unicanvas_dependencies(payload)
    enqueue.assert_not_called()


def test_only_selected_server_owned_dependency_is_queued(monkeypatch):
    enqueue = mock.Mock()
    monkeypatch.setattr(presets, "_enqueue_preset_download", enqueue)
    keys = presets._download_unicanvas_dependencies({"generation_mode": "qwen_image21",
        "download_keys": ["qwen_image21:dependency:0"], "hf_repo": "untrusted", "local_path": "/untrusted"})
    assert keys == ["qwen_image21:dependency:0"]
    asset = enqueue.call_args.args[1]
    assert asset["hf_repo"] == UC.models.qwen_image21.QWEN21_OUTPAINT_LORA_REPO_ID
    assert "ausboss/" in asset["local_path"]
    enqueue.assert_called_once()


def test_repeated_download_requests_do_not_duplicate_pending_jobs(monkeypatch):
    queue = mock.Mock()
    monkeypatch.setattr(presets, "_PRESET_DOWNLOAD_QUEUE", queue)
    monkeypatch.setattr(presets, "_ensure_unicanvas_download_worker", lambda: None)
    payload = {"generation_mode": "qwen_image21", "download_keys": ["qwen_image21:dependency:0"]}
    presets._download_unicanvas_dependencies(payload)
    presets._download_unicanvas_dependencies(payload)
    queue.put.assert_called_once()


def test_byte_progress_is_published_during_the_transfer_even_when_console_disabled(monkeypatch):
    class CountingTqdm:
        def __init__(self, *args, total=None, initial=0, disable=False, **kwargs):
            assert disable is False
            self.total, self.n = total, initial

        def update(self, n=1):
            self.n += n

    auto = types.ModuleType("tqdm.auto")
    auto.tqdm = CountingTqdm
    monkeypatch.setitem(sys.modules, "tqdm.auto", auto)
    progress = presets._unicanvas_download_progress_class("file")(total=100, initial=10, disable=True, name="hub")
    assert presets._PRESET_DOWNLOAD_STATUS["file"]["downloaded_bytes"] == 10
    progress.update(40)
    state = presets._PRESET_DOWNLOAD_STATUS["file"]
    assert state["status"] == "downloading"
    assert state["downloaded_bytes"] == 50 and state["total_bytes"] == 100
    assert state["progress"] == 49
    progress.update(50)
    assert presets._PRESET_DOWNLOAD_STATUS["file"]["progress"] == 98


def test_deleted_successful_download_is_missing_again():
    presets._PRESET_DOWNLOAD_STATUS["qwen_image21:dependency:0"] = {"status": "success"}
    asset = next(asset for asset in presets._get_unicanvas_dependencies("qwen_image21")["assets"] if "Outpaint" in asset["name"])
    assert not asset["installed"] and asset["status"] == "missing"
