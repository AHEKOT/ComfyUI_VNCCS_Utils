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

    def fail(**kwargs):
        raise error

    monkeypatch.setattr(sys.modules["nodes"], "common_ksampler", fail, raising=False)
    monkeypatch.setattr(sampling, "_call_node_method", lambda *a, **k: pytest.fail("sampling was retried"))
    with pytest.raises(type(error), match=str(error)):
        sampling._sample_generation_latent_default(
            "model", "positive", "negative", {}, 1, 4, 1.0, "euler", "normal", 1.0, {}, "cancel-test"
        )


def test_sampler_fallback_is_used_when_common_sampler_is_missing(monkeypatch):
    from nodes.unicanvas import sampling

    monkeypatch.delattr(sys.modules["nodes"], "common_ksampler", raising=False)
    monkeypatch.setattr(sampling, "_call_node_method", lambda *a, **k: ({"samples": "fallback"},))
    result = sampling._sample_generation_latent_default(
        "model", "positive", "negative", {}, 1, 4, 1.0, "euler", "normal", 1.0, {}, "fallback-test"
    )
    assert result == {"samples": "fallback"}


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
