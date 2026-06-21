"""VNCCS UniCanvas - in-node canvas editor with direct modular draw actions."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import gc
import io
import json
import inspect
import queue
import shutil
import threading
from typing import Any
import math
import os
import ntpath
import time
import tempfile
import re
from dataclasses import dataclass

import numpy as np
import torch
from PIL import Image, ImageFilter


_DRAW_LOCK = asyncio.Lock()
_MODEL_CACHE_LOCK = threading.Lock()
_COMFY_MODEL_OP_LOCK = threading.RLock()
_MODEL_CACHE_MAX_ENTRIES = 1
_MODEL_CACHE: dict[Any, tuple[Any, Any, Any]] = {}
_LORA_CACHE: dict[str, Any] = {}
_MODEL_PATCH_CACHE: dict[str, Any] = {}
_SAM_CACHE: dict[str, tuple[Any, Any, Any]] = {}
_DRAW_PROGRESS: dict[str, dict[str, Any]] = {}
_DRAW_PROGRESS_LOCK = threading.Lock()
_COMFY_PROGRESS_PATCH_LOCK = threading.Lock()
_COMFY_PROGRESS_PATCHED = False
_COMFY_PROGRESS_LOCAL = threading.local()
_PRESET_DOWNLOAD_STATUS: dict[str, dict[str, Any]] = {}
_PRESET_DOWNLOAD_QUEUE: queue.Queue[tuple[str, dict[str, Any]]] = queue.Queue()
_PRESET_DOWNLOAD_TIMEOUT = (10, 60)
_PRESET_MODEL_FILE_EXTENSIONS = {".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin"}
_PRESET_MIN_MODEL_FILE_SIZE = 1024
_PRESET_DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024 * 1024
_MAX_UPLOAD_BYTES = 48 * 1024 * 1024
_MAX_PIXELS = 4096 * 4096
_UNICANVAS_STATE_CACHE_DIR = os.path.join(tempfile.gettempdir(), "vnccs_unicanvas_state_cache")
_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]+")
OUTPAINT_PROMPT_SUFFIX = "outpaint black part of image"
ANIMA_LLLITE_REPO_ID = "kohya-ss/Anima-LLLite"
ANIMA_LLLITE_INPAINT_FILENAME = "anima-lllite-inpainting-v2.safetensors"
Z_IMAGE_FUN_CONTROLNET_REPO_ID = "alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1"
Z_IMAGE_FUN_CONTROLNET_FILENAME = "Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors"
SDXL_TURBO_LORA_NAME = "DMD2/dmd2_sdxl_4step_lora_fp16.safetensors"
ANIMA_TURBO_LORA_NAME = "anima/anima-turbo-lora-v0.1.safetensors"
QWEN_IMAGE_EDIT_TURBO_LORA_NAME = "qwen/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
SAM_MODEL_IDS = {
    "sam2_large": "facebook/sam2.1-hiera-large",
    "sam1_huge": "facebook/sam-vit-huge",
}

ILLUSTRIOUS_DEFAULTS = {
    "generation_mode": "illustrious",
    "ckpt_name": "",
    "sampler": "euler",
    "sampler_name": "euler",
    "scheduler": "normal",
    "steps": 20,
    "cfg": 8.0,
}

ANIMA_DEFAULTS = {
    "generation_mode": "anima",
    "diffusion_model_name": "",
    "clip_name": "qwen_3_06b_base.safetensors",
    "vae_name": "qwen_image_vae.safetensors",
    "clip_type": "stable_diffusion",
    "sampler": "euler",
    "sampler_name": "euler",
    "scheduler": "simple",
    "steps": 30,
    "cfg": 4.5,
    "turbo_enabled": False,
    "dmd_lora_name": ANIMA_TURBO_LORA_NAME,
    "dmd_lora_strength": 1.0,
    "anima_lllite_inpaint": True,
    "anima_lllite_name": ANIMA_LLLITE_INPAINT_FILENAME,
    "anima_lllite_strength": 1.0,
    "lora_stack": [],
}

FLUX_KLEIN_DEFAULTS = {
    "generation_mode": "flux_klein",
    "model_loader": "diffusion_model",
    "diffusion_model_name": "flux-2-klein-9b-fp8.safetensors",
    "clip_name": "qwen_3_8b_fp8mixed.safetensors",
    "vae_name": "flux2-vae.safetensors",
    "clip_type": "flux2",
    "sampler": "euler",
    "sampler_name": "euler",
    "scheduler": "simple",
    "steps": 4,
    "cfg": 1.0,
}

Z_IMAGE_DEFAULTS = {
    "generation_mode": "z_image",
    "model_loader": "diffusion_model",
    "diffusion_model_name": "z_image_turbo_bf16.safetensors",
    "clip_name": "qwen_3_4b.safetensors",
    "vae_name": "ae.safetensors",
    "clip_type": "lumina2",
    "sampler": "res_multistep",
    "sampler_name": "res_multistep",
    "scheduler": "simple",
    "steps": 8,
    "cfg": 1.0,
    "aura_flow_shift": 3.0,
    "fun_controlnet_patch_name": Z_IMAGE_FUN_CONTROLNET_FILENAME,
    "fun_controlnet_strength": 1.0,
    "fun_controlnet_inpaint": True,
}

QWEN_IMAGE_EDIT_DEFAULTS = {
    "generation_mode": "qwen_image_edit",
    "model_loader": "gguf",
    "gguf_model_name": "qwen-image-edit-2511-Q5_0.gguf",
    "clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors",
    "vae_name": "qwen_image_vae.safetensors",
    "clip_type": "qwen_image",
    "sampler": "euler",
    "sampler_name": "euler",
    "scheduler": "simple",
    "steps": 4,
    "cfg": 1.0,
    "denoise": 1.0,
    "qwen_lora_name": "",
    "qwen_lora_strength": 0.0,
    "qwen_2511": True,
    "qwen_target_vl_size": 384,
    "qwen_instruction": (
        "Describe the key features of the input image (color, shape, size, texture, objects, background), "
        "then explain how the user's text instruction should alter or modify the image. Generate a new image "
        "that meets the user's requirements while maintaining consistency with the original input where appropriate."
    ),
    "qwen_inpaint_prompt": "[!!!IMPORTANT!!!] Inpaint mode: draw only inside the black masked area. ",
}


@dataclass(frozen=True)
class UniCanvasNodeStep:
    """One declarative Comfy node invocation inside a UniCanvas pipeline.

    Inputs may reference values in the pipeline context with "$name". The node is
    called through ComfyUI's NODE_CLASS_MAPPINGS and its FUNCTION metadata, so
    contributors do not need to know Python method names for most core nodes.
    """

    node: str | tuple[str, ...]
    inputs: dict[str, Any]
    output: str
    methods: tuple[str, ...] = ()
    output_index: int = 0
    optional: bool = False
    description: str = ""


@dataclass(frozen=True)
class UniCanvasPipeline:
    """Declarative inference graph for model modules with non-standard nodes."""

    reference: tuple[UniCanvasNodeStep, ...] = ()
    sample: tuple[UniCanvasNodeStep, ...] = ()
    decode: tuple[UniCanvasNodeStep, ...] = ()


def _pipeline_ref_path(context: dict[str, Any], path: str) -> Any:
    value: Any = context
    for part in path.split("."):
        if isinstance(value, dict):
            value = value.get(part)
        else:
            value = getattr(value, part)
    return value


def _resolve_pipeline_value(value: Any, context: dict[str, Any]) -> Any:
    if isinstance(value, str) and value.startswith("$"):
        return _pipeline_ref_path(context, value[1:])
    if isinstance(value, dict):
        return {key: _resolve_pipeline_value(item, context) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_resolve_pipeline_value(item, context) for item in value)
    return value


def _select_pipeline_output(result: Any, output_index: int) -> Any:
    if _is_comfy_node_output(result):
        result = _unwrap_comfy_node_output(result)
    if isinstance(result, tuple):
        if not result:
            return None
        return result[min(max(int(output_index), 0), len(result) - 1)]
    return result


def _run_pipeline_step(step: UniCanvasNodeStep, context: dict[str, Any], draw_id: str) -> Any:
    node_names = list(step.node if isinstance(step.node, tuple) else (step.node,))
    inputs = {key: _resolve_pipeline_value(value, context) for key, value in step.inputs.items()}
    result = _call_node_method(node_names, list(step.methods), **inputs)
    selected = _select_pipeline_output(result, step.output_index)
    if selected is None and not step.optional:
        label = step.description or step.node
        raise RuntimeError(f"{label} is unavailable or returned no output")
    context[step.output] = selected
    if step.description:
        _uc_log(draw_id, f"pipeline step {step.description}", {"output": step.output, "type": type(selected).__name__})
    return selected


def _run_pipeline_steps(steps: tuple[UniCanvasNodeStep, ...], context: dict[str, Any], draw_id: str) -> dict[str, Any]:
    for step in steps:
        _run_pipeline_step(step, context, draw_id)
    return context


FLUX_KLEIN_PIPELINE = UniCanvasPipeline(
    reference=(
        UniCanvasNodeStep(
            node="VAEEncode",
            methods=("encode",),
            inputs={"pixels": "$image_tensor", "vae": "$vae"},
            output="reference_latent",
            description="VAEEncode reference image",
        ),
        UniCanvasNodeStep(
            node="ConditioningZeroOut",
            methods=("zero_out",),
            inputs={"conditioning": "$positive"},
            output="negative_base",
            description="zero negative conditioning",
        ),
        UniCanvasNodeStep(
            node="ReferenceLatent",
            methods=("append", "reference", "encode"),
            inputs={"conditioning": "$positive", "latent": "$reference_latent"},
            output="positive",
            description="attach positive reference latent",
        ),
        UniCanvasNodeStep(
            node="ReferenceLatent",
            methods=("append", "reference", "encode"),
            inputs={"conditioning": "$negative_base", "latent": "$reference_latent"},
            output="negative",
            description="attach negative reference latent",
        ),
    ),
    sample=(
        UniCanvasNodeStep(
            node="RandomNoise",
            methods=("get_noise", "generate"),
            inputs={"noise_seed": "$seed", "seed": "$seed"},
            output="noise",
            description="noise",
        ),
        UniCanvasNodeStep(
            node="KSamplerSelect",
            methods=("get_sampler", "sample"),
            inputs={"sampler_name": "$sampler_name"},
            output="sampler",
            description="sampler",
        ),
        UniCanvasNodeStep(
            node="Flux2Scheduler",
            methods=("get_sigmas", "schedule"),
            inputs={"steps": "$steps", "width": "$width", "height": "$height"},
            output="sigmas",
            description="Flux2 sigmas",
        ),
        UniCanvasNodeStep(
            node="CFGGuider",
            methods=("get_guider", "append"),
            inputs={"model": "$model", "positive": "$positive", "negative": "$negative", "cfg": "$cfg"},
            output="guider",
            description="CFG guider",
        ),
        UniCanvasNodeStep(
            node="SamplerCustomAdvanced",
            methods=("sample",),
            inputs={
                "noise": "$noise",
                "guider": "$guider",
                "sampler": "$sampler",
                "sigmas": "$sigmas",
                "latent_image": "$latent",
            },
            output="latent",
            description="advanced sampler",
        ),
    ),
)


@dataclass(frozen=True)
class UniCanvasModelModule:
    """Backend adapter for one UniCanvas model family.

    The frontend cannot rely on graph connections for model objects because the
    draw action runs inside the widget before a workflow execution starts. Each
    model family therefore owns its own loader contract and generation quirks.
    """

    key: str
    aliases: tuple[str, ...]
    defaults: dict[str, Any]
    is_edit_model: bool = False

    def normalize_key(self, generation_mode: str) -> bool:
        return generation_mode == self.key or generation_mode in self.aliases

    def uses_edit_masked_latents(self, mode: str) -> bool:
        return mode in {"inpaint", "outpaint"}

    def uses_differential_diffusion(self, mode: str) -> bool:
        return mode in {"inpaint", "outpaint"}

    def outpaint_prompt_suffix(self) -> str:
        return OUTPAINT_PROMPT_SUFFIX if self.is_edit_model else ""

    def prepare_outpaint_reference_image(self, source_rgba: Image.Image, mask_image: Image.Image, draw_id: str) -> Image.Image:
        if self.is_edit_model:
            return _make_edit_outpaint_reference_rgb(source_rgba, draw_id)
        return _sample_transparent_outpaint_rgb(source_rgba, draw_id)

    def apply_loras(self, model: Any, clip: Any, gen_settings: dict[str, Any]):
        lora_stack = gen_settings.get("lora_stack") or []
        if isinstance(lora_stack, list):
            for item in lora_stack:
                if not isinstance(item, dict):
                    continue
                lora_name = str(item.get("name") or item.get("lora_name") or "")
                strength = float(item.get("strength", item.get("model_strength", 1.0)))
                clip_strength = item.get("clip_strength", None)
                model, clip = _apply_lora_cached(
                    model,
                    clip,
                    lora_name,
                    strength,
                    None if clip_strength is None else float(clip_strength),
                )
        return model, clip

    def encode_prompt(self, clip: Any, text: str, _gen_settings: dict[str, Any]):
        tokens = clip.tokenize(text or "")
        cond, pooled = clip.encode_from_tokens(tokens, return_pooled=True)
        return [[cond, {"pooled_output": pooled}]]

    def validate_conditioning(self, _positive: Any, _negative: Any, _gen_settings: dict[str, Any]) -> None:
        return None

    def clone_assets(self, model: Any, clip: Any) -> tuple[Any, Any]:
        return _clone_model_clip(model, clip)

    def create_empty_latent(self, width: int, height: int, _gen_settings: dict[str, Any], draw_id: str = "unknown") -> dict[str, Any]:
        import nodes

        batch_size = max(1, int((_gen_settings or {}).get("batch_size", 1) or 1))
        encoded = nodes.EmptyLatentImage().generate(width, height, batch_size)[0]
        _uc_log(draw_id, "created empty SD latent", _latent_debug(encoded))
        return encoded

    def decode_samples(self, vae: Any, samples: Any, _gen_settings: dict[str, Any]):
        latent_samples = _unwrap_latent_samples(samples)
        tile_size = 256 if str((_gen_settings or {}).get("generation_mode") or "").lower() in {"z_image", "z-image", "zimage", "z_image_turbo"} else 512
        overlap = min(64, max(32, tile_size // 4))
        _uc_log(str((_gen_settings or {}).get("_draw_id") or "unknown"), "VAE tiled decode", {"tile_size": tile_size, "overlap": overlap})
        return vae.decode_tiled(latent_samples, tile_x=tile_size, tile_y=tile_size, overlap=overlap)

    def prepare_reference_conditioning(
        self,
        positive: Any,
        negative: Any,
        vae: Any,
        image_tensor: torch.Tensor,
        gen_settings: dict[str, Any],
        draw_id: str = "unknown",
    ) -> tuple[Any, Any]:
        return positive, negative

    def sample_latent(
        self,
        model: Any,
        positive: Any,
        negative: Any,
        latent: Any,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        denoise: float,
        gen_settings: dict[str, Any],
        draw_id: str = "unknown",
        width: int | None = None,
        height: int | None = None,
    ):
        return _sample_generation_latent_default(
            model=model,
            positive=positive,
            negative=negative,
            latent=latent,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            denoise=denoise,
            gen_settings=gen_settings,
            draw_id=draw_id,
        )


@dataclass(frozen=True)
class SDXLUniCanvasModule(UniCanvasModelModule):
    def apply_loras(self, model: Any, clip: Any, gen_settings: dict[str, Any]):
        lora_name = str(gen_settings.get("dmd_lora_name") or "")
        if gen_settings.get("turbo_enabled") and _lora_name_matches(lora_name, SDXL_TURBO_LORA_NAME):
            model, clip = _apply_lora_cached(
                model,
                clip,
                lora_name,
                float(gen_settings.get("dmd_lora_strength", 1.0)),
            )
        return super().apply_loras(model, clip, gen_settings)


@dataclass(frozen=True)
class AnimaUniCanvasModule(UniCanvasModelModule):
    def uses_differential_diffusion(self, mode: str) -> bool:
        return False

    def apply_loras(self, model: Any, clip: Any, gen_settings: dict[str, Any]):
        lora_name = str(gen_settings.get("dmd_lora_name") or "")
        if gen_settings.get("turbo_enabled") and _lora_name_matches(lora_name, ANIMA_TURBO_LORA_NAME):
            model, clip = _apply_lora_cached(
                model,
                clip,
                lora_name,
                float(gen_settings.get("dmd_lora_strength", 1.0)),
                0.0,
            )
        return super().apply_loras(model, clip, gen_settings)

    def encode_prompt(self, clip: Any, text: str, _gen_settings: dict[str, Any]):
        encoded = _call_node_method(["CLIPTextEncode"], ["encode"], clip=clip, text=text or "")
        if isinstance(encoded, tuple) and encoded:
            return encoded[0]
        if encoded is not None:
            return encoded
        return super().encode_prompt(clip, text, _gen_settings)

    def validate_conditioning(self, positive: Any, negative: Any, gen_settings: dict[str, Any]) -> None:
        _validate_anima_conditioning(positive, negative, str(gen_settings.get("clip_name") or ""))

    def create_empty_latent(self, width: int, height: int, _gen_settings: dict[str, Any], draw_id: str = "unknown") -> dict[str, Any]:
        import comfy.model_management

        batch_size = max(1, int((_gen_settings or {}).get("batch_size", 1) or 1))
        latent = torch.zeros(
            [batch_size, 16, max(1, int(height) // 8), max(1, int(width) // 8)],
            device=comfy.model_management.intermediate_device(),
            dtype=comfy.model_management.intermediate_dtype(),
        )
        encoded = {"samples": latent}
        _uc_log(draw_id, "created empty Anima latent", _latent_debug(encoded))
        return encoded

    def sample_latent(
        self,
        model: Any,
        positive: Any,
        negative: Any,
        latent: Any,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        denoise: float,
        gen_settings: dict[str, Any],
        draw_id: str = "unknown",
        width: int | None = None,
        height: int | None = None,
    ):
        draw_mode = str(gen_settings.get("draw_mode") or "")
        if draw_mode in {"inpaint", "outpaint"} and bool(gen_settings.get("anima_lllite_inpaint", True)):
            image = gen_settings.get("_anima_lllite_image")
            mask = gen_settings.get("_anima_lllite_mask")
            if torch.is_tensor(image) and torch.is_tensor(mask):
                model = self._apply_inpaint_lllite(model, image, mask, gen_settings, draw_id)
                denoise = 1.0
            else:
                _uc_log(
                    draw_id,
                    "Anima LLLite inpaint skipped",
                    {
                        "reason": "missing image or mask tensor",
                        "image": _tensor_debug(image) if torch.is_tensor(image) else None,
                        "mask": _tensor_debug(mask) if torch.is_tensor(mask) else None,
                    },
                )
        return super().sample_latent(
            model=model,
            positive=positive,
            negative=negative,
            latent=latent,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            denoise=denoise,
            gen_settings=gen_settings,
            draw_id=draw_id,
            width=width,
            height=height,
        )

    def _apply_inpaint_lllite(
        self,
        model: Any,
        image: torch.Tensor,
        mask: torch.Tensor,
        gen_settings: dict[str, Any],
        draw_id: str,
    ) -> Any:
        try:
            from .anima_lllite_internal import apply_anima_lllite_inpaint
        except ImportError:
            from anima_lllite_internal import apply_anima_lllite_inpaint

        lllite_name = str(gen_settings.get("anima_lllite_name") or ANIMA_LLLITE_INPAINT_FILENAME).strip()
        weights_path = _ensure_anima_lllite_model(lllite_name, draw_id)
        strength = float(gen_settings.get("anima_lllite_strength", 1.0))
        patched = apply_anima_lllite_inpaint(
            model=model,
            weights_path=weights_path,
            image=image,
            mask=mask,
            strength=strength,
        )
        _uc_log(
            draw_id,
            "Anima LLLite inpaint applied",
            {
                "weights": os.path.basename(weights_path),
                "strength": strength,
                "image": _tensor_debug(image),
                "mask": _tensor_debug(mask),
            },
        )
        return patched

    def decode_samples(self, vae: Any, samples: Any, _gen_settings: dict[str, Any]):
        latent_payload = samples if isinstance(samples, dict) else {"samples": samples}
        latent_tensor = _unwrap_latent_samples(latent_payload)
        decode_payload = {"samples": latent_tensor}
        decoded = _call_node_method(
            ["VAEDecodeTiled"],
            ["decode"],
            samples=decode_payload,
            vae=vae,
            tile_size=512,
            tile_x=512,
            tile_y=512,
            overlap=64,
            temporal_size=64,
            temporal_overlap=8,
        )
        if isinstance(decoded, tuple) and decoded:
            return decoded[0]
        if decoded is not None:
            return decoded
        return vae.decode_tiled(latent_tensor, tile_x=512, tile_y=512, overlap=64)


@dataclass(frozen=True)
class FluxKleinUniCanvasModule(UniCanvasModelModule):
    pipeline: UniCanvasPipeline = FLUX_KLEIN_PIPELINE

    def encode_prompt(self, clip: Any, text: str, _gen_settings: dict[str, Any]):
        encoded = _call_node_method(["CLIPTextEncode"], ["encode"], clip=clip, text=text or "")
        if isinstance(encoded, tuple) and encoded:
            return encoded[0]
        if encoded is not None:
            return encoded
        return super().encode_prompt(clip, text, _gen_settings)

    def create_empty_latent(self, width: int, height: int, _gen_settings: dict[str, Any], draw_id: str = "unknown") -> dict[str, Any]:
        batch_size = max(1, int((_gen_settings or {}).get("batch_size", 1) or 1))
        encoded = _call_node_method(
            ["EmptyFlux2LatentImage"],
            ["generate"],
            width=width,
            height=height,
            batch_size=batch_size,
        )
        if isinstance(encoded, tuple) and encoded:
            _uc_log(draw_id, "created empty Flux2 latent", _latent_debug(encoded[0]))
            return encoded[0]
        if isinstance(encoded, dict):
            _uc_log(draw_id, "created empty Flux2 latent", _latent_debug(encoded))
            return encoded
        import comfy.model_management

        latent = torch.zeros(
            [batch_size, 128, max(1, int(height) // 16), max(1, int(width) // 16)],
            device=comfy.model_management.intermediate_device(),
        )
        encoded = {"samples": latent}
        _uc_log(
            draw_id,
            "created fallback empty Flux2 latent",
            {
                **_latent_debug(encoded),
                "reason": "EmptyFlux2LatentImage did not return a latent through direct node call",
            },
        )
        return encoded

    def prepare_reference_conditioning(
        self,
        positive: Any,
        negative: Any,
        vae: Any,
        image_tensor: torch.Tensor,
        gen_settings: dict[str, Any],
        draw_id: str = "unknown",
    ) -> tuple[Any, Any]:
        context = {
            "positive": positive,
            "negative": negative,
            "vae": vae,
            "image_tensor": image_tensor,
        }
        _run_pipeline_steps(self.pipeline.reference, context, draw_id)
        _uc_log(
            draw_id,
            "Flux Klein reference conditioning prepared",
            {
                "positive_reference": _latent_debug(context.get("reference_latent")),
                "positive": _conditioning_debug(context.get("positive")),
                "negative": _conditioning_debug(context.get("negative")),
            },
        )
        return context["positive"], context["negative"]

    def sample_latent(
        self,
        model: Any,
        positive: Any,
        negative: Any,
        latent: Any,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        denoise: float,
        gen_settings: dict[str, Any],
        draw_id: str = "unknown",
        width: int | None = None,
        height: int | None = None,
    ):
        _ensure_direct_sampling_prompt_context()
        width = int(width or 1024)
        height = int(height or 1024)
        _set_draw_progress(draw_id, "sampling", 0.35, 0, steps, f"Sampling 0/{steps}")
        context = {
            "model": model,
            "positive": positive,
            "negative": negative,
            "latent": latent,
            "seed": seed,
            "steps": steps,
            "cfg": cfg,
            "sampler_name": sampler_name,
            "width": width,
            "height": height,
        }
        with _suppress_direct_sampling_comfy_progress():
            _run_pipeline_steps(self.pipeline.sample, context, draw_id)
        _set_draw_progress(draw_id, "sampling", 0.85, steps, steps, f"Sampling {steps}/{steps}")
        _uc_log(draw_id, "SamplerCustomAdvanced output", _latent_debug(context.get("latent")))
        return context["latent"]

    def decode_samples(self, vae: Any, samples: Any, _gen_settings: dict[str, Any]):
        return super().decode_samples(vae, samples, _gen_settings)


@dataclass(frozen=True)
class QwenImageEditUniCanvasModule(UniCanvasModelModule):
    def clone_assets(self, model: Any, clip: Any) -> tuple[Any, Any]:
        return model, clip

    def apply_loras(self, model: Any, clip: Any, gen_settings: dict[str, Any]):
        lora_name = str(gen_settings.get("qwen_lora_name") or "")
        if _lora_name_matches(lora_name, QWEN_IMAGE_EDIT_TURBO_LORA_NAME) and float(gen_settings.get("qwen_lora_strength", 0.0) or 0.0) > 0:
            model, clip = _apply_lora_cached(
                model,
                clip,
                lora_name,
                float(gen_settings.get("qwen_lora_strength", 1.0)),
                0.0,
            )
        return super().apply_loras(model, clip, gen_settings)

    def encode_prompt(self, clip: Any, text: str, gen_settings: dict[str, Any]):
        image_tensor = gen_settings.get("_qwen_edit_reference_image")
        if torch.is_tensor(image_tensor):
            positive, negative, _latent = self._encode_qwen_edit(
                clip=clip,
                vae=gen_settings.get("_qwen_edit_vae"),
                image_tensor=image_tensor,
                image_tensors=None,
                prompt=text,
                gen_settings=gen_settings,
                draw_id=str(gen_settings.get("_draw_id") or "unknown"),
            )
            gen_settings["_qwen_edit_positive"] = positive
            gen_settings["_qwen_edit_negative"] = negative
            gen_settings["_qwen_edit_latent"] = _latent
            return positive
        encoded = _call_node_method(["CLIPTextEncode"], ["encode"], clip=clip, text=text or "")
        if isinstance(encoded, tuple) and encoded:
            return encoded[0]
        if encoded is not None:
            return encoded
        return super().encode_prompt(clip, text, gen_settings)

    def prepare_reference_conditioning(
        self,
        positive: Any,
        negative: Any,
        vae: Any,
        image_tensor: torch.Tensor,
        gen_settings: dict[str, Any],
        draw_id: str = "unknown",
    ) -> tuple[Any, Any]:
        reference = image_tensor
        vl_references = [image_tensor]
        draw_mode = str(gen_settings.get("draw_mode") or "")
        mask = gen_settings.get("_qwen_edit_mask")
        if draw_mode in {"inpaint", "outpaint"} and torch.is_tensor(mask):
            pixel_mask = torch.nn.functional.interpolate(
                mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1])).float(),
                size=(reference.shape[1], reference.shape[2]),
                mode="bilinear",
            ).squeeze(1).unsqueeze(-1).clamp(0, 1)
            reference = reference.clone()
            reference = reference * (1.0 - (pixel_mask > 0.01).to(reference.dtype))
            vl_references = [reference, image_tensor]
            _uc_log(
                draw_id,
                "Qwen Image Edit multi-image masked references prepared",
                {
                    "mode": draw_mode,
                    "first_masked_reference": _tensor_debug(reference),
                    "second_unmasked_reference": _tensor_debug(image_tensor),
                    "mask": _tensor_debug(mask),
                    "reason": "Qwen Image Edit 2511 gets masked image as image 1 and original image as image 2",
                },
            )

        positive, negative, latent = self._encode_qwen_edit(
            clip=gen_settings.get("_qwen_edit_clip"),
            vae=vae,
            image_tensor=reference,
            image_tensors=vl_references,
            prompt=str(gen_settings.get("positive") or ""),
            gen_settings=gen_settings,
            draw_id=draw_id,
        )
        gen_settings["_qwen_edit_positive"] = positive
        gen_settings["_qwen_edit_negative"] = negative
        gen_settings["_qwen_edit_latent"] = latent
        _uc_log(
            draw_id,
            "Qwen Image Edit conditioning prepared",
            {
                "positive": _conditioning_debug(positive),
                "negative": _conditioning_debug(negative),
                "latent": _latent_debug(latent),
            },
        )
        return positive, negative

    def create_empty_latent(self, width: int, height: int, _gen_settings: dict[str, Any], draw_id: str = "unknown") -> dict[str, Any]:
        import comfy.model_management

        batch_size = max(1, int((_gen_settings or {}).get("batch_size", 1) or 1))
        latent = torch.zeros(
            [batch_size, 16, max(1, int(height) // 8), max(1, int(width) // 8)],
            device=comfy.model_management.intermediate_device(),
            dtype=comfy.model_management.intermediate_dtype(),
        )
        encoded = {"samples": latent}
        _uc_log(draw_id, "created fallback empty Qwen Image latent", _latent_debug(encoded))
        return encoded

    def sample_latent(
        self,
        model: Any,
        positive: Any,
        negative: Any,
        latent: Any,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        denoise: float,
        gen_settings: dict[str, Any],
        draw_id: str = "unknown",
        width: int | None = None,
        height: int | None = None,
    ):
        qwen_latent = gen_settings.get("_qwen_edit_latent")
        if isinstance(qwen_latent, dict):
            latent = qwen_latent
        draw_mode = str(gen_settings.get("draw_mode") or "")
        if draw_mode in {"inpaint", "outpaint"} and float(denoise) < 1.0:
            _uc_log(
                draw_id,
                "Qwen Image Edit masked denoise forced",
                {
                    "reason": "masked reference contains black pixels; partial denoise preserves the black mask",
                    "from": float(denoise),
                    "to": 1.0,
                    "mode": draw_mode,
                },
            )
            denoise = 1.0
        return _sample_generation_latent_default(
            model=model,
            positive=positive,
            negative=negative,
            latent=latent,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            denoise=denoise,
            gen_settings=gen_settings,
            draw_id=draw_id,
        )

    def _encode_qwen_edit(
        self,
        clip: Any,
        vae: Any,
        image_tensor: torch.Tensor,
        image_tensors: list[torch.Tensor] | None,
        prompt: str,
        gen_settings: dict[str, Any],
        draw_id: str = "unknown",
    ) -> tuple[Any, Any, dict[str, Any]]:
        if clip is None:
            raise ValueError("Qwen Image Edit requires a Qwen Image CLIP/VL encoder")
        if vae is None:
            raise ValueError("Qwen Image Edit requires a Qwen Image VAE")
        import comfy.utils
        import node_helpers

        target_size = int(gen_settings.get("qwen_target_size", image_tensor.shape[1]))
        target_vl_size = int(gen_settings.get("qwen_target_vl_size", 384))
        upscale_method = str(gen_settings.get("qwen_upscale_method") or "lanczos")
        crop_method = str(gen_settings.get("qwen_crop_method") or "center")
        instruction = str(gen_settings.get("qwen_instruction") or QWEN_IMAGE_EDIT_DEFAULTS["qwen_instruction"])
        draw_mode = str(gen_settings.get("draw_mode") or "")
        base_prompt = str(prompt or "")
        if draw_mode in {"inpaint", "outpaint"}:
            base_prompt = str(gen_settings.get("qwen_inpaint_prompt") or QWEN_IMAGE_EDIT_DEFAULTS["qwen_inpaint_prompt"]) + base_prompt

        reference_tensors = [tensor for tensor in (image_tensors or [image_tensor]) if torch.is_tensor(tensor)]
        if not reference_tensors:
            reference_tensors = [image_tensor]

        vl_images = []
        vl_sizes = []
        ref_latents = []
        ref_sizes = []
        for reference_tensor in reference_tensors:
            prepared = self._prepare_qwen_encoder_image(reference_tensor)
            ref_image = self._process_qwen_encoder_image(prepared, target_size, upscale_method, crop_method)
            ref_latents.append(vae.encode(ref_image[:, :, :, :3]))
            ref_sizes.append([int(ref_image.shape[2]), int(ref_image.shape[1])])

            vl_image = self._process_qwen_encoder_image(prepared, target_vl_size, upscale_method, crop_method)
            vl_images.append(vl_image)
            vl_sizes.append([int(vl_image.shape[2]), int(vl_image.shape[1])])

        template_prefix = "<|im_start|>system\n"
        template_suffix = "<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n"
        llama_template = template_prefix + instruction + template_suffix
        image_prompt = "".join(
            f"Picture {index + 1}: <|vision_start|><|image_pad|><|vision_end|>"
            for index in range(len(vl_images))
        )
        tokens = clip.tokenize(image_prompt + base_prompt, images=vl_images, llama_template=llama_template)
        conditioning = clip.encode_from_tokens_scheduled(tokens)
        if bool(gen_settings.get("qwen_2511", True)):
            method = "index_timestep_zero"
            conditioning = node_helpers.conditioning_set_values(conditioning, {"reference_latents_method": method})
        positive = conditioning
        if ref_latents:
            weights = [float(gen_settings.get(f"qwen_ref_weight_{index + 1}", 1.0) or 0.0) for index in range(len(ref_latents))]
            weighted_ref_latents = [(weight ** 2) * latent for weight, latent in zip(weights, ref_latents) if weight > 0]
            if weighted_ref_latents:
                positive = node_helpers.conditioning_set_values(positive, {"reference_latents": weighted_ref_latents}, append=True)
        negative = [(torch.zeros_like(cond[0]), cond[1]) for cond in positive]
        latent_index = max(1, int(gen_settings.get("qwen_latent_image_index", 1) or 1))
        ref_latent = ref_latents[min(latent_index - 1, len(ref_latents) - 1)] if ref_latents else torch.zeros(1, 4, 128, 128)
        latent = {"samples": ref_latent}
        _uc_log(
            draw_id,
            "Qwen Image Edit encode",
            {
                "prompt_len": len(base_prompt),
                "target_size": target_size,
                "vl_sizes": vl_sizes,
                "ref_sizes": ref_sizes,
                "image_count": len(vl_images),
                "reference_latent": _tensor_debug(ref_latent),
            },
        )
        return positive, negative, latent

    def _prepare_qwen_encoder_image(self, image: torch.Tensor) -> torch.Tensor:
        if image.ndim == 3:
            image = image.unsqueeze(0)
        if not torch.is_floating_point(image):
            image = image.float()
        if image.numel() and image.detach().max() > 1.5:
            image = image / 255.0
        image = image.clamp(0.0, 1.0)
        channels = int(image.shape[-1])
        if channels == 1:
            return image.repeat(1, 1, 1, 3)
        if channels < 4:
            return image
        rgb = image[..., :3]
        alpha = image[..., 3:4].clamp(0.0, 1.0)
        if bool((alpha < 0.999).any().item()):
            background = torch.ones((1, 1, 1, 3), dtype=rgb.dtype, device=rgb.device)
            rgb = rgb * alpha + background * (1.0 - alpha)
        return rgb.clamp(0.0, 1.0)

    def _process_qwen_encoder_image(self, image: torch.Tensor, target_size: int, upscale_method: str, crop_method: str) -> torch.Tensor:
        import comfy.utils

        samples = image.movedim(-1, 1)
        current_total = max(1, int(samples.shape[3] * samples.shape[2]))
        scale_by = math.sqrt(float(target_size * target_size) / current_total)
        if crop_method == "pad":
            crop = "center"
            scaled_width = round(samples.shape[3] * scale_by)
            scaled_height = round(samples.shape[2] * scale_by)
            canvas_width = max(8, math.ceil(scaled_width / 8.0) * 8)
            canvas_height = max(8, math.ceil(scaled_height / 8.0) * 8)
            canvas = torch.zeros(
                (samples.shape[0], samples.shape[1], canvas_height, canvas_width),
                dtype=samples.dtype,
                device=samples.device,
            )
            resized = comfy.utils.common_upscale(samples, scaled_width, scaled_height, upscale_method, crop)
            canvas[:, :, : resized.shape[2], : resized.shape[3]] = resized
            processed = canvas
        else:
            width = max(8, round(samples.shape[3] * scale_by / 8.0) * 8)
            height = max(8, round(samples.shape[2] * scale_by / 8.0) * 8)
            processed = comfy.utils.common_upscale(samples, width, height, upscale_method, crop_method)
        return processed.movedim(1, -1)

    def decode_samples(self, vae: Any, samples: Any, _gen_settings: dict[str, Any]):
        return super().decode_samples(vae, samples, _gen_settings)


@dataclass(frozen=True)
class ZImageUniCanvasModule(UniCanvasModelModule):
    def clone_assets(self, model: Any, clip: Any) -> tuple[Any, Any]:
        return _clone_model_clip(model, clip)

    def uses_edit_masked_latents(self, mode: str) -> bool:
        return mode == "outpaint"

    def is_turbo_conditioning_mode(self, gen_settings: dict[str, Any]) -> tuple[bool, str]:
        model_names = (
            str(gen_settings.get("diffusion_model_name") or ""),
            str(gen_settings.get("gguf_model_name") or ""),
        )
        if any("turbo" in name.lower() for name in model_names if name):
            return True, "model name contains turbo"
        try:
            if abs(float(gen_settings.get("cfg", 0.0)) - 1.0) < 1e-6:
                return True, "cfg is 1"
        except Exception:
            pass
        return False, "non-turbo model and cfg is not 1"

    def encode_prompt(self, clip: Any, text: str, _gen_settings: dict[str, Any]):
        encoded = _call_node_method(["CLIPTextEncode"], ["encode"], clip=clip, text=text or "")
        if isinstance(encoded, tuple) and encoded:
            return encoded[0]
        if encoded is not None:
            return encoded
        return super().encode_prompt(clip, text, _gen_settings)

    def prepare_reference_conditioning(
        self,
        positive: Any,
        negative: Any,
        vae: Any,
        image_tensor: torch.Tensor,
        gen_settings: dict[str, Any],
        draw_id: str = "unknown",
    ) -> tuple[Any, Any]:
        draw_mode = str(gen_settings.get("draw_mode") or "")
        if draw_mode in {"inpaint", "outpaint"}:
            zero_negative = _call_node_method(
                ["ConditioningZeroOut"],
                ["zero_out"],
                conditioning=positive,
            )
            if zero_negative is not None:
                negative = zero_negative
            _uc_log(
                draw_id,
                "Z-image masked mode uses Fun ControlNet workflow conditioning",
                {
                    "mode": draw_mode,
                    "positive": _conditioning_debug(positive),
                    "negative": _conditioning_debug(negative),
                },
            )
            return positive, negative

        use_turbo_conditioning, reason = self.is_turbo_conditioning_mode(gen_settings)
        if not use_turbo_conditioning:
            _uc_log(
                draw_id,
                "Z-image full negative prompt conditioning kept",
                {
                    "reason": reason,
                    "negative": _conditioning_debug(negative),
                },
            )
            return positive, negative

        _uc_log(draw_id, "Z-image turbo positive conditioning before zero negative", _conditioning_debug(positive))
        zero_negative = _call_node_method(
            ["ConditioningZeroOut"],
            ["zero_out"],
            conditioning=positive,
        )
        if zero_negative is not None:
            negative = zero_negative
            _uc_log(
                draw_id,
                "Z-image turbo negative conditioning zeroed",
                {
                    "reason": reason,
                    "negative": _conditioning_debug(negative),
                },
            )
        return positive, negative

    def create_empty_latent(self, width: int, height: int, _gen_settings: dict[str, Any], draw_id: str = "unknown") -> dict[str, Any]:
        batch_size = max(1, int((_gen_settings or {}).get("batch_size", 1) or 1))
        encoded = _call_node_method(
            ["EmptySD3LatentImage"],
            ["generate"],
            width=width,
            height=height,
            batch_size=batch_size,
        )
        if isinstance(encoded, tuple) and encoded:
            _uc_log(draw_id, "created empty Z-image/SD3 latent", _latent_debug(encoded[0]))
            return encoded[0]
        if isinstance(encoded, dict):
            _uc_log(draw_id, "created empty Z-image/SD3 latent", _latent_debug(encoded))
            return encoded
        import comfy.model_management

        latent = torch.zeros(
            [batch_size, 16, max(1, int(height) // 8), max(1, int(width) // 8)],
            device=comfy.model_management.intermediate_device(),
            dtype=comfy.model_management.intermediate_dtype(),
        )
        encoded = {"samples": latent}
        _uc_log(
            draw_id,
            "created fallback empty Z-image/SD3 latent",
            {
                **_latent_debug(encoded),
                "reason": "EmptySD3LatentImage did not return a latent through direct node call",
            },
        )
        return encoded

    def sample_latent(
        self,
        model: Any,
        positive: Any,
        negative: Any,
        latent: Any,
        seed: int,
        steps: int,
        cfg: float,
        sampler_name: str,
        scheduler: str,
        denoise: float,
        gen_settings: dict[str, Any],
        draw_id: str = "unknown",
        width: int | None = None,
        height: int | None = None,
    ):
        model = self._apply_fun_controlnet_if_needed(model, gen_settings, draw_id)
        model = self._apply_aura_flow_sampling(model, gen_settings, draw_id)
        if str(gen_settings.get("draw_mode") or "") in {"inpaint", "outpaint"} and bool(gen_settings.get("fun_controlnet_inpaint", True)):
            denoise = 1.0
        return super().sample_latent(
            model=model,
            positive=positive,
            negative=negative,
            latent=latent,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            denoise=denoise,
            gen_settings=gen_settings,
            draw_id=draw_id,
            width=width,
            height=height,
        )

    def _apply_fun_controlnet_if_needed(self, model: Any, gen_settings: dict[str, Any], draw_id: str) -> Any:
        draw_mode = str(gen_settings.get("draw_mode") or "")
        if draw_mode not in {"inpaint", "outpaint"}:
            return model
        if not bool(gen_settings.get("fun_controlnet_inpaint", True)):
            _uc_log(draw_id, "Z-image Fun ControlNet skipped", {"reason": "fun_controlnet_inpaint is disabled"})
            return model
        patch_name = str(gen_settings.get("fun_controlnet_patch_name") or "").strip()
        if not patch_name:
            _uc_log(draw_id, "Z-image Fun ControlNet skipped", {"reason": "no fun_controlnet_patch_name"})
            return model
        inpaint_image = gen_settings.get("_z_image_fun_controlnet_image")
        mask = gen_settings.get("_z_image_fun_controlnet_mask")
        vae = gen_settings.get("_z_image_fun_controlnet_vae")
        if not torch.is_tensor(inpaint_image) or not torch.is_tensor(mask) or vae is None:
            _uc_log(
                draw_id,
                "Z-image Fun ControlNet skipped",
                {
                    "reason": "missing inpaint image, mask, or VAE",
                    "image": _tensor_debug(inpaint_image) if torch.is_tensor(inpaint_image) else None,
                    "mask": _tensor_debug(mask) if torch.is_tensor(mask) else None,
                    "has_vae": vae is not None,
                },
            )
            return model

        model_patch = gen_settings.pop("_z_image_fun_controlnet_patch_model", None)
        if model_patch is None:
            _uc_log(
                draw_id,
                "Z-image Fun ControlNet patch loaded late",
                {
                    "patch": patch_name,
                    "reason": "preloaded patch was unavailable; using compatibility fallback",
                },
            )
            patch_name = _ensure_z_image_fun_controlnet_model(patch_name, draw_id)
            model_patch = _load_model_patch(patch_name)
        patched = _call_node_method(
            ["ZImageFunControlnet"],
            ["diffsynth_controlnet"],
            model=model,
            model_patch=model_patch,
            vae=vae,
            strength=float(gen_settings.get("fun_controlnet_strength", 1.0)),
            inpaint_image=inpaint_image,
            mask=mask,
        )
        model_patch = None
        if patched is None:
            raise RuntimeError("ZImageFunControlnet returned no patched model")
        _uc_log(
            draw_id,
            "Z-image Fun ControlNet applied",
            {
                "mode": draw_mode,
                "patch": patch_name,
                "strength": float(gen_settings.get("fun_controlnet_strength", 1.0)),
                "image": _tensor_debug(inpaint_image),
                "mask": _tensor_debug(mask),
            },
        )
        return patched

    def _apply_aura_flow_sampling(self, model: Any, gen_settings: dict[str, Any], draw_id: str) -> Any:
        shift = float(gen_settings.get("aura_flow_shift", 3.0))
        patched = _call_node_method(
            ["ModelSamplingAuraFlow"],
            ["patch_aura"],
            model=model,
            shift=shift,
        )
        if patched is None:
            _uc_log(draw_id, "Z-image ModelSamplingAuraFlow patch skipped", {"reason": "node returned no model", "shift": shift})
            return model
        _uc_log(draw_id, "Z-image ModelSamplingAuraFlow applied", {"shift": shift})
        return patched

    def decode_samples(self, vae: Any, samples: Any, _gen_settings: dict[str, Any]):
        latent_payload = samples if isinstance(samples, dict) else {"samples": samples}
        return super().decode_samples(vae, latent_payload, _gen_settings)


@dataclass(frozen=True)
class UniCanvasModelLoader:
    key: str
    aliases: tuple[str, ...]
    forced_mode: str | None = None

    def cache_key(self, gen_settings: dict[str, Any]) -> tuple[Any, ...]:
        raise NotImplementedError

    def load_assets(self, gen_settings: dict[str, Any]):
        raise NotImplementedError


@dataclass(frozen=True)
class CheckpointUniCanvasLoader(UniCanvasModelLoader):
    def cache_key(self, gen_settings: dict[str, Any]) -> tuple[Any, ...]:
        return (self.key, str(gen_settings.get("ckpt_name") or ""))

    def load_assets(self, gen_settings: dict[str, Any]):
        import comfy.sd
        import folder_paths

        ckpt_name = str(gen_settings.get("ckpt_name") or "")
        if not ckpt_name:
            raise ValueError("Checkpoint is required")
        ckpt_path = _get_full_path_agnostic(folder_paths, "checkpoints", ckpt_name, require_exists=True)
        if not ckpt_path:
            raise ValueError(f"Checkpoint path not found for '{ckpt_name}'")
        out = comfy.sd.load_checkpoint_guess_config(
            ckpt_path,
            output_vae=True,
            output_clip=True,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )
        assets = out[:3]
        if any(item is None for item in assets):
            raise ValueError(f"Failed to load checkpoint assets from '{ckpt_name}'")
        return assets


@dataclass(frozen=True)
class DiffusionModelUniCanvasLoader(UniCanvasModelLoader):
    def cache_key(self, gen_settings: dict[str, Any]) -> tuple[Any, ...]:
        return (
            self.key,
            gen_settings.get("diffusion_model_name", ""),
            gen_settings.get("clip_name", ""),
            gen_settings.get("vae_name", ""),
            gen_settings.get("clip_type", ""),
        )

    def load_assets(self, gen_settings: dict[str, Any]):
        import comfy.sd
        import folder_paths

        diffusion_model_name = gen_settings.get("diffusion_model_name")
        clip_name = gen_settings.get("clip_name")
        vae_name = gen_settings.get("vae_name")
        clip_type_name = str(gen_settings.get("clip_type", "stable_diffusion") or "stable_diffusion").lower()

        if not diffusion_model_name:
            raise ValueError("No Diffusion Model selected for UniCanvas")
        if not clip_name:
            raise ValueError("No CLIP selected for UniCanvas")
        if not vae_name:
            raise ValueError("No VAE selected for UniCanvas")

        model = _call_loader_node(
            ["UNETLoader", "Load Diffusion Model"],
            ["load_unet", "load_model", "load_diffusion_model"],
            unet_name=diffusion_model_name,
            model_name=diffusion_model_name,
            diffusion_model_name=diffusion_model_name,
            weight_dtype="default",
        )
        if model is None and hasattr(comfy.sd, "load_diffusion_model"):
            diffusion_model_path = _get_full_path_agnostic(folder_paths, "diffusion_models", diffusion_model_name)
            if diffusion_model_path:
                model = comfy.sd.load_diffusion_model(diffusion_model_path)

        clip = _call_loader_node(
            ["CLIPLoader", "Load CLIP"],
            ["load_clip", "load_model"],
            clip_name=clip_name,
            model_name=clip_name,
            type=clip_type_name,
            device="default",
        )
        if clip is None and hasattr(comfy.sd, "load_clip"):
            clip_path = _get_full_path_agnostic(folder_paths, "text_encoders", clip_name)
            if clip_path:
                clip_type = getattr(comfy.sd.CLIPType, clip_type_name.upper(), None)
                if clip_type is None:
                    raise ValueError(
                        f"ComfyUI CLIPType.{clip_type_name.upper()} is not available. "
                        "ANIMA expects CLIPLoader type 'stable_diffusion'."
                    )
                clip = comfy.sd.load_clip(
                    ckpt_paths=[clip_path],
                    embedding_directory=folder_paths.get_folder_paths("embeddings"),
                    clip_type=clip_type,
                )

        vae = _call_loader_node(
            ["VAELoader", "Load VAE"],
            ["load_vae", "load_model"],
            vae_name=vae_name,
            model_name=vae_name,
        )
        if vae is None and hasattr(comfy.sd, "load_vae"):
            vae_path = _get_full_path_agnostic(folder_paths, "vae", vae_name)
            if vae_path:
                vae = comfy.sd.load_vae(vae_path)

        if model is None:
            raise ValueError(f"Failed to load Diffusion Model '{diffusion_model_name}'")
        if clip is None:
            raise ValueError(f"Failed to load CLIP '{clip_name}'")
        if vae is None:
            raise ValueError(f"Failed to load VAE '{vae_name}'")
        return model, clip, vae


@dataclass(frozen=True)
class GGUFUniCanvasLoader(DiffusionModelUniCanvasLoader):
    def cache_key(self, gen_settings: dict[str, Any]) -> tuple[Any, ...]:
        return (
            self.key,
            gen_settings.get("gguf_model_name", ""),
            gen_settings.get("clip_name", ""),
            gen_settings.get("vae_name", ""),
            gen_settings.get("clip_type", ""),
        )

    def load_assets(self, gen_settings: dict[str, Any]):
        import comfy.sd
        import folder_paths

        gguf_model_name = gen_settings.get("gguf_model_name")
        clip_name = gen_settings.get("clip_name")
        vae_name = gen_settings.get("vae_name")
        clip_type_name = str(gen_settings.get("clip_type", "stable_diffusion") or "stable_diffusion").lower()

        if not gguf_model_name:
            raise ValueError("No GGUF model selected for UniCanvas")
        if not clip_name:
            raise ValueError("No CLIP selected for UniCanvas")
        if not vae_name:
            raise ValueError("No VAE selected for UniCanvas")

        model = _call_loader_node(
            ["UnetLoaderGGUF", "UNETLoaderGGUF", "GGUF Loader"],
            ["load_unet", "load_model", "load_diffusion_model"],
            unet_name=gguf_model_name,
            model_name=gguf_model_name,
            diffusion_model_name=gguf_model_name,
            weight_dtype="default",
        )
        if model is None:
            raise ValueError(
                "Failed to load GGUF model. Install/enable a GGUF loader node such as ComfyUI-GGUF "
                f"and select a valid GGUF model; current model is '{gguf_model_name}'."
            )

        clip = _call_loader_node(
            ["CLIPLoader", "Load CLIP"],
            ["load_clip", "load_model"],
            clip_name=clip_name,
            model_name=clip_name,
            type=clip_type_name,
            device="default",
        )
        if clip is None and hasattr(comfy.sd, "load_clip"):
            clip_path = _get_full_path_agnostic(folder_paths, "text_encoders", clip_name)
            if clip_path:
                clip_type = getattr(comfy.sd.CLIPType, clip_type_name.upper(), None)
                if clip_type is None:
                    raise ValueError(f"ComfyUI CLIPType.{clip_type_name.upper()} is not available.")
                clip = comfy.sd.load_clip(
                    ckpt_paths=[clip_path],
                    embedding_directory=folder_paths.get_folder_paths("embeddings"),
                    clip_type=clip_type,
                )

        vae = _call_loader_node(
            ["VAELoader", "Load VAE"],
            ["load_vae", "load_model"],
            vae_name=vae_name,
            model_name=vae_name,
        )
        if vae is None and hasattr(comfy.sd, "load_vae"):
            vae_path = _get_full_path_agnostic(folder_paths, "vae", vae_name)
            if vae_path:
                vae = comfy.sd.load_vae(vae_path)

        if clip is None:
            raise ValueError(f"Failed to load CLIP '{clip_name}'")
        if vae is None:
            raise ValueError(f"Failed to load VAE '{vae_name}'")
        return model, clip, vae


UNICANVAS_MODEL_MODULES: dict[str, UniCanvasModelModule] = {}
UNICANVAS_MODEL_LOADERS: dict[str, UniCanvasModelLoader] = {}


def _register_unicanvas_model_module(module: UniCanvasModelModule) -> None:
    UNICANVAS_MODEL_MODULES[module.key] = module
    for alias in module.aliases:
        UNICANVAS_MODEL_MODULES[alias] = module


_register_unicanvas_model_module(SDXLUniCanvasModule("sdxl", ("illustrious",), ILLUSTRIOUS_DEFAULTS))
_register_unicanvas_model_module(AnimaUniCanvasModule("anima", (), ANIMA_DEFAULTS))
_register_unicanvas_model_module(
    FluxKleinUniCanvasModule("flux_klein", ("flux-klein", "klein"), FLUX_KLEIN_DEFAULTS, is_edit_model=True)
)
_register_unicanvas_model_module(
    QwenImageEditUniCanvasModule(
        "qwen_image_edit",
        ("qwen-edit", "qwen_edit", "qwen-image-edit", "qwen_image_edit_2511"),
        QWEN_IMAGE_EDIT_DEFAULTS,
        is_edit_model=True,
    )
)
_register_unicanvas_model_module(ZImageUniCanvasModule("z_image", ("z-image", "zimage", "z_image_turbo"), Z_IMAGE_DEFAULTS))


def _register_unicanvas_model_loader(loader: UniCanvasModelLoader) -> None:
    UNICANVAS_MODEL_LOADERS[loader.key] = loader
    for alias in loader.aliases:
        UNICANVAS_MODEL_LOADERS[alias] = loader


_register_unicanvas_model_loader(CheckpointUniCanvasLoader("checkpoint", ("ckpt",), forced_mode="sdxl"))
_register_unicanvas_model_loader(DiffusionModelUniCanvasLoader("diffusion_model", ("unet", "diffusion"), forced_mode=None))
_register_unicanvas_model_loader(GGUFUniCanvasLoader("gguf", (), forced_mode=None))


def _get_unicanvas_model_module(generation_mode: str | None) -> UniCanvasModelModule:
    key = str(generation_mode or "illustrious").lower()
    module = UNICANVAS_MODEL_MODULES.get(key)
    if module is None:
        supported = sorted({module.key for module in UNICANVAS_MODEL_MODULES.values()})
        raise ValueError(f"Unsupported UniCanvas model mode '{key}'. Supported modes: {', '.join(supported)}")
    return module


def _get_unicanvas_model_loader(loader_type: str | None) -> UniCanvasModelLoader:
    key = str(loader_type or "checkpoint").lower()
    loader = UNICANVAS_MODEL_LOADERS.get(key)
    if loader is None:
        supported = sorted({loader.key for loader in UNICANVAS_MODEL_LOADERS.values()})
        raise ValueError(f"Unsupported UniCanvas model loader '{key}'. Supported loaders: {', '.join(supported)}")
    return loader


def _uc_log(draw_id: str, message: str, data: dict[str, Any] | None = None) -> None:
    if data is None:
        print(f"[VNCCS UniCanvas][draw:{draw_id}] {message}", flush=True)
        return
    try:
        payload = json.dumps(data, ensure_ascii=False, default=str, sort_keys=True)
    except Exception:
        payload = str(data)
    print(f"[VNCCS UniCanvas][draw:{draw_id}] {message}: {payload}", flush=True)


def _set_draw_progress(draw_id: str, stage: str, progress: float, step: int = 0, steps: int = 0, message: str | None = None) -> None:
    payload = {
        "draw_id": draw_id,
        "stage": stage,
        "progress": max(0.0, min(1.0, float(progress))),
        "step": max(0, int(step or 0)),
        "steps": max(0, int(steps or 0)),
        "message": message or stage,
        "updated_at": time.time(),
    }
    with _DRAW_PROGRESS_LOCK:
        _DRAW_PROGRESS[draw_id] = payload


def _get_draw_progress(draw_id: str) -> dict[str, Any]:
    with _DRAW_PROGRESS_LOCK:
        return dict(_DRAW_PROGRESS.get(draw_id) or {
            "draw_id": draw_id,
            "stage": "unknown",
            "progress": 0,
            "step": 0,
            "steps": 0,
            "message": "Waiting",
            "updated_at": time.time(),
        })


def _tensor_debug(value: Any) -> dict[str, Any]:
    if value is None:
        return {"present": False}
    if not torch.is_tensor(value):
        return {"present": True, "type": type(value).__name__}
    tensor = value.detach().float().cpu()
    stats: dict[str, Any] = {
        "present": True,
        "shape": list(value.shape),
        "dtype": str(value.dtype),
        "device": str(value.device),
        "min": float(tensor.min().item()) if tensor.numel() else None,
        "max": float(tensor.max().item()) if tensor.numel() else None,
        "mean": float(tensor.mean().item()) if tensor.numel() else None,
        "sum": float(tensor.sum().item()) if tensor.numel() else None,
        "nonzero_gt_0_01": int((tensor > 0.01).sum().item()) if tensor.numel() else 0,
        "nonzero_gt_0_5": int((tensor > 0.5).sum().item()) if tensor.numel() else 0,
    }
    if tensor.numel() and tensor.ndim >= 2:
        plane = tensor
        if tensor.ndim == 4 and tensor.shape[-1] in (1, 3, 4):
            plane = tensor[0].amax(dim=-1)
        elif tensor.ndim == 4 and tensor.shape[1] in (1, 3, 4, 16):
            plane = tensor[0].amax(dim=0)
            while plane.ndim > 2:
                plane = plane[0]
        else:
            while plane.ndim > 2:
                plane = plane[0]
        points = torch.nonzero(plane > 0.01, as_tuple=False)
        if points.numel():
            y_min = int(points[:, 0].min().item())
            y_max = int(points[:, 0].max().item())
            x_min = int(points[:, 1].min().item())
            x_max = int(points[:, 1].max().item())
            active_bbox = {"x": x_min, "y": y_min, "width": x_max - x_min + 1, "height": y_max - y_min + 1}
            stats["active_bbox_gt_0_01"] = active_bbox
            stats["bbox_gt_0_01"] = active_bbox
    return stats


def _latent_debug(latent: Any) -> dict[str, Any]:
    if not isinstance(latent, dict):
        return {"type": type(latent).__name__, "is_dict": False}
    return {
        "type": type(latent).__name__,
        "is_dict": True,
        "keys": sorted(str(key) for key in latent.keys()),
        "samples": _tensor_debug(latent.get("samples")),
        "noise_mask": _tensor_debug(latent.get("noise_mask")),
    }


def _conditioning_debug(conditioning: Any) -> dict[str, Any]:
    if not isinstance(conditioning, list):
        return {"type": type(conditioning).__name__, "is_list": False}
    entries = []
    for item in conditioning[:2]:
        entry: dict[str, Any] = {"type": type(item).__name__}
        if isinstance(item, (list, tuple)) and item:
            entry["conditioning"] = _tensor_debug(item[0])
        if isinstance(item, (list, tuple)) and len(item) > 1 and isinstance(item[1], dict):
            metadata = item[1]
            entry["keys"] = sorted(str(key) for key in metadata.keys())
            for key in ("attention_mask", "concat_latent_image", "concat_mask", "pooled_output"):
                if key in metadata:
                    entry[key] = _tensor_debug(metadata.get(key))
        entries.append(entry)
    return {"type": type(conditioning).__name__, "is_list": True, "count": len(conditioning), "entries": entries}


class VNCCS_UniCanvas:
    """A ComfyUI node that hosts the VNCCS UniCanvas editor.

    The node's visible work happens in the frontend widget. Its DRAW button calls
    the custom backend endpoint below and intentionally does not queue the whole
    ComfyUI graph.
    """

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "export_state"
    CATEGORY = "VNCCS/canvas"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "unicanvas_state": ("STRING", {"multiline": True, "default": "{}"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, unicanvas_state: str = "{}", unique_id: str | None = None):
        return unicanvas_state

    def export_state(self, unicanvas_state: str = "{}", unique_id: str | None = None):
        return (_render_unicanvas_state_to_image_tensor(unicanvas_state),)


def _content_length_ok(request, max_bytes: int) -> bool:
    try:
        raw_length = request.headers.get("Content-Length")
        if raw_length is None:
            return not getattr(request, "can_read_body", False)
        return int(raw_length) <= max_bytes
    except Exception:
        return False


def _decode_data_url(data_url: str, mode: str) -> Image.Image:
    if not isinstance(data_url, str) or not data_url:
        raise ValueError("Missing image data")
    payload = data_url.split(",", 1)[1] if "," in data_url else data_url
    raw = base64.b64decode(payload, validate=False)
    if len(raw) > _MAX_UPLOAD_BYTES:
        raise ValueError("Image upload is too large")
    image = Image.open(io.BytesIO(raw))
    if image.width * image.height > _MAX_PIXELS:
        raise ValueError("Image dimensions are too large")
    return image.convert(mode)


def _encode_png_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _safe_unicanvas_state_id(value: Any) -> str:
    safe = _SAFE_ID_RE.sub("_", str(value or ""))[:96].strip("_")
    return safe or "unicanvas"


def _read_unicanvas_state_cache(state_id: str) -> dict[str, Any] | None:
    path = os.path.join(_UNICANVAS_STATE_CACHE_DIR, f"{_safe_unicanvas_state_id(state_id)}.json")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        entry = json.load(handle)
    return entry.get("state") if isinstance(entry, dict) else None


def _merge_unicanvas_state_with_cache(state: dict[str, Any], cached: dict[str, Any]) -> dict[str, Any]:
    cached_layers = cached.get("layers")
    live_layers = state.get("layers")
    if not isinstance(cached_layers, list) or not isinstance(live_layers, list):
        return cached

    cached_by_id = {
        layer.get("id"): layer
        for layer in cached_layers
        if isinstance(layer, dict) and layer.get("id") is not None
    }
    merged = {**cached, **state}
    merged_layers: list[dict[str, Any]] = []
    for live_layer in live_layers:
        if not isinstance(live_layer, dict):
            continue
        cached_layer = cached_by_id.get(live_layer.get("id"))
        if isinstance(cached_layer, dict):
            layer = {**cached_layer, **live_layer}
            if live_layer.get("cached") and not live_layer.get("dataURL"):
                for key in ("crop", "dataURL", "hiresRect", "hiresDataURL"):
                    layer[key] = cached_layer.get(key)
        else:
            layer = dict(live_layer)
        merged_layers.append(layer)
    merged["layers"] = merged_layers
    return merged


def _load_unicanvas_state(unicanvas_state: str) -> dict[str, Any]:
    try:
        state = json.loads(unicanvas_state or "{}")
    except Exception as exc:
        raise ValueError("Invalid UniCanvas state JSON") from exc
    if not isinstance(state, dict):
        raise ValueError("Invalid UniCanvas state")

    state_id = state.get("state_id")
    layers = state.get("layers")
    needs_cache = (
        state.get("storage") == "server_cache"
        or (isinstance(layers, list) and any(layer.get("cached") and not layer.get("dataURL") for layer in layers if isinstance(layer, dict)))
    )
    if state_id and needs_cache:
        cached = _read_unicanvas_state_cache(str(state_id))
        if isinstance(cached, dict) and isinstance(cached.get("layers"), list):
            state = _merge_unicanvas_state_with_cache(state, cached)
        elif any(layer.get("cached") and not layer.get("dataURL") for layer in layers or [] if isinstance(layer, dict)):
            raise ValueError("UniCanvas state cache is missing; interact with the canvas once or wait for state sync before queueing")

    if not isinstance(state.get("layers"), list):
        state["layers"] = []
    return state


def _number(value: Any, default: float) -> float:
    try:
        result = float(value)
        if math.isfinite(result):
            return result
    except Exception:
        pass
    return default


def _append_prompt_suffix(prompt: str, suffix: str) -> str:
    prompt = str(prompt or "").strip()
    suffix = str(suffix or "").strip()
    if not suffix:
        return prompt
    if suffix.lower() in prompt.lower():
        return prompt
    if not prompt:
        return suffix
    return f"{prompt}, {suffix}"


def _rect_from_state(value: Any, default: dict[str, float]) -> dict[str, float]:
    data = value if isinstance(value, dict) else {}
    return {
        "x": _number(data.get("x"), default["x"]),
        "y": _number(data.get("y"), default["y"]),
        "width": max(1.0, _number(data.get("width"), default["width"])),
        "height": max(1.0, _number(data.get("height"), default["height"])),
    }


def _pil_rgba_to_image_tensor(image: Image.Image) -> torch.Tensor:
    arr = np.asarray(image.convert("RGBA"), dtype=np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _apply_layer_opacity(image: Image.Image, opacity: float) -> Image.Image:
    opacity = max(0.0, min(1.0, opacity))
    if opacity >= 0.999:
        return image
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A").point(lambda value: int(round(value * opacity)))
    rgba.putalpha(alpha)
    return rgba


def _render_unicanvas_state_to_rgba(unicanvas_state: str) -> Image.Image:
    state = _load_unicanvas_state(unicanvas_state)
    origin = _rect_from_state(state.get("origin"), {"x": 0, "y": 0, "width": 1, "height": 1})
    bbox = _rect_from_state(state.get("bbox"), {"x": 0, "y": 0, "width": 1024, "height": 1024})
    width = max(1, int(round(bbox["width"])))
    height = max(1, int(round(bbox["height"])))
    bbox_local_x = bbox["x"] - origin["x"]
    bbox_local_y = bbox["y"] - origin["y"]
    out = Image.new("RGBA", (width, height), (0, 0, 0, 0))

    for layer in reversed(state.get("layers") or []):
        if not isinstance(layer, dict):
            continue
        if layer.get("type") != "raster" or layer.get("visible") is False:
            continue
        crop = layer.get("crop")
        data_url = layer.get("dataURL")
        if not isinstance(crop, dict) or not data_url:
            continue

        layer_x = int(round(_number(crop.get("x"), 0)))
        layer_y = int(round(_number(crop.get("y"), 0)))
        layer_w = max(1, int(round(_number(crop.get("width"), 1))))
        layer_h = max(1, int(round(_number(crop.get("height"), 1))))
        dst_x = int(round(layer_x - bbox_local_x))
        dst_y = int(round(layer_y - bbox_local_y))
        inter_left = max(0, dst_x)
        inter_top = max(0, dst_y)
        inter_right = min(width, dst_x + layer_w)
        inter_bottom = min(height, dst_y + layer_h)
        if inter_right <= inter_left or inter_bottom <= inter_top:
            continue

        image = _decode_data_url(str(data_url), "RGBA")
        src_left = inter_left - dst_x
        src_top = inter_top - dst_y
        src_right = src_left + (inter_right - inter_left)
        src_bottom = src_top + (inter_bottom - inter_top)
        image = image.crop((src_left, src_top, src_right, src_bottom))
        image = _apply_layer_opacity(image, _number(layer.get("opacity"), 1.0))
        out.alpha_composite(image, (inter_left, inter_top))

    return out


def _render_unicanvas_state_to_image_tensor(unicanvas_state: str) -> torch.Tensor:
    return _pil_rgba_to_image_tensor(_render_unicanvas_state_to_rgba(unicanvas_state))


def _pil_to_image_tensor(image: Image.Image) -> torch.Tensor:
    arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _pil_to_mask_tensor(image: Image.Image) -> torch.Tensor:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.float32) / 255.0
    alpha = rgba[..., 3]
    luminance = rgba[..., :3].mean(axis=2)
    mask = alpha if np.any(alpha < 0.999) else luminance
    return torch.from_numpy(mask)[None,]


def _pil_to_mask_image(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.float32)
    alpha = rgba[..., 3]
    luminance = rgba[..., :3].mean(axis=2)
    mask = alpha if np.any(alpha < 254.5) else luminance
    return Image.fromarray(np.clip(mask, 0, 255).astype(np.uint8), mode="L")


def _image_tensor_to_pil(images: torch.Tensor) -> Image.Image:
    image = images.detach().cpu().numpy()
    while image.ndim > 3 and image.shape[0] == 1:
        image = image[0]
    if image.ndim == 4:
        image = image[0]
    if image.ndim == 3 and image.shape[0] in (1, 3, 4) and image.shape[-1] not in (1, 3, 4):
        image = np.moveaxis(image, 0, -1)
    if image.ndim == 2:
        image = np.repeat(image[..., None], 3, axis=-1)
    if image.ndim != 3 or image.shape[-1] not in (1, 3, 4):
        raise ValueError(f"Unsupported image tensor shape for PIL conversion: {tuple(images.shape)}")
    if image.shape[-1] == 1:
        image = np.repeat(image, 3, axis=-1)
    image = np.clip(image * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(image)


def _image_tensor_to_pil_list(images: torch.Tensor) -> list[Image.Image]:
    if torch.is_tensor(images) and images.ndim == 4:
        return [_image_tensor_to_pil(images[index]) for index in range(int(images.shape[0]))]
    return [_image_tensor_to_pil(images)]


def _repeat_latent_batch(latent: Any, batch_size: int, draw_id: str = "unknown") -> Any:
    batch_size = max(1, int(batch_size))
    if batch_size <= 1 or not isinstance(latent, dict):
        return latent
    samples = latent.get("samples")
    if not torch.is_tensor(samples) or samples.ndim < 1:
        return latent
    current = int(samples.shape[0])
    if current == batch_size:
        return latent
    if current != 1:
        _uc_log(draw_id, "latent batch resize skipped", {"current": current, "requested": batch_size})
        return latent
    repeated = dict(latent)
    repeated["samples"] = samples.repeat((batch_size, *([1] * (samples.ndim - 1))))
    noise_mask = repeated.get("noise_mask")
    if torch.is_tensor(noise_mask) and noise_mask.ndim >= 1 and int(noise_mask.shape[0]) == 1:
        repeated["noise_mask"] = noise_mask.repeat((batch_size, *([1] * (noise_mask.ndim - 1))))
    _uc_log(draw_id, "latent batch prepared", {"batch_size": batch_size, "latent": _latent_debug(repeated)})
    return repeated


_CONDITIONING_BATCH_METADATA_KEYS = {
    "concat_latent_image",
    "concat_mask",
    "reference_latents",
}


def _repeat_conditioning_batch_value(value: Any, batch_size: int) -> Any:
    if torch.is_tensor(value) and value.ndim >= 1 and int(value.shape[0]) == 1:
        return value.repeat((batch_size, *([1] * (value.ndim - 1))))
    if isinstance(value, list):
        return [_repeat_conditioning_batch_value(item, batch_size) for item in value]
    if isinstance(value, tuple):
        return tuple(_repeat_conditioning_batch_value(item, batch_size) for item in value)
    return value


def _repeat_conditioning_batch(conditioning: Any, batch_size: int, draw_id: str = "unknown", label: str = "conditioning") -> Any:
    batch_size = max(1, int(batch_size))
    if batch_size <= 1 or not isinstance(conditioning, list):
        return conditioning
    changed = False
    repeated = []
    for item in conditioning:
        if not (isinstance(item, (list, tuple)) and len(item) > 1 and isinstance(item[1], dict)):
            repeated.append(item)
            continue
        metadata = dict(item[1])
        for key in _CONDITIONING_BATCH_METADATA_KEYS:
            if key in metadata:
                metadata[key] = _repeat_conditioning_batch_value(metadata[key], batch_size)
                changed = True
        if isinstance(item, tuple):
            repeated.append((item[0], metadata, *item[2:]))
        else:
            repeated.append([item[0], metadata, *item[2:]])
    if changed:
        _uc_log(draw_id, "conditioning batch metadata prepared", {"label": label, "batch_size": batch_size})
    return repeated


def _combine_mask_with_source_alpha(mask_image: Image.Image, source_rgba: Image.Image) -> Image.Image:
    mask = np.asarray(_pil_to_mask_image(mask_image), dtype=np.uint8)
    alpha = np.asarray(source_rgba.convert("RGBA").getchannel("A"), dtype=np.uint8)
    alpha_mask = np.where(alpha > 8, 0, 255).astype(np.uint8)
    combined = np.maximum(mask, alpha_mask)
    return Image.fromarray(combined.astype(np.uint8), mode="L")


def _gaussian_kernel(radius: int) -> torch.Tensor:
    radius = max(0, int(radius))
    if radius <= 0:
        return torch.ones((1, 1), dtype=torch.float32)
    size = radius * 2 + 1
    sigma = max(radius / 2.5, 0.001)
    coords = torch.arange(size, dtype=torch.float32) - radius
    yy, xx = torch.meshgrid(coords, coords, indexing="ij")
    dist = torch.sqrt(xx.square() + yy.square())
    kernel = torch.exp(-0.5 * (dist / sigma).square())
    kernel = torch.where(dist <= radius, kernel, torch.zeros_like(kernel))
    kernel = kernel / torch.clamp(kernel.max(), min=1e-6)
    return kernel


def _max_filter2d_weighted(image: torch.Tensor, kernel: torch.Tensor) -> torch.Tensor:
    height, width = kernel.shape
    pad_y = height // 2
    pad_x = width // 2
    padded = torch.nn.functional.pad(image, (pad_x, pad_x, pad_y, pad_y), mode="constant", value=0)
    result = torch.zeros_like(image)
    for y in range(height):
        for x in range(width):
            weight = kernel[y, x]
            if float(weight.item()) <= 0:
                continue
            region = padded[y : y + image.shape[0], x : x + image.shape[1]]
            result = torch.maximum(result, region * weight)
    return result


def _make_gradient_denoise_mask(mask_image: Image.Image, edge_radius: int, draw_id: str) -> tuple[Image.Image, Image.Image]:
    """Comfy noise mask + expanded paste area: white/1 means denoise."""
    hard = np.where(np.asarray(_pil_to_mask_image(mask_image), dtype=np.uint8) > 8, 255, 0).astype(np.uint8)
    width, height = mask_image.size
    latent_width = max(1, width // 8)
    latent_height = max(1, height // 8)
    latent_radius = max(0, int(edge_radius) // 8)
    latent = Image.fromarray(hard, mode="L").resize((latent_width, latent_height), Image.Resampling.BILINEAR)
    latent_tensor = torch.from_numpy(np.asarray(latent, dtype=np.float32) / 255.0)
    if latent_radius > 0:
        latent_tensor = _max_filter2d_weighted(latent_tensor, _gaussian_kernel(latent_radius))
    denoise = Image.fromarray(np.clip(latent_tensor.numpy() * 255.0, 0, 255).astype(np.uint8), mode="L")
    denoise = denoise.resize((width, height), Image.Resampling.BILINEAR)
    expanded_area = Image.fromarray(np.where(np.asarray(denoise, dtype=np.uint8) > 1, 255, 0).astype(np.uint8), mode="L")
    _uc_log(
        draw_id,
        "gradient denoise mask prepared",
        {
            "edge_radius": edge_radius,
            "latent_edge_radius": latent_radius,
            "mask": _tensor_debug(torch.from_numpy(np.asarray(denoise, dtype=np.float32) / 255.0)[None,]),
            "expanded_area": _tensor_debug(torch.from_numpy(np.asarray(expanded_area, dtype=np.float32) / 255.0)[None,]),
        },
    )
    return denoise, expanded_area


def _make_gradient_paste_mask(mask_image: Image.Image, fade_size_px: int, draw_id: str) -> Image.Image:
    """Paste mask: white chooses generated pixels, black keeps the source."""
    hard = Image.fromarray(
        np.where(np.asarray(_pil_to_mask_image(mask_image), dtype=np.uint8) > 8, 255, 0).astype(np.uint8),
        mode="L",
    )
    fade = max(0, int(fade_size_px))
    if fade <= 0:
        return hard
    blurred = hard.filter(ImageFilter.GaussianBlur(radius=fade))
    hard_np = np.asarray(hard, dtype=np.uint8)
    blur_np = np.asarray(blurred, dtype=np.uint8)
    paste = np.maximum(hard_np, blur_np)
    paste_image = Image.fromarray(paste.astype(np.uint8), mode="L")
    _uc_log(
        draw_id,
        "gradient paste mask prepared",
        {
            "fade_size_px": fade,
            "mask": _tensor_debug(torch.from_numpy(paste.astype(np.float32) / 255.0)[None,]),
        },
    )
    return paste_image


def _infill_masked_rgb(source_rgba: Image.Image, mask_image: Image.Image, draw_id: str) -> Image.Image:
    rgba = source_rgba.convert("RGBA")
    alpha = np.asarray(rgba.getchannel("A"), dtype=np.uint8)
    mask = np.asarray(_pil_to_mask_image(mask_image), dtype=np.uint8)
    np_image = np.asarray(rgba, dtype=np.uint8)
    height, width = alpha.shape
    valid = alpha > 8

    if not bool(valid.any()):
        _uc_log(draw_id, "outpaint infill fallback", {"reason": "no valid source pixels"})
        return Image.new("RGB", rgba.size, (127, 127, 127))

    mean_color = np_image[valid, :3].mean(axis=0).astype(np.float32)
    mean_tuple = tuple(np.round(mean_color).astype(np.uint8).tolist())
    lowfreq = Image.new("RGB", rgba.size, mean_tuple)
    lowfreq.paste(rgba.convert("RGB"), (0, 0), rgba.getchannel("A"))
    blur_radius = max(24, int(round(max(width, height) / 18)))
    lowfreq = lowfreq.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    lowfreq_width = max(8, int(round(width / 32)))
    lowfreq_height = max(8, int(round(height / 32)))
    lowfreq = lowfreq.resize((lowfreq_width, lowfreq_height), Image.Resampling.BICUBIC)
    lowfreq = lowfreq.resize((width, height), Image.Resampling.BICUBIC)
    filled = np.asarray(lowfreq, dtype=np.float32)

    rng = np.random.default_rng(0)
    noise_layers = ((128, 16.0), (64, 10.0), (32, 5.0))
    for noise_cell, noise_strength in noise_layers:
        noise_width = max(1, int(math.ceil(width / noise_cell)))
        noise_height = max(1, int(math.ceil(height / noise_cell)))
        noise = rng.normal(0.0, noise_strength, size=(noise_height, noise_width, 3)).astype(np.float32)
        noise_image = Image.fromarray(np.clip(127.5 + noise, 0, 255).astype(np.uint8), mode="RGB")
        noise_image = noise_image.resize((width, height), Image.Resampling.BILINEAR)
        filled += np.asarray(noise_image, dtype=np.float32) - 127.5

    result = Image.fromarray(np.clip(filled, 0, 255).astype(np.uint8), mode="RGB")
    result.paste(rgba, (0, 0), rgba.getchannel("A"))
    _uc_log(
        draw_id,
        "outpaint source infilled with low-frequency context noise",
        {
            "source_size": source_rgba.size,
            "mean_color": [float(v) for v in mean_color],
            "blur_radius": blur_radius,
            "lowfreq_size": [lowfreq_width, lowfreq_height],
            "noise_layers": [{"cell": cell, "strength": strength} for cell, strength in noise_layers],
            "mask": _tensor_debug(torch.from_numpy(mask.astype(np.float32) / 255.0)[None,]),
            "alpha": _tensor_debug(torch.from_numpy(alpha.astype(np.float32) / 255.0)[None,]),
            "valid_source_pixels": int(valid.sum()),
        },
    )
    return result


def _sample_transparent_outpaint_rgb(source_rgba: Image.Image, draw_id: str) -> Image.Image:
    rgba = source_rgba.convert("RGBA")
    alpha = np.asarray(rgba.getchannel("A"), dtype=np.uint8)
    valid = alpha > 8
    if not bool(valid.any()):
        _uc_log(draw_id, "outpaint sampled-fill fallback", {"reason": "no valid source pixels"})
        return Image.new("RGB", rgba.size, (127, 127, 127))

    rgb = np.asarray(rgba.convert("RGB"), dtype=np.uint8)
    palette = rgb[valid]
    ys, xs = np.nonzero(valid)
    min_x = int(xs.min())
    max_x = int(xs.max())
    min_y = int(ys.min())
    max_y = int(ys.max())
    height, width = alpha.shape

    grid_y, grid_x = np.indices((height, width))
    sample_x = np.clip(grid_x, min_x, max_x)
    sample_y = np.clip(grid_y, min_y, max_y)
    edge_extended = rgb[sample_y, sample_x].astype(np.float32)

    rng = np.random.default_rng(0)
    sampled = np.zeros((height, width, 3), dtype=np.float32)
    noise_layers = ((96, 0.55), (32, 0.3), (8, 0.15))
    for cell, weight in noise_layers:
        noise_width = max(1, int(math.ceil(width / cell)))
        noise_height = max(1, int(math.ceil(height / cell)))
        indices = rng.integers(0, len(palette), size=(noise_height, noise_width))
        noise = Image.fromarray(palette[indices].astype(np.uint8), mode="RGB")
        noise = noise.resize((width, height), Image.Resampling.BILINEAR)
        sampled += np.asarray(noise, dtype=np.float32) * float(weight)

    total_weight = sum(weight for _cell, weight in noise_layers)
    sampled /= max(total_weight, 1e-6)
    fill = sampled * 0.7 + edge_extended * 0.3
    blur_radius = max(2, int(round(max(width, height) / 256)))
    fill_image = Image.fromarray(np.clip(fill, 0, 255).astype(np.uint8), mode="RGB")
    if blur_radius > 0:
        fill_image = fill_image.filter(ImageFilter.GaussianBlur(radius=blur_radius))

    result = fill_image.convert("RGB")
    result.paste(rgba, (0, 0), rgba.getchannel("A"))
    _uc_log(
        draw_id,
        "outpaint source filled with sampled source-color static",
        {
            "source_size": rgba.size,
            "valid_bbox": [min_x, min_y, max_x - min_x + 1, max_y - min_y + 1],
            "palette_pixels": int(len(palette)),
            "blur_radius": blur_radius,
            "noise_layers": [{"cell": cell, "weight": weight} for cell, weight in noise_layers],
            "alpha": _tensor_debug(torch.from_numpy(alpha.astype(np.float32) / 255.0)[None,]),
        },
    )
    return result


def _make_edit_outpaint_reference_rgb(source_rgba: Image.Image, draw_id: str) -> Image.Image:
    rgba = source_rgba.convert("RGBA")
    background = Image.new("RGBA", rgba.size, (0, 0, 0, 255))
    background.alpha_composite(rgba)
    result = background.convert("RGB")
    _uc_log(
        draw_id,
        "edit-model outpaint reference flattened on black",
        {"source_size": rgba.size},
    )
    return result


def _apply_differential_diffusion(model: Any, draw_id: str, strength: float = 1.0) -> Any:
    try:
        from comfy_extras.nodes_differential_diffusion import DifferentialDiffusion

        model = model.clone()
        model.set_model_denoise_mask_function(
            lambda *args, **kwargs: DifferentialDiffusion.forward(*args, **kwargs, strength=strength)
        )
        _uc_log(draw_id, "DifferentialDiffusion applied", {"strength": strength})
        return model
    except Exception as exc:
        _uc_log(draw_id, "DifferentialDiffusion unavailable", {"error": str(exc)})
        return model


def _composite_inpaint_result(
    source: Image.Image,
    generated: Image.Image,
    mask_image: Image.Image,
    output_size: tuple[int, int],
    draw_id: str,
) -> Image.Image:
    base = source.convert("RGB")
    upper = generated.convert("RGB")
    mask = _pil_to_mask_image(mask_image)
    if base.size != output_size:
        base = base.resize(output_size, Image.Resampling.LANCZOS)
    if upper.size != output_size:
        upper = upper.resize(output_size, Image.Resampling.LANCZOS)
    if mask.size != output_size:
        mask = mask.resize(output_size, Image.Resampling.BILINEAR)
    _uc_log(
        draw_id,
        "inpaint paste-back",
        {
            "base_size": base.size,
            "upper_size": upper.size,
            "mask_size": mask.size,
            "mask": _tensor_debug(torch.from_numpy(np.asarray(mask, dtype=np.float32) / 255.0)[None,]),
        },
    )
    return Image.composite(upper, base, mask)


def _normalize_path(value: str) -> str:
    return str(value or "").strip().replace("\\", os.sep).replace("/", os.sep)


def _is_absolute_any_os(value: str) -> bool:
    raw = str(value or "").strip()
    return os.path.isabs(raw) or ntpath.isabs(raw) or bool(ntpath.splitdrive(raw)[0])


def _path_variants(name: str) -> list[str]:
    raw = str(name or "").strip()
    if not raw:
        return []
    variants = []
    for candidate in (raw, raw.replace("\\", "/"), raw.replace("/", "\\")):
        if candidate and candidate not in variants:
            variants.append(candidate)
    return variants


def _safe_get_folder_paths(folder_paths: Any, category: str) -> list[str]:
    try:
        return folder_paths.get_folder_paths(category) or []
    except Exception:
        return []


def _is_under_any_folder(path: str, folders: list[str]) -> bool:
    try:
        path_abs = os.path.abspath(_normalize_path(path))
        for folder in folders:
            folder_abs = os.path.abspath(_normalize_path(folder))
            if os.path.commonpath([folder_abs, path_abs]) == folder_abs:
                return True
    except Exception:
        return False
    return False


def _get_full_path_agnostic(folder_paths: Any, category: str, name: str, require_exists: bool = False) -> str | None:
    folders = _safe_get_folder_paths(folder_paths, category)
    first_match = None

    for candidate in _path_variants(name):
        try:
            found = folder_paths.get_full_path(category, candidate)
        except Exception:
            found = None
        if found:
            if os.path.exists(found):
                return found
            if first_match is None:
                first_match = found

        for folder in folders:
            joined = os.path.join(folder, _normalize_path(candidate))
            if os.path.exists(joined):
                return joined
            if first_match is None:
                first_match = joined

        if _is_absolute_any_os(candidate) and _is_under_any_folder(candidate, folders):
            normalized_candidate = _normalize_path(candidate)
            if os.path.exists(normalized_candidate):
                return normalized_candidate
            if first_match is None:
                first_match = normalized_candidate

    return None if require_exists else first_match


def _safe_filename_list(category: str) -> list[str]:
    try:
        import folder_paths

        return folder_paths.get_filename_list(category)
    except Exception:
        return []


def _get_node_combo_values(class_names: list[str], input_name: str) -> list[str]:
    try:
        import nodes

        mappings = getattr(nodes, "NODE_CLASS_MAPPINGS", {}) or {}
        for class_name in class_names:
            node_cls = mappings.get(class_name)
            if node_cls is None or not hasattr(node_cls, "INPUT_TYPES"):
                continue
            input_types = node_cls.INPUT_TYPES()
            if not isinstance(input_types, dict):
                continue
            for section_name in ("required", "optional"):
                section = input_types.get(section_name) or {}
                if not isinstance(section, dict) or input_name not in section:
                    continue
                spec = section.get(input_name)
                if isinstance(spec, (list, tuple)) and spec:
                    values = spec[0]
                    if isinstance(values, (list, tuple)):
                        return [str(value) for value in values]
    except Exception:
        return []
    return []


def _infer_unicanvas_loader_type(settings: dict[str, Any]) -> str:
    explicit = str(settings.get("model_loader") or settings.get("loader_type") or "").lower()
    if explicit:
        return explicit
    if settings.get("gguf_model_name"):
        return "gguf"
    generation_mode = str(settings.get("generation_mode", "illustrious")).lower()
    if generation_mode in {"qwen_image_edit", "qwen-edit", "qwen_edit", "qwen-image-edit", "qwen_image_edit_2511"}:
        return "gguf"
    if generation_mode in {"anima", "flux_klein", "flux-klein", "klein", "z_image", "z-image", "zimage", "z_image_turbo"} or settings.get("diffusion_model_name"):
        return "diffusion_model"
    return "checkpoint"


def _normalize_gen_settings(gen_settings: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(gen_settings or {})
    loader = _get_unicanvas_model_loader(_infer_unicanvas_loader_type(normalized))
    generation_mode = loader.forced_mode or str(normalized.get("generation_mode", "illustrious")).lower()
    mode_settings = normalized.get("mode_settings", {})
    module = _get_unicanvas_model_module(generation_mode)
    mode_profile = {}
    if isinstance(mode_settings, dict):
        mode_profile = mode_settings.get(generation_mode) or mode_settings.get(module.key) or {}
    defaults = module.defaults
    merged = dict(defaults)
    merged.update(normalized)
    if isinstance(mode_profile, dict):
        merged.update(mode_profile)
    merged["generation_mode"] = module.key
    merged["generation_mode_alias"] = generation_mode
    merged["model_loader"] = loader.key
    if loader.forced_mode:
        merged["loader_forced_generation_mode"] = loader.forced_mode
    if "sampler" in merged and "sampler_name" not in merged:
        merged["sampler_name"] = merged["sampler"]
    if "sampler_name" in merged:
        merged["sampler"] = merged["sampler_name"]
    return merged


def _call_loader_node(class_names: list[str], method_names: list[str], **kwargs):
    import nodes

    mappings = getattr(nodes, "NODE_CLASS_MAPPINGS", {}) or {}
    for class_name in class_names:
        loader_cls = mappings.get(class_name)
        if loader_cls is None:
            continue
        loader = loader_cls()
        candidate_method_names = list(method_names)
        function_name = getattr(loader_cls, "FUNCTION", None)
        if function_name and function_name not in candidate_method_names:
            candidate_method_names.append(function_name)
        for method_name in candidate_method_names:
            method = getattr(loader, method_name, None)
            if method is None:
                continue
            accepted_kwargs = _filter_node_kwargs(loader_cls, method, kwargs)
            result = method(**accepted_kwargs)
            return _unwrap_single_node_result(result)
    return None


def _is_comfy_node_output(value: Any) -> bool:
    return hasattr(value, "result") and hasattr(value, "args") and type(value).__name__ == "NodeOutput"


def _unwrap_comfy_node_output(value: Any) -> Any:
    if not _is_comfy_node_output(value):
        return value
    block_execution = getattr(value, "block_execution", None)
    if block_execution:
        raise RuntimeError(str(block_execution))
    return getattr(value, "result", None)


def _unwrap_single_node_result(result: Any) -> Any:
    result = _unwrap_comfy_node_output(result)
    if isinstance(result, tuple):
        if not result:
            return None
        return result[0]
    return result


def _node_input_names(node_cls: Any) -> set[str]:
    input_types_fn = getattr(node_cls, "INPUT_TYPES", None)
    if input_types_fn is None:
        return set()
    try:
        input_types = input_types_fn()
    except Exception:
        return set()
    names: set[str] = set()
    if not isinstance(input_types, dict):
        return names
    for section_name in ("required", "optional", "hidden"):
        section = input_types.get(section_name)
        if isinstance(section, dict):
            names.update(str(key) for key in section.keys())
    return names


def _filter_node_kwargs(node_cls: Any, method: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    signature = inspect.signature(method)
    has_var_keyword = any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values())
    input_names = _node_input_names(node_cls)
    if input_names:
        return {key: value for key, value in kwargs.items() if key in input_names}
    if has_var_keyword:
        return dict(kwargs)
    return {key: value for key, value in kwargs.items() if key in signature.parameters}


def _call_node_method(class_names: list[str], method_names: list[str], **kwargs):
    import nodes

    mappings = getattr(nodes, "NODE_CLASS_MAPPINGS", {}) or {}
    for class_name in class_names:
        node_cls = mappings.get(class_name)
        if node_cls is None:
            continue
        node_instance = node_cls()
        candidate_method_names = list(method_names)
        function_name = getattr(node_cls, "FUNCTION", None)
        if function_name and function_name not in candidate_method_names:
            candidate_method_names.append(function_name)
        for method_name in candidate_method_names:
            method = getattr(node_instance, method_name, None)
            if method is None:
                continue
            accepted_kwargs = _filter_node_kwargs(node_cls, method, kwargs)
            return _unwrap_single_node_result(method(**accepted_kwargs))
    return None


def _load_generation_assets(gen_settings: dict[str, Any]):
    loader = _get_unicanvas_model_loader(str(gen_settings.get("model_loader") or "checkpoint").lower())
    asset_key = loader.cache_key(gen_settings)
    with _COMFY_MODEL_OP_LOCK:
        with _MODEL_CACHE_LOCK:
            cached = _MODEL_CACHE.get(asset_key)
            if cached is not None:
                return cached
            if len(_MODEL_CACHE) >= _MODEL_CACHE_MAX_ENTRIES:
                _MODEL_CACHE.clear()
        assets = loader.load_assets(gen_settings)
        with _MODEL_CACHE_LOCK:
            _MODEL_CACHE[asset_key] = assets
        return assets


def _clone_model_clip(model: Any, clip: Any) -> tuple[Any, Any]:
    return (model.clone() if hasattr(model, "clone") else model, clip.clone() if hasattr(clip, "clone") else clip)


def _normalize_lora_name(value: Any) -> str:
    return str(value or "").replace("\\", "/").strip().lower()


def _lora_name_matches(value: Any, expected: str) -> bool:
    normalized = _normalize_lora_name(value)
    expected_normalized = _normalize_lora_name(expected)
    return normalized == expected_normalized or os.path.basename(normalized) == os.path.basename(expected_normalized)


def _get_lora_full_path(lora_name: str) -> str:
    import folder_paths

    path = _get_full_path_agnostic(folder_paths, "loras", lora_name, require_exists=True)
    if not path:
        raise ValueError(f"LoRA not found: {lora_name}")
    return path


def _apply_lora_cached(model: Any, clip: Any, lora_name: str, strength: float, clip_strength: float | None = None):
    if not lora_name or float(strength or 0) == 0:
        return model, clip
    import comfy.sd
    import comfy.utils

    with _MODEL_CACHE_LOCK:
        lora = _LORA_CACHE.get(lora_name)
    if lora is None:
        lora = comfy.utils.load_torch_file(_get_lora_full_path(lora_name), safe_load=True)
        with _MODEL_CACHE_LOCK:
            _LORA_CACHE[lora_name] = lora
    return comfy.sd.load_lora_for_models(model, clip, lora, strength, strength if clip_strength is None else clip_strength)


def _load_model_patch(patch_name: str):
    if not patch_name:
        raise ValueError("Model patch name is required")
    loaded = _call_node_method(
        ["ModelPatchLoader"],
        ["load_model_patch"],
        name=patch_name,
    )
    if loaded is None:
        raise ValueError(f"Model patch not found or failed to load: {patch_name}")
    return loaded


def _load_model_patch_cached(patch_name: str):
    if not patch_name:
        raise ValueError("Model patch name is required")
    with _MODEL_CACHE_LOCK:
        cached = _MODEL_PATCH_CACHE.get(patch_name)
    if cached is not None:
        return cached.clone() if hasattr(cached, "clone") else cached
    loaded = _load_model_patch(patch_name)
    with _MODEL_CACHE_LOCK:
        _MODEL_PATCH_CACHE[patch_name] = loaded
    return loaded.clone() if hasattr(loaded, "clone") else loaded


def _preload_z_image_fun_controlnet_patch(gen_settings: dict[str, Any], mode: str, draw_id: str = "unknown") -> None:
    if str(gen_settings.get("generation_mode") or "").lower() != "z_image":
        return
    if mode not in {"inpaint", "outpaint"}:
        return
    if not bool(gen_settings.get("fun_controlnet_inpaint", True)):
        return
    patch_name = str(gen_settings.get("fun_controlnet_patch_name") or "").strip()
    if not patch_name:
        return
    patch_name = _ensure_z_image_fun_controlnet_model(patch_name, draw_id)
    gen_settings["fun_controlnet_patch_name"] = patch_name
    gen_settings["_z_image_fun_controlnet_patch_model"] = _load_model_patch(patch_name)
    _uc_log(
        draw_id,
        "Z-image Fun ControlNet patch preloaded",
        {
            "mode": mode,
            "patch": patch_name,
            "reason": "load before prompt/VAE/latent preparation to avoid late high-memory patch allocation",
        },
    )


def _ensure_z_image_fun_controlnet_model(patch_name: str, draw_id: str = "unknown") -> str:
    import folder_paths

    requested = str(patch_name or Z_IMAGE_FUN_CONTROLNET_FILENAME).replace("\\", "/").strip()
    basename = os.path.basename(requested) or Z_IMAGE_FUN_CONTROLNET_FILENAME
    if basename != Z_IMAGE_FUN_CONTROLNET_FILENAME:
        return patch_name

    found = _get_full_path_agnostic(folder_paths, "model_patches", requested, require_exists=True)
    if found:
        return patch_name
    found = _get_full_path_agnostic(folder_paths, "model_patches", basename, require_exists=True)
    if found:
        return basename

    folders = _safe_get_folder_paths(folder_paths, "model_patches")
    if folders:
        target_dir = folders[0]
    else:
        models_dir = os.path.abspath(getattr(folder_paths, "models_dir", os.path.join(os.getcwd(), "models")))
        target_dir = os.path.join(models_dir, "model_patches")
    os.makedirs(target_dir, exist_ok=True)
    target_path = os.path.join(target_dir, basename)
    if os.path.isfile(target_path):
        return basename

    _uc_log(
        draw_id,
        "Z-image Fun ControlNet model download started",
        {
            "repo": Z_IMAGE_FUN_CONTROLNET_REPO_ID,
            "filename": Z_IMAGE_FUN_CONTROLNET_FILENAME,
            "target": target_path,
        },
    )
    try:
        import shutil
        from huggingface_hub import hf_hub_download

        cached_path = hf_hub_download(
            repo_id=Z_IMAGE_FUN_CONTROLNET_REPO_ID,
            filename=Z_IMAGE_FUN_CONTROLNET_FILENAME,
            repo_type="model",
            local_files_only=False,
        )
        tmp_path = target_path + ".tmp"
        shutil.copy2(cached_path, tmp_path)
        os.replace(tmp_path, target_path)
    except Exception as exc:
        with contextlib.suppress(Exception):
            os.remove(target_path + ".tmp")
        raise RuntimeError(
            f"Failed to download Z-image Fun ControlNet model from {Z_IMAGE_FUN_CONTROLNET_REPO_ID}: {exc}"
        ) from exc

    _uc_log(draw_id, "Z-image Fun ControlNet model downloaded", {"path": target_path})
    return basename


def _ensure_anima_lllite_model(lllite_name: str, draw_id: str = "unknown") -> str:
    import folder_paths

    requested = str(lllite_name or ANIMA_LLLITE_INPAINT_FILENAME).replace("\\", "/").strip()
    basename = os.path.basename(requested) or ANIMA_LLLITE_INPAINT_FILENAME
    if basename != ANIMA_LLLITE_INPAINT_FILENAME:
        raise ValueError(
            f"Unsupported bundled Anima LLLite model: {lllite_name}. "
            f"Expected {ANIMA_LLLITE_INPAINT_FILENAME} from {ANIMA_LLLITE_REPO_ID}."
        )

    found = _get_full_path_agnostic(folder_paths, "controlnet", requested, require_exists=True)
    if found:
        return found
    found = _get_full_path_agnostic(folder_paths, "controlnet", basename, require_exists=True)
    if found:
        return found

    folders = _safe_get_folder_paths(folder_paths, "controlnet")
    if folders:
        target_dir = folders[0]
    else:
        models_dir = os.path.abspath(getattr(folder_paths, "models_dir", os.path.join(os.getcwd(), "models")))
        target_dir = os.path.join(models_dir, "controlnet")
    os.makedirs(target_dir, exist_ok=True)
    target_path = os.path.join(target_dir, basename)
    if os.path.isfile(target_path):
        return target_path

    _uc_log(
        draw_id,
        "Anima LLLite model download started",
        {"repo": ANIMA_LLLITE_REPO_ID, "filename": ANIMA_LLLITE_INPAINT_FILENAME, "target": target_path},
    )
    try:
        import shutil
        from huggingface_hub import hf_hub_download

        cached_path = hf_hub_download(
            repo_id=ANIMA_LLLITE_REPO_ID,
            filename=ANIMA_LLLITE_INPAINT_FILENAME,
            repo_type="model",
            local_files_only=False,
        )
        tmp_path = target_path + ".tmp"
        shutil.copy2(cached_path, tmp_path)
        os.replace(tmp_path, target_path)
    except Exception as exc:
        with contextlib.suppress(Exception):
            os.remove(target_path + ".tmp")
        raise RuntimeError(f"Failed to download Anima LLLite inpaint model from {ANIMA_LLLITE_REPO_ID}: {exc}") from exc

    _uc_log(draw_id, "Anima LLLite model downloaded", {"path": target_path})
    return target_path


def _apply_generation_loras(model: Any, clip: Any, gen_settings: dict[str, Any]):
    module = _get_unicanvas_model_module(str(gen_settings.get("generation_mode", "illustrious")).lower())
    return module.apply_loras(model, clip, gen_settings)


def _encode_generation_prompt(clip: Any, text: str, gen_settings: dict[str, Any]):
    module = _get_unicanvas_model_module(str(gen_settings.get("generation_mode", "illustrious")).lower())
    return module.encode_prompt(clip, text, gen_settings)


def _validate_anima_conditioning(positive: Any, negative: Any, clip_name: str) -> None:
    def context_width(conditioning):
        try:
            if not conditioning:
                return None
            return conditioning[0][0].shape[-1]
        except Exception:
            return None

    widths = [width for width in (context_width(positive), context_width(negative)) if width is not None]
    bad_widths = [width for width in widths if width != 1024]
    if bad_widths:
        raise ValueError(
            "ANIMA conditioning has the wrong text-encoder width "
            f"{bad_widths[0]} instead of 1024. Select 'qwen_3_06b_base.safetensors' in the CLIP field; "
            f"current CLIP is '{clip_name}'."
        )


def _prepare_noise_mask_for_latent(
    vae: Any,
    pixels: torch.Tensor,
    mask: torch.Tensor,
    grow_mask_by: int,
) -> tuple[torch.Tensor, torch.Tensor]:
    downscale_ratio = vae.spacial_compression_encode()
    height = (pixels.shape[1] // downscale_ratio) * downscale_ratio
    width = (pixels.shape[2] // downscale_ratio) * downscale_ratio
    mask = torch.nn.functional.interpolate(
        mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1])),
        size=(pixels.shape[1], pixels.shape[2]),
        mode="bilinear",
    )
    has_soft_edges = bool(((mask > 0.001) & (mask < 0.999)).any().item())
    if pixels.shape[1] != height or pixels.shape[2] != width:
        y_offset = (pixels.shape[1] % downscale_ratio) // 2
        x_offset = (pixels.shape[2] % downscale_ratio) // 2
        pixels = pixels[:, y_offset:height + y_offset, x_offset:width + x_offset, :]
        mask = mask[:, :, y_offset:height + y_offset, x_offset:width + x_offset]

    if grow_mask_by > 0 and not has_soft_edges:
        kernel = torch.ones((1, 1, grow_mask_by, grow_mask_by))
        padding = math.ceil((grow_mask_by - 1) / 2)
        mask = torch.clamp(torch.nn.functional.conv2d(mask.round(), kernel, padding=padding), 0, 1)
    elif not has_soft_edges:
        mask = mask.round()
    else:
        mask = torch.clamp(mask, 0, 1)
    return pixels, torch.clamp(mask[:, :, :height, :width], 0, 1)


def _encode_source_latent(vae: Any, image_tensor: torch.Tensor, mask: torch.Tensor | None, grow_mask_by: int, draw_id: str = "unknown"):
    import nodes

    if mask is not None:
        encode_pixels, noise_mask = _prepare_noise_mask_for_latent(vae, image_tensor, mask, grow_mask_by)
        encoded = nodes.VAEEncode().encode(vae, encode_pixels)[0]
        encoded["noise_mask"] = noise_mask
        _uc_log(
            draw_id,
            "VAEEncode source + attached noise_mask",
            {
                "reason": "keep original pixels in masked area; Comfy VAEEncodeForInpaint blanks them to 0.5 before encode",
                "latent": _latent_debug(encoded),
            },
        )
        return encoded

    encoded = _call_node_method(["VAEEncode"], ["encode"], vae=vae, pixels=image_tensor, image=image_tensor)
    if isinstance(encoded, tuple) and encoded:
        encoded = encoded[0]
    if encoded is not None:
        _uc_log(draw_id, "VAEEncode returned latent", _latent_debug(encoded))
        return encoded
    encoded = nodes.VAEEncode().encode(vae, image_tensor)[0]
    _uc_log(draw_id, "fallback VAEEncode returned latent", _latent_debug(encoded))
    return encoded


def _prepare_inpaint_model_conditioning(
    positive: Any,
    negative: Any,
    vae: Any,
    image_tensor: torch.Tensor,
    mask: torch.Tensor,
    grow_mask_by: int,
    draw_id: str = "unknown",
) -> tuple[Any, Any, dict[str, Any]]:
    import node_helpers
    import nodes

    try:
        encoded = nodes.InpaintModelConditioning().encode(
            positive=positive,
            negative=negative,
            pixels=image_tensor,
            vae=vae,
            mask=mask,
            noise_mask=True,
        )
        if isinstance(encoded, tuple) and len(encoded) >= 3 and isinstance(encoded[2], dict):
            native_positive, native_negative, native_latent = encoded[:3]
            _uc_log(
                draw_id,
                "InpaintModelConditioning returned",
                {
                    "positive": _conditioning_debug(native_positive),
                    "negative": _conditioning_debug(native_negative),
                    "latent": _latent_debug(native_latent),
                },
            )
            return native_positive, native_negative, native_latent
        _uc_log(draw_id, "InpaintModelConditioning returned unexpected output", {"type": type(encoded).__name__})
    except Exception as exc:
        _uc_log(draw_id, "InpaintModelConditioning failed; using manual fallback", {"error": str(exc)})

    encode_pixels, noise_mask = _prepare_noise_mask_for_latent(vae, image_tensor, mask, grow_mask_by)
    masked_pixels = encode_pixels.clone()
    pixel_mask = noise_mask.round().squeeze(1)
    for channel in range(3):
        masked_pixels[:, :, :, channel] -= 0.5
        masked_pixels[:, :, :, channel] *= 1.0 - pixel_mask
        masked_pixels[:, :, :, channel] += 0.5

    latent = nodes.VAEEncode().encode(vae, encode_pixels)[0]
    latent["noise_mask"] = noise_mask
    concat_latent = nodes.VAEEncode().encode(vae, masked_pixels)[0]["samples"]
    positive = node_helpers.conditioning_set_values(
        positive,
        {"concat_latent_image": concat_latent, "concat_mask": noise_mask},
    )
    negative = node_helpers.conditioning_set_values(
        negative,
        {"concat_latent_image": concat_latent, "concat_mask": noise_mask},
    )
    _uc_log(
        draw_id,
        "manual inpaint conditioning returned",
        {
            "positive": _conditioning_debug(positive),
            "negative": _conditioning_debug(negative),
            "latent": _latent_debug(latent),
        },
    )
    return positive, negative, latent


def _prepare_masked_generation_latent(
    model_module: "UniCanvasModelModule",
    mode: str,
    positive: Any,
    negative: Any,
    vae: Any,
    image_tensor: torch.Tensor,
    mask: torch.Tensor,
    grow_mask_by: int,
    draw_id: str = "unknown",
    gen_settings: dict[str, Any] | None = None,
) -> tuple[Any, Any, dict[str, Any]]:
    if model_module.key == "qwen_image_edit":
        _uc_log(
            draw_id,
            "Qwen Image Edit masked latent uses prepared reference latent",
            {"reason": "Qwen Image Edit 2511 edits from reference_latents instead of SDXL inpaint conditioning"},
        )
        batch_size = max(1, int((gen_settings or {}).get("batch_size", 1) or 1))
        return positive, negative, {
            "samples": torch.zeros(
                [batch_size, 16, max(1, image_tensor.shape[1] // 8), max(1, image_tensor.shape[2] // 8)],
                dtype=image_tensor.dtype,
            )
        }

    if model_module.key == "z_image" and bool((gen_settings or {}).get("fun_controlnet_inpaint", True)):
        latent = _encode_source_latent(vae, image_tensor, mask, grow_mask_by, draw_id=draw_id)
        _uc_log(
            draw_id,
            "Z-image Fun ControlNet source latent returned",
            {
                "reason": "Fun ControlNet workflow uses VAE-encoded current source latent instead of an empty latent",
                "latent": _latent_debug(latent),
            },
        )
        return positive, negative, latent

    if model_module.key == "anima" and bool((gen_settings or {}).get("anima_lllite_inpaint", True)):
        latent = model_module.create_empty_latent(
            int(image_tensor.shape[2]),
            int(image_tensor.shape[1]),
            gen_settings or {},
            draw_id=draw_id,
        )
        _uc_log(
            draw_id,
            "Anima LLLite empty latent returned",
            {
                "reason": "Anima LLLite inpaint workflow uses an empty latent; structure comes through the bundled LLLite model wrapper",
                "latent": _latent_debug(latent),
            },
        )
        return positive, negative, latent

    if mode == "inpaint":
        positive, negative, native_latent = _prepare_inpaint_model_conditioning(
            positive=positive,
            negative=negative,
            vae=vae,
            image_tensor=image_tensor,
            mask=mask,
            grow_mask_by=grow_mask_by,
            draw_id=draw_id,
        )
        source_latent = _encode_source_latent(vae, image_tensor, mask, grow_mask_by, draw_id=draw_id)
        _uc_log(
            draw_id,
            "hybrid inpaint latent returned",
            {
                "reason": "keep native InpaintModelConditioning concat context while using source-preserving encoded latent",
                "native_latent": _latent_debug(native_latent),
                "source_latent": _latent_debug(source_latent),
            },
        )
        return positive, negative, source_latent

    if not model_module.uses_edit_masked_latents(mode):
        return _prepare_inpaint_model_conditioning(
            positive=positive,
            negative=negative,
            vae=vae,
            image_tensor=image_tensor,
            mask=mask,
            grow_mask_by=grow_mask_by,
            draw_id=draw_id,
        )

    latent = _encode_source_latent(vae, image_tensor, mask, grow_mask_by, draw_id=draw_id)
    return positive, negative, latent


def _create_empty_generation_latent(width: int, height: int, gen_settings: dict[str, Any], draw_id: str = "unknown") -> dict[str, Any]:
    module = _get_unicanvas_model_module(str(gen_settings.get("generation_mode", "illustrious")).lower())
    return module.create_empty_latent(width, height, gen_settings, draw_id=draw_id)


def _ensure_direct_sampling_prompt_context(prompt_id: str = "unicanvas_draw") -> None:
    try:
        from server import PromptServer

        if not hasattr(PromptServer.instance, "last_prompt_id"):
            PromptServer.instance.last_prompt_id = prompt_id
    except Exception:
        pass


def _install_direct_sampling_progress_suppressor() -> None:
    global _COMFY_PROGRESS_PATCHED
    if _COMFY_PROGRESS_PATCHED:
        return
    with _COMFY_PROGRESS_PATCH_LOCK:
        if _COMFY_PROGRESS_PATCHED:
            return
        try:
            from server import PromptServer

            instance = PromptServer.instance
            original_send_sync = getattr(instance, "send_sync", None)
            if not callable(original_send_sync):
                _COMFY_PROGRESS_PATCHED = True
                return
            if getattr(original_send_sync, "_vnccs_unicanvas_progress_guard", False):
                _COMFY_PROGRESS_PATCHED = True
                return

            def guarded_send_sync(*args: Any, **kwargs: Any):
                event = args[0] if args else kwargs.get("event")
                if event == "progress" and getattr(_COMFY_PROGRESS_LOCAL, "suppress", 0):
                    return None
                return original_send_sync(*args, **kwargs)

            guarded_send_sync._vnccs_unicanvas_progress_guard = True  # type: ignore[attr-defined]
            setattr(instance, "send_sync", guarded_send_sync)
        except Exception:
            pass
        _COMFY_PROGRESS_PATCHED = True


@contextlib.contextmanager
def _suppress_direct_sampling_comfy_progress():
    _install_direct_sampling_progress_suppressor()
    depth = int(getattr(_COMFY_PROGRESS_LOCAL, "suppress", 0) or 0)
    _COMFY_PROGRESS_LOCAL.suppress = depth + 1
    try:
        yield
    finally:
        if depth:
            _COMFY_PROGRESS_LOCAL.suppress = depth
        else:
            try:
                delattr(_COMFY_PROGRESS_LOCAL, "suppress")
            except AttributeError:
                pass


def _sample_generation_latent_default(
    model: Any,
    positive: Any,
    negative: Any,
    latent: Any,
    seed: int,
    steps: int,
    cfg: float,
    sampler_name: str,
    scheduler: str,
    denoise: float,
    gen_settings: dict[str, Any],
    draw_id: str = "unknown",
):
    import nodes

    _ensure_direct_sampling_prompt_context()
    _uc_log(
        draw_id,
        "KSampler input",
        {
            "seed": seed,
            "steps": steps,
            "cfg": cfg,
            "sampler_name": sampler_name,
            "scheduler": scheduler,
            "denoise": denoise,
            "latent": _latent_debug(latent),
        },
    )

    def on_step(step: int, *_args: Any) -> None:
        current = min(max(int(step) + 1, 1), max(steps, 1))
        _set_draw_progress(draw_id, "sampling", 0.35 + 0.5 * (current / max(steps, 1)), current, steps, f"Sampling step {current}/{steps}")

    kwargs = dict(
        model=model,
        seed=seed,
        steps=steps,
        cfg=cfg,
        sampler_name=sampler_name,
        scheduler=scheduler,
        positive=positive,
        negative=negative,
        latent=latent,
        denoise=denoise,
    )
    try:
        sig = inspect.signature(nodes.common_ksampler)
        if "callback" in sig.parameters:
            kwargs["callback"] = on_step
        _set_draw_progress(draw_id, "sampling", 0.35, 0, steps, f"Sampling 0/{steps}")
        with _suppress_direct_sampling_comfy_progress():
            sampled = nodes.common_ksampler(**kwargs)[0]
        _uc_log(draw_id, "common_ksampler output", _latent_debug(sampled))
        return sampled
    except Exception as exc:
        _uc_log(draw_id, "common_ksampler with progress failed; falling back to KSampler", {"error": str(exc)})

    _set_draw_progress(draw_id, "sampling", 0.35, 0, steps, f"Sampling 0/{steps}")
    with _suppress_direct_sampling_comfy_progress():
        sampled = _call_node_method(
            ["KSampler"],
            ["sample"],
            model=model,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            positive=positive,
            negative=negative,
            latent_image=latent,
            latent=latent,
            denoise=denoise,
        )
    _set_draw_progress(draw_id, "sampling", 0.85, steps, steps, f"Sampling {steps}/{steps}")
    if isinstance(sampled, tuple) and sampled:
        _uc_log(draw_id, "KSampler tuple output", _latent_debug(sampled[0]))
        return sampled[0]
    if sampled is not None:
        _uc_log(draw_id, "KSampler output", _latent_debug(sampled))
        return sampled
    raise RuntimeError("Sampler returned no latent output")


def _sample_generation_latent(
    model: Any,
    positive: Any,
    negative: Any,
    latent: Any,
    seed: int,
    steps: int,
    cfg: float,
    sampler_name: str,
    scheduler: str,
    denoise: float,
    gen_settings: dict[str, Any],
    draw_id: str = "unknown",
    width: int | None = None,
    height: int | None = None,
):
    module = _get_unicanvas_model_module(str(gen_settings.get("generation_mode", "illustrious")).lower())
    return module.sample_latent(
        model=model,
        positive=positive,
        negative=negative,
        latent=latent,
        seed=seed,
        steps=steps,
        cfg=cfg,
        sampler_name=sampler_name,
        scheduler=scheduler,
        denoise=denoise,
        gen_settings=gen_settings,
        draw_id=draw_id,
        width=width,
        height=height,
    )


def _unwrap_latent_samples(value: Any):
    while isinstance(value, (list, tuple)) and value:
        value = value[0]
    seen_ids = set()
    while isinstance(value, dict) and "samples" in value:
        value_id = id(value)
        if value_id in seen_ids:
            break
        seen_ids.add(value_id)
        value = value["samples"]
        while isinstance(value, (list, tuple)) and value:
            value = value[0]
    return value


def _decode_generation_samples(vae: Any, samples: Any, gen_settings: dict[str, Any]):
    module = _get_unicanvas_model_module(str(gen_settings.get("generation_mode", "illustrious")).lower())
    return module.decode_samples(vae, samples, gen_settings)


def _preload_vae_for_direct_decode(vae: Any, gen_settings: dict[str, Any], draw_id: str = "unknown") -> None:
    generation_mode = str((gen_settings or {}).get("generation_mode") or "").lower()
    draw_mode = str((gen_settings or {}).get("draw_mode") or "").lower()
    if generation_mode not in {"z_image", "z-image", "zimage", "z_image_turbo"} or draw_mode not in {"inpaint", "outpaint"}:
        return

    patcher = getattr(vae, "patcher", None)
    if patcher is None:
        _uc_log(draw_id, "VAE preload skipped", {"reason": "VAE has no patcher"})
        return

    try:
        import comfy.model_management as model_management

        load_models_gpu = getattr(model_management, "load_models_gpu", None)
        if not callable(load_models_gpu):
            _uc_log(draw_id, "VAE preload skipped", {"reason": "model_management.load_models_gpu is unavailable"})
            return

        kwargs = {}
        with contextlib.suppress(Exception):
            sig = inspect.signature(load_models_gpu)
            if "memory_required" in sig.parameters:
                kwargs["memory_required"] = 0
        load_models_gpu([patcher], **kwargs)
        _uc_log(draw_id, "VAE preloaded before Z-image sampling", {"kwargs": kwargs})
    except Exception as exc:
        _uc_log(draw_id, "VAE preload failed", {"error": str(exc)})


def _unload_vae_after_direct_decode(vae: Any, gen_settings: dict[str, Any], draw_id: str = "unknown") -> None:
    generation_mode = str((gen_settings or {}).get("generation_mode") or "").lower()
    draw_mode = str((gen_settings or {}).get("draw_mode") or "").lower()
    if generation_mode not in {"z_image", "z-image", "zimage", "z_image_turbo"} or draw_mode not in {"inpaint", "outpaint"}:
        return

    patcher = getattr(vae, "patcher", None)
    if patcher is None:
        return

    try:
        import comfy.model_management as model_management

        loaded_models = getattr(model_management, "current_loaded_models", None)
        if not isinstance(loaded_models, list):
            _uc_log(draw_id, "VAE post-decode unload skipped", {"reason": "current_loaded_models is unavailable"})
            return

        unloaded = 0
        for index in range(len(loaded_models) - 1, -1, -1):
            loaded_model = loaded_models[index]
            if getattr(loaded_model, "model", None) is not patcher:
                continue
            try:
                loaded_model.model_unload(1e30)
            finally:
                loaded_models.pop(index)
            unloaded += 1

        gc.collect()
        with contextlib.suppress(Exception):
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        _uc_log(draw_id, "VAE unloaded after direct decode", {"unloaded": unloaded})
    except Exception as exc:
        _uc_log(draw_id, "VAE post-decode unload failed", {"error": str(exc)})


def _release_generation_sampling_refs(gen_settings: dict[str, Any], draw_id: str = "unknown") -> None:
    released_keys = []
    for key in (
        "_z_image_fun_controlnet_image",
        "_z_image_fun_controlnet_mask",
        "_z_image_fun_controlnet_vae",
        "_z_image_fun_controlnet_patch_model",
        "_anima_lllite_image",
        "_anima_lllite_mask",
        "_qwen_edit_reference_image",
        "_qwen_edit_mask",
        "_qwen_edit_latent",
    ):
        if key in gen_settings:
            gen_settings.pop(key, None)
            released_keys.append(key)
    gc.collect()
    with contextlib.suppress(Exception):
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    if released_keys:
        _uc_log(draw_id, "released sampling-only references before VAE decode", {"keys": released_keys})


def _save_temp_image(image: Image.Image, prefix: str = "VNCCS_UniCanvas") -> dict[str, str]:
    import folder_paths

    output_dir = folder_paths.get_temp_directory()
    full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        prefix, output_dir, image.width, image.height
    )
    file = f"{filename}_{counter:05}_.png"
    image.save(f"{full_output_folder}/{file}", compress_level=1)
    return {"filename": file, "subfolder": subfolder, "type": "temp"}


def _get_checkpoint_names() -> list[str]:
    return _safe_filename_list("checkpoints")


def _get_diffusion_model_names() -> list[str]:
    return [name for name in _safe_filename_list("diffusion_models") if not str(name).lower().endswith(".gguf")]


def _get_gguf_model_names() -> list[str]:
    names = _get_node_combo_values(["UnetLoaderGGUF", "UNETLoaderGGUF", "GGUF Loader"], "unet_name")
    if names:
        return names
    for category in ("diffusion_models", "unet"):
        for name in _safe_filename_list(category):
            if str(name).lower().endswith(".gguf") and name not in names:
                names.append(name)
    return names


def _unicanvas_presets_path() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "config", "unicanvas_presets.json"))


def _unicanvas_models_root() -> str:
    try:
        import folder_paths

        base = getattr(folder_paths, "base_path", os.getcwd())
        return os.path.abspath(getattr(folder_paths, "models_dir", os.path.join(base, "models")))
    except Exception:
        return os.path.abspath(os.path.join(os.getcwd(), "models"))


def _unicanvas_temp_dir() -> str:
    try:
        import folder_paths

        base = getattr(folder_paths, "base_path", os.getcwd())
        temp_dir = getattr(folder_paths, "get_temp_directory", lambda: os.path.join(base, "temp"))()
        return os.path.abspath(temp_dir)
    except Exception:
        return os.path.abspath(tempfile.gettempdir())


def _unicanvas_max_download_bytes() -> int:
    return _PRESET_DEFAULT_MAX_DOWNLOAD_BYTES


def _unicanvas_validate_model_filename(path: str) -> None:
    ext = os.path.splitext(str(path or ""))[1].lower()
    if ext not in _PRESET_MODEL_FILE_EXTENSIONS:
        allowed = ", ".join(sorted(_PRESET_MODEL_FILE_EXTENSIONS))
        raise ValueError(f"Unsupported model file extension '{ext}'. Allowed: {allowed}")


def _unicanvas_resolve_local_model_path(local_path: str) -> str:
    normalized = str(local_path or "").strip().replace("\\", "/")
    if not normalized:
        raise ValueError("Preset asset local_path is required")
    if _is_absolute_any_os(normalized):
        raise ValueError("Preset asset local_path must be relative")
    parts = [part for part in normalized.split("/") if part]
    if len(parts) < 3 or parts[0] != "models":
        raise ValueError("Preset asset local_path must use 'models/<folder>/<file>'")
    if any(part in {".", ".."} for part in parts):
        raise ValueError("Preset asset local_path contains path traversal")
    _unicanvas_validate_model_filename(parts[-1])
    root = _unicanvas_models_root()
    target = os.path.abspath(os.path.join(root, *parts[1:]))
    if os.path.commonpath([root, target]) != root:
        raise ValueError("Preset asset local_path escapes ComfyUI models directory")
    return target


def _unicanvas_asset_rel_name(local_path: str) -> str:
    normalized = str(local_path or "").strip().replace("\\", "/")
    parts = [part for part in normalized.split("/") if part]
    if len(parts) < 3 or parts[0] != "models":
        return os.path.basename(normalized)
    folder = parts[1]
    tail = "/".join(parts[2:])
    if folder in {"checkpoints", "loras"}:
        return tail
    return os.path.basename(tail)


def _unicanvas_load_preset_registry() -> dict[str, Any]:
    path = _unicanvas_presets_path()
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    presets = data.get("presets") if isinstance(data, dict) else None
    if not isinstance(presets, list):
        raise ValueError("unicanvas_presets.json must contain a presets array")
    return {"presets": presets}


def _unicanvas_enrich_asset(entry: dict[str, Any], download_key: str) -> dict[str, Any]:
    enriched = dict(entry)
    local_path = str(enriched.get("local_path") or "")
    target_path = _unicanvas_resolve_local_model_path(local_path) if local_path else ""
    status = _PRESET_DOWNLOAD_STATUS.get(download_key) or {}
    enriched["download_key"] = download_key
    enriched["relative_name"] = _unicanvas_asset_rel_name(local_path)
    enriched["installed"] = bool(target_path and os.path.exists(target_path))
    enriched["status"] = status.get("status") or ("installed" if enriched["installed"] else "missing")
    enriched["message"] = status.get("message") or ("Installed" if enriched["installed"] else "Missing")
    if "progress" in status:
        enriched["progress"] = status.get("progress")
    return enriched


def _get_unicanvas_presets() -> dict[str, Any]:
    registry = _unicanvas_load_preset_registry()
    presets = []
    for raw_preset in registry.get("presets", []):
        if not isinstance(raw_preset, dict):
            continue
        preset = dict(raw_preset)
        preset_id = str(preset.get("id") or "")
        assets = []
        for index, raw_asset in enumerate(preset.get("assets") or []):
            if isinstance(raw_asset, dict):
                assets.append(_unicanvas_enrich_asset(raw_asset, f"{preset_id}:asset:{index}"))
        preset["assets"] = assets
        turbo = preset.get("turbo")
        if isinstance(turbo, dict) and isinstance(turbo.get("asset"), dict):
            turbo = dict(turbo)
            turbo["asset"] = _unicanvas_enrich_asset(turbo["asset"], f"{preset_id}:turbo")
            preset["turbo"] = turbo
        preset["installed"] = bool(assets) and all(bool(asset.get("installed")) for asset in assets)
        if not assets:
            preset["installed"] = False
            preset["status"] = "manual"
            preset["message"] = "Preset only"
        elif any(asset.get("status") in {"queued", "downloading"} for asset in assets):
            preset["status"] = "downloading"
            preset["message"] = "Downloading"
        elif preset["installed"]:
            preset["status"] = "installed"
            preset["message"] = "Installed"
        else:
            preset["status"] = "missing"
            preset["message"] = "Missing"
        presets.append(preset)
    return {"presets": presets, "downloads": dict(_PRESET_DOWNLOAD_STATUS)}


def _unicanvas_find_preset_asset(preset_id: str, asset_kind: str, asset_index: int = 0) -> tuple[str, dict[str, Any]]:
    registry = _unicanvas_load_preset_registry()
    for preset in registry.get("presets", []):
        if not isinstance(preset, dict) or str(preset.get("id") or "") != preset_id:
            continue
        if asset_kind == "turbo":
            turbo = preset.get("turbo")
            asset = turbo.get("asset") if isinstance(turbo, dict) else None
            if isinstance(asset, dict):
                return f"{preset_id}:turbo", asset
            raise ValueError("Preset has no turbo asset")
        assets = preset.get("assets") or []
        if asset_index < 0 or asset_index >= len(assets) or not isinstance(assets[asset_index], dict):
            raise ValueError("Preset asset not found")
        return f"{preset_id}:asset:{asset_index}", assets[asset_index]
    raise ValueError(f"Preset '{preset_id}' not found")


def _unicanvas_validate_download_response(response: Any, expected_name: str) -> tuple[int, int]:
    url = str(getattr(response, "url", "") or "")
    if not url.startswith("https://"):
        raise ValueError("Preset download URL must use HTTPS")
    total_size = int(response.headers.get("content-length", 0) or 0)
    max_bytes = _unicanvas_max_download_bytes()
    if total_size > max_bytes:
        raise ValueError(
            f"{expected_name} is too large to download safely "
            f"({total_size / (1024 * 1024 * 1024):.1f} GB, limit {max_bytes / (1024 * 1024 * 1024):.1f} GB)"
        )
    return total_size, max_bytes


def _unicanvas_validate_downloaded_file(path: str, expected_name: str) -> None:
    size = os.path.getsize(path)
    if size < _PRESET_MIN_MODEL_FILE_SIZE:
        raise ValueError(f"{expected_name} is too small to be a valid model file ({size} bytes)")
    _unicanvas_validate_model_filename(expected_name)


def _unicanvas_download_worker_loop() -> None:
    while True:
        download_key, asset = _PRESET_DOWNLOAD_QUEUE.get()
        temp_path = ""
        try:
            target_path = _unicanvas_resolve_local_model_path(str(asset.get("local_path") or ""))
            if os.path.exists(target_path):
                _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "success", "message": "Installed", "progress": 100}
                continue
            _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "downloading", "message": "Initializing", "progress": 0}
            if asset.get("url"):
                url = str(asset.get("url") or "")
            else:
                from huggingface_hub import hf_hub_url

                repo_id = str(asset.get("hf_repo") or "")
                filename = str(asset.get("hf_path") or "")
                if not repo_id or not filename:
                    raise ValueError("Preset asset needs hf_repo and hf_path")
                if filename.startswith(f"{repo_id}/"):
                    filename = filename[len(repo_id) + 1 :]
                url = hf_hub_url(repo_id, filename)

            if not url.startswith("https://"):
                raise ValueError("Preset download URL must use HTTPS")

            import requests

            response = requests.get(url, stream=True, allow_redirects=True, timeout=_PRESET_DOWNLOAD_TIMEOUT)
            response.raise_for_status()
            expected_name = os.path.basename(target_path)
            total_size, max_bytes = _unicanvas_validate_download_response(response, expected_name)
            temp_dir = _unicanvas_temp_dir()
            os.makedirs(temp_dir, exist_ok=True)
            temp_path = os.path.join(temp_dir, f"vnccs_unicanvas_{re.sub(r'[^A-Za-z0-9]+', '_', download_key)}.tmp")
            downloaded = 0
            with open(temp_path, "wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    handle.write(chunk)
                    downloaded += len(chunk)
                    if downloaded > max_bytes:
                        raise ValueError(f"{expected_name} exceeded max download size")
                    mb_done = downloaded / (1024 * 1024)
                    if total_size > 0:
                        mb_total = total_size / (1024 * 1024)
                        _PRESET_DOWNLOAD_STATUS[download_key] = {
                            "status": "downloading",
                            "message": f"{mb_done:.1f}/{mb_total:.1f} MB",
                            "progress": (downloaded / total_size) * 100,
                        }
                    else:
                        _PRESET_DOWNLOAD_STATUS[download_key] = {
                            "status": "downloading",
                            "message": f"{mb_done:.1f} MB",
                            "progress": 0,
                        }
            _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "downloading", "message": "Validating", "progress": 99}
            _unicanvas_validate_downloaded_file(temp_path, expected_name)
            os.makedirs(os.path.dirname(target_path), exist_ok=True)
            shutil.move(temp_path, target_path)
            _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "success", "message": "Installed", "progress": 100}
        except Exception as exc:
            if temp_path and os.path.exists(temp_path):
                with contextlib.suppress(Exception):
                    os.remove(temp_path)
            _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "error", "message": str(exc)}
        finally:
            _PRESET_DOWNLOAD_QUEUE.task_done()


threading.Thread(target=_unicanvas_download_worker_loop, daemon=True).start()


def _get_unicanvas_assets() -> dict[str, Any]:
    try:
        import comfy.samplers

        samplers = list(comfy.samplers.KSampler.SAMPLERS)
        schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
    except Exception:
        samplers = []
        schedulers = []
    return {
        "model_modules": [
            {
                "key": module.key,
                "aliases": list(module.aliases),
                "defaults": module.defaults,
                "is_edit_model": module.is_edit_model,
            }
            for module in {module.key: module for module in UNICANVAS_MODEL_MODULES.values()}.values()
        ],
        "model_loaders": [
            {
                "key": loader.key,
                "aliases": list(loader.aliases),
                "forced_mode": loader.forced_mode,
            }
            for loader in {loader.key: loader for loader in UNICANVAS_MODEL_LOADERS.values()}.values()
        ],
        "checkpoints": _safe_filename_list("checkpoints"),
        "diffusion_models": _get_diffusion_model_names(),
        "gguf_models": _get_gguf_model_names(),
        "text_encoders": _safe_filename_list("text_encoders"),
        "vae_models": _safe_filename_list("vae"),
        "model_patches": _safe_filename_list("model_patches"),
        "loras": _safe_filename_list("loras"),
        "samplers": samplers,
        "schedulers": schedulers,
    }


def _load_checkpoint(ckpt_name: str):
    return _load_generation_assets({"generation_mode": "illustrious", "ckpt_name": ckpt_name})


def _encode_prompt(clip: Any, text: str):
    return _encode_generation_prompt(clip, text, {"generation_mode": "illustrious"})


def _run_unicanvas_draw(payload: dict[str, Any]) -> dict[str, Any]:
    draw_id = str(payload.get("debug_id") or f"{int(time.time() * 1000)}")
    _set_draw_progress(draw_id, "queued", 0.01, 0, 0, "Queued")
    mode = str(payload.get("mode") or "img2img")
    if mode not in {"txt2img", "img2img", "inpaint", "outpaint"}:
        raise ValueError("mode must be txt2img, img2img, inpaint or outpaint")

    settings = _normalize_gen_settings(payload.get("settings") or {})
    settings["draw_mode"] = mode
    seed = int(settings.get("seed", 0))
    batch_size = max(1, min(99, int(settings.get("batch_size", 1) or 1)))
    settings["batch_size"] = batch_size
    steps = int(settings.get("steps", 24))
    cfg = float(settings.get("cfg", 7.0))
    denoise = float(settings.get("denoise", 0.65 if mode == "img2img" else 1.0))
    if mode == "txt2img":
        denoise = 1.0
    sampler_name = str(settings.get("sampler_name") or settings.get("sampler") or "euler")
    scheduler = str(settings.get("scheduler") or "normal")
    grow_mask_by = int(settings.get("grow_mask_by", 6))
    mask_blur = int(settings.get("mask_blur", 16))
    coherence_edge_size = int(settings.get("canvas_coherence_edge_size", 16))
    positive_text = str(settings.get("positive", ""))
    model_module = _get_unicanvas_model_module(str(settings.get("generation_mode", "illustrious")).lower())
    outpaint_prompt_suffix = model_module.outpaint_prompt_suffix() if mode == "outpaint" else ""
    if outpaint_prompt_suffix:
        positive_text = _append_prompt_suffix(positive_text, outpaint_prompt_suffix)
    negative_text = str(settings.get("negative", ""))
    _uc_log(
        draw_id,
        "request",
        {
            "mode": mode,
            "bbox": payload.get("bbox"),
            "inference_size": payload.get("inference_size"),
            "output_size": payload.get("output_size"),
            "source_empty": payload.get("source_empty"),
            "frontend_debug": payload.get("debug"),
            "generation_mode": settings.get("generation_mode"),
            "model_loader": settings.get("model_loader"),
            "ckpt_name": settings.get("ckpt_name"),
            "diffusion_model_name": settings.get("diffusion_model_name"),
            "gguf_model_name": settings.get("gguf_model_name"),
            "clip_name": settings.get("clip_name"),
            "clip_type": settings.get("clip_type"),
            "vae_name": settings.get("vae_name"),
            "lora_stack_count": len(settings.get("lora_stack") or []) if isinstance(settings.get("lora_stack"), list) else None,
            "mode_settings_keys": sorted(str(key) for key in settings.get("mode_settings", {}).keys()) if isinstance(settings.get("mode_settings"), dict) else None,
            "turbo_enabled": settings.get("turbo_enabled"),
            "seed": seed,
            "batch_size": batch_size,
            "steps": steps,
            "cfg": cfg,
            "denoise": denoise,
            "sampler_name": sampler_name,
            "scheduler": scheduler,
            "grow_mask_by": grow_mask_by,
            "mask_blur": mask_blur,
            "canvas_coherence_edge_size": coherence_edge_size,
            "outpaint_prompt_suffix": outpaint_prompt_suffix or None,
            "positive_len": len(positive_text),
            "negative_len": len(negative_text),
        },
    )

    source_rgba = _decode_data_url(str(payload.get("image") or ""), "RGBA")
    source = source_rgba.convert("RGB")
    reference_source = source
    source_for_composite = source
    width, height = source.size
    source_empty = bool(payload.get("source_empty"))
    inference_payload = payload.get("inference_size") or {}
    expected_width = int(inference_payload.get("width") or width)
    expected_height = int(inference_payload.get("height") or height)
    if (width, height) != (expected_width, expected_height):
        raise ValueError(
            f"inference_size mismatch: payload says {expected_width}x{expected_height}, image is {width}x{height}"
        )
    output_payload = payload.get("output_size") or {}
    output_width = int(output_payload.get("width") or width)
    output_height = int(output_payload.get("height") or height)
    if output_width < 1 or output_height < 1:
        raise ValueError("output_size must be positive")
    if output_width * output_height > _MAX_PIXELS:
        raise ValueError("output_size is too large")

    with contextlib.ExitStack() as _model_stack:
        _model_stack.enter_context(_COMFY_MODEL_OP_LOCK)
        _model_stack.enter_context(torch.inference_mode())
        if True:
            _set_draw_progress(draw_id, "loading", 0.08, 0, steps, "Loading models")
            model, clip, vae = _load_generation_assets(settings)
            model, clip = model_module.clone_assets(model, clip)
            settings["_draw_id"] = draw_id
            _preload_z_image_fun_controlnet_patch(settings, mode, draw_id)
            _preload_vae_for_direct_decode(vae, settings, draw_id)
            if model_module.key == "qwen_image_edit":
                settings["_qwen_edit_clip"] = clip
                settings["_qwen_edit_vae"] = vae
            _set_draw_progress(draw_id, "loras", 0.14, 0, steps, "Applying LoRAs")
            model, clip = _apply_generation_loras(model, clip, settings)
            if model_module.key == "qwen_image_edit":
                settings["_qwen_edit_clip"] = clip
            _set_draw_progress(draw_id, "conditioning", 0.2, 0, steps, "Encoding prompts")
            if model_module.key == "qwen_image_edit":
                positive = []
                negative = []
                _uc_log(
                    draw_id,
                    "Qwen Image Edit prompt encoding deferred",
                    {"reason": "Qwen Image Edit 2511 needs the prepared reference image and VL image tokens"},
                )
            else:
                positive = _encode_generation_prompt(clip, positive_text, settings)
                negative = _encode_generation_prompt(clip, negative_text, settings)
                model_module.validate_conditioning(positive, negative, settings)

        mask = None
        mask_image = None
        paste_mask_image = None
        _set_draw_progress(draw_id, "preparing", 0.26, 0, steps, "Preparing source")
        if mode in {"inpaint", "outpaint"}:
            mask_image = _decode_data_url(str(payload.get("mask") or ""), "RGBA")
            if mask_image.size != source.size:
                _uc_log(draw_id, "mask resized to source size", {"from": mask_image.size, "to": source.size})
                mask_image = mask_image.resize(source.size, Image.Resampling.BILINEAR)
            if mode == "outpaint":
                mask_image = _combine_mask_with_source_alpha(mask_image, source_rgba)
                denoise_mask_image, expanded_mask_area = _make_gradient_denoise_mask(
                    mask_image, coherence_edge_size, draw_id
                )
                paste_mask_image = _make_gradient_paste_mask(expanded_mask_area, mask_blur, draw_id)
                source = model_module.prepare_outpaint_reference_image(source_rgba, mask_image, draw_id)
                reference_source = source
                source_for_composite = source_rgba.convert("RGB")
                mask = _pil_to_mask_tensor(denoise_mask_image)
            else:
                denoise_mask_image, expanded_mask_area = _make_gradient_denoise_mask(
                    mask_image, coherence_edge_size, draw_id
                )
                paste_mask_image = _make_gradient_paste_mask(expanded_mask_area, mask_blur, draw_id)
                mask = _pil_to_mask_tensor(denoise_mask_image)
            if mask is not None and float(mask.sum().item()) <= 0.0:
                _uc_log(
                    draw_id,
                    "empty masked-mode mask converted to img2img",
                    {
                        "from_mode": mode,
                        "reason": "masked generation with an empty mask produces an empty paste mask and applies zero result pixels",
                    },
                )
                mode = "img2img"
                settings["draw_mode"] = mode
                if settings.pop("_z_image_fun_controlnet_patch_model", None) is not None:
                    gc.collect()
                    with contextlib.suppress(Exception):
                        if torch.cuda.is_available():
                            torch.cuda.empty_cache()
                    _uc_log(
                        draw_id,
                        "Z-image Fun ControlNet patch released after empty mask mode switch",
                        {"to_mode": mode},
                    )
                mask = None
                mask_image = None
                paste_mask_image = None
            if model_module.key == "qwen_image_edit" and mask is not None:
                settings["_qwen_edit_mask"] = mask
            if mask_image is not None:
                mask_for_debug = _pil_to_mask_image(mask_image)
                _uc_log(
                    draw_id,
                    "mask decoded",
                    {
                        "full_mask_size": mask_image.size,
                        "note": "active_bbox_gt_0_01 is only the non-zero mask area inside the full inference image",
                        "tensor": _tensor_debug(mask),
                    },
                )
                source_debug = _save_temp_image(source, f"VNCCS_UniCanvas_{draw_id}_source")
                mask_debug = _save_temp_image(mask_for_debug, f"VNCCS_UniCanvas_{draw_id}_mask")
                paste_mask_debug = _save_temp_image(paste_mask_image, f"VNCCS_UniCanvas_{draw_id}_paste_mask") if paste_mask_image is not None else None
                _uc_log(
                    draw_id,
                    "debug input images saved",
                    {"source": source_debug, "mask": mask_debug, "paste_mask": paste_mask_debug},
                )
        else:
            _uc_log(draw_id, "mask skipped", {"reason": f"mode is {mode}"})
        if model_module.is_edit_model and (mode == "txt2img" or source_empty):
            source = Image.new("RGB", (width, height), (0, 0, 0))
            reference_source = source
            source_for_composite = source
            _uc_log(draw_id, "edit-model txt2img source replaced with black reference image", {"size": source.size})
        image_tensor = _pil_to_image_tensor(source)
        reference_image_tensor = _pil_to_image_tensor(reference_source)
        _uc_log(
            draw_id,
            "source prepared",
            {
                "size": source.size,
                "tensor": _tensor_debug(image_tensor),
                "reference_size": reference_source.size,
                "reference_tensor": _tensor_debug(reference_image_tensor),
            },
        )
        if model_module.key == "z_image" and mode in {"inpaint", "outpaint"} and mask is not None:
            settings["_z_image_fun_controlnet_image"] = image_tensor
            settings["_z_image_fun_controlnet_mask"] = mask
            settings["_z_image_fun_controlnet_vae"] = vae
            _uc_log(
                draw_id,
                "Z-image Fun ControlNet inputs prepared",
                {
                    "mode": mode,
                    "image": _tensor_debug(image_tensor),
                    "mask": _tensor_debug(mask),
                    "patch": settings.get("fun_controlnet_patch_name"),
                },
            )
        if model_module.key == "anima" and mode in {"inpaint", "outpaint"} and mask is not None and bool(settings.get("anima_lllite_inpaint", True)):
            settings["_anima_lllite_image"] = image_tensor
            settings["_anima_lllite_mask"] = mask
            _uc_log(
                draw_id,
                "Anima LLLite inputs prepared",
                {
                    "mode": mode,
                    "image": _tensor_debug(image_tensor),
                    "mask": _tensor_debug(mask),
                    "weights": settings.get("anima_lllite_name"),
                },
            )
        positive, negative = model_module.prepare_reference_conditioning(
            positive=positive,
            negative=negative,
            vae=vae,
            image_tensor=reference_image_tensor,
            gen_settings=settings,
            draw_id=draw_id,
        )
        if (
            not model_module.is_edit_model
            and model_module.uses_differential_diffusion(mode)
            and mode in {"inpaint", "outpaint"}
            and mask is not None
        ):
            model = _apply_differential_diffusion(model, draw_id, strength=1.0)
        _set_draw_progress(draw_id, "latent", 0.32, 0, steps, "Preparing latent")
        if mode == "txt2img" or (source_empty and mask is None):
            latent = _create_empty_generation_latent(width, height, settings, draw_id=draw_id)
        elif mode in {"inpaint", "outpaint"} and mask is not None:
            positive, negative, latent = _prepare_masked_generation_latent(
                model_module=model_module,
                mode=mode,
                positive=positive,
                negative=negative,
                vae=vae,
                image_tensor=image_tensor,
                mask=mask,
                grow_mask_by=grow_mask_by,
                draw_id=draw_id,
                gen_settings=settings,
            )
        elif model_module.key == "qwen_image_edit" and isinstance(settings.get("_qwen_edit_latent"), dict):
            latent = settings["_qwen_edit_latent"]
            _uc_log(
                draw_id,
                "Qwen Image Edit uses encoder reference latent",
                {"reason": "matches VNCCS_QWEN_Encoder output latent", "latent": _latent_debug(latent)},
            )
        else:
            latent = _encode_source_latent(vae, image_tensor, None, grow_mask_by, draw_id=draw_id)
        latent = _repeat_latent_batch(latent, batch_size, draw_id)
        if model_module.key == "qwen_image_edit":
            settings["_qwen_edit_latent"] = latent
        positive = _repeat_conditioning_batch(positive, batch_size, draw_id, "positive")
        negative = _repeat_conditioning_batch(negative, batch_size, draw_id, "negative")
        latent = _sample_generation_latent(
            model=model,
            positive=positive,
            negative=negative,
            latent=latent,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            denoise=denoise,
            gen_settings=settings,
            draw_id=draw_id,
            width=width,
            height=height,
        )
        model = None
        clip = None
        positive = None
        negative = None
        image_tensor = None
        reference_image_tensor = None
        mask = None
        _release_generation_sampling_refs(settings, draw_id)
        _set_draw_progress(draw_id, "decoding", 0.88, steps, steps, "Decoding")
        decoded = _decode_generation_samples(vae, latent, settings)
        _uc_log(draw_id, "decoded image tensor", _tensor_debug(decoded))
        result_images = _image_tensor_to_pil_list(decoded)
        _unload_vae_after_direct_decode(vae, settings, draw_id)

    output_size = (output_width, output_height)
    if mode in {"inpaint", "outpaint"} and mask_image is not None:
        resized_images = []
        for result_image in result_images:
            if result_image.size != output_size:
                _uc_log(draw_id, "masked result resized to output size", {"from": result_image.size, "to": output_size})
                result_image = result_image.resize(output_size, Image.Resampling.LANCZOS)
            resized_images.append(result_image)
        result_images = resized_images
        _uc_log(
            draw_id,
            "masked-region output",
            {
                "note": "Returning raw generated pixels plus paste mask; frontend stores only masked regions as the layer.",
                "result_count": len(result_images),
                "result_size": result_images[0].size if result_images else output_size,
                "paste_mask_size": paste_mask_image.size if paste_mask_image is not None else mask_image.size,
            },
        )
    else:
        resized_images = []
        for result_image in result_images:
            if result_image.size != output_size:
                _uc_log(draw_id, "result resized to output size", {"from": result_image.size, "to": (output_width, output_height)})
                result_image = result_image.resize(output_size, Image.Resampling.LANCZOS)
            resized_images.append(result_image)
        result_images = resized_images

    _set_draw_progress(draw_id, "saving", 0.96, steps, steps, "Saving result")
    saved_images = [
        _save_temp_image(result_image, f"VNCCS_UniCanvas_{draw_id}_{index + 1:02d}")
        for index, result_image in enumerate(result_images)
    ]
    if not saved_images:
        raise RuntimeError("Generation returned no decoded images")
    saved = saved_images[0] if saved_images else None
    saved_mask = None
    if mode in {"inpaint", "outpaint"} and paste_mask_image is not None:
        mask_to_save = paste_mask_image
        if mask_to_save.size != output_size:
            mask_to_save = mask_to_save.resize(output_size, Image.Resampling.BILINEAR)
        saved_mask = _save_temp_image(mask_to_save, f"VNCCS_UniCanvas_{draw_id}_result_mask")
    _uc_log(draw_id, "result saved", {"image": saved, "images": saved_images, "mask": saved_mask, "count": len(saved_images), "size": output_size})
    _set_draw_progress(draw_id, "complete", 1.0, steps, steps, "Complete")
    return {
        "status": "ok",
        "image": saved,
        "images": saved_images,
        "mask": saved_mask,
        "width": output_width,
        "height": output_height,
        "inference_width": width,
        "inference_height": height,
        "generation_mode": settings.get("generation_mode", "illustrious"),
        "debug_id": draw_id,
    }


def _run_sdxl_draw(payload: dict[str, Any]) -> dict[str, Any]:
    return _run_unicanvas_draw(payload)


def _load_sam_model(model_key: str) -> tuple[Any, Any, Any]:
    key = model_key if model_key in SAM_MODEL_IDS else "sam2_large"
    with _MODEL_CACHE_LOCK:
        cached = _SAM_CACHE.get(key)
        if cached is not None:
            return cached

    model_id = SAM_MODEL_IDS[key]
    if key == "sam1_huge":
        from transformers.models.sam import SamModel
        from transformers.models.sam.processing_sam import SamProcessor

        model = SamModel.from_pretrained(model_id)
        processor = SamProcessor.from_pretrained(model_id)
    else:
        from transformers.models.sam2 import Sam2Model
        from transformers.models.sam2.processing_sam2 import Sam2Processor

        model = Sam2Model.from_pretrained(model_id)
        processor = Sam2Processor.from_pretrained(model_id)

    try:
        import comfy.model_management as model_management

        device = model_management.get_torch_device()
    except Exception:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if getattr(device, "type", None) not in {"cpu", "cuda"}:
        device = torch.device("cpu")
    model.to(device)
    model.eval()
    cached = (model, processor, device)
    with _MODEL_CACHE_LOCK:
        _SAM_CACHE[key] = cached
    return cached


def _largest_sam_mask(mask_batch: Any) -> torch.Tensor:
    masks = mask_batch[0] if isinstance(mask_batch, (list, tuple)) else mask_batch
    if isinstance(masks, np.ndarray):
        masks = torch.from_numpy(masks)
    masks = masks.detach().cpu()
    while masks.ndim > 3:
        masks = masks[0]
    if masks.ndim == 2:
        return masks > 0
    if masks.ndim != 3:
        raise RuntimeError(f"Unexpected SAM mask shape: {tuple(masks.shape)}")
    binary = masks > 0
    areas = binary.flatten(1).sum(dim=1)
    if not int(areas.max().item()):
        return binary[0]
    return binary[int(torch.argmax(areas).item())]


def _feature_value(features: Any, key: str) -> Any:
    try:
        if isinstance(features, dict):
            return features.get(key)
        data = getattr(features, "data", None)
        if isinstance(data, dict):
            return data.get(key)
        return getattr(features, key, None)
    except Exception:
        return None


def _to_cpu_tensor(value: Any) -> Any:
    return value.detach().cpu() if hasattr(value, "detach") else value


def _post_process_sam_masks(processor: Any, pred_masks: torch.Tensor, inputs: Any) -> Any:
    original_sizes = _to_cpu_tensor(_feature_value(inputs, "original_sizes"))
    reshaped_input_sizes = _to_cpu_tensor(_feature_value(inputs, "reshaped_input_sizes"))
    if original_sizes is None:
        raise RuntimeError("SAM processor returned no original image sizes")

    kwargs = {"masks": pred_masks.detach().cpu(), "original_sizes": original_sizes}
    signature = inspect.signature(processor.post_process_masks)
    if "reshaped_input_sizes" in signature.parameters:
        kwargs["reshaped_input_sizes"] = reshaped_input_sizes if reshaped_input_sizes is not None else original_sizes
    return processor.post_process_masks(**kwargs)


def _run_unicanvas_segment(payload: dict[str, Any]) -> dict[str, Any]:
    model_key = str(payload.get("model") or "sam2_large")
    model_key = model_key if model_key in SAM_MODEL_IDS else "sam2_large"
    points_payload = payload.get("points") or []
    if not isinstance(points_payload, list) or not points_payload:
        raise ValueError("SAM needs at least one point")

    image_rgba = _decode_data_url(str(payload.get("image") or ""), "RGBA")
    image = Image.new("RGB", image_rgba.size, (255, 255, 255))
    image.paste(image_rgba, mask=image_rgba.getchannel("A"))
    width, height = image.size

    points: list[list[float]] = []
    labels: list[int] = []
    for item in points_payload:
        if not isinstance(item, dict):
            continue
        x = float(item.get("x", -1))
        y = float(item.get("y", -1))
        if x < 0 or y < 0 or x >= width or y >= height:
            continue
        label = 0 if int(item.get("label", 1)) <= 0 else 1
        points.append([x, y])
        labels.append(label)
    if not points:
        raise ValueError("SAM points are outside the layer crop")

    with _COMFY_MODEL_OP_LOCK:
        model, processor, device = _load_sam_model(model_key)
        if model_key == "sam1_huge":
            processor_points = [points]
            processor_labels = [labels]
        else:
            processor_points = [[points]]
            processor_labels = [[labels]]
        inputs = processor(
            images=image,
            input_points=processor_points,
            input_labels=processor_labels,
            return_tensors="pt",
        )
        if hasattr(inputs, "to"):
            inputs = inputs.to(device)
        else:
            inputs = {key: value.to(device) if hasattr(value, "to") else value for key, value in inputs.items()}

        with torch.inference_mode():
            outputs = model(**inputs)

    pred_masks = getattr(outputs, "pred_masks", None)
    if pred_masks is None:
        raise RuntimeError("SAM returned no masks")
    masks = _post_process_sam_masks(processor, pred_masks, inputs)
    mask = _largest_sam_mask(masks)
    mask_np = (mask.numpy().astype(np.uint8) * 255)
    mask_image = Image.fromarray(mask_np, mode="L")
    if mask_image.size != image.size:
        mask_image = mask_image.resize(image.size, Image.Resampling.NEAREST)
    rgba_mask = Image.new("RGBA", image.size, (255, 255, 255, 0))
    rgba_mask.putalpha(mask_image)
    return {
        "status": "ok",
        "model": model_key,
        "mask": _encode_png_data_url(rgba_mask),
        "width": image.width,
        "height": image.height,
    }


def register_unicanvas_routes() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return

    @PromptServer.instance.routes.get("/vnccs/unicanvas/checkpoints")
    async def vnccs_unicanvas_checkpoints(_request):
        try:
            return web.json_response({"checkpoints": _get_checkpoint_names()})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/unicanvas/assets")
    async def vnccs_unicanvas_assets(_request):
        try:
            return web.json_response(_get_unicanvas_assets())
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/unicanvas/presets")
    async def vnccs_unicanvas_presets(_request):
        try:
            return web.json_response(_get_unicanvas_presets())
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/unicanvas/presets/status")
    async def vnccs_unicanvas_presets_status(_request):
        return web.json_response(dict(_PRESET_DOWNLOAD_STATUS))

    @PromptServer.instance.routes.post("/vnccs/unicanvas/presets/download")
    async def vnccs_unicanvas_presets_download(request):
        try:
            payload = await request.json()
            preset_id = str(payload.get("preset_id") or "")
            kind = str(payload.get("kind") or "assets")
            queued: list[str] = []
            if kind == "turbo":
                download_key, asset = _unicanvas_find_preset_asset(preset_id, "turbo")
                if not os.path.exists(_unicanvas_resolve_local_model_path(str(asset.get("local_path") or ""))):
                    _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "queued", "message": "Queued", "progress": 0}
                    _PRESET_DOWNLOAD_QUEUE.put((download_key, asset))
                queued.append(download_key)
            else:
                registry = _unicanvas_load_preset_registry()
                found = None
                for preset in registry.get("presets", []):
                    if isinstance(preset, dict) and str(preset.get("id") or "") == preset_id:
                        found = preset
                        break
                if found is None:
                    raise ValueError(f"Preset '{preset_id}' not found")
                for index, asset in enumerate(found.get("assets") or []):
                    if not isinstance(asset, dict):
                        continue
                    download_key = f"{preset_id}:asset:{index}"
                    if not os.path.exists(_unicanvas_resolve_local_model_path(str(asset.get("local_path") or ""))):
                        _PRESET_DOWNLOAD_STATUS[download_key] = {"status": "queued", "message": "Queued", "progress": 0}
                        _PRESET_DOWNLOAD_QUEUE.put((download_key, asset))
                    queued.append(download_key)
            return web.json_response({"status": "queued", "queued": queued})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.post("/vnccs/unicanvas/draw")
    async def vnccs_unicanvas_draw(request):
        if not _content_length_ok(request, _MAX_UPLOAD_BYTES * 2 + 1024 * 1024):
            return web.json_response({"error": "UniCanvas draw payload is too large"}, status=413)
        payload: dict[str, Any] = {}
        try:
            payload = await request.json()
            async with _DRAW_LOCK:
                result = await asyncio.to_thread(_run_unicanvas_draw, payload)
            return web.json_response(result)
        except Exception as exc:
            import traceback

            traceback.print_exc()
            draw_id = str(payload.get("debug_id") or "unknown")
            _set_draw_progress(draw_id, "error", 1.0, 0, 0, str(exc))
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.post("/vnccs/unicanvas/segment")
    async def vnccs_unicanvas_segment(request):
        if not _content_length_ok(request, _MAX_UPLOAD_BYTES + 1024 * 1024):
            return web.json_response({"error": "UniCanvas SAM payload is too large"}, status=413)
        try:
            payload = await request.json()
            result = await asyncio.to_thread(_run_unicanvas_segment, payload)
            return web.json_response(result)
        except Exception as exc:
            import traceback

            traceback.print_exc()
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/unicanvas/progress/{draw_id}")
    async def vnccs_unicanvas_progress(request):
        return web.json_response(_get_draw_progress(str(request.match_info.get("draw_id") or "")))


NODE_CLASS_MAPPINGS = {
    "VNCCS_UniCanvas": VNCCS_UniCanvas,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VNCCS_UniCanvas": "VNCCS UniCanvas",
}
