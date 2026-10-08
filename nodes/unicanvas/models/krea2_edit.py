"""Krea2 Identity Edit v1.2 model family (mandatory edit LoRA, grounded Qwen3-VL prompt)."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import ClassVar

from ..comfy_bridge import _call_node_method
from ..latents import _unwrap_latent_samples
from ..loras import LoraRequirement
from .base import UniCanvasModelModule, _reference_image_slots
from .capabilities import STANDARD_TASKS, ModelCapabilities, PromptGuide, ReferenceInputs


KREA2_EDIT_DEFAULTS = {
    "generation_mode": "krea2_edit",
    "model_loader": "diffusion_model",
    "diffusion_model_name": "krea2_turbo_fp8_scaled.safetensors",
    "clip_name": "qwen3vl_4b_fp8_scaled.safetensors",
    "vae_name": "qwen_image_vae.safetensors",
    "clip_type": "krea2",
    # Found by file name in any loras subfolder (krea\, krea2\, Krea2/...): loras._get_lora_full_path.
    "krea2_edit_lora_name": "Krea2/krea2_identity_edit_v1_2.safetensors",
    "krea2_likeness": 4.0,
    "sampler_name": "euler",
    "scheduler": "simple",
    "steps": 10,
    "cfg": 1.0,
    "denoise": 1.0,
}


@dataclass(frozen=True)
class Krea2EditUniCanvasModule(UniCanvasModelModule):
    """Identity Edit v1.2: mandatory LoRA, grounded Qwen3-VL and clean source tokens."""

    sampling_scratch_keys: ClassVar[tuple[str, ...]] = ("_krea2_edit_clip", "_krea2_edit_image", "_krea2_edit_image_b", "_krea2_edit_vae")

    capabilities: ModelCapabilities = ModelCapabilities(
        label="Krea2 Edit",
        tasks=tuple(STANDARD_TASKS[key] for key in ("image_to_image", "inpaint", "outpaint")),
        # The LoRA was trained on at most two pictures: the working area (background) and one
        # reference (the character to put into it).
        references=ReferenceInputs(max_images=1, slot_label="image {n}"),
        requires_source_image=True,
        source_image_message="Krea2 Edit requires an image inside the bbox. Import an image and describe the edit.",
        default_loader="diffusion_model",
        prompt_guide=PromptGuide(
            hint="A clear, direct edit: recolor the car to matte black / add a hat to the man on the left",
            guide=(
                "Krea2 Identity Edit changes an existing image: import an image, put the bbox over "
                "the area to edit and write one clear, direct instruction - recolor, add or insert, "
                "change an attribute, restyle, translate the scene. Refer to subjects by position "
                "(\"the man on the left\").\n\n"
                "The Turbo card (CFG 1, ~8-10 steps) handles most edits. Removing salient content "
                "needs real guidance: use the Krea2 Edit Raw card (CFG 3, ~20 steps) - Turbo tends "
                "to re-render the subject instead of removing it. Likeness pulls the result toward "
                "the source (>1 stronger, <1 looser). Stay at or below about 2 megapixels, or source "
                "content can bleed and subjects duplicate. Your negative prompt is not used: the "
                "unconditional branch is the same image with an empty instruction."
            ),
            examples=("Recolor the car to matte black and add rain on the windshield.",),
            negative_prompt=False,
            sources=(
                "https://github.com/lbouaraba/comfyui-krea2edit",
                "docs/UNICANVAS_KREA2_EDIT.md",
            ),
        ),
    )

    lora_requirements: tuple[LoraRequirement, ...] = (
        LoraRequirement(
            name_setting="krea2_edit_lora_name",
            default_name=KREA2_EDIT_DEFAULTS["krea2_edit_lora_name"],
            fixed_strength=1.0,
            clip_strength=0.0,
            required=True,
            description="Krea2 Identity Edit adapter (mandatory)",
        ),
    )

    def encode_prompt(self, clip, text, gen_settings):
        # Defer until the exact bbox reference is prepared, including outpaint pixels.
        gen_settings["_krea2_edit_clip"] = clip
        return text or ""

    def prepare_reference_conditioning(self, positive, negative, vae, image_tensor, gen_settings, draw_id="unknown"):
        from .krea2_edit_inference import Krea2EditGroundedEncode

        clip = gen_settings.pop("_krea2_edit_clip")
        encoder = Krea2EditGroundedEncode()
        # image = the working area (background), image_b = the one reference (character).
        slots = _reference_image_slots(image_tensor, gen_settings)
        image = slots.get(1)
        image_b = slots.get(2)
        positive = encoder.encode(clip, positive, image=image, image_b=image_b, grounding_px=768)[0]
        # Trained unconditional: the SAME images with an empty instruction.
        negative = encoder.encode(clip, "", image=image, image_b=image_b, grounding_px=768)[0]
        gen_settings["_krea2_edit_image"] = image
        gen_settings["_krea2_edit_image_b"] = image_b
        gen_settings["_krea2_edit_vae"] = vae
        return positive, negative

    def create_empty_latent(self, width, height, gen_settings, draw_id="unknown"):
        latent = _call_node_method(["EmptySD3LatentImage"], ["generate"], width=width, height=height,
                                  batch_size=max(1, int(gen_settings.get("batch_size", 1))))
        if latent is None:
            raise ValueError("Krea2 Edit requires EmptySD3LatentImage. Update ComfyUI.")
        return latent

    def sample_latent(self, model, positive, negative, latent, seed, steps, cfg, sampler_name,
                      scheduler, denoise, gen_settings, draw_id="unknown", width=None, height=None):
        from .krea2_edit_inference import patch_krea2_edit

        model = patch_krea2_edit(model, gen_settings.pop("_krea2_edit_vae"),
                                gen_settings.pop("_krea2_edit_image"), latent,
                                gen_settings["krea2_likeness"],
                                image_b=gen_settings.pop("_krea2_edit_image_b", None))
        return super().sample_latent(model, positive, negative, latent, seed, steps, cfg,
                                     sampler_name, scheduler, 1.0, gen_settings, draw_id, width, height)

    def decode_samples(self, vae, samples, gen_settings):
        return vae.decode(_unwrap_latent_samples(samples))

    # -- settings and draw hooks ------------------------------------------------------------

    def normalize_settings(self, settings):
        likeness = float(settings.get("krea2_likeness", 4.0))
        if not math.isfinite(likeness) or not 0 <= likeness <= 10:
            raise ValueError("Krea2 Edit likeness must be between 0 and 10")
        settings["krea2_likeness"] = likeness
        settings["denoise"] = 1.0
        return settings

    def prepare_generation_latent(self, ctx):
        # Every edit mode samples a fresh noise target; the source only enters through
        # the grounded conditioning and the patched model, never as the initial latent.
        return self.create_empty_latent(ctx.width, ctx.height, ctx.settings, draw_id=ctx.draw_id)
