"""VNCCS UniCanvas - in-node canvas editor with direct modular draw actions."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import inspect
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
_MODEL_CACHE: dict[Any, tuple[Any, Any, Any]] = {}
_LORA_CACHE: dict[str, Any] = {}
_DRAW_PROGRESS: dict[str, dict[str, Any]] = {}
_DRAW_PROGRESS_LOCK = threading.Lock()
_MAX_UPLOAD_BYTES = 48 * 1024 * 1024
_MAX_PIXELS = 4096 * 4096
_UNICANVAS_STATE_CACHE_DIR = os.path.join(tempfile.gettempdir(), "vnccs_unicanvas_state_cache")
_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]+")

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
    "sampler": "er_sde",
    "sampler_name": "er_sde",
    "scheduler": "simple",
    "steps": 30,
    "cfg": 4.0,
    "turbo_enabled": False,
    "dmd_lora_name": "anima\\anima-turbo-lora-v0.1.safetensors",
    "dmd_lora_strength": 1.0,
    "lora_stack": [],
}

FLUX_KLEIN_DEFAULTS = {
    "generation_mode": "flux_klein",
    "model_loader": "diffusion_model",
    "diffusion_model_name": "flux-2-klein-9b-fp8.safetensors",
    "clip_name": "qwen_3_8b_fp8mixed.safetensors",
    "vae_name": "full_encoder_small_decoder.safetensors",
    "clip_type": "flux2",
    "sampler": "euler",
    "sampler_name": "euler",
    "scheduler": "flux2",
    "steps": 4,
    "cfg": 1.0,
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
    decode=(
        UniCanvasNodeStep(
            node="VAEDecode",
            methods=("decode",),
            inputs={"samples": "$latent", "vae": "$vae"},
            output="image",
            description="VAE decode",
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

    def normalize_key(self, generation_mode: str) -> bool:
        return generation_mode == self.key or generation_mode in self.aliases

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

    def create_empty_latent(self, width: int, height: int, _gen_settings: dict[str, Any], draw_id: str = "unknown") -> dict[str, Any]:
        import nodes

        encoded = nodes.EmptyLatentImage().generate(width, height, 1)[0]
        _uc_log(draw_id, "created empty SD latent", _latent_debug(encoded))
        return encoded

    def decode_samples(self, vae: Any, samples: Any, _gen_settings: dict[str, Any]):
        latent_samples = _unwrap_latent_samples(samples)
        return vae.decode_tiled(latent_samples, tile_x=512, tile_y=512)

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
        for key in ("dmd_lora_name", "age_lora_name"):
            lora_name = str(gen_settings.get(key) or "")
            if lora_name:
                strength_key = key.replace("_name", "_strength")
                model, clip = _apply_lora_cached(model, clip, lora_name, float(gen_settings.get(strength_key, 1.0)))
        return super().apply_loras(model, clip, gen_settings)


@dataclass(frozen=True)
class AnimaUniCanvasModule(UniCanvasModelModule):
    def apply_loras(self, model: Any, clip: Any, gen_settings: dict[str, Any]):
        if gen_settings.get("turbo_enabled"):
            model, clip = _apply_lora_cached(
                model,
                clip,
                str(gen_settings.get("dmd_lora_name") or ""),
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

        latent = torch.zeros(
            [1, 16, 1, height // 8, width // 8],
            device=comfy.model_management.intermediate_device(),
            dtype=comfy.model_management.intermediate_dtype(),
        )
        encoded = {"samples": latent}
        _uc_log(draw_id, "created empty Anima/Qwen latent", _latent_debug(encoded))
        return encoded

    def decode_samples(self, vae: Any, samples: Any, _gen_settings: dict[str, Any]):
        latent_payload = samples if isinstance(samples, dict) else {"samples": samples}
        latent_tensor = _unwrap_latent_samples(latent_payload)
        decode_payload = {"samples": latent_tensor}
        try:
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
        except Exception:
            pass
        decoded = _call_node_method(["VAEDecode"], ["decode"], samples=decode_payload, vae=vae)
        if isinstance(decoded, tuple) and decoded:
            return decoded[0]
        if decoded is not None:
            return decoded
        return vae.decode(latent_tensor)


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
        encoded = _call_node_method(
            ["EmptyFlux2LatentImage"],
            ["generate"],
            width=width,
            height=height,
            batch_size=1,
        )
        if isinstance(encoded, tuple) and encoded:
            _uc_log(draw_id, "created empty Flux2 latent", _latent_debug(encoded[0]))
            return encoded[0]
        if isinstance(encoded, dict):
            _uc_log(draw_id, "created empty Flux2 latent", _latent_debug(encoded))
            return encoded
        import comfy.model_management

        latent = torch.zeros(
            [1, 128, max(1, int(height) // 16), max(1, int(width) // 16)],
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
        _run_pipeline_steps(self.pipeline.sample, context, draw_id)
        _set_draw_progress(draw_id, "sampling", 0.85, steps, steps, f"Sampling {steps}/{steps}")
        _uc_log(draw_id, "SamplerCustomAdvanced output", _latent_debug(context.get("latent")))
        return context["latent"]

    def decode_samples(self, vae: Any, samples: Any, _gen_settings: dict[str, Any]):
        context = {"latent": samples, "vae": vae}
        _run_pipeline_steps(self.pipeline.decode, context, "flux_klein_decode")
        return context["image"]


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
_register_unicanvas_model_module(FluxKleinUniCanvasModule("flux_klein", ("flux-klein", "klein"), FLUX_KLEIN_DEFAULTS))


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
        if isinstance(item, (list, tuple)) and len(item) > 1 and isinstance(item[1], dict):
            metadata = item[1]
            entry["keys"] = sorted(str(key) for key in metadata.keys())
            for key in ("concat_latent_image", "concat_mask"):
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
    image = images[0].detach().cpu().numpy()
    image = np.clip(image * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(image)


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
    rgb = np.asarray(rgba.convert("RGB"), dtype=np.uint8).copy()
    alpha = np.asarray(rgba.getchannel("A"), dtype=np.uint8)
    mask = np.asarray(_pil_to_mask_image(mask_image), dtype=np.uint8)
    # Invoke infill receives the RGBA initial image and fills only transparent
    # pixels. User/inpaint masks are handled by the denoise mask, not by infill.
    valid = alpha > 8

    if not bool(valid.any()):
        _uc_log(draw_id, "outpaint infill fallback", {"reason": "no valid source pixels"})
        return Image.new("RGB", rgba.size, (127, 127, 127))

    height, width = valid.shape
    filled = rgb.copy()
    valid_rows = np.flatnonzero(valid.any(axis=1))
    for y in range(height):
        row_valid = np.flatnonzero(valid[y])
        if row_valid.size:
            x = np.arange(width)
            right_idx = np.searchsorted(row_valid, x, side="left")
            left_idx = np.clip(right_idx - 1, 0, row_valid.size - 1)
            right_idx = np.clip(right_idx, 0, row_valid.size - 1)
            left_x = row_valid[left_idx]
            right_x = row_valid[right_idx]
            nearest_x = np.where(np.abs(x - left_x) <= np.abs(right_x - x), left_x, right_x)
            filled[y] = rgb[y, nearest_x]
        else:
            nearest_row = valid_rows[np.argmin(np.abs(valid_rows - y))]
            filled[y] = filled[nearest_row]

    infilled = Image.fromarray(filled, mode="RGB").filter(ImageFilter.GaussianBlur(radius=2))
    original = rgba.convert("RGB")
    keep = Image.fromarray(valid.astype(np.uint8) * 255, mode="L")
    result = Image.composite(original, infilled, keep)
    _uc_log(
        draw_id,
        "outpaint source infilled",
        {
            "source_size": source_rgba.size,
            "mask": _tensor_debug(torch.from_numpy(mask.astype(np.float32) / 255.0)[None,]),
            "alpha": _tensor_debug(torch.from_numpy(alpha.astype(np.float32) / 255.0)[None,]),
            "valid_source_pixels": int(valid.sum()),
        },
    )
    return result


def _make_flux_outpaint_reference_rgb(source_rgba: Image.Image, draw_id: str) -> Image.Image:
    rgba_image = source_rgba.convert("RGBA")
    rgba = np.asarray(rgba_image, dtype=np.float32) / 255.0
    rgb = rgba[..., :3]
    alpha = rgba[..., 3:4]
    valid = alpha[..., 0] > 0.03
    if not bool(valid.any()):
        _uc_log(draw_id, "Flux Klein outpaint reference fallback", {"reason": "no valid source pixels"})
        return Image.new("RGB", rgba_image.size, (0, 0, 0))

    mean_color = rgb[valid].mean(axis=0)
    premul = rgb * alpha
    width, height = rgba_image.size
    blur_radius = max(16, min(96, int(max(width, height) / 18)))
    premul_img = Image.fromarray(np.clip(premul * 255.0, 0, 255).astype(np.uint8), mode="RGB")
    alpha_img = Image.fromarray(np.clip(alpha[..., 0] * 255.0, 0, 255).astype(np.uint8), mode="L")
    blurred_premul = np.asarray(premul_img.filter(ImageFilter.GaussianBlur(radius=blur_radius)), dtype=np.float32) / 255.0
    blurred_alpha = np.asarray(alpha_img.filter(ImageFilter.GaussianBlur(radius=blur_radius)), dtype=np.float32)[..., None] / 255.0
    fill = np.divide(
        blurred_premul,
        np.maximum(blurred_alpha, 1.0 / 255.0),
        out=np.broadcast_to(mean_color, rgb.shape).copy(),
        where=blurred_alpha > (1.0 / 255.0),
    )
    fill = np.clip(fill, 0.0, 1.0)
    composite = rgb * alpha + fill * (1.0 - alpha)
    result = Image.fromarray(np.clip(composite * 255.0, 0, 255).astype(np.uint8), mode="RGB")
    _uc_log(
        draw_id,
        "Flux Klein outpaint reference smooth-filled",
        {
            "blur_radius": blur_radius,
            "source_size": rgba_image.size,
            "valid_source_pixels": int(valid.sum()),
        },
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
    if generation_mode in {"anima", "flux_klein", "flux-klein", "klein"} or settings.get("diffusion_model_name"):
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
    with _MODEL_CACHE_LOCK:
        cached = _MODEL_CACHE.get(asset_key)
        if cached is not None:
            return cached
    assets = loader.load_assets(gen_settings)
    with _MODEL_CACHE_LOCK:
        _MODEL_CACHE[asset_key] = assets
    return assets


def _clone_model_clip(model: Any, clip: Any) -> tuple[Any, Any]:
    return (model.clone() if hasattr(model, "clone") else model, clip.clone() if hasattr(clip, "clone") else clip)


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
        sampled = nodes.common_ksampler(**kwargs)[0]
        _uc_log(draw_id, "common_ksampler output", _latent_debug(sampled))
        return sampled
    except Exception as exc:
        _uc_log(draw_id, "common_ksampler with progress failed; falling back to KSampler", {"error": str(exc)})

    _set_draw_progress(draw_id, "sampling", 0.35, 0, steps, f"Sampling 0/{steps}")
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
    seed = int(settings.get("seed", 0))
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
            "vae_name": settings.get("vae_name"),
            "seed": seed,
            "steps": steps,
            "cfg": cfg,
            "denoise": denoise,
            "sampler_name": sampler_name,
            "scheduler": scheduler,
            "grow_mask_by": grow_mask_by,
            "mask_blur": mask_blur,
            "canvas_coherence_edge_size": coherence_edge_size,
            "positive_len": len(positive_text),
            "negative_len": len(negative_text),
        },
    )

    source_rgba = _decode_data_url(str(payload.get("image") or ""), "RGBA")
    source = source_rgba.convert("RGB")
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

    with torch.inference_mode():
        model_module = _get_unicanvas_model_module(str(settings.get("generation_mode", "illustrious")).lower())
        _set_draw_progress(draw_id, "loading", 0.08, 0, steps, "Loading models")
        model, clip, vae = _load_generation_assets(settings)
        model, clip = _clone_model_clip(model, clip)
        _set_draw_progress(draw_id, "loras", 0.14, 0, steps, "Applying LoRAs")
        model, clip = _apply_generation_loras(model, clip, settings)
        _set_draw_progress(draw_id, "conditioning", 0.2, 0, steps, "Encoding prompts")
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
                if model_module.key == "flux_klein":
                    source = _make_flux_outpaint_reference_rgb(source_rgba, draw_id)
                else:
                    source = _infill_masked_rgb(source_rgba, mask_image, draw_id)
                source_for_composite = source_rgba.convert("RGB")
                mask = _pil_to_mask_tensor(denoise_mask_image)
            else:
                denoise_mask_image, expanded_mask_area = _make_gradient_denoise_mask(
                    mask_image, coherence_edge_size, draw_id
                )
                paste_mask_image = _make_gradient_paste_mask(expanded_mask_area, mask_blur, draw_id)
                mask = _pil_to_mask_tensor(denoise_mask_image)
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
            _uc_log(draw_id, "debug input images saved", {"source": source_debug, "mask": mask_debug, "paste_mask": paste_mask_debug})
        else:
            _uc_log(draw_id, "mask skipped", {"reason": f"mode is {mode}"})
        if model_module.key == "flux_klein" and (mode == "txt2img" or source_empty):
            source = Image.new("RGB", (width, height), (0, 0, 0))
            source_for_composite = source
            _uc_log(draw_id, "Flux Klein txt2img source replaced with black reference image", {"size": source.size})
        image_tensor = _pil_to_image_tensor(source)
        _uc_log(draw_id, "source prepared", {"size": source.size, "tensor": _tensor_debug(image_tensor)})
        positive, negative = model_module.prepare_reference_conditioning(
            positive=positive,
            negative=negative,
            vae=vae,
            image_tensor=image_tensor,
            gen_settings=settings,
            draw_id=draw_id,
        )
        if model_module.key != "flux_klein" and mode in {"inpaint", "outpaint"} and mask is not None:
            model = _apply_differential_diffusion(model, draw_id, strength=1.0)
        _set_draw_progress(draw_id, "latent", 0.32, 0, steps, "Preparing latent")
        if mode == "txt2img" or (source_empty and mask is None):
            latent = _create_empty_generation_latent(width, height, settings, draw_id=draw_id)
        elif model_module.key != "flux_klein" and mode in {"inpaint", "outpaint"} and mask is not None:
            positive, negative, latent = _prepare_inpaint_model_conditioning(
                positive=positive,
                negative=negative,
                vae=vae,
                image_tensor=image_tensor,
                mask=mask,
                grow_mask_by=grow_mask_by,
                draw_id=draw_id,
            )
        else:
            latent = _encode_source_latent(vae, image_tensor, mask, grow_mask_by, draw_id=draw_id)
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
        _set_draw_progress(draw_id, "decoding", 0.88, steps, steps, "Decoding")
        decoded = _decode_generation_samples(vae, latent, settings)
        _uc_log(draw_id, "decoded image tensor", _tensor_debug(decoded))
        result_image = _image_tensor_to_pil(decoded)

    output_size = (output_width, output_height)
    if mode in {"inpaint", "outpaint"} and mask_image is not None:
        if result_image.size != output_size:
            _uc_log(draw_id, "masked result resized to output size", {"from": result_image.size, "to": output_size})
            result_image = result_image.resize(output_size, Image.Resampling.LANCZOS)
        _uc_log(
            draw_id,
            "masked-region output",
            {
                "note": "Returning raw generated pixels plus paste mask; frontend stores only masked regions as the layer.",
                "result_size": result_image.size,
                "paste_mask_size": paste_mask_image.size if paste_mask_image is not None else mask_image.size,
            },
        )
    elif result_image.size != output_size:
        _uc_log(draw_id, "result resized to output size", {"from": result_image.size, "to": (output_width, output_height)})
        result_image = result_image.resize(output_size, Image.Resampling.LANCZOS)

    _set_draw_progress(draw_id, "saving", 0.96, steps, steps, "Saving result")
    saved = _save_temp_image(result_image)
    saved_mask = None
    if mode in {"inpaint", "outpaint"} and paste_mask_image is not None:
        mask_to_save = paste_mask_image
        if mask_to_save.size != output_size:
            mask_to_save = mask_to_save.resize(output_size, Image.Resampling.BILINEAR)
        saved_mask = _save_temp_image(mask_to_save, f"VNCCS_UniCanvas_{draw_id}_result_mask")
    _uc_log(draw_id, "result saved", {"image": saved, "mask": saved_mask, "size": result_image.size})
    _set_draw_progress(draw_id, "complete", 1.0, steps, steps, "Complete")
    return {
        "status": "ok",
        "image": saved,
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

    @PromptServer.instance.routes.get("/vnccs/unicanvas/progress/{draw_id}")
    async def vnccs_unicanvas_progress(request):
        return web.json_response(_get_draw_progress(str(request.match_info.get("draw_id") or "")))


NODE_CLASS_MAPPINGS = {
    "VNCCS_UniCanvas": VNCCS_UniCanvas,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VNCCS_UniCanvas": "VNCCS UniCanvas",
}
