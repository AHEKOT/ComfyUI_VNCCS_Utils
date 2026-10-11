import sys
import types

import pytest

from helpers.unicanvas_package import load_unicanvas_package

load_unicanvas_package("nodes")

from nodes.unicanvas import progress
from nodes.unicanvas.sampling import _report_comfy_sampling_progress


@pytest.mark.parametrize("error", [RuntimeError("out of memory"), type("InterruptProcessingException", (Exception,), {})("stopped")])
def test_sampler_runtime_errors_never_start_a_second_sampler(monkeypatch, error):
    from nodes.unicanvas import sampling

    calls = []
    def fail(name, **kwargs):
        calls.append(name)
        raise error

    monkeypatch.setattr(sampling, "_call_comfy_node", fail)
    with pytest.raises(type(error), match=str(error)):
        sampling._sample_generation_latent_default(
            "model", "positive", "negative", {}, 1, 4, 1.0, "euler", "normal", 1.0, {}, "cancel-test"
        )
    assert calls == ["KSampler"]


def test_sampler_always_uses_the_native_node_and_progress_hook(monkeypatch):
    from nodes.unicanvas import sampling

    monkeypatch.setattr(sys.modules["nodes"], "common_ksampler", lambda **kwargs: pytest.fail("bypassed the node lifecycle"), raising=False)
    calls = []
    monkeypatch.setattr(sampling, "_call_comfy_node", lambda name, **kwargs: calls.append((name, kwargs)) or ({"samples": "native"},))
    result = sampling._sample_generation_latent_default(
        "model", "positive", "negative", {}, 1, 4, 1.0, "euler", "normal", 1.0, {}, "fallback-test"
    )
    assert result == {"samples": "native"}
    assert calls == [("KSampler", dict(model="model", seed=1, steps=4, cfg=1.0,
                                      sampler_name="euler", scheduler="normal", positive="positive",
                                      negative="negative", latent_image={}, denoise=1.0))]


def test_inpaint_node_failure_propagates_without_manual_encode_retry(monkeypatch):
    from nodes.unicanvas import latents
    calls = []
    def fail(name, **kwargs):
        calls.append(name)
        raise MemoryError("encoding OOM")
    monkeypatch.setattr(latents, "_call_comfy_node", fail)
    with pytest.raises(MemoryError, match="encoding OOM"):
        latents._prepare_inpaint_model_conditioning("positive", "negative", "vae", "image", "mask", 4)
    assert calls == ["InpaintModelConditioning"]


def test_comfy_progress_bar_updates_reach_the_draw_progress(monkeypatch):
    seen = []
    utils = types.ModuleType("comfy.utils")
    utils.PROGRESS_BAR_HOOK = lambda *args: seen.append(args)
    monkeypatch.setitem(sys.modules, "comfy.utils", utils)
    monkeypatch.setitem(sys.modules, "comfy", types.SimpleNamespace(utils=utils))
    with _report_comfy_sampling_progress("draw-x", 4):
        utils.PROGRESS_BAR_HOOK(1, 4, None, None)
        state = progress._get_draw_progress("draw-x")
    assert (state["step"], state["steps"], state["stage"]) == (1, 4, "sampling")
    assert seen, "the original ComfyUI hook must still run"
    assert utils.PROGRESS_BAR_HOOK is not None and len(seen) == 1
