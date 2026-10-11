"""Use ComfyUI's LoRA loader and Viggle's registered sigma node."""

from __future__ import annotations

from typing import Any

from ..comfy_bridge import _call_comfy_node


VIGGLE_TURBO_NODES = (1.0, 0.9375, 0.875, 0.75, 0.5, 0.25)
VIGGLE_TURBO_MARKER = "vnccs_qwen21_viggle_turbo"


def viggle_turbo_sigmas(latent: dict[str, Any]):
    return _call_comfy_node(
        "ViggleTurboSigmas", latent=latent, nodes=", ".join(str(value) for value in VIGGLE_TURBO_NODES),
    )[0]


def apply_viggle_turbo_lora(model: Any, clip: Any, lora_name: str, strength: float):
    # The author's unmerged hooks move all LoRA tensors to GPU outside ComfyUI's memory manager.
    patched = _call_comfy_node("LoraLoaderModelOnly", model=model, lora_name=lora_name, strength_model=strength)[0]
    patched.model_options.setdefault("transformer_options", {})[VIGGLE_TURBO_MARKER] = True
    return patched, clip


def has_viggle_turbo(model: Any) -> bool:
    options = getattr(model, "model_options", None) or {}
    return bool((options.get("transformer_options") or {}).get(VIGGLE_TURBO_MARKER))
