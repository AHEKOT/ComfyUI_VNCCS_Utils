"""Draw ownership and runtime cleanup preserve cached model weights."""

import contextlib
import copy
import sys
import threading
import types
import weakref
from unittest import mock

import pytest
import numpy as np

from helpers.unicanvas_package import load_unicanvas_package


torch_stub = types.ModuleType("torch")
torch_stub.Tensor = object
unicanvas = load_unicanvas_package("vnccs_draw_ownership_test", torch_module=torch_stub)
draw = unicanvas.draw


@pytest.mark.parametrize("family", ["qwen_image21", "flux_klein"])
def test_qi2_keeps_weights_cached_but_loads_a_fresh_text_encoder(monkeypatch, family):
    loaders = unicanvas.loaders
    model, first_clip, fresh_clip, vae = (object() for _ in range(4))
    load = mock.Mock(return_value=(model, first_clip, vae))
    fresh = mock.Mock(return_value=fresh_clip)
    monkeypatch.setattr(loaders, "_MODEL_CACHE", {})
    monkeypatch.setattr(loaders.DiffusionModelUniCanvasLoader, "load_assets", load)
    monkeypatch.setattr(loaders.DiffusionModelUniCanvasLoader, "load_clip", fresh)
    settings = {"model_loader": "diffusion_model", "generation_mode": family}
    assert loaders._load_generation_assets(settings) == (model, first_clip, vae)
    second = loaders._load_generation_assets(settings)
    assert second == (model, fresh_clip if family == "qwen_image21" else first_clip, vae)
    load.assert_called_once()
    assert fresh.call_count == int(family == "qwen_image21")
    cached = loaders._peek_cached_generation_assets(settings)
    assert cached == (model, None if family == "qwen_image21" else first_clip, vae)


def test_failed_qi2_encoder_reload_never_reuses_previous_encoder(monkeypatch):
    loaders = unicanvas.loaders
    model, clip, vae = (object() for _ in range(3))
    monkeypatch.setattr(loaders, "_MODEL_CACHE", {})
    monkeypatch.setattr(loaders.DiffusionModelUniCanvasLoader, "load_assets", lambda *a: (model, clip, vae))
    monkeypatch.setattr(loaders.DiffusionModelUniCanvasLoader, "load_clip", mock.Mock(side_effect=RuntimeError("encoder failed")))
    settings = {"model_loader": "diffusion_model", "generation_mode": "qwen_image21"}
    loaders._load_generation_assets(settings)
    with pytest.raises(RuntimeError, match="encoder failed"):
        loaders._load_generation_assets(settings)
    assert loaders._peek_cached_generation_assets(settings) == (model, None, vae)


@pytest.mark.parametrize("outcome,event", [("success", "cleanup"), ("error", "cleanup"),
                                           ("cancel", "cleanup"), ("success", "detach")])
def test_repeated_turbo_outpaint_releases_adapter_gpu_weights(monkeypatch, outcome, event):
    import comfy.patcher_extension as extension
    import comfy.sd
    import comfy.utils

    qwen = unicanvas.models.qwen_image21
    viggle = unicanvas.models.qwen_image21_viggle
    tensor_refs, loaded_files, retained_models = [], [], []

    class Tensor:
        def __init__(self, device="cpu", value=1):
            self.device, self.value = device, value
            tensor_refs.append(weakref.ref(self))
        def to(self, device):
            return self if device == self.device else Tensor(device, self.value)
        def cpu(self):
            return self.to("cpu")
        def __mul__(self, value):
            return Tensor(self.device, self.value * value)

    class Linear:
        def __init__(self):
            self.hooks = []
        def register_forward_hook(self, hook):
            self.hooks.append(hook)
            return types.SimpleNamespace(remove=lambda: self.hooks.remove(hook))

    linear = Linear()
    diffusion = types.SimpleNamespace(get_submodule=lambda name: linear)

    class Model:
        def __init__(self):
            self.model_options = {"transformer_options": {}}
            self.wrappers, self.callbacks, self.patches = {}, {}, {}
        def clone(self):
            model = Model()
            model.parent = self
            for key in ("model_options", "wrappers", "callbacks", "patches"):
                setattr(model, key, copy.deepcopy(getattr(self, key)))
            return model
        def add_wrapper_with_key(self, kind, key, wrapper):
            self.wrappers.setdefault(kind, {}).setdefault(key, []).append(wrapper)
        def add_callback_with_key(self, kind, key, callback):
            self.callbacks.setdefault(kind, {}).setdefault(key, []).append(callback)
        def finish(self):
            for group in self.callbacks.get(event, {}).values():
                for callback in group:
                    callback(self, True) if event == "detach" else callback(self)

    monkeypatch.setattr(extension, "WrappersMP", types.SimpleNamespace(DIFFUSION_MODEL="forward"), raising=False)
    monkeypatch.setattr(extension, "CallbacksMP", types.SimpleNamespace(ON_CLEANUP="cleanup", ON_DETACH="detach"), raising=False)
    monkeypatch.setattr(sys.modules["comfy"], "patcher_extension", extension, raising=False)
    monkeypatch.setattr(qwen, "resolve_qwen21_turbo_lora", lambda: qwen.QWEN21_TURBO_LORA_NAME)
    monkeypatch.setattr(qwen, "resolve_qwen21_outpaint_lora", lambda: qwen.QWEN21_OUTPAINT_LORA_NAME)
    monkeypatch.setattr(unicanvas.loras, "_get_lora_full_path", lambda name: name)

    def load(name, safe_load, return_metadata=False):
        loaded_files.append(name)
        if return_metadata:
            return {"transformer.block.q.lora_A.weight": Tensor(),
                    "transformer.block.q.lora_B.weight": Tensor()}, {}
        return {"outpaint": Tensor()}

    def merge(model, clip, weights, strength, clip_strength):
        model = model.clone()
        model.patches["outpaint"] = weights["outpaint"]
        return model, clip

    monkeypatch.setattr(comfy.utils, "load_torch_file", load)
    monkeypatch.setattr(comfy.sd, "load_lora_for_models", merge)

    def lora_linear(value, pair):
        assert all(tensor.device == "gpu" for tensor in pair)
        assert all(tensor.value == 1 for tensor in pair)
        return 0

    monkeypatch.setattr(viggle, "_lora_linear", lora_linear)

    class Interrupted(Exception):
        pass

    failure = {"error": RuntimeError("sampling failed"), "cancel": Interrupted("stopped")}.get(outcome)

    class Executor:
        class_obj = diffusion
        def __call__(self, value):
            for hook in linear.hooks:
                hook(linear, (value,), 0)
            if failure:
                raise failure
            return "sampled"

    base, clip = Model(), object()
    module = qwen.QwenImage21UniCanvasModule()
    settings = {**module.defaults, "draw_mode": "outpaint"}
    for _ in range(6):
        # Outpaint and QI2 cache clone the Turbo patcher; callbacks must follow both clones.
        model, output_clip = module.apply_loras(base.clone(), clip, settings)
        model = model.clone()
        retained_models.append(model)
        assert output_clip is clip and viggle.has_viggle_turbo(model)
        assert set(model.patches) == {"outpaint"}
        wrapper = model.wrappers["forward"][viggle.VIGGLE_TURBO_MARKER][0]
        # A cached patched model must still work after its previous cleanup/offload.
        for _ in range(2):
            try:
                if failure:
                    with pytest.raises(type(failure), match=str(failure)):
                        wrapper(Executor(), types.SimpleNamespace(device="gpu"))
                else:
                    for _ in range(6):
                        assert wrapper(Executor(), types.SimpleNamespace(device="gpu")) == "sampled"
            finally:
                model.finish()
            assert linear.hooks == []
            assert not any(ref() is not None and ref().device == "gpu" for ref in tensor_refs), "Turbo weights survived sampler cleanup"
    assert loaded_files == [qwen.QWEN21_TURBO_LORA_NAME, qwen.QWEN21_OUTPAINT_LORA_NAME] * 6
    assert base.wrappers == base.callbacks == base.patches == {}
    assert base.model_options == {"transformer_options": {}}


@pytest.mark.parametrize("batch_size", [4, 20])
@pytest.mark.parametrize("turbo", [False, True])
@pytest.mark.parametrize("failure_stage", [None, "encode", "sample", "decode"])
def test_qi2_releases_allocator_between_stages_and_decodes_one_image_at_a_time(monkeypatch, batch_size, turbo, failure_stage):
    import comfy
    import comfy.model_management as management

    qwen = unicanvas.models.qwen_image21
    module = qwen.QwenImage21UniCanvasModule()
    state = {"prefetch": False, "cast": False, "watermark": False}
    memory = types.ModuleType("comfy.memory_management")
    memory.aimdo_enabled = True
    prefetch = types.ModuleType("comfy.model_prefetch")
    aimdo = types.ModuleType("comfy_aimdo")
    aimdo.model_vbar = types.ModuleType("comfy_aimdo.model_vbar")
    prefetch.cleanup_prefetch_queues = lambda: state.__setitem__("prefetch", False)
    monkeypatch.setattr(management, "reset_cast_buffers", lambda: state.__setitem__("cast", False), raising=False)
    aimdo.model_vbar.vbars_reset_watermark_limits = lambda: state.__setitem__("watermark", False)
    for name, value in (("comfy.memory_management", memory), ("comfy.model_prefetch", prefetch),
                        ("comfy_aimdo", aimdo), ("comfy_aimdo.model_vbar", aimdo.model_vbar)):
        monkeypatch.setitem(sys.modules, name, value)
    monkeypatch.setattr(comfy, "memory_management", memory, raising=False)
    monkeypatch.setattr(comfy, "model_prefetch", prefetch, raising=False)
    monkeypatch.setattr(comfy, "model_management", management, raising=False)
    unload = mock.Mock()
    monkeypatch.setattr(management, "unload_all_models", unload, raising=False)
    monkeypatch.setattr(qwen, "has_viggle_turbo", lambda model: turbo)
    monkeypatch.setattr(qwen, "viggle_turbo_sigmas", lambda latent: [1, .9, .8, .7, .6, .5, 0])
    monkeypatch.setattr(torch_stub, "cat", lambda images, dim: np.concatenate(images, axis=dim), raising=False)
    latent = {"samples": np.arange(batch_size).reshape(batch_size, 1, 1, 1)}
    live_gpu_images, decoded_indices = [], []

    def work(stage):
        assert not any(state.values()), f"allocator resources leaked into {stage}"
        state.update(prefetch=True, cast=True, watermark=True)
        if failure_stage == stage and (stage != "decode" or len(decoded_indices) == 1):
            raise RuntimeError(f"{stage} failed")

    class GpuImage:
        def __init__(self, index):
            self.index = index
            live_gpu_images.append(weakref.ref(self))
        def cpu(self):
            return np.full((1, 2, 2, 4), self.index, dtype=np.float32)

    def node(name, **kwargs):
        if name == "TextEncodeQwenImage21":
            work("encode")
            return ("positive", "negative", {"samples": None})
        if name == "SamplerCustomAdvanced":
            work("sample")
            return (latent,)
        if name == "VAEDecode":
            assert all(ref() is None for ref in live_gpu_images), "previous decoded images stayed on the GPU"
            samples = kwargs["samples"]["samples"]
            assert samples.shape[0] == 1
            work("decode")
            index = int(samples[0, 0, 0, 0])
            decoded_indices.append(index)
            return (GpuImage(index),)
        return (object(),)

    def regular_sample(**kwargs):
        work("sample")
        return latent

    monkeypatch.setattr(qwen, "_call_comfy_node", node)
    monkeypatch.setattr(unicanvas.models.base, "_sample_generation_latent_default", regular_sample)
    def run():
        module._encode_qi21(object(), object(), "cat", "", {}, 1024)
        sampled = module.sample_latent(object(), "positive", "negative", latent, 7, 6, 1, "euler", "simple", 1, {})
        return module.decode_samples(object(), sampled, {})
    if failure_stage:
        with pytest.raises(RuntimeError, match=f"{failure_stage} failed"):
            run()
    else:
        images = run()
        assert images.shape == (batch_size, 2, 2, 4)
        assert decoded_indices == list(range(batch_size))
        assert np.array_equal(images[:, 0, 0, 0], np.arange(batch_size))
        assert all(ref() is None for ref in live_gpu_images)
    assert not any(state.values())
    unload.assert_not_called()


@pytest.mark.parametrize("dynamic_vram", [False, True])
@pytest.mark.parametrize("stage", ["load_models", "sample", "decode", "save_result"])
@pytest.mark.parametrize("outcome", ["success", "error", "cancel"])
def test_draw_sessions_release_runtime_state_and_reuse_cached_weights(monkeypatch, dynamic_vram, stage, outcome):
    import comfy
    import comfy.model_management as management

    class Interrupted(Exception):
        pass

    lock = threading.RLock()
    state = {"queues": [], "graphs": {}, "cast_buffers": [], "watermark": None}
    releases, seen_assets, model_cleanup_states = [], [], []
    assets = (object(), object(), object())
    load_assets = mock.Mock(return_value=assets)
    loader = types.SimpleNamespace(key="checkpoint", cache_key=lambda settings: ("test",), load_assets=load_assets)
    monkeypatch.setattr(unicanvas.loaders, "_MODEL_CACHE", {})
    monkeypatch.setattr(unicanvas.loaders, "_get_unicanvas_model_loader", lambda name: loader)
    for module in (draw, unicanvas.draw_pipeline, unicanvas.loaders):
        monkeypatch.setattr(module, "_COMFY_MODEL_OP_LOCK", lock)

    def release(name):
        assert lock._is_owned()
        releases.append(name)
        if name == "prefetch":
            state["queues"].clear()
            state["graphs"].clear()
        elif name == "cast":
            state["cast_buffers"].clear()
        else:
            state["watermark"] = None

    memory = types.ModuleType("comfy.memory_management")
    memory.aimdo_enabled = dynamic_vram
    prefetch = types.ModuleType("comfy.model_prefetch")
    prefetch.cleanup_prefetch_queues = lambda: release("prefetch")
    aimdo = types.ModuleType("comfy_aimdo")
    aimdo.model_vbar = types.ModuleType("comfy_aimdo.model_vbar")
    aimdo.model_vbar.vbars_reset_watermark_limits = lambda: release("watermark")
    for name, module in (("comfy.memory_management", memory), ("comfy.model_prefetch", prefetch),
                         ("comfy_aimdo", aimdo), ("comfy_aimdo.model_vbar", aimdo.model_vbar)):
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(comfy, "memory_management", memory, raising=False)
    monkeypatch.setattr(comfy, "model_prefetch", prefetch, raising=False)
    monkeypatch.setattr(comfy, "model_management", management, raising=False)
    monkeypatch.setattr(management, "reset_cast_buffers", lambda: release("cast"), raising=False)
    unload = mock.Mock()
    monkeypatch.setattr(management, "unload_all_models", unload, raising=False)

    def cleanup_models():
        model_cleanup_states.append(state == {"queues": [], "graphs": {}, "cast_buffers": [], "watermark": None})

    monkeypatch.setattr(management, "cleanup_models", cleanup_models, raising=False)
    monkeypatch.setattr(management, "soft_empty_cache", mock.Mock(), raising=False)
    monkeypatch.setattr(management, "InterruptProcessingException", Interrupted, raising=False)
    monkeypatch.setattr(draw, "set_interrupt", lambda value: None)
    monkeypatch.setattr(draw, "consume_draw_cancellation", lambda draw_id: False)
    monkeypatch.setattr(unicanvas.draw_pipeline, "set_interrupt", lambda value: None)
    monkeypatch.setattr(unicanvas.draw_pipeline, "_set_draw_progress", lambda *args: None)
    monkeypatch.setattr(torch_stub, "inference_mode", contextlib.nullcontext, raising=False)
    request = types.SimpleNamespace(settings={}, mode="img2img", denoise=1, draw_id="runtime-session",
                                    module=types.SimpleNamespace(validate_request=mock.Mock(), sampling_scratch_keys=()))
    monkeypatch.setattr(draw.DrawRequest, "from_payload", lambda payload: request)
    failure = {"error": RuntimeError("generation failed"), "cancel": Interrupted("stopped")}.get(outcome)
    initial_releases = 2 if outcome == "cancel" else 1

    def run_stage(name):
        if name == "load_models":
            assert state == {"queues": [], "graphs": {}, "cast_buffers": [], "watermark": None}
            seen_assets.append(unicanvas.loaders._load_generation_assets(request.settings))
            if dynamic_vram:
                state.update(queues=[object()], graphs={"worker": object()}, cast_buffers=[object()], watermark=10)
        if name == stage and failure is not None:
            raise failure
        return {"status": "ok"}

    def create_pipeline(request):
        pipeline = unicanvas.draw_pipeline.ImageDrawPipeline(request.module, request)
        for name in ("prepare_source", "check_sizes", "crop_to_mask", "load_models", "apply_loras", "enhance_prompts",
                     "encode_prompts", "prepare_mask", "prepare_inputs", "condition", "prepare_latent", "sample",
                     "decode", "fit_to_output", "save_result"):
            setattr(pipeline, name, lambda name=name: run_stage(name))
        return pipeline

    monkeypatch.setattr(draw, "_create_draw_pipeline", create_pipeline)
    if failure is not None:
        with pytest.raises(type(failure)) as caught:
            draw._run_unicanvas_draw({})
        assert caught.value is failure
        assert draw._ACTIVE_DRAW_ID is None
        assert state == {"queues": [], "graphs": {}, "cast_buffers": [], "watermark": None}
        assert releases == (["prefetch", "cast", "watermark"] * initial_releases if dynamic_vram else [])
        failure = None
    for _ in range(3):
        assert draw._run_unicanvas_draw({}) == {"status": "ok"}
        assert draw._ACTIVE_DRAW_ID is None
        assert state == {"queues": [], "graphs": {}, "cast_buffers": [], "watermark": None}
    assert all(all(value is cached for value, cached in zip(seen, assets)) for seen in seen_assets)
    assert unicanvas.loaders._MODEL_CACHE == {("test",): assets}
    load_assets.assert_called_once()
    unload.assert_not_called()
    assert model_cleanup_states == ([True] if outcome == "cancel" else [])
    release_count = len(seen_assets) + (outcome == "cancel")
    assert releases == (["prefetch", "cast", "watermark"] * release_count if dynamic_vram else [])


@pytest.mark.parametrize("stop_queued", [False, True])
def test_queued_draw_cannot_clear_or_receive_another_draw_stop(monkeypatch, stop_queued):
    first_started = threading.Event()
    queued_at_lock = threading.Event()
    finish_first = threading.Event()
    lock = threading.RLock()
    interrupted = {"value": False}
    calls, results, errors, states = [], {}, [], {}

    class ObservedLock:
        def __enter__(self):
            if threading.current_thread().name == "queued-draw":
                queued_at_lock.set()
            lock.acquire()

        def __exit__(self, *_args):
            lock.release()

    def set_interrupt(value):
        calls.append(value)
        interrupted["value"] = value

    def pipeline(request):
        def run():
            if request.draw_id == "graph":
                first_started.set()
                assert finish_first.wait(5)
            result = {"interrupted": interrupted["value"]}
            states[request.draw_id] = {"stage": "complete"}
            return result
        return types.SimpleNamespace(run=run)

    def run(draw_id):
        try:
            results[draw_id] = draw._run_unicanvas_draw({"debug_id": draw_id})
        except Exception as exc:
            errors.append(exc)

    monkeypatch.setattr(draw, "_COMFY_MODEL_OP_LOCK", ObservedLock())
    monkeypatch.setattr(draw, "set_interrupt", set_interrupt)
    monkeypatch.setattr(draw, "interrupt_types", lambda: ())
    monkeypatch.setattr(draw, "_get_draw_progress", lambda draw_id: states.get(draw_id, {"stage": "unknown"}))
    monkeypatch.setattr(draw, "_set_draw_progress", lambda draw_id, stage, *_args, **kwargs: states.__setitem__(draw_id, {"stage": stage, **kwargs}))
    monkeypatch.setattr(draw, "consume_draw_cancellation", lambda draw_id: states.get(draw_id, {}).pop("cancel_before_start", False))
    monkeypatch.setattr(draw.DrawRequest, "from_payload", lambda payload: types.SimpleNamespace(
        draw_id=payload["debug_id"], module=types.SimpleNamespace(validate_request=mock.Mock()),
    ))
    monkeypatch.setattr(draw, "_create_draw_pipeline", pipeline)
    first = threading.Thread(target=run, args=("graph",))
    second = threading.Thread(target=run, args=("http",), name="queued-draw")
    try:
        first.start()
        assert first_started.wait(5)
        second.start()
        assert queued_at_lock.wait(5)
        if stop_queued:
            assert draw.interrupt_draw("http")
            assert calls == [False]
            assert not interrupted["value"]
        assert not draw.interrupt_draw("")
        assert draw.interrupt_draw("graph")
        assert calls == [False, True]
        assert interrupted["value"]
    finally:
        finish_first.set()
        first.join(5)
        if second.ident is not None:
            second.join(5)
    assert not first.is_alive() and not second.is_alive()
    if stop_queued:
        assert len(errors) == 1 and isinstance(errors[0], draw.DrawCancelled)
        assert results == {"graph": {"interrupted": True}}
    else:
        assert not errors
        assert results == {"graph": {"interrupted": True}, "http": {"interrupted": False}}
    assert not draw.interrupt_draw("http")
    assert calls == ([False, True] if stop_queued else [False, True, False])


def test_failed_request_releases_draw_ownership(monkeypatch):
    monkeypatch.setattr(draw, "set_interrupt", mock.Mock())
    monkeypatch.setattr(draw.DrawRequest, "from_payload", mock.Mock(side_effect=ValueError("invalid payload")))
    with pytest.raises(ValueError, match="invalid payload"):
        draw._run_unicanvas_draw({"debug_id": "failed"})
    assert draw._ACTIVE_DRAW_ID is None


def test_queued_cancellation_is_consumed_so_reusing_draw_id_can_run(monkeypatch):
    progress = load_unicanvas_package("vnccs_draw_ownership_test", torch_module=torch_stub).progress
    monkeypatch.setattr(progress, "_DRAW_PROGRESS", {})
    monkeypatch.setattr(draw, "interrupt_types", lambda: ())
    monkeypatch.setattr(draw, "set_interrupt", mock.Mock())
    assert draw.interrupt_draw("reused-id")
    with pytest.raises(draw.DrawCancelled):
        draw._run_unicanvas_draw({"debug_id": "reused-id"})
    monkeypatch.setattr(draw.DrawRequest, "from_payload", lambda payload: types.SimpleNamespace(
        draw_id=payload["debug_id"], module=types.SimpleNamespace(validate_request=mock.Mock()),
    ))
    monkeypatch.setattr(draw, "_create_draw_pipeline", lambda request: types.SimpleNamespace(run=lambda: {"ran": True}))
    assert draw._run_unicanvas_draw({"debug_id": "reused-id"}) == {"ran": True}
