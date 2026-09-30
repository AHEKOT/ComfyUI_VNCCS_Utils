"""Z-Image Turbo model family, including the Fun ControlNet inpaint patch."""

from __future__ import annotations

import contextlib
import gc
import os
from dataclasses import dataclass
from typing import Any, ClassVar

import torch

from ..comfy_bridge import _call_node_method
from ..debug import _conditioning_debug, _latent_debug, _tensor_debug, _uc_log
from ..latents import _encode_source_latent
from ..loras import _clone_model_clip, _load_model_patch
from ..paths import _get_full_path_agnostic, _safe_get_folder_paths
from ..sampling import _preload_vae_for_direct_decode, _unload_vae_after_direct_decode
from .base import UniCanvasModelModule
from .capabilities import ModelCapabilities, PromptGuide


Z_IMAGE_FUN_CONTROLNET_REPO_ID = "alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1"
Z_IMAGE_FUN_CONTROLNET_FILENAME = "Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors"

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


@dataclass(frozen=True)
class ZImageUniCanvasModule(UniCanvasModelModule):
    sampling_scratch_keys: ClassVar[tuple[str, ...]] = (
        "_z_image_fun_controlnet_image",
        "_z_image_fun_controlnet_mask",
        "_z_image_fun_controlnet_vae",
        "_z_image_fun_controlnet_patch_model",
    )
    decode_tile_size: ClassVar[int] = 256
    capabilities: ModelCapabilities = ModelCapabilities(
        label="Z-image",
        default_loader="diffusion_model",
        prompt_guide=PromptGuide(
            hint="80-250 words of plain description: shot and subject, look, clothes, place, light, mood, style",
            guide=(
                "Z-image reads sentences, not tag soup, and follows written instructions closely. "
                "Build the prompt as: shot and subject, age and appearance, clothing, environment, "
                "lighting, mood, style or medium, then technical notes. Around 80-250 words of "
                "precise description works best (attention caps near 512 tokens); precision beats "
                "flowery wording.\n\n"
                "Turbo runs without guidance, so the negative prompt is ignored: phrase every "
                "constraint positively in the prompt (\"no watermark\" belongs there). Text to render "
                "goes in quotes with its placement (\"large white title at the top\"); English and "
                "Chinese both work. Non-turbo checkpoints at CFG above 1 do use the negative prompt. "
                "Inpaint and outpaint run through the Fun ControlNet inpaint patch."
            ),
            examples=("Close-up portrait of a young knight in dented steel armor resting against a mossy stone wall, auburn hair tied back, soft morning fog, cool diffuse light, calm tired mood, cinematic photograph, shallow depth of field.",),
            sources=(
                "https://huggingface.co/Tongyi-MAI/Z-Image-Turbo/discussions/8",
                "https://gist.github.com/illuminatianon/c42f8e57f1e3ebf037dd58043da9de32",
            ),
        ),
    )
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

    # -- draw hooks -----------------------------------------------------------------------

    def prepare_draw_assets(self, ctx) -> None:
        _preload_z_image_fun_controlnet_patch(ctx.settings, ctx.mode, ctx.draw_id)

    def preload_vae(self, ctx) -> None:
        if _masked_draw(ctx.settings):
            _preload_vae_for_direct_decode(ctx.vae, ctx.settings, ctx.draw_id)

    def release_vae(self, ctx) -> None:
        if _masked_draw(ctx.settings):
            _unload_vae_after_direct_decode(ctx.vae, ctx.settings, ctx.draw_id)

    def on_masked_mode_dropped(self, ctx) -> None:
        if ctx.settings.pop("_z_image_fun_controlnet_patch_model", None) is None:
            return
        gc.collect()
        with contextlib.suppress(Exception):
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        _uc_log(ctx.draw_id, "Z-image Fun ControlNet patch released after empty mask mode switch", {"to_mode": ctx.mode})

    def prepare_masked_inputs(self, ctx) -> None:
        if not ctx.is_masked:
            return
        ctx.settings["_z_image_fun_controlnet_image"] = ctx.image_tensor
        ctx.settings["_z_image_fun_controlnet_mask"] = ctx.mask
        ctx.settings["_z_image_fun_controlnet_vae"] = ctx.vae
        _uc_log(
            ctx.draw_id,
            "Z-image Fun ControlNet inputs prepared",
            {
                "mode": ctx.mode,
                "image": _tensor_debug(ctx.image_tensor),
                "mask": _tensor_debug(ctx.mask),
                "patch": ctx.settings.get("fun_controlnet_patch_name"),
            },
        )

    def prepare_masked_latent(self, ctx) -> tuple[Any, Any, Any]:
        if not bool((ctx.settings or {}).get("fun_controlnet_inpaint", True)):
            return super().prepare_masked_latent(ctx)
        latent = _encode_source_latent(ctx.vae, ctx.image_tensor, ctx.mask, ctx.request.grow_mask_by, draw_id=ctx.draw_id)
        _uc_log(
            ctx.draw_id,
            "Z-image Fun ControlNet source latent returned",
            {
                "reason": "Fun ControlNet workflow uses VAE-encoded current source latent instead of an empty latent",
                "latent": _latent_debug(latent),
            },
        )
        return ctx.positive, ctx.negative, latent


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
            token=False,
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


def _masked_draw(settings: dict[str, Any]) -> bool:
    return str((settings or {}).get("draw_mode") or "").lower() in {"inpaint", "outpaint"}
