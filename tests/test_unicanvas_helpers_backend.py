"""GGUF architecture hints, SAM 3 fallback and SmolVLM layer-name cleanup (no downloads)."""

from __future__ import annotations

import sys
import types

import pytest
from PIL import Image

from nodes.unicanvas import gguf_compat, segment
from nodes.unicanvas.describe_layers import clean_layer_name, layer_thumbnail


def _fake_gguf(monkeypatch):
    """A stand-in ComfyUI-GGUF package: loader + tools.convert with its detect_arch."""

    class ModelTemplate:
        arch = "invalid"
        keys_detect = []

    class ModelFlux(ModelTemplate):
        arch = "flux"
        keys_detect = [("double_blocks.0.img_attn.proj.weight",)]

    convert = types.ModuleType("FakeGGUF.tools.convert")
    convert.ModelTemplate = ModelTemplate
    convert.arch_list = [ModelFlux]

    def detect_arch(state_dict):
        for arch in convert.arch_list:
            if any(all(key in state_dict for key in keys) for keys in arch.keys_detect):
                return arch()
        raise AssertionError("Unknown model architecture!")

    convert.detect_arch = detect_arch
    loader = types.ModuleType("FakeGGUF.loader")
    loader.__package__ = "FakeGGUF"
    loader.IMG_ARCH_LIST = {"flux", "qwen_image", "wan"}
    loader.gguf_sd_loader = lambda *args, **kwargs: None
    monkeypatch.setitem(sys.modules, "FakeGGUF.loader", loader)
    monkeypatch.setitem(sys.modules, "FakeGGUF.tools.convert", convert)
    return convert


QWEN21_KEYS = {"txt_in.text_norm.weight", "modulation.1.weight", "img_in.weight", "proj_out.weight", "transformer_blocks.0.attn.to_q.weight"}


def test_auto_hint_lets_comfyui_gguf_detect_qwen_image_21(monkeypatch):
    convert = _fake_gguf(monkeypatch)
    with pytest.raises(AssertionError, match="Unknown model architecture"):
        convert.detect_arch(QWEN21_KEYS)
    with gguf_compat.gguf_architecture_hint("auto"):
        assert convert.detect_arch(QWEN21_KEYS).arch == "qwen_image"
    assert len(convert.arch_list) == 1, "the extra template is removed after the load"


def test_explicit_hint_wins_and_unknown_names_are_rejected(monkeypatch):
    convert = _fake_gguf(monkeypatch)
    with gguf_compat.gguf_architecture_hint("wan"):
        assert convert.detect_arch({"anything"}).arch == "wan"
    assert len(convert.arch_list) == 1
    with pytest.raises(ValueError, match="does not support the GGUF architecture 'bogus'"):
        with gguf_compat.gguf_architecture_hint("bogus"):
            pass
    assert gguf_compat.gguf_architectures() == ["auto", "flux", "qwen_image", "wan"]


def test_sam3_falls_back_to_sam2_without_the_sam3_code(monkeypatch):
    calls = {}
    monkeypatch.setattr(segment, "_sam3_code", lambda: None)

    def fake_load(model_key):
        calls["model"] = model_key
        raise RuntimeError("stop")

    monkeypatch.setattr(segment, "_load_sam_model", fake_load)
    image = Image.new("RGBA", (8, 8), (255, 0, 0, 255))
    from nodes.unicanvas.imaging import _encode_png_data_url

    with pytest.raises(RuntimeError, match="stop"):
        segment._run_unicanvas_segment({"model": "sam3", "image": _encode_png_data_url(image), "points": [{"x": 2, "y": 2, "label": 1}]})
    assert calls["model"] == "sam2_large"


def test_sam3_keeps_the_union_of_grounded_instances(monkeypatch):
    import torch

    class _Processor:
        def set_image(self, image):
            return {}

        def add_point_prompt(self, points, labels, state):
            assert points == [[0.25, 0.5]] and labels == [1]
            masks = torch.zeros(2, 1, 4, 8)
            masks[0, 0, :, :2] = 1
            masks[1, 0, :, 6:] = 1
            return {"masks": masks}

    monkeypatch.setattr(segment, "_load_sam3_model", lambda: (None, _Processor()))
    mask = segment._sam3_mask(Image.new("RGB", (8, 4)), [[2.0, 2.0]], [1])
    assert mask.getpixel((0, 0)) == 255 and mask.getpixel((7, 3)) == 255 and mask.getpixel((4, 1)) == 0


@pytest.mark.parametrize("raw, expected", [
    ("Blonde woman in a bath.", "Blonde Woman In A Bath"),
    ("Assistant: A night street", "Night Street"),
    ('"water pond"', "Water Pond"),
    ("", None),
    ("This picture shows a woman standing in a pond near a wall", None),
])
def test_layer_names_are_cleaned(raw, expected):
    assert clean_layer_name(raw) == expected


def test_layer_thumbnail_crops_alpha_onto_gray():
    image = Image.new("RGBA", (1000, 500), (0, 0, 0, 0))
    image.paste((255, 0, 0, 255), (100, 100, 300, 200))
    thumb = layer_thumbnail(image)
    assert thumb.mode == "RGB" and thumb.size == (200, 100)
    assert thumb.getpixel((5, 5)) == (255, 0, 0)


def test_bare_default_model_names_resolve_to_installed_subfolder_files():
    from nodes.unicanvas.paths import _resolve_model_filename

    class _FolderPaths:
        @staticmethod
        def get_filename_list(category):
            return {"vae": ["flux/ae.safetensors", r"qwen\qwen_image_2.1_vae_bf16.safetensors"], "unet": []}.get(category, [])

    fp = _FolderPaths()
    assert _resolve_model_filename(fp, "vae", "qwen_image_2.1_vae_bf16.safetensors") == r"qwen\qwen_image_2.1_vae_bf16.safetensors"
    assert _resolve_model_filename(fp, "vae", "flux/ae.safetensors") == "flux/ae.safetensors"
    assert _resolve_model_filename(fp, ("unet", "vae"), "AE.safetensors") == "flux/ae.safetensors"
    assert _resolve_model_filename(fp, "vae", "missing.safetensors") == "missing.safetensors"


def test_v3_node_outputs_come_back_as_result_tuples(monkeypatch):
    import nodes as comfy_nodes

    from nodes.unicanvas.comfy_bridge import _call_comfy_node

    class _NodeOutput:
        def __init__(self, *args):
            self.args = args
            self.block_execution = None

    class _V3Node:
        FUNCTION = "EXECUTE_NORMALIZED"

        def EXECUTE_NORMALIZED(self, **kwargs):
            return _NodeOutput("POS", "NEG", {"samples": 1})

    monkeypatch.setattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {"V3": _V3Node}, raising=False)
    assert _call_comfy_node("V3", clip="c") == ("POS", "NEG", {"samples": 1})
