"""Bundled Anima ControlNet-LLLite runtime for VNCCS UniCanvas.

This is an internal adaptation of kohya-ss/ComfyUI-Anima-LLLite. UniCanvas uses
it directly so Anima inpaint control does not depend on an external custom node.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F

logger = logging.getLogger(__name__)

TARGET_ATTENTION_CLASS = "Attention"
TARGET_MLP_CLASS = "GPT2FeedForward"
LLM_ADAPTER_NAME = "llm_adapter"
ASPP_DEFAULT_DILATIONS = (1, 2, 4, 8)
ATOMIC_SPECIFIERS = ("self_attn_q_pre", "self_attn_kv_pre", "cross_attn_q_pre", "mlp_fc1_pre")
PRESETS = {
    "self_attn_q": ("self_attn_q_pre",),
    "self_attn_qkv": ("self_attn_q_pre", "self_attn_kv_pre"),
    "self_attn_qkv_cross_q": ("self_attn_q_pre", "self_attn_kv_pre", "cross_attn_q_pre"),
}


def _parse_target_layers(spec: str) -> tuple[str, ...]:
    spec = str(spec or "").strip()
    parts = PRESETS.get(spec)
    if parts is None:
        parts = tuple(part.strip() for part in spec.split(",") if part.strip())
    bad = [part for part in parts if part not in ATOMIC_SPECIFIERS]
    if bad:
        raise ValueError(f"Unknown Anima LLLite target layer(s): {bad}")
    return tuple(item for item in ATOMIC_SPECIFIERS if item in parts)


def _gn(channels: int) -> nn.GroupNorm:
    groups = 8
    while groups > 1 and channels % groups != 0:
        groups //= 2
    return nn.GroupNorm(groups, channels)


class _ResBlock(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.norm1 = _gn(channels)
        self.conv1 = nn.Conv2d(channels, channels, kernel_size=3, padding=1)
        self.norm2 = _gn(channels)
        self.conv2 = nn.Conv2d(channels, channels, kernel_size=3, padding=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = self.conv1(F.silu(self.norm1(x)))
        h = self.conv2(F.silu(self.norm2(h)))
        return x + h


class _ASPP(nn.Module):
    def __init__(self, channels: int, dilations: tuple[int, ...] = ASPP_DEFAULT_DILATIONS):
        super().__init__()
        self.branches = nn.ModuleList()
        for dilation in dilations:
            if dilation == 1:
                conv = nn.Conv2d(channels, channels, kernel_size=1)
            else:
                conv = nn.Conv2d(channels, channels, kernel_size=3, padding=dilation, dilation=dilation)
            self.branches.append(nn.Sequential(conv, _gn(channels), nn.SiLU()))
        self.global_pool = nn.AdaptiveAvgPool2d(1)
        self.global_conv = nn.Sequential(nn.Conv2d(channels, channels, kernel_size=1), _gn(channels), nn.SiLU())
        self.proj = nn.Sequential(nn.Conv2d(channels * (len(dilations) + 1), channels, kernel_size=1), _gn(channels), nn.SiLU())

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        height, width = x.shape[-2:]
        outputs = [branch(x) for branch in self.branches]
        pooled = self.global_conv(self.global_pool(x))
        outputs.append(F.interpolate(pooled, size=(height, width), mode="bilinear", align_corners=False))
        return self.proj(torch.cat(outputs, dim=1))


class _Conditioning1(nn.Module):
    def __init__(
        self,
        cond_dim: int,
        cond_emb_dim: int,
        n_resblocks: int,
        use_aspp: bool,
        aspp_dilations: tuple[int, ...],
        cond_in_channels: int,
    ):
        super().__init__()
        ch_half = cond_dim // 2
        self.conv1 = nn.Conv2d(cond_in_channels, ch_half, kernel_size=4, stride=4, padding=0)
        self.norm1 = _gn(ch_half)
        self.conv2 = nn.Conv2d(ch_half, ch_half, kernel_size=3, stride=1, padding=1)
        self.norm2 = _gn(ch_half)
        self.conv3 = nn.Conv2d(ch_half, cond_dim, kernel_size=4, stride=4, padding=0)
        self.norm3 = _gn(cond_dim)
        self.resblocks = nn.ModuleList(_ResBlock(cond_dim) for _ in range(n_resblocks))
        self.aspp = _ASPP(cond_dim, aspp_dilations) if use_aspp else None
        self.proj = nn.Conv2d(cond_dim, cond_emb_dim, kernel_size=1)
        self.out_norm = nn.LayerNorm(cond_emb_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = F.silu(self.norm1(self.conv1(x)))
        h = F.silu(self.norm2(self.conv2(h)))
        h = F.silu(self.norm3(self.conv3(h)))
        for block in self.resblocks:
            h = block(h)
        if self.aspp is not None:
            h = self.aspp(h)
        h = self.proj(h)
        batch, channels, height, width = h.shape
        h = h.view(batch, channels, height * width).permute(0, 2, 1).contiguous()
        return self.out_norm(h)


class _LLLiteModuleDiT(nn.Module):
    def __init__(self, name: str, org_module: nn.Linear, cond_emb_dim: int, mlp_dim: int, multiplier: float):
        super().__init__()
        self.lllite_name = name
        self.org_module = [org_module]
        self.multiplier = multiplier
        self.down = nn.Linear(org_module.in_features, mlp_dim)
        self.mid = nn.Linear(mlp_dim + cond_emb_dim, mlp_dim)
        self.cond_to_film = nn.Linear(cond_emb_dim, 2 * mlp_dim)
        self.up = nn.Linear(mlp_dim, org_module.in_features)
        nn.init.zeros_(self.cond_to_film.weight)
        nn.init.zeros_(self.cond_to_film.bias)
        nn.init.zeros_(self.up.weight)
        nn.init.zeros_(self.up.bias)
        self.cond_emb: torch.Tensor | None = None
        self.org_forward = None
        self.layer_idx = -1
        self._depth_embeds_ref: list[nn.Parameter] = []

    def apply_to(self) -> None:
        if self.org_forward is None:
            self.org_forward = self.org_module[0].forward
            self.org_module[0].forward = self.forward

    def restore(self) -> None:
        if self.org_forward is not None:
            self.org_module[0].forward = self.org_forward
            self.org_forward = None

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self.multiplier == 0.0 or self.cond_emb is None:
            return self.org_forward(x)

        original_shape = x.shape
        is_5d = x.dim() == 5
        if is_5d:
            batch, frames, height, width, dim = original_shape
            x = x.reshape(batch, frames * height * width, dim)

        cond = self.cond_emb
        if x.shape[0] != cond.shape[0]:
            if x.shape[0] % cond.shape[0] != 0:
                return self.org_forward(x.reshape(original_shape) if is_5d else x)
            cond = cond.repeat(x.shape[0] // cond.shape[0], 1, 1)
        if x.shape[1] != cond.shape[1]:
            return self.org_forward(x.reshape(original_shape) if is_5d else x)

        param_dtype = self.down.weight.dtype
        x_proc = x if x.dtype == param_dtype else x.to(param_dtype)
        cond = cond.to(device=x.device, dtype=param_dtype)
        if self._depth_embeds_ref:
            cond = cond + self._depth_embeds_ref[0][self.layer_idx].to(device=x.device, dtype=param_dtype)

        h = F.silu(self.down(x_proc))
        gamma, beta = self.cond_to_film(cond).chunk(2, dim=-1)
        h = self.mid(torch.cat([cond, h], dim=-1))
        h = F.silu(h * (1 + gamma) + beta)
        delta = self.up(h) * self.multiplier
        if delta.dtype != x.dtype:
            delta = delta.to(x.dtype)
        y = self.org_forward(x + delta)
        if is_5d:
            y = y.reshape(original_shape[0], original_shape[1], original_shape[2], original_shape[3], -1)
        return y


class _ControlNetLLLiteDiT(nn.Module):
    def __init__(
        self,
        dit: nn.Module,
        *,
        cond_emb_dim: int,
        mlp_dim: int,
        target_layers: str,
        multiplier: float,
        cond_dim: int,
        cond_resblocks: int,
        use_aspp: bool,
        aspp_dilations: tuple[int, ...],
        cond_in_channels: int,
        inpaint_masked_input: bool,
    ):
        super().__init__()
        atomics = _parse_target_layers(target_layers)
        self.multiplier = multiplier
        self.cond_in_channels = cond_in_channels
        self.inpaint_masked_input = inpaint_masked_input
        self.conditioning1 = _Conditioning1(
            cond_dim,
            cond_emb_dim,
            cond_resblocks,
            use_aspp=use_aspp,
            aspp_dilations=aspp_dilations,
            cond_in_channels=cond_in_channels,
        )
        self.lllite_modules = nn.ModuleList(self._create_modules(dit, cond_emb_dim, mlp_dim, atomics, multiplier))
        self.depth_embeds = nn.Parameter(torch.zeros(len(self.lllite_modules), cond_emb_dim))
        for idx, module in enumerate(self.lllite_modules):
            module.layer_idx = idx
            module._depth_embeds_ref = [self.depth_embeds]

    @staticmethod
    def _attn_atomic_match(is_self_attn: bool, child_name: str, atomics: tuple[str, ...]) -> bool:
        if "output_proj" in child_name:
            return False
        if is_self_attn:
            return (child_name == "q_proj" and "self_attn_q_pre" in atomics) or (
                child_name in {"k_proj", "v_proj"} and "self_attn_kv_pre" in atomics
            )
        return child_name == "q_proj" and "cross_attn_q_pre" in atomics

    def _create_modules(
        self,
        dit: nn.Module,
        cond_emb_dim: int,
        mlp_dim: int,
        atomics: tuple[str, ...],
        multiplier: float,
    ) -> list[_LLLiteModuleDiT]:
        modules: list[_LLLiteModuleDiT] = []
        want_mlp = "mlp_fc1_pre" in atomics
        any_attn = any(item in atomics for item in ("self_attn_q_pre", "self_attn_kv_pre", "cross_attn_q_pre"))
        for name, module in dit.named_modules():
            if LLM_ADAPTER_NAME in name:
                continue
            cls_name = module.__class__.__name__
            if any_attn and cls_name == TARGET_ATTENTION_CLASS and hasattr(module, "is_selfattn"):
                for child_name, child in module.named_children():
                    if isinstance(child, nn.Linear) and self._attn_atomic_match(bool(module.is_selfattn), child_name, atomics):
                        modules.append(_LLLiteModuleDiT(f"lllite_dit.{name}.{child_name}".replace(".", "_"), child, cond_emb_dim, mlp_dim, multiplier))
            elif want_mlp and cls_name == TARGET_MLP_CLASS:
                child = getattr(module, "layer1", None)
                if isinstance(child, nn.Linear):
                    modules.append(_LLLiteModuleDiT(f"lllite_dit.{name}.layer1".replace(".", "_"), child, cond_emb_dim, mlp_dim, multiplier))
        return modules

    def set_cond_image(self, cond_image: torch.Tensor | None) -> None:
        if cond_image is None:
            for module in self.lllite_modules:
                module.cond_emb = None
            return
        cond_emb = self.conditioning1(cond_image)
        for module in self.lllite_modules:
            module.cond_emb = cond_emb

    def set_multiplier(self, multiplier: float) -> None:
        self.multiplier = multiplier
        for module in self.lllite_modules:
            module.multiplier = multiplier

    def apply_to(self) -> None:
        for module in self.lllite_modules:
            module.apply_to()

    def restore(self) -> None:
        for module in self.lllite_modules:
            module.restore()


def _get_inner_dit(model: Any) -> nn.Module:
    inner = getattr(model, "model", None)
    dit = getattr(inner, "diffusion_model", None) if inner is not None else None
    if dit is None:
        raise RuntimeError("Anima LLLite expected a Comfy MODEL with model.diffusion_model")
    return dit


def _read_metadata(path: str) -> dict[str, str]:
    if os.path.splitext(path)[1] != ".safetensors":
        return {}
    from safetensors import safe_open

    with safe_open(path, framework="pt") as handle:
        return handle.metadata() or {}


def _load_weights(lllite: _ControlNetLLLiteDiT, path: str):
    from safetensors.torch import load_file

    weights = load_file(path) if os.path.splitext(path)[1] == ".safetensors" else torch.load(path, map_location="cpu")
    name_to_idx = {module.lllite_name: idx for idx, module in enumerate(lllite.lllite_modules)}
    converted: dict[str, torch.Tensor] = {}
    depth_slices: dict[int, torch.Tensor] = {}
    for key, value in weights.items():
        if key.startswith("lllite_conditioning1."):
            converted["conditioning1." + key[len("lllite_conditioning1."):]] = value
        elif key.endswith(".depth_embed"):
            name = key[: -len(".depth_embed")]
            if name in name_to_idx:
                depth_slices[name_to_idx[name]] = value
        else:
            head, dot, tail = key.partition(".")
            if dot and head in name_to_idx:
                converted[f"lllite_modules.{name_to_idx[head]}.{tail}"] = value
            else:
                converted[key] = value
    if depth_slices:
        converted["depth_embeds"] = torch.stack([depth_slices[idx] for idx in range(len(name_to_idx))], dim=0)
    return lllite.load_state_dict(converted, strict=False)


def _target_cond_hw(latent_h: int, latent_w: int, patch_spatial: int) -> tuple[int, int]:
    padded_h = ((latent_h + patch_spatial - 1) // patch_spatial) * patch_spatial
    padded_w = ((latent_w + patch_spatial - 1) // patch_spatial) * patch_spatial
    return padded_h * 8, padded_w * 8


def _prepare_image(image: torch.Tensor, latent_h: int, latent_w: int, device: torch.device, dtype: torch.dtype, patch_spatial: int) -> torch.Tensor:
    if image.ndim != 4 or image.shape[-1] < 3:
        raise ValueError(f"Unexpected Anima LLLite image shape: {tuple(image.shape)}")
    rgb = image[:1, :, :, :3].permute(0, 3, 1, 2).contiguous()
    target_h, target_w = _target_cond_hw(latent_h, latent_w, patch_spatial)
    if rgb.shape[-2:] != (target_h, target_w):
        rgb = F.interpolate(rgb, size=(target_h, target_w), mode="bicubic", align_corners=False).clamp(0.0, 1.0)
    return (rgb * 2.0 - 1.0).to(device=device, dtype=dtype)


def _prepare_mask(mask: torch.Tensor, latent_h: int, latent_w: int, device: torch.device, dtype: torch.dtype, patch_spatial: int) -> torch.Tensor:
    if mask.ndim == 3:
        mask = mask.unsqueeze(1)
    elif mask.ndim != 4 or mask.shape[1] != 1:
        raise ValueError(f"Unexpected Anima LLLite mask shape: {tuple(mask.shape)}")
    mask = mask[:1].float()
    target_h, target_w = _target_cond_hw(latent_h, latent_w, patch_spatial)
    if mask.shape[-2:] != (target_h, target_w):
        mask = F.interpolate(mask, size=(target_h, target_w), mode="nearest")
    return (mask >= 0.5).to(device=device, dtype=dtype)


def apply_anima_lllite_inpaint(
    model: Any,
    weights_path: str,
    image: torch.Tensor,
    mask: torch.Tensor,
    strength: float,
    start_percent: float = 0.0,
    end_percent: float = 1.0,
) -> Any:
    meta = _read_metadata(weights_path)
    cond_in_channels = int(meta.get("lllite.cond_in_channels", 4))
    if cond_in_channels != 4:
        raise ValueError(f"Anima inpaint LLLite requires 4ch weights, got cond_in_channels={cond_in_channels}: {weights_path}")
    aspp_meta = str(meta.get("lllite.aspp_dilations", ""))
    aspp_dilations = tuple(int(item) for item in aspp_meta.split(",") if item.strip()) or ASPP_DEFAULT_DILATIONS
    lllite = _ControlNetLLLiteDiT(
        _get_inner_dit(model),
        cond_emb_dim=int(meta.get("lllite.cond_emb_dim", 32)),
        mlp_dim=int(meta.get("lllite.mlp_dim", 64)),
        target_layers=str(meta.get("lllite.target_atomics", meta.get("lllite.target_layers", "self_attn_q"))),
        multiplier=float(strength),
        cond_dim=int(meta.get("lllite.cond_dim", 64)),
        cond_resblocks=int(meta.get("lllite.cond_resblocks", 1)),
        use_aspp=str(meta.get("lllite.use_aspp", "false")).lower() == "true",
        aspp_dilations=aspp_dilations,
        cond_in_channels=cond_in_channels,
        inpaint_masked_input=str(meta.get("lllite.inpaint_masked_input", "false")).lower() == "true",
    )
    _load_weights(lllite, weights_path)
    lllite.eval().requires_grad_(False)

    model_sampling = model.get_model_object("model_sampling")
    sigma_start = float(model_sampling.percent_to_sigma(float(start_percent)))
    sigma_end = float(model_sampling.percent_to_sigma(float(end_percent)))
    old_wrapper = model.model_options.get("model_function_wrapper")
    source_image = image.detach().clone()
    source_mask = mask.detach().clone()
    cache: dict[str, Any] = {"key": None, "cond": None, "device_tag": None}
    patch_spatial = int(getattr(_get_inner_dit(model), "patch_spatial", 2))
    inpaint_masked_input = bool(lllite.inpaint_masked_input)

    def call_next(apply_model, args):
        if old_wrapper is not None:
            return old_wrapper(apply_model, args)
        input_x = args["input"]
        timestep = args["timestep"]
        c = args["c"]
        return apply_model(input_x, timestep, **c)

    def wrapper(apply_model, args):
        input_x = args["input"]
        timestep = args["timestep"]
        c = args["c"]
        sigma = float(timestep.max().item())
        if not (sigma_end <= sigma <= sigma_start):
            return call_next(apply_model, args)

        latent_h, latent_w = int(input_x.shape[-2]), int(input_x.shape[-1])
        device = input_x.device
        dtype = input_x.dtype
        device_tag = (device, dtype)
        if cache["device_tag"] != device_tag:
            lllite.to(device=device, dtype=dtype)
            cache["device_tag"] = device_tag
            cache["cond"] = None

        key = (latent_h, latent_w, device, dtype)
        if cache["key"] != key or cache["cond"] is None:
            rgb = _prepare_image(source_image, latent_h, latent_w, device, dtype, patch_spatial)
            mask01 = _prepare_mask(source_mask, latent_h, latent_w, device, dtype, patch_spatial)
            if inpaint_masked_input:
                rgb = rgb * (mask01 < 0.5).to(dtype)
            mask_pm1 = mask01 * 2.0 - 1.0
            cache["cond"] = torch.cat([rgb, mask_pm1], dim=1)
            cache["key"] = key

        lllite.set_multiplier(float(strength))
        lllite.set_cond_image(cache["cond"])
        lllite.apply_to()
        try:
            return call_next(apply_model, args)
        finally:
            lllite.restore()
            lllite.set_cond_image(None)

    patched = model.clone()
    patched.set_model_unet_function_wrapper(wrapper)
    return patched
