import numpy as np
import pytest
import torch
from PIL import Image

from helpers.unicanvas_images import decode_png_data_url, png_data_url
from nodes.unicanvas import color_match
from nodes.unicanvas.color_match import (
    UC_COLOR_MATCH_METHODS,
    _apply_color_match_strength,
    _color_match_transfer,
    _reinhard_lab_gpu_transfer,
    _reinhard_lab_transfer_np,
    _run_unicanvas_color_match,
    _torch_srgb_to_lab,
)

# Mid-range (in-gamut) samples keep the LAB round trip free of clipping so
# mean/std assertions stay exact.
_SRC = torch.tensor((0.2 + 0.5 * np.random.RandomState(0).rand(6, 5, 3)).astype(np.float32))
_REF = torch.tensor((0.2 + 0.5 * np.random.RandomState(1).rand(6, 5, 3)).astype(np.float32))


def test_method_list_matches_design_spec():
    assert UC_COLOR_MATCH_METHODS == (
        "local_lab",
        "mkl",
        "hm",
        "reinhard",
        "mvgd",
        "hm-mvgd-hm",
        "hm-mkl-hm",
        "reinhard_lab_gpu",
    )


@pytest.mark.parametrize("method", UC_COLOR_MATCH_METHODS)
def test_every_method_runs_on_small_tensors(monkeypatch, method):
    calls = []

    class RecordingMatcher:
        def transfer(self, src=None, ref=None, method=None):
            calls.append(method)
            return np.asarray(ref, dtype=np.uint8).copy()

    monkeypatch.setattr(color_match, "_load_color_matcher_class", lambda: RecordingMatcher)

    matched, engine = _color_match_transfer(_SRC, _REF, method)

    assert tuple(matched.shape) == tuple(_SRC.shape)
    assert float(matched.min()) >= 0.0
    assert float(matched.max()) <= 1.0
    if method in ("reinhard_lab_gpu", "local_lab"):
        assert engine == method
        assert calls == []
    else:
        assert engine == "color-matcher"
        assert calls == [method]


def test_strength_scaling_blends_toward_matched():
    src = torch.full((4, 4, 3), 0.25, dtype=torch.float32)
    matched = torch.full((4, 4, 3), 0.75, dtype=torch.float32)

    assert torch.allclose(_apply_color_match_strength(src, matched, 0.0), src)
    assert torch.allclose(_apply_color_match_strength(src, matched, 10.0), matched)
    assert torch.allclose(_apply_color_match_strength(src, matched, 5.0), torch.full((4, 4, 3), 0.5))
    # strength is clamped to 0..10
    assert torch.allclose(_apply_color_match_strength(src, matched, 25.0), matched)
    assert torch.allclose(_apply_color_match_strength(src, matched, "5"), torch.full((4, 4, 3), 0.5))


def test_missing_dependency_falls_back_to_pure_reinhard(monkeypatch):
    monkeypatch.setattr(color_match, "_load_color_matcher_class", lambda: None)

    matched, engine = _color_match_transfer(_SRC, _REF, "mkl")

    assert engine == "reinhard-fallback"
    matched_lab = _torch_srgb_to_lab(matched).numpy()
    ref_lab = _torch_srgb_to_lab(_REF).numpy()
    # Pure Reinhard matches the reference LAB mean and std.
    assert np.allclose(matched_lab.mean(axis=(0, 1)), ref_lab.mean(axis=(0, 1)), atol=1.0)
    assert np.allclose(matched_lab.std(axis=(0, 1)), ref_lab.std(axis=(0, 1)), atol=1.0)


def test_reinhard_lab_gpu_matches_pure_reinhard():
    gpu = _reinhard_lab_gpu_transfer(_SRC, _REF)
    pure = torch.from_numpy(_reinhard_lab_transfer_np(_SRC.numpy(), _REF.numpy()))

    assert torch.allclose(gpu, pure, atol=2e-2)


def test_run_color_match_preserves_alpha_and_reports_engine(monkeypatch):
    monkeypatch.setattr(color_match, "_load_color_matcher_class", lambda: None)
    target = Image.new("RGBA", (4, 4), (200, 40, 40, 128))
    reference = Image.new("RGB", (4, 4), (40, 200, 40))

    result = _run_unicanvas_color_match({
        "image": png_data_url(target),
        "reference": png_data_url(reference),
        "method": "hm",
        "strength": 10,
    })

    assert result["engine"] == "reinhard-fallback"
    assert result["method"] == "hm"
    assert result["strength"] == 10.0
    out = decode_png_data_url(result["image"])
    assert out.mode == "RGBA"
    assert out.getpixel((0, 0))[3] == 128
    # Full strength moves the target toward the green reference.
    assert out.getpixel((0, 0))[1] > out.getpixel((0, 0))[0]


def test_unknown_color_match_method_is_rejected():
    with pytest.raises(ValueError, match=r"\[VNCCS UniCanvas\] Unknown color match method"):
        _color_match_transfer(_SRC, _REF, "nope")


def test_local_lab_follows_the_reference_under_each_pixel():
    # A flat gray layer over a background that is red on the left and blue on the right:
    # a global transfer paints it one purple, the local one follows each side.
    src = torch.full((32, 64, 3), 0.5)
    ref = torch.zeros(32, 64, 3)
    ref[:, :32, 0] = 0.8
    ref[:, 32:, 2] = 0.8
    matched, engine = _color_match_transfer(src, ref, "local_lab", torch.ones(32, 64))
    assert engine == "local_lab"
    left, right = matched[16, 2], matched[16, 61]
    assert left[0] > left[2] + 0.2 and right[2] > right[0] + 0.2
