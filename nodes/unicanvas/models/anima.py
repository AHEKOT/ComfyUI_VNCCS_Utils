"""Anima model family, including the Anima LLLite inpaint patch."""

from __future__ import annotations

import contextlib
import os
from dataclasses import dataclass
from typing import Any, ClassVar

import torch

from ..comfy_bridge import _call_node_method
from ..debug import _latent_debug, _tensor_debug, _uc_log
from ..latents import _unwrap_latent_samples
from ..loras import LoraRequirement
from ..paths import _get_full_path_agnostic, _safe_get_folder_paths
from .base import UniCanvasModelModule
from .capabilities import ModelCapabilities, PromptGuide


ANIMA_LLLITE_REPO_ID = "kohya-ss/Anima-LLLite"
ANIMA_LLLITE_INPAINT_FILENAME = "anima-lllite-inpainting-v2.safetensors"

ANIMA_TURBO_LORA_NAME = "anima/anima-turbo-lora-v0.1.safetensors"

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


@dataclass(frozen=True)
class AnimaUniCanvasModule(UniCanvasModelModule):
    sampling_scratch_keys: ClassVar[tuple[str, ...]] = ("_anima_lllite_image", "_anima_lllite_mask")
    capabilities: ModelCapabilities = ModelCapabilities(
        label="Anima",
        default_loader="diffusion_model",
        prompt_guide=PromptGuide(
            hint="masterpiece, best quality, score_7, safe, 1girl, ... - tags, sentences or both",
            guide=(
                "Anima was trained on Danbooru tags, natural-language captions and mixes of the two; "
                "all three work, in any order. Write tags in lowercase with spaces (brown hair, not "
                "brown_hair) - only score tags keep underscores (score_7) - and prefix artist tags "
                "with @. Tag order: quality / meta / year / safety, subject count (1girl), character, "
                "series, @artist, then general tags; add a sentence for composition, lighting or "
                "story.\n\n"
                "A good start: \"masterpiece, best quality, score_7, safe,\" with the negative \"worst "
                "quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg "
                "artifacts, chromatic aberration\". With the turbo LoRA (CFG 1) the negative has no "
                "effect. Inpaint and outpaint use the Anima LLLite patch: describe what belongs in "
                "the masked or empty area."
            ),
            examples=("masterpiece, best quality, score_7, safe, 1girl, fox ears, kimono. She stands on a shrine bridge at dusk, lanterns glowing.",),
            sources=(
                "https://huggingface.co/circlestone-labs/Anima",
                "https://github.com/CalamitousFelicitousness/ai-prompting-guides/blob/main/docs/anima.md",
            ),
        ),
    )
    lora_requirements: tuple[LoraRequirement, ...] = (
        LoraRequirement(
            name_setting="dmd_lora_name",
            match=ANIMA_TURBO_LORA_NAME,
            enabled_setting="turbo_enabled",
            strength_setting="dmd_lora_strength",
            clip_strength=0.0,
            description="Anima turbo",
        ),
    )

    def uses_differential_diffusion(self, mode: str) -> bool:
        return False

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
            from ...anima_lllite_internal import apply_anima_lllite_inpaint
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

    # -- draw hooks -----------------------------------------------------------------------

    def prepare_masked_inputs(self, ctx) -> None:
        if not ctx.is_masked or not bool(ctx.settings.get("anima_lllite_inpaint", True)):
            return
        ctx.settings["_anima_lllite_image"] = ctx.image_tensor
        ctx.settings["_anima_lllite_mask"] = ctx.mask
        _uc_log(
            ctx.draw_id,
            "Anima LLLite inputs prepared",
            {
                "mode": ctx.mode,
                "image": _tensor_debug(ctx.image_tensor),
                "mask": _tensor_debug(ctx.mask),
                "weights": ctx.settings.get("anima_lllite_name"),
            },
        )

    def prepare_masked_latent(self, ctx) -> tuple[Any, Any, Any]:
        if not bool((ctx.settings or {}).get("anima_lllite_inpaint", True)):
            return super().prepare_masked_latent(ctx)
        latent = self.create_empty_latent(
            int(ctx.image_tensor.shape[2]),
            int(ctx.image_tensor.shape[1]),
            ctx.settings or {},
            draw_id=ctx.draw_id,
        )
        _uc_log(
            ctx.draw_id,
            "Anima LLLite empty latent returned",
            {
                "reason": "Anima LLLite inpaint workflow uses an empty latent; structure comes through the bundled LLLite model wrapper",
                "latent": _latent_debug(latent),
            },
        )
        return ctx.positive, ctx.negative, latent


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
            token=False,
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
