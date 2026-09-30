import inspect
import sys
import types

import numpy as np
import pytest
import torch
from PIL import Image

from helpers.unicanvas_images import decode_png_data_url, png_data_url
from nodes.unicanvas import remove_bg
from nodes.unicanvas.models.registry import UNICANVAS_MODEL_MODULES
from nodes.unicanvas.remove_bg import (
    UC_QI21_REMOVE_BG_UNAVAILABLE,
    _run_unicanvas_remove_bg,
)

EXPECTED_QI21_MESSAGE = (
    "[VNCCS UniCanvas] Remove bg \u2013 QI2.1 requires the Qwen-Image-2.1 module (QI2.1 family)."
)


class _FakeQi21Module:
    """Contract stub for the parallel-branch Qwen-Image-2.1 module."""

    def __init__(self):
        self.received = None

    def remove_background(self, image, settings=None):
        self.received = image
        height, width = image.shape[0], image.shape[1]
        rgba = torch.zeros((height, width, 4), dtype=torch.float32)
        rgba[..., :3] = image
        rgba[..., 3] = 0.5
        return rgba


class _ModuleWithoutSubjectExtraction:
    pass


def test_qi21_contract_stub_receives_rgb_tensor(monkeypatch):
    fake = _FakeQi21Module()
    monkeypatch.setitem(UNICANVAS_MODEL_MODULES, "qwen_image21", fake)

    image = Image.new("RGB", (4, 3), (200, 100, 50))
    result = _run_unicanvas_remove_bg({"method": "qi21", "image": png_data_url(image)})

    received = fake.received
    assert isinstance(received, torch.Tensor)
    # Scaled into the edit model's 1-2 MP working range with the layer's aspect ratio.
    assert received.ndim == 3 and received.shape[-1] == 3
    assert received.shape[0] * received.shape[1] >= 900_000
    assert received.dtype == torch.float32
    assert float(received.min()) >= 0.0
    assert float(received.max()) <= 1.0
    out = decode_png_data_url(result["alpha"])
    assert out.mode == "RGBA"
    assert out.size == (4, 3)
    assert abs(out.getpixel((0, 0))[3] - 128) <= 1
    assert result["method"] == "edit"
    assert result["edit_model"] == "qwen_image21"


def test_qi21_fails_fast_without_qwen_image21_module(monkeypatch):
    # Simulate the module being absent: the route must fail fast with the exact
    # contract message instead of reaching the real QI2.1 loading path.
    monkeypatch.delitem(UNICANVAS_MODEL_MODULES, "qwen_image21", raising=False)
    with pytest.raises(RuntimeError) as excinfo:
        _run_unicanvas_remove_bg({"method": "qi21", "image": png_data_url(Image.new("RGB", (2, 2)))})

    assert str(excinfo.value) == EXPECTED_QI21_MESSAGE
    assert str(excinfo.value) == UC_QI21_REMOVE_BG_UNAVAILABLE


def test_qi21_fails_fast_without_remove_background(monkeypatch):
    monkeypatch.setitem(UNICANVAS_MODEL_MODULES, "qwen_image21", _ModuleWithoutSubjectExtraction())

    with pytest.raises(RuntimeError) as excinfo:
        _run_unicanvas_remove_bg({"method": "qi21", "image": png_data_url(Image.new("RGB", (2, 2)))})

    assert str(excinfo.value) == EXPECTED_QI21_MESSAGE


def test_birefnet_loader_resolves_with_dual_form_import(monkeypatch):
    """Exercise the REAL loader path against the real module.

    The loader must try the ComfyUI-relative import form first and fall back to
    the absolute form used under tests/conftest.py's top-level "nodes" stub;
    both forms resolve to the same auto_mask_bgr. Only leaf dependencies that
    are optional in the test venv are stubbed (cv2, folder_paths.models_dir).
    """
    monkeypatch.setitem(sys.modules, "cv2", types.ModuleType("cv2"))
    monkeypatch.setattr(sys.modules["folder_paths"], "models_dir", ".", raising=False)

    masker = remove_bg._uc_load_birefnet_masker()

    from vnccs_sam3d.processing.birefnet_mask import auto_mask_bgr

    assert callable(masker)
    assert masker is auto_mask_bgr
    source = inspect.getsource(remove_bg._uc_load_birefnet_masker)
    assert source.index("from ...vnccs_sam3d") < source.index("from vnccs_sam3d.processing.birefnet_mask")


def test_birefnet_applies_mask_as_alpha(monkeypatch):
    calls = []

    def fake_masker(img_bgr):
        calls.append(img_bgr)
        mask = np.zeros(img_bgr.shape[:2], dtype=np.uint8)
        mask[:, :2] = 1
        return mask, np.array([[0, 0, 1, 1]], dtype=np.float32)

    monkeypatch.setattr(remove_bg, "_uc_load_birefnet_masker", lambda: fake_masker)

    image = Image.new("RGB", (4, 3), (10, 20, 30))
    result = _run_unicanvas_remove_bg({"method": "birefnet", "image": png_data_url(image)})

    assert len(calls) == 1
    # auto_mask_bgr works on BGR arrays.
    assert int(calls[0][0, 0, 0]) == 30
    out = decode_png_data_url(result["alpha"])
    assert out.mode == "RGBA"
    assert out.size == (4, 3)
    assert out.getpixel((0, 0))[3] == 255
    assert out.getpixel((1, 0))[3] == 255
    assert out.getpixel((2, 0))[3] == 0
    assert out.getpixel((3, 2))[3] == 0
    assert result["method"] == "birefnet"


def test_minimax_h3_is_not_an_edit_model_for_remove_bg():
    """MiniMax H3 decodes RGB only (a video model): it cannot extract a subject with alpha."""
    assert "minimax_h3" not in remove_bg._uc_remove_bg_edit_models()
    with pytest.raises(ValueError, match=r"Unknown remove bg edit model 'minimax_h3'"):
        _run_unicanvas_remove_bg(
            {"method": "edit", "edit_model": "minimax_h3", "image": png_data_url(Image.new("RGB", (2, 2)))}
        )


def test_edit_model_works_at_one_to_two_megapixels_and_returns_the_layer_size():
    assert remove_bg.edit_working_size((768, 1344)) == (768, 1344)
    big = remove_bg.edit_working_size((4000, 3000))
    assert big[0] * big[1] <= remove_bg.EDIT_MAX_PIXELS and big[0] % 32 == 0 and big[1] % 32 == 0
    small = remove_bg.edit_working_size((200, 100))
    assert small[0] * small[1] <= remove_bg.EDIT_MIN_PIXELS and small[0] * small[1] > 900_000
    assert abs(small[0] / small[1] - 2.0) < 0.05


def test_edit_model_unknown_model_is_rejected():
    with pytest.raises(ValueError, match=r"Unknown remove bg edit model"):
        _run_unicanvas_remove_bg(
            {"method": "edit", "edit_model": "sdxl", "image": png_data_url(Image.new("RGB", (2, 2)))}
        )


def test_edit_model_without_remove_background_fails_fast(monkeypatch):
    monkeypatch.setitem(UNICANVAS_MODEL_MODULES, "qwen_image21", _ModuleWithoutSubjectExtraction())

    with pytest.raises(RuntimeError, match=r"Qwen-Image-2.1 module"):
        _run_unicanvas_remove_bg(
            {"method": "edit", "edit_model": "qwen_image21", "image": png_data_url(Image.new("RGB", (2, 2)))}
        )


def test_rembg_runs_u2net_onnx_without_the_rembg_package(monkeypatch):
    """rembg needs no pip package: u2net runs through onnxruntime with rembg's pre/post-processing."""
    import numpy as np
    from nodes.unicanvas import rembg_onnx

    seen = {}

    class _Input:
        name = "input.1"

    class _Session:
        def get_inputs(self):
            return [_Input()]

        def run(self, _outputs, feeds):
            seen["input"] = feeds["input.1"]
            pred = np.zeros((1, 1, 320, 320), dtype=np.float32)
            pred[..., :, 160:] = 1.0  # right half is the subject
            return [pred]

    monkeypatch.setitem(sys.modules, "rembg", None)
    monkeypatch.setattr(rembg_onnx, "_onnx_session", lambda: _Session())
    result = _run_unicanvas_remove_bg({"method": "rembg", "image": png_data_url(Image.new("RGB", (40, 20), (200, 10, 10)))})
    assert seen["input"].shape == (1, 3, 320, 320) and seen["input"].dtype == np.float32
    out = decode_png_data_url(result["alpha"])
    assert out.size == (40, 20)
    assert out.getpixel((2, 10))[3] < 20 and out.getpixel((37, 10))[3] > 235
    assert result["method"] == "rembg"


def test_sam3_reuses_the_segment_route(monkeypatch):
    calls = []

    def fake_segment(payload):
        calls.append(payload)
        return {
            "mask": png_data_url(Image.new("RGBA", (4, 3), (255, 255, 255, 128))),
        }

    monkeypatch.setattr(remove_bg, "_run_unicanvas_segment", fake_segment)

    image = Image.new("RGB", (4, 3), (10, 20, 30))
    result = _run_unicanvas_remove_bg({"method": "sam3", "image": png_data_url(image)})

    assert len(calls) == 1
    points = calls[0]["points"]
    assert points[0]["label"] == 1
    assert [point["label"] for point in points[1:]] == [0, 0, 0, 0]
    out = decode_png_data_url(result["alpha"])
    assert out.mode == "RGBA"
    assert result["method"] == "sam3"


def test_unknown_remove_bg_method_is_rejected():
    with pytest.raises(ValueError, match=r"\[VNCCS UniCanvas\] Unknown remove bg method"):
        _run_unicanvas_remove_bg({"method": "magic", "image": png_data_url(Image.new("RGB", (2, 2)))})


def test_edit_model_receives_the_popover_settings_with_a_fresh_seed(monkeypatch):
    received = []

    class _Module:
        def remove_background(self, image, settings=None):
            received.append(settings)
            rgba = torch.zeros((image.shape[0], image.shape[1], 4), dtype=torch.float32)
            rgba[..., 3] = 1.0
            return rgba

    monkeypatch.setitem(UNICANVAS_MODEL_MODULES, "qwen_image21", _Module())
    image = Image.new("RGB", (4, 3), (10, 20, 30))
    payload = {
        "method": "edit",
        "edit_model": "qwen_image21",
        "image": png_data_url(image),
        "edit_settings": {
            "model_loader": "gguf", "gguf_model_name": "h3.gguf", "gguf_arch": "auto",
            "clip_name": "clip.safetensors", "vae_name": "vae.safetensors",
            "steps": "12", "cfg": 2.5, "scheduler": "beta", "sampler_name": "euler_a",
            "lora_name": "turbo/qi21-turbo.safetensors", "lora_strength": 0.8,
            "seed": 7, "evil": "ignored", "steps_bad": 9999, "prompt": "Cut out the girl",
        },
    }
    _run_unicanvas_remove_bg(payload)
    _run_unicanvas_remove_bg(payload)
    first, second = received
    assert first["model_loader"] == "gguf" and first["gguf_model_name"] == "h3.gguf"
    assert first["steps"] == 12 and first["cfg"] == 2.5 and first["scheduler"] == "beta"
    assert first["sampler_name"] == "euler_a"
    assert first["lora_stack"] == [{"name": "turbo/qi21-turbo.safetensors", "strength": 0.8}]
    assert first["prompt"] == "Cut out the girl"
    none = remove_bg._uc_edit_remove_bg_settings({"lora_name": ""})
    assert none["lora_stack"] == [], "an explicit None pick disables the family turbo LoRA"
    assert "lora_stack" not in remove_bg._uc_edit_remove_bg_settings({})
    assert "evil" not in first and "steps_bad" not in first
    assert isinstance(first["seed"], int) and first["seed"] != 7
    assert 0 <= second["seed"] < 2**32
