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


def test_card_and_custom_offer_the_same_complete_qwen_model():
    card = presets._get_unicanvas_dependencies("qwen_image21", "qwen_image21")
    custom = presets._get_unicanvas_dependencies("qi21")
    assert card == custom
    assert [asset["required"] for asset in card["assets"]] == [True, True, True, False, False, False]
    assert card["assets"][0]["role"] == "diffusion_model"
    assert all(not asset["installed"] for asset in card["assets"])
    outpaint = next(asset for asset in card["assets"] if "Outpaint" in asset["name"])
    assert outpaint["hf_revision"] == UC.models.qwen_image21.QWEN21_OUTPAINT_LORA_REVISION
    assert outpaint["local_path"] == "models/loras/" + UC.models.qwen_image21.QWEN21_OUTPAINT_LORA_NAME
    assert not outpaint["installed"]
    pose = next(asset for asset in card["assets"] if "Pose Studio" in asset["name"])
    family = UC.models.qwen_image21
    assert pose["hf_repo"] == family.QWEN21_POSE_LORA_REPO_ID
    assert pose["hf_revision"] == family.QWEN21_POSE_LORA_REVISION
    assert pose["hf_path"] == family.QWEN21_POSE_LORA_FILENAME
    assert pose["local_path"] == "models/loras/" + family.QWEN21_POSE_LORA_NAME
    assert not pose["required"] and not pose["installed"]


def test_custom_uses_installed_manually_selected_encoder_and_vae(tmp_path):
    for category in ("text_encoders", "vae"):
        target = tmp_path / category / "custom" / "alternative.safetensors"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"installed")
    catalog = presets._get_unicanvas_dependencies(
        "qwen_image21", clip_name="custom/alternative.safetensors", vae_name="custom/alternative.safetensors")
    assert len(catalog["assets"]) == 4
    assert [asset["required"] for asset in catalog["assets"]] == [True, False, False, False]
    assert all(asset["role"] not in {"clip", "vae"} for asset in catalog["assets"])
    assert len(presets._get_unicanvas_dependencies("qwen_image21", "qwen_image21")["assets"]) == 6
    with pytest.raises(ValueError):
        presets._get_unicanvas_dependencies("qwen_image21", clip_name="../alternative.safetensors")


def test_custom_missing_subfolder_does_not_accept_another_encoder_or_vae(tmp_path):
    folders = sys.modules["folder_paths"]
    for category in ("text_encoders", "vae"):
        target = tmp_path / category / "other" / "alternative.safetensors"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"installed")
    folders.get_folder_paths = lambda key: [str(tmp_path / key)]
    folders.get_filename_list = lambda key: ["other/alternative.safetensors"]
    catalog = presets._get_unicanvas_dependencies(
        "qwen_image21", clip_name="missing/alternative.safetensors", vae_name="missing/alternative.safetensors")
    assert len(catalog["assets"]) == 6
    assert any(asset["required"] and asset["role"] == "clip" for asset in catalog["assets"])
    assert any(asset["required"] and asset["role"] == "vae" for asset in catalog["assets"])


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
    ensure = UC.models.anima._ensure_anima_lllite_model if family == "anima" else UC.models.z_image._ensure_z_image_fun_controlnet_model
    with pytest.raises(ValueError, match="not found"):
        ensure(f"missing/{filename}")


@pytest.mark.parametrize("preset_id", ["krea2_edit", "krea2_edit_raw"])
def test_krea_offers_every_missing_part_of_the_selected_model(preset_id):
    preset = next(entry for entry in presets._unicanvas_load_preset_registry()["presets"] if entry["id"] == preset_id)
    card = presets._get_unicanvas_dependencies("krea2_edit", preset_id)
    custom = presets._get_unicanvas_dependencies(
        "krea2_edit", model_loader="diffusion_model", model_name=preset["settings"]["diffusion_model_name"])
    assert card == custom
    assets = card["assets"]
    assert [asset["role"] for asset in assets] == ["diffusion_model", "clip", "vae", "lora"]
    assert all(asset["required"] for asset in assets)
    assert all(not asset["installed"] for asset in assets)
    assert assets[0]["relative_name"] == preset["settings"]["diffusion_model_name"]


@pytest.mark.parametrize("preset", presets._unicanvas_load_preset_registry()["presets"], ids=lambda preset: preset["id"])
def test_every_preset_keeps_all_missing_core_assets_in_its_catalog(preset):
    catalog = presets._get_unicanvas_dependencies(preset["settings"]["generation_mode"], preset["id"])
    core = [asset for asset in catalog["assets"] if asset["required"]]
    assert [asset["local_path"] for asset in core] == [asset["local_path"] for asset in preset["assets"]]
    assert all(not asset["installed"] for asset in core)


def test_custom_uses_installed_model_instead_of_offering_a_missing_default(tmp_path):
    target = tmp_path / "diffusion_models" / "custom" / "alternative.safetensors"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"installed")
    catalog = presets._get_unicanvas_dependencies(
        "krea2_edit", model_loader="diffusion_model", model_name="custom/alternative.safetensors")
    assert [asset["role"] for asset in catalog["assets"]] == ["clip", "vae", "lora"]


def test_custom_missing_selected_files_stay_visible_even_when_other_copies_exist(tmp_path):
    for category, name in (("diffusion_models", "krea2_turbo_fp8_scaled.safetensors"),
                           ("text_encoders", "qwen3vl_4b_fp8_scaled.safetensors"),
                           ("vae", "qwen_image_vae.safetensors")):
        target = tmp_path / category / name
        target.parent.mkdir(parents=True)
        target.write_bytes(b"installed")
    catalog = presets._get_unicanvas_dependencies(
        "krea2_edit", model_loader="diffusion_model", model_name="missing/krea2_turbo_fp8_scaled.safetensors",
        clip_name="missing/qwen3vl_4b_fp8_scaled.safetensors", vae_name="missing/qwen_image_vae.safetensors")
    missing = {asset["role"]: asset for asset in catalog["assets"] if not asset["installed"]}
    assert set(missing) == {"diffusion_model", "clip", "vae", "lora"}
    for role in ("diffusion_model", "clip", "vae"):
        assert missing[role]["relative_name"].startswith("missing/")
        assert missing[role]["downloadable"] is False


@pytest.mark.parametrize("role", ["diffusion_model", "clip", "vae", "lora"])
def test_krea_reports_a_removed_file_despite_old_success_status(tmp_path, role):
    catalog = presets._get_unicanvas_dependencies("krea2_edit", "krea2_edit")
    for asset in catalog["assets"]:
        target = tmp_path / asset["local_path"].removeprefix("models/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"installed")
        presets._PRESET_DOWNLOAD_STATUS[asset["download_key"]] = {"status": "success"}
        if asset["role"] == role:
            removed = target
    removed.unlink()
    assets = presets._get_unicanvas_dependencies("krea2_edit", "krea2_edit")["assets"]
    missing = [asset for asset in assets if not asset["installed"]]
    assert [asset["role"] for asset in missing] == [role]
    assert missing[0]["status"] == "missing"


def test_selective_download_can_queue_all_core_krea_files(monkeypatch):
    enqueue = mock.Mock()
    monkeypatch.setattr(presets, "_enqueue_preset_download", enqueue)
    catalog = presets._get_unicanvas_dependencies("krea2_edit", "krea2_edit")
    keys = [asset["download_key"] for asset in catalog["assets"]]
    queued = presets._download_unicanvas_dependencies({"generation_mode": "krea2_edit", "preset_id": "krea2_edit",
                                                      "download_keys": keys})
    assert queued == keys
    assert [call.args[1]["role"] for call in enqueue.call_args_list] == ["diffusion_model", "clip", "vae", "lora"]


def test_unknown_custom_files_are_visible_but_never_queued(monkeypatch):
    enqueue = mock.Mock()
    monkeypatch.setattr(presets, "_enqueue_preset_download", enqueue)
    selection = {"generation_mode": "krea2_edit", "model_loader": "gguf", "model_name": "custom/missing.gguf"}
    catalog = presets._get_unicanvas_dependencies(**selection)
    missing = next(asset for asset in catalog["assets"] if asset["role"] == "gguf")
    assert not missing["installed"] and missing["required"] and not missing["downloadable"]
    assert all(asset["role"] != "diffusion_model" for asset in catalog["assets"])
    with pytest.raises(ValueError, match="catalog"):
        presets._download_unicanvas_dependencies({**selection, "download_keys": [missing["download_key"]]})
    enqueue.assert_not_called()


@pytest.mark.parametrize("selection", [
    {"model_name": "../model.safetensors"}, {"model_name": "C:\\models\\model.safetensors"},
    {"model_loader": "unknown"},
])
def test_custom_model_selection_is_validated(selection):
    with pytest.raises(ValueError):
        presets._get_unicanvas_dependencies("krea2_edit", **selection)


def test_custom_checkpoint_does_not_require_stale_separate_encoder_or_vae_names():
    catalog = presets._get_unicanvas_dependencies(
        "sdxl", model_loader="checkpoint", model_name="missing.safetensors",
        clip_name="old-encoder.safetensors", vae_name="old-vae.safetensors")
    required = [asset for asset in catalog["assets"] if asset["required"]]
    assert [asset["role"] for asset in required] == ["checkpoint"]
    assert required[0]["relative_name"] == "missing.safetensors" and not required[0]["installed"]


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
