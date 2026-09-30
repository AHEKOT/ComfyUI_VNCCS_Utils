"""Layer tools are registries: new blend modes, panorama projections, background removers
and color transfers plug in without editing the dispatching functions."""

import json
from dataclasses import dataclass
from typing import Any

import numpy as np
import pytest
import torch
from PIL import Image

from helpers.unicanvas_images import decode_png_data_url, png_data_url
from nodes.unicanvas import color_match, remove_bg, render
from nodes.unicanvas.models import UNICANVAS_MODEL_MODULES
from nodes.unicanvas.models.base import UniCanvasModelModule

# --- blend modes -----------------------------------------------------------------------


def test_every_blend_mode_is_a_registered_function():
    assert set(render.BLEND_MODES) == set(render._UNICANVAS_BLEND_MODES)
    for name, blend in render.BLEND_MODES.items():
        assert callable(blend), name


def test_registered_blend_mode_is_used_by_the_compositor(monkeypatch):
    monkeypatch.setitem(render.BLEND_MODES, "test-invert", lambda backdrop, source: 1.0 - backdrop)
    backdrop = Image.new("RGBA", (1, 1), (200, 100, 0, 255))
    source = Image.new("RGBA", (1, 1), (10, 10, 10, 255))
    result = render._alpha_composite_with_blend(backdrop, source, "test-invert")
    assert result.getpixel((0, 0)) == (55, 155, 255, 255)


def test_unknown_blend_mode_falls_back_to_normal():
    backdrop = np.array([[[0.2, 0.2, 0.2]]])
    source = np.array([[[0.7, 0.7, 0.7]]])
    assert np.allclose(render._blend_rgb(backdrop, source, "no-such-mode"), source)


def test_register_blend_mode_helper(monkeypatch):
    monkeypatch.setattr(render, "BLEND_MODES", dict(render.BLEND_MODES))
    render.register_blend_mode("test-keep", lambda backdrop, source: backdrop)
    assert "test-keep" in render.BLEND_MODES


# --- document projections ---------------------------------------------------------------


def _state(panorama=None, width=4, height=2):
    image = Image.new("RGBA", (width, height), (30, 60, 90, 255))
    state = {
        "origin": {"x": 0, "y": 0},
        "bbox": {"x": 0, "y": 0, "width": width, "height": height},
        "layers": [{"id": "base", "type": "raster", "crop": {"x": 0, "y": 0, "width": width, "height": height}, "dataURL": png_data_url(image)}],
    }
    if panorama is not None:
        state["panorama"] = panorama
    return state


def test_equirectangular_is_a_registered_panorama_projection():
    assert "equirectangular" in render.PANORAMA_PROJECTIONS
    assert isinstance(render._document_projection({}), render.FlatDocument)


def test_unregistered_projection_is_rejected():
    with pytest.raises(ValueError, match="Unsupported UniCanvas panorama projection"):
        render._render_unicanvas_state_to_rgba(json.dumps(_state({"projection": "cubemap"})))


def test_a_new_projection_plugs_in(monkeypatch):
    class HalfHeightPanorama(render.FlatDocument):
        """A toy projection: the document is the full layer, rendered at half height."""

        def frame(self):
            return {"x": 0, "y": 0, "width": 4, "height": 1}

    monkeypatch.setitem(render.PANORAMA_PROJECTIONS, "test-half", HalfHeightPanorama)
    result = render._render_unicanvas_state_to_rgba(json.dumps(_state({"projection": "test-half"})))
    assert result.size == (4, 1)
    assert result.getpixel((0, 0)) == (30, 60, 90, 255)


# --- background removers --------------------------------------------------------------


def test_builtin_background_removers_are_registered():
    assert set(remove_bg.BACKGROUND_REMOVERS) >= {"edit", "birefnet", "rembg", "sam3"}
    assert remove_bg._resolve_background_remover("qi21").key == "edit"


def test_registered_background_remover_is_dispatched(monkeypatch):
    class HalfAlphaRemover(remove_bg.BackgroundRemover):
        key = "test-half"

        def remove(self, image, request):
            result = image.convert("RGBA")
            result.putalpha(128)
            return result

    monkeypatch.setattr(remove_bg, "BACKGROUND_REMOVERS", dict(remove_bg.BACKGROUND_REMOVERS))
    remove_bg.register_background_remover(HalfAlphaRemover())
    result = remove_bg._run_unicanvas_remove_bg({"method": "test-half", "image": png_data_url(Image.new("RGB", (3, 2)))})
    assert result["method"] == "test-half"
    assert result["edit_model"] is None
    assert decode_png_data_url(result["alpha"]).getpixel((0, 0))[3] == 128


@dataclass(frozen=True)
class _MattingFamily(UniCanvasModelModule):
    key: str = "test_matting"
    aliases: tuple[str, ...] = ()
    defaults: dict[str, Any] = None
    is_edit_model: bool = True

    def remove_background(self, image, settings=None):
        rgba = torch.zeros((image.shape[0], image.shape[1], 4))
        rgba[..., :3] = image
        rgba[..., 3] = 1.0
        return rgba


def test_edit_families_that_can_remove_backgrounds_are_offered(monkeypatch):
    assert "qwen_image21" in remove_bg._uc_remove_bg_edit_models()
    assert "minimax_h3" not in remove_bg._uc_remove_bg_edit_models()  # RGB-only video VAE
    monkeypatch.setitem(UNICANVAS_MODEL_MODULES, "test_matting", _MattingFamily())
    assert "test_matting" in remove_bg._uc_remove_bg_edit_models()
    result = remove_bg._run_unicanvas_remove_bg({"method": "edit", "edit_model": "test_matting", "image": png_data_url(Image.new("RGB", (2, 2)))})
    assert result["edit_model"] == "test_matting"
    assert decode_png_data_url(result["alpha"]).getpixel((0, 0))[3] == 255


# --- color transfers ----------------------------------------------------------------------


def test_builtin_color_transfers_are_registered():
    assert tuple(color_match.COLOR_TRANSFERS) == color_match.UC_COLOR_MATCH_METHODS


def test_registered_color_transfer_is_dispatched(monkeypatch):
    class Grey(color_match.ColorTransfer):
        key = "test-grey"

        def transfer(self, src, ref):
            return torch.full_like(src, 0.5), "grey"

    monkeypatch.setattr(color_match, "COLOR_TRANSFERS", dict(color_match.COLOR_TRANSFERS))
    color_match.register_color_transfer(Grey())
    matched, engine = color_match._color_match_transfer(torch.zeros(2, 2, 3), torch.ones(2, 2, 3), "test-grey")
    assert engine == "grey"
    assert torch.allclose(matched, torch.full((2, 2, 3), 0.5))
