"""FLUX.2 Klein model family (reference-latent edit pipeline)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import torch

from ..comfy_bridge import _call_node_method
from ..debug import _conditioning_debug, _latent_debug, _uc_log
from ..pipeline import UniCanvasNodeStep, UniCanvasPipeline, _run_pipeline_steps
from ..progress import _set_draw_progress
from ..sampling import (
    _ensure_direct_sampling_prompt_context,
    _report_comfy_sampling_progress,
    _suppress_direct_sampling_comfy_progress,
)
from .base import UniCanvasModelModule, _reference_image_slots
from .capabilities import ModelCapabilities, PromptGuide


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
class FluxKleinUniCanvasModule(UniCanvasModelModule):
    capabilities: ModelCapabilities = ModelCapabilities(
        label="Flux Klein",
        supports_pose_edit=True,
        default_loader="diffusion_model",
        prompt_guide=PromptGuide(
            hint="One paragraph: style and tight framing, each subject's place, look, hands and gaze, then light",
            guide=(
                "Write one cohesive paragraph in this order: art style and camera framing; each "
                "subject in its own spatial zone (\"in the background on the left\", \"in the "
                "foreground on the right\") with hair, age and clothing, a simple hand action and an "
                "explicit gaze target; the environment with the light source and shadow direction; "
                "then quality keywords (perfectly aligned eyes, highly detailed faces, correct hands).\n\n"
                "Reference images give the look; the text decides where each trait goes, so spell "
                "out every character's traits in their zone to stop features bleeding between them. "
                "Keep the camera close (medium close-up, waist-up) so faces get enough pixels, and "
                "give hands a surface to rest on instead of vague gestures.\n\n"
                "Klein is an edit model: the working area is attached as a reference, so you can also "
                "describe a change (\"add a red scarf\"). The negative prompt is not used (the negative "
                "conditioning is zeroed). Pose layers send the pose render and the background as two "
                "references."
            ),
            examples=(
                "Cinematic anime style. A tight medium close-up across a wooden tavern counter. Behind the "
                "bar on the left stands an older man with a short graying beard and a white apron, one hand "
                "flat on the counter, staring into the stranger's eyes. In the foreground on the right, "
                "filling much of the frame, a young man with messy maroon hair leans forward, looking back "
                "at him. Warm firelight from the right casts deep shadows to the left. Masterpiece, "
                "perfectly aligned eyes, highly detailed faces, correct hands.",
            ),
            negative_prompt=False,
            sources=("https://github.com/i-am-neon/infinit/blob/main/design/prompt_guides/flux_2_klein.md",),
        ),
    )
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
        references = gen_settings.get("_pose_edit_images") or list(_reference_image_slots(image_tensor, gen_settings).values())
        for reference in references:
            context["image_tensor"] = reference
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
        with _suppress_direct_sampling_comfy_progress(), _report_comfy_sampling_progress(draw_id, int(steps)):
            _run_pipeline_steps(self.pipeline.sample, context, draw_id)
        _set_draw_progress(draw_id, "sampling", 0.85, steps, steps, f"Sampling {steps}/{steps}")
        _uc_log(draw_id, "SamplerCustomAdvanced output", _latent_debug(context.get("latent")))
        return context["latent"]

    def decode_samples(self, vae: Any, samples: Any, _gen_settings: dict[str, Any]):
        return super().decode_samples(vae, samples, _gen_settings)
