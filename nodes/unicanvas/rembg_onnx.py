"""rembg-compatible background removal without the ``rembg`` package.

Runs rembg's u2net ONNX model through onnxruntime with rembg's own pre/post-processing
(320x320 input, ImageNet normalization, min-max normalized first output as alpha). The model
is downloaded on first use into ``models/rembg`` (helper_models), so nothing has to be
installed or reloaded.
"""

from __future__ import annotations

import threading
from typing import Any

import numpy as np
from PIL import Image

from .helper_models import ensure_helper_model_file


REMBG_MODEL_KEY = "rembg_u2net"
REMBG_INPUT_SIZE = (320, 320)
REMBG_MEAN = (0.485, 0.456, 0.406)
REMBG_STD = (0.229, 0.224, 0.225)
UC_REMBG_ONNXRUNTIME_MISSING = (
    "[VNCCS UniCanvas] Remove bg – rembg needs onnxruntime (it ships with most ComfyUI installs)."
)

_SESSION_LOCK = threading.Lock()
_SESSION: dict[str, Any] = {}


def _onnx_session() -> Any:
    with _SESSION_LOCK:
        session = _SESSION.get(REMBG_MODEL_KEY)
        if session is not None:
            return session
        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise RuntimeError(UC_REMBG_ONNXRUNTIME_MISSING) from exc
        path = ensure_helper_model_file(REMBG_MODEL_KEY)
        available = set(ort.get_available_providers())
        providers = [name for name in ("CUDAExecutionProvider", "CPUExecutionProvider") if name in available] or None
        session = ort.InferenceSession(path, providers=providers)
        _SESSION[REMBG_MODEL_KEY] = session
        return session


def rembg_preprocess(image: Image.Image) -> np.ndarray:
    """rembg's normalize(): resize, scale by the max pixel, ImageNet mean/std, NCHW float32."""
    resized = np.asarray(image.convert("RGB").resize(REMBG_INPUT_SIZE, Image.Resampling.LANCZOS), dtype=np.float32)
    resized = resized / max(float(resized.max()), 1e-6)
    normalized = (resized - np.asarray(REMBG_MEAN, dtype=np.float32)) / np.asarray(REMBG_STD, dtype=np.float32)
    return normalized.transpose(2, 0, 1)[None].astype(np.float32)


def rembg_postprocess(prediction: np.ndarray, size: tuple[int, int]) -> Image.Image:
    """First output channel, min-max normalized, resized back: the alpha mask."""
    pred = np.asarray(prediction, dtype=np.float32)
    while pred.ndim > 2:
        pred = pred[0]
    low, high = float(pred.min()), float(pred.max())
    pred = (pred - low) / max(high - low, 1e-6)
    mask = Image.fromarray((pred * 255).clip(0, 255).astype(np.uint8), mode="L")
    return mask.resize(size, Image.Resampling.LANCZOS)


def remove_background_rembg(image: Image.Image) -> Image.Image:
    session = _onnx_session()
    input_name = session.get_inputs()[0].name
    outputs = session.run(None, {input_name: rembg_preprocess(image)})
    mask = rembg_postprocess(outputs[0], image.size)
    result = image.convert("RGBA")
    result.putalpha(mask)
    return result
