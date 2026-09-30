"""Speed and memory options shared by every UniCanvas draw (UniCanvas settings, "Performance").

- Attention: ComfyUI picks its attention kernel once at startup (Comfy Kitchen, sage, flash,
  xformers, PyTorch SDPA - launch flags and installed packages). UniCanvas samples through
  ComfyUI's own KSampler path with ComfyUI's model code, so every family already runs on that
  kernel; ``attention_backend()`` only reports which one for the debug log.
- Step cache (``step_cache``, on by default): ComfyUI's native EasyCache node - skips diffusion
  steps whose output barely changes. Families opt out through
  ``UniCanvasModelModule.supports_step_cache``.
- VAE chunking (``vae_chunking``, off by default): VAE encode/decode in tiles, so low RAM/VRAM
  machines can generate. Implemented as a proxy around the loaded VAE: every ``encode``/``decode``
  call of every family becomes ``encode_tiled``/``decode_tiled``; the cached VAE is untouched.
"""

from __future__ import annotations

import logging
from typing import Any

from .comfy_bridge import _call_comfy_node

STEP_CACHE_SETTING = "step_cache"
VAE_CHUNKING_SETTING = "vae_chunking"
STEP_CACHE_DEFAULTS = {"reuse_threshold": 0.2, "start_percent": 0.15, "end_percent": 0.95}
# Few-step (turbo / distilled) runs have nothing to skip and every step matters.
STEP_CACHE_MIN_STEPS = 10


def _flag(settings: dict[str, Any] | None, key: str, default: bool) -> bool:
    value = (settings or {}).get(key, default)
    if isinstance(value, str):
        return value.strip().lower() not in {"", "0", "false", "off", "no"}
    return bool(value)


def attention_backend() -> str:
    try:
        import comfy.ldm.modules.attention as attention

        return getattr(attention.optimized_attention, "__name__", "unknown")
    except Exception:
        return "unknown"


class ChunkedVAE:
    """A VAE whose full-image encode/decode run tiled (same results, far less peak memory)."""

    _vnccs_chunked = True

    def __init__(self, vae: Any):
        self._vae = vae

    def __getattr__(self, name: str) -> Any:
        return getattr(self._vae, name)

    def decode(self, samples, *args, **kwargs):
        try:
            return self._vae.decode_tiled(samples)
        except Exception as exc:  # a VAE without a tiled path still decodes in one go
            logging.warning("[VNCCS UniCanvas] Chunked VAE decode unavailable (%s); decoding in one piece.", exc)
            return self._vae.decode(samples, *args, **kwargs)

    def encode(self, pixels, *args, **kwargs):
        try:
            return self._vae.encode_tiled(pixels)
        except Exception as exc:
            logging.warning("[VNCCS UniCanvas] Chunked VAE encode unavailable (%s); encoding in one piece.", exc)
            return self._vae.encode(pixels, *args, **kwargs)


def apply_vae_chunking(vae: Any, settings: dict[str, Any] | None) -> Any:
    if vae is None or not _flag(settings, VAE_CHUNKING_SETTING, False) or getattr(vae, "_vnccs_chunked", False):
        return vae
    return ChunkedVAE(vae)


def performance_label(settings: dict[str, Any] | None, cached: bool, cache_note: str = "") -> str:
    """One line for the progress bar: attention kernel, step cache and VAE mode."""
    cache = "EasyCache on" if cached else f"EasyCache off{f' ({cache_note})' if cache_note else ''}"
    vae = "VAE chunked" if _flag(settings, VAE_CHUNKING_SETTING, False) else "VAE full"
    return f"attention {attention_backend().replace('attention_', '')} · {cache} · {vae}"


def step_cache_skip_reason(settings: dict[str, Any] | None, steps: int) -> str:
    if not _flag(settings, STEP_CACHE_SETTING, True):
        return "disabled"
    if int(steps or 0) < STEP_CACHE_MIN_STEPS:
        return f"{steps} steps"
    return ""


def apply_step_cache(model: Any, settings: dict[str, Any] | None, steps: int) -> Any:
    """``model`` with ComfyUI's EasyCache when the setting is on and the run is long enough."""
    if model is None or not _flag(settings, STEP_CACHE_SETTING, True) or int(steps or 0) < STEP_CACHE_MIN_STEPS:
        return model
    try:
        patched = _call_comfy_node("EasyCache", model=model, verbose=False, **STEP_CACHE_DEFAULTS)
    except Exception as exc:  # older ComfyUI without the node: run uncached
        logging.info("[VNCCS UniCanvas] EasyCache unavailable (%s); sampling without the step cache.", exc)
        return model
    if isinstance(patched, (tuple, list)):
        patched = patched[0] if patched else None
    return patched if patched is not None else model
