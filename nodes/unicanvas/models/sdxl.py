"""SDXL / Illustrious model family."""

from __future__ import annotations

from dataclasses import dataclass

from ..loras import LoraRequirement
from .base import UniCanvasModelModule
from .capabilities import ModelCapabilities, PromptGuide


SDXL_TURBO_LORA_NAME = "DMD2/dmd2_sdxl_4step_lora_fp16.safetensors"

ILLUSTRIOUS_DEFAULTS = {
    "generation_mode": "illustrious",
    "ckpt_name": "",
    "sampler": "euler",
    "sampler_name": "euler",
    "scheduler": "normal",
    "steps": 20,
    "cfg": 8.0,
}


@dataclass(frozen=True)
class SDXLUniCanvasModule(UniCanvasModelModule):
    capabilities: ModelCapabilities = ModelCapabilities(
        label="SDXL",
        prompt_guide=PromptGuide(
            hint="masterpiece, best quality, 1girl, solo, silver hair, school uniform, classroom, window light",
            guide=(
                "SDXL checkpoints, above all Illustrious / NoobAI / Pony merges, are trained on "
                "comma-separated Danbooru tags; a short English sentence plus tags also works. Order "
                "matters - earlier tags weigh more: quality tags (masterpiece, best quality), subject "
                "count (1girl, solo), character and series, then appearance, clothing, pose, "
                "background, lighting and style.\n\n"
                "CLIP reads about 75 tokens per chunk, so keep prompts tight and put what matters "
                "first. The negative prompt is used: worst quality, low quality, bad hands, "
                "watermark, text. For inpaint describe only what belongs in the mask. With the DMD2 "
                "turbo LoRA keep prompts short and simple."
            ),
            examples=("masterpiece, best quality, 1girl, solo, silver hair, red eyes, school uniform, classroom, window light",),
            sources=(
                "https://note.com/kazumu/n/n6390a899bdce?hl=en",
                "https://wiki.monai.art/en/models/illustrious_xl",
            ),
        ),
    )
    lora_requirements: tuple[LoraRequirement, ...] = (
        LoraRequirement(
            name_setting="dmd_lora_name",
            match=SDXL_TURBO_LORA_NAME,
            enabled_setting="turbo_enabled",
            strength_setting="dmd_lora_strength",
            description="DMD2 4-step turbo",
        ),
    )
