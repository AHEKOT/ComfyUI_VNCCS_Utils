"""Draw ownership and runtime cleanup preserve cached model weights."""

import contextlib
import sys
import threading
import types
from unittest import mock

import pytest

from helpers.unicanvas_package import load_unicanvas_package


torch_stub = types.ModuleType("torch")
torch_stub.Tensor = object
unicanvas = load_unicanvas_package("vnccs_draw_ownership_test", torch_module=torch_stub)
draw = unicanvas.draw


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
