"""Viggle QI2.1 turbo adapter: the student's sigma schedule and unmerged LoRA application.

Follows Viggle's ComfyUI reference
(https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/blob/main/comfyui/viggle_turbo.py).
The 6-step DMD student only produces clean images on its own timesteps, and merging the
rank-128 adapter into int8 (convrot) weights re-quantizes it away, so the adapter runs as
forward hooks next to the frozen weights instead.
"""

from __future__ import annotations

import json
import math
from typing import Any

import torch


VIGGLE_TURBO_NODES = (1.0, 0.9375, 0.875, 0.75, 0.5, 0.25)
VIGGLE_TURBO_MARKER = "vnccs_qwen21_viggle_turbo"


def viggle_turbo_sigmas(latent: dict[str, Any], denoise: float = 1.0) -> torch.Tensor:
    """Shift the raw student nodes by the latent's token count; ends with sigma 0.

    ``denoise`` < 1 (img2img) keeps only the student nodes at or below it.
    """
    samples = latent["samples"]
    spatial_ratio = latent.get("downscale_ratio_spacial", 16) / 16
    tokens = round(samples.shape[-2] * spatial_ratio) * round(samples.shape[-1] * spatial_ratio)
    shift = 0.5 + 0.4 * (tokens - 256) / (8192 - 256)
    # ponytail: off-grid denoise snaps down to the next student node; interpolate if that proves too weak.
    raw = [node for node in VIGGLE_TURBO_NODES if node <= float(denoise) + 1e-6] or [max(float(denoise), 1e-3)]
    nodes = torch.tensor(raw, dtype=torch.float64)
    shifted = math.exp(shift) / (math.exp(shift) + (1 / nodes - 1))
    return torch.cat((shifted, shifted.new_zeros(1))).float()


def _lora_linear(tensor: torch.Tensor, pair) -> torch.Tensor:
    import torch.nn.functional as F  # lazy: torch-free suites load the package with a stub torch

    down, up = pair
    return F.linear(F.linear(tensor, down.to(tensor.dtype)), up.to(tensor.dtype))


def _attach_fused_mlp_hooks(mlp, gate, up, down):
    # ComfyUI fuses gate_layer/proj into gate_up and may run `out` inside a fused kernel,
    # so the adapter is added on gate_up's output and on the whole MLP's output.
    intermediate = {}

    def gate_up_hook(_module, inputs, output):
        combined = output + torch.cat((_lora_linear(inputs[0], gate), _lora_linear(inputs[0], up)), dim=-1)
        intermediate["gate_up"] = combined
        return combined

    def mlp_hook(_module, _inputs, output):
        import torch.nn.functional as F

        gate_value, up_value = intermediate.pop("gate_up").chunk(2, dim=-1)
        return output + _lora_linear(F.silu(gate_value) * up_value, down)

    return [mlp.gate_up.register_forward_hook(gate_up_hook), mlp.register_forward_hook(mlp_hook)]


def _run_with_viggle_lora(weights: dict[str, list], executor, *args, **kwargs):
    diffusion_model = executor.class_obj
    device = args[0].device
    for pair in weights.values():
        if pair[0].device != device:
            pair[0], pair[1] = pair[0].to(device), pair[1].to(device)
    hooks = []
    try:
        for name, pair in weights.items():
            parent_name, _, leaf = name.rpartition(".")
            parent = diffusion_model.get_submodule(parent_name)
            if not getattr(parent, "fused", False):
                hooks.append(diffusion_model.get_submodule(name).register_forward_hook(
                    lambda _module, inputs, output, adapter=pair: output + _lora_linear(inputs[0], adapter)
                ))
            elif leaf == "out":
                hooks.extend(_attach_fused_mlp_hooks(
                    parent, weights[parent_name + ".gate_layer"], weights[parent_name + ".proj"], pair,
                ))
        return executor(*args, **kwargs)
    finally:
        for hook in hooks:
            hook.remove()


def viggle_lora_weights(state_dict: dict[str, torch.Tensor], metadata: dict[str, Any] | None, strength: float) -> dict[str, list]:
    """Diffusers LoRA pairs keyed by transformer module name, with alpha/rank and strength folded into up."""
    adapter_metadata = json.loads((metadata or {}).get("lora_adapter_metadata", "{}") or "{}")
    scale = float(strength) * float(adapter_metadata.get("transformer.lora_alpha", 1)) / float(adapter_metadata.get("transformer.r", 1))
    weights = {}
    for key, down in state_dict.items():
        if not key.endswith(".lora_A.weight"):
            continue
        name = key.removeprefix("transformer.").removesuffix(".lora_A.weight")
        weights[name] = [down, state_dict[key.replace(".lora_A.weight", ".lora_B.weight")] * scale]
    if not weights:
        raise ValueError("[VNCCS UniCanvas] Viggle turbo LoRA contains no transformer adapter weights.")
    return weights


def apply_viggle_turbo_lora(model: Any, clip: Any, lora_name: str, strength: float):
    """``LoraRequirement.apply`` for the Viggle turbo: wrap the diffusion model, keep weights unmerged."""
    import comfy.patcher_extension
    import comfy.utils

    from ..loras import _get_lora_full_path

    state_dict, metadata = comfy.utils.load_torch_file(_get_lora_full_path(lora_name), safe_load=True, return_metadata=True)
    weights = viggle_lora_weights(state_dict, metadata, strength)
    patched = model.clone()
    patched.add_wrapper_with_key(
        comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL,
        VIGGLE_TURBO_MARKER,
        lambda executor, *args, **kwargs: _run_with_viggle_lora(weights, executor, *args, **kwargs),
    )
    # Tells sample_latent to use the student schedule.
    patched.model_options.setdefault("transformer_options", {})[VIGGLE_TURBO_MARKER] = True
    return patched, clip


def has_viggle_turbo(model: Any) -> bool:
    options = getattr(model, "model_options", None) or {}
    return bool((options.get("transformer_options") or {}).get(VIGGLE_TURBO_MARKER))
