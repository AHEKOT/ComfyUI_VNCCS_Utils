"""Captured-frame QI2 refinement contracts without Torch or model weights."""

import sys
import threading
import types
from contextlib import nullcontext
from unittest import mock

import pytest
from PIL import Image

from helpers.backend_package import service_package, stub_imports


load = service_package("vnccs_cg_generation_test")
generation = load("nodes.cg_creator_generation")
bridge = load("nodes.unicanvas.comfy_bridge")
progress = load("nodes.unicanvas.progress")
locks = load("nodes.unicanvas.locks")
with stub_imports({"torch": types.ModuleType("torch")}):
    sampling = load("nodes.unicanvas.sampling")


def test_defaults_are_isolated_and_only_cg_qi2_fields_survive():
    settings = generation.normalize_settings({"description": "unused", "attributes": {"time": "Sunset"},
        "generation_mode": "illustrious", "generation": {"diffusion_model_name": "other.safetensors"}})
    assert settings == generation.DEFAULT_SETTINGS
    settings["generation"]["lora_stack"].append({"name": "test"})
    assert generation.DEFAULT_SETTINGS["generation"]["lora_stack"] == []
    assert generation.normalize_settings({"prompt": "  "})["prompt"] == generation.DEFAULT_SETTINGS["prompt"]
    assert not hasattr(generation, "wizard")


@pytest.mark.parametrize("settings", [[], "{}", {"generation": []}, {"prompt": 1},
    {"prompt": "x" * 8001}, {"prompt": "bad\x00prompt"}, {"aspect": "not-an-aspect"}, {"aspect": []},
    {"generation": {"steps": True}}, {"generation": {"steps": 1.5}},
    {"generation": {"cfg": float("nan")}}, {"generation": {"cfg": float("inf")}},
    {"generation": {"seed": -1}}, {"generation": {"seed": 2**80}},
    {"resolution_mp": 20}, {"resolution_mp": float("nan")},
    {"generation": {"prompt_enhance": "yes"}}, {"generation": {"turbo": 1}},
    {"generation": {"cache_device": "cuda"}}, {"generation": {"cache_dtype": "fp64"}},
    {"generation": {"sampler": ""}}, {"generation": {"lora_stack": {}}},
    {"generation": {"lora_stack": [{}] * 9}}, {"generation": {"lora_stack": [None]}},
    {"generation": {"lora_stack": [{"name": "../secret"}]}},
    {"generation": {"lora_stack": [{"name": ".. /secret"}]}},
    {"generation": {"lora_stack": [{"name": "C:\\secret"}]}},
    {"generation": {"lora_stack": [{"name": "\\\\server\\secret"}]}},
    {"generation": {"lora_stack": [{"name": "/secret"}]}},
    {"generation": {"lora_stack": [{"name": "good.safetensors", "strength": float("nan")}]}},
    {"generation": {"lora_stack": [{"name": generation.TURBO_LORA}]}}])
def test_rejects_malformed_settings(settings):
    with pytest.raises(ValueError):
        generation.normalize_settings(settings)


@pytest.fixture
def runtime(monkeypatch):
    calls, clips = [], []
    base = mock.Mock(name="cached-model")
    base.clone.side_effect = lambda: mock.Mock(name="request-model")
    vae = object()
    monkeypatch.setattr(generation, "_ASSET_CACHE", None)
    monkeypatch.setattr(generation, "_ACTIVE", None)
    monkeypatch.setattr(generation, "_asset_name", lambda category, name: name)
    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(inference_mode=nullcontext))
    monkeypatch.setattr(sampling, "_ensure_direct_sampling_prompt_context", lambda *_: None)
    monkeypatch.setattr(sampling, "_suppress_direct_sampling_comfy_progress", nullcontext)
    monkeypatch.setattr(sampling, "_report_comfy_sampling_progress", lambda *_: nullcontext())
    monkeypatch.setattr(progress, "_set_draw_progress", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(progress, "set_interrupt", mock.Mock())
    monkeypatch.setattr(generation, "_pil_to_tensor", lambda image: ("reference", image.size, image.mode))
    size = [800, 512]
    monkeypatch.setattr(generation, "_tensor_to_pil", lambda tensor: Image.new("RGB", tuple(size)))

    def call(name, **kwargs):
        calls.append((name, kwargs))
        if name == "UNETLoader":
            return (base,)
        if name == "CLIPLoader":
            clip = object()
            clips.append(clip)
            return (clip,)
        if name == "VAELoader":
            return (vae,)
        if name == "LoraLoader":
            return kwargs["model"], kwargs["clip"]
        if name == "QwenImage21Cache":
            return (kwargs["model"],)
        if name == "TextGenerate":
            return ("<think>Preserve the camera.</think>\n```text\nFinish the room with the same camera.\n```",)
        if name == "TextEncodeQwenImage21":
            return "positive", "negative", {"samples": "camera-aligned-reference"}
        return (name + "-output",)

    monkeypatch.setattr(generation, "_call_comfy_node", call)
    return types.SimpleNamespace(calls=calls, clips=clips, base=base, size=size, call=call,
                                 reference=Image.new("RGB", tuple(size)))


def test_refinement_uses_creator_assets_cache_enhancement_and_native_reference_latent(runtime):
    image, metadata = generation.generate_image({}, "cg-frame", threading.Event(), runtime.reference)
    names = [name for name, _ in runtime.calls]
    assert names == ["UNETLoader", "CLIPLoader", "VAELoader", "QwenImage21Cache", "TextGenerate",
                     "TextEncodeQwenImage21", "KSampler", "VAEDecode"]
    calls = dict(runtime.calls)
    assert calls["UNETLoader"]["unet_name"] == generation.ASSETS["diffusion_models"]
    assert calls["CLIPLoader"]["clip_name"] == generation.ASSETS["text_encoders"]
    assert calls["CLIPLoader"]["type"] == "qwen_image"
    assert calls["VAELoader"]["vae_name"] == generation.ASSETS["vae"]
    assert calls["QwenImage21Cache"]["device"] == "gpu"
    assert calls["QwenImage21Cache"]["dtype"] == "int8"
    assert calls["TextGenerate"]["sampling_mode"] == generation.TEXT_GENERATION["sampling_mode"]
    encode = calls["TextEncodeQwenImage21"]
    assert encode["images"] == {"image_1": ("reference", (800, 512), "RGB")}
    assert encode["resolution"] == 0 and encode["negative_prompt"] == ""
    assert encode["prompt"] == metadata["prompt"] == "Finish the room with the same camera."
    assert (encode["width"], encode["height"]) == image.size == (800, 512)
    assert calls["KSampler"]["latent_image"] == {"samples": "camera-aligned-reference"}
    assert calls["KSampler"]["steps"] == 25 and calls["KSampler"]["cfg"] == 1
    assert calls["KSampler"]["scheduler"] == "simple" and calls["KSampler"]["denoise"] == 1
    assert metadata["settings"] == generation.DEFAULT_SETTINGS and metadata["model"] == "qi2"
    runtime.base.clone.assert_called_once()


def test_geometry_comes_only_from_capture_and_custom_prompt_is_preserved(runtime):
    settings = {"aspect": "1:1", "resolution_mp": 0.5, "prompt": "Repair the room; keep the view.",
                "generation": {"prompt_enhance": False}}
    image, metadata = generation.generate_image(settings, "camera-cg", threading.Event(), runtime.reference)
    encode = dict(runtime.calls)["TextEncodeQwenImage21"]
    assert (encode["width"], encode["height"]) == image.size == runtime.reference.size
    assert encode["prompt"] == metadata["prompt"] == settings["prompt"]
    assert "TextGenerate" not in dict(runtime.calls) and "EmptyLatentImage" not in dict(runtime.calls)


def test_fresh_clip_per_request_and_no_automatic_character_loras(runtime):
    settings = {"generation": {"prompt_enhance": False, "lora_stack": [{"name": "scenery.safetensors", "strength": 0.7}]}}
    generation.generate_image(settings, "first", threading.Event(), runtime.reference)
    generation.generate_image(settings, "second", threading.Event(), runtime.reference)
    names = [name for name, _ in runtime.calls]
    assert names.count("UNETLoader") == names.count("VAELoader") == 1
    assert names.count("CLIPLoader") == 2 and runtime.clips[0] is not runtime.clips[1]
    assert [call["lora_name"] for name, call in runtime.calls if name == "LoraLoader"] == ["scenery.safetensors"] * 2
    assert runtime.base.clone.call_count == 2


@pytest.mark.parametrize("encoded", [("positive", "negative"), ("positive", "negative", None), None])
def test_missing_aligned_latent_fails_before_sampling(runtime, monkeypatch, encoded):
    def call(name, **kwargs):
        return encoded if name == "TextEncodeQwenImage21" else runtime.call(name, **kwargs)
    monkeypatch.setattr(generation, "_call_comfy_node", call)
    with pytest.raises(RuntimeError, match="camera-aligned"):
        generation.generate_image({}, "missing-latent", threading.Event(), runtime.reference)
    assert "KSampler" not in dict(runtime.calls)


@pytest.mark.parametrize("reference", [None, "image.png", {}, 1])
def test_reference_is_required_before_loading_models(runtime, reference):
    with pytest.raises(ValueError, match="captured frame"):
        generation.generate_image({}, "no-reference", threading.Event(), reference)
    assert runtime.calls == []


@pytest.mark.parametrize("size", [(100, 100), (16, 16), (4112, 64), (4096, 4096)])
def test_rejects_invalid_capture_geometry_before_loading(runtime, size):
    with pytest.raises(ValueError, match="Captured frame"):
        generation.generate_image({}, "bad-capture", threading.Event(), Image.new("RGB", size))
    assert runtime.calls == []


def test_decoding_must_match_requested_size(runtime):
    runtime.size[:] = [64, 64]
    with pytest.raises(RuntimeError, match="expected"):
        generation.generate_image({}, "wrong-size", threading.Event(), runtime.reference)


def test_turbo_uses_existing_adapter_sigmas_and_advanced_sampler(runtime, monkeypatch):
    package = generation.__package__ + ".unicanvas.models"
    monkeypatch.setitem(sys.modules, package, types.ModuleType(package))
    monkeypatch.setitem(sys.modules, package + ".qwen_image21",
                        types.SimpleNamespace(resolve_qwen21_turbo_lora=lambda: generation.TURBO_LORA))

    def apply(model, clip, name, strength):
        runtime.calls.append(("TurboAdapter", {"lora_name": name, "strength": strength}))
        return model, clip

    def sigmas(latent):
        runtime.calls.append(("TurboSigmas", {"latent": latent}))
        return [1, 0.9375, 0.875, 0.75, 0.5, 0.25, 0]

    monkeypatch.setitem(sys.modules, package + ".qwen_image21_viggle",
                        types.SimpleNamespace(apply_viggle_turbo_lora=apply, viggle_turbo_sigmas=sigmas))
    settings = {"generation": {"turbo": True, "steps": 6, "cfg": 1}}
    generation.generate_image(settings, "turbo", threading.Event(), runtime.reference)
    names = [name for name, _ in runtime.calls]
    assert names.index("TurboAdapter") < names.index("QwenImage21Cache")
    assert "KSampler" not in names and "SamplerCustomAdvanced" in names
    assert dict(runtime.calls)["KSamplerSelect"]["sampler_name"] == "euler"
    assert dict(runtime.calls)["BasicGuider"]["conditioning"] == "positive"
    assert dict(runtime.calls)["TurboSigmas"]["latent"] == {"samples": "camera-aligned-reference"}


@pytest.mark.parametrize("settings", [{"turbo": True}, {"turbo": True, "steps": 6, "cfg": 2}])
def test_turbo_rejects_unsupported_schedule_before_loading(runtime, settings):
    with pytest.raises(ValueError, match="six steps and CFG 1"):
        generation.generate_image({"generation": settings}, "turbo-bad", threading.Event(), runtime.reference)
    assert runtime.calls == []


def test_cancelled_pending_job_never_loads_or_interrupts_other_jobs(runtime):
    event = threading.Event()
    event.set()
    with pytest.raises(generation.GenerationCancelled):
        generation.generate_image({}, "cancelled", event, runtime.reference)
    assert runtime.calls == []
    assert generation.interrupt("another-widget") is False
    progress.set_interrupt.assert_not_called()


def test_cancel_while_waiting_does_not_interrupt_the_current_gpu_owner(runtime, monkeypatch):
    event = threading.Event()
    waiting_lock = mock.Mock()
    def acquire(*, timeout):
        event.set()
        return False
    waiting_lock.acquire.side_effect = acquire
    monkeypatch.setattr(locks, "_COMFY_MODEL_OP_LOCK", waiting_lock)
    with pytest.raises(generation.GenerationCancelled):
        generation.generate_image({}, "waiting", event, runtime.reference)
    assert runtime.calls == [] and generation._ACTIVE is None
    waiting_lock.release.assert_not_called()
    progress.set_interrupt.assert_not_called()


def test_new_owned_job_clears_previous_workflow_interrupt_before_loading(runtime, monkeypatch):
    def call(name, **kwargs):
        progress.set_interrupt.assert_called_once_with(False)
        return runtime.call(name, **kwargs)
    monkeypatch.setattr(generation, "_call_comfy_node", call)
    generation.generate_image({}, "fresh-request", threading.Event(), runtime.reference)
    assert generation._ACTIVE is None


def test_interrupt_only_targets_the_active_cg_job(runtime):
    event = threading.Event()
    with generation._model_session("owned", event):
        assert generation.interrupt("another-widget") is False
        assert generation.interrupt("owned") is True
        assert event.is_set()
    assert progress.set_interrupt.call_args_list == [mock.call(False), mock.call(True), mock.call(False)]
    assert generation._ACTIVE is None and generation.interrupt("owned") is False


def test_cancel_after_encoding_discards_result_before_sampling(runtime, monkeypatch):
    event = threading.Event()
    def call(name, **kwargs):
        result = runtime.call(name, **kwargs)
        if name == "TextEncodeQwenImage21":
            event.set()
        return result
    monkeypatch.setattr(generation, "_call_comfy_node", call)
    with pytest.raises(generation.GenerationCancelled):
        generation.generate_image({}, "cancel-encode", event, runtime.reference)
    assert "KSampler" not in dict(runtime.calls) and generation._ACTIVE is None


def test_configuration_reports_only_qi2_and_installed_loras_without_loads(monkeypatch):
    installed = {category: ["QI2/" + name] for category, name in generation.ASSETS.items()}
    installed["loras"] = ["scenery/example.safetensors"]
    monkeypatch.setattr(generation, "_installed", lambda category: installed.get(category, []))
    monkeypatch.setattr(bridge, "_get_node_combo_values", lambda *_: [])
    config = generation.configuration()
    assert config["installed"] is True and config["model"] == "Qwen Image 2.1 INT8 ConvRot"
    assert config["loras"] == installed["loras"]
    assert config["samplers"] == ["euler"] and config["schedulers"] == ["simple"]
    assert config["settings"] == generation.DEFAULT_SETTINGS and "editor" not in config
    installed["vae"] = []
    assert generation.configuration()["installed"] is False
