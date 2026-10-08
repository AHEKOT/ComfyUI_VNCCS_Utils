import sys
import types

from helpers.unicanvas_package import load_unicanvas_package

load_unicanvas_package("nodes")

from nodes.unicanvas import progress
from nodes.unicanvas.sampling import _report_comfy_sampling_progress


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
