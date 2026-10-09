"""MiniMax H3 model family: diffusion model + CLIP (type "minimax") + video VAE from the node's own
loader, or the same tensors from an optional VNCSS Config node (which can also add an audio VAE)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import torch

from ..comfy_bridge import _call_comfy_node
from ..debug import _uc_log
from ..loras import LoraRequirement
from ..sampling import _report_comfy_sampling_progress
from .base import UniCanvasModelModule, _reference_image_slots
from .capabilities import CANVAS_TASKS, STANDARD_TASKS, ModelCapabilities, PromptGuide, ReferenceInputs


@dataclass(frozen=True)
class MiniMaxH3UniCanvasModule(UniCanvasModelModule):
    capabilities: ModelCapabilities = ModelCapabilities(
        label="MiniMax H3",
        # A reference-to-video model: UniCanvas keeps the first frame as the still.
        tasks=CANVAS_TASKS + (
            STANDARD_TASKS["reference_to_video"].planned().with_prompt_guide(
                PromptGuide(
                    hint="Describe the action and camera over the clip; say which <Picture N> each subject comes from",
                    guide=(
                        "Reference-to-video (planned, not wired into the canvas yet): write what happens "
                        "over the clip - the motion of each subject, the camera movement and the pacing - "
                        "and name the <Picture N> every subject, outfit or setting is taken from. "
                        "<Picture 1> is the working area; <Picture 2>, <Picture 3>, ... are the references."
                    ),
                    examples=("The woman from <Picture 2> walks toward the camera and waves; slow dolly-in, evening light.",),
                    negative_prompt=False,
                    sources=("https://docs.comfy.org/tutorials/video/minimax/minimax-h3",),
                )
            ),
        ),
        references=ReferenceInputs(max_images=10, slot_label="<Picture {n}>"),
        prompt_guide=PromptGuide(
            hint="Keep the identity from <Picture 2>. Use the pose from <Picture 3>.",
            guide=(
                "MiniMax H3 edits images REF2VA-style: it rebuilds the working area from ordered "
                "pictures. <Picture 1> is the working area; the Edit model reference images are "
                "<Picture 2>, <Picture 3>, ... in socket order. State the role of every connected "
                "picture explicitly (identity, face, hair, clothing, pose, camera, environment) - "
                "explicit assignments win over what the prompt does not mention. Keep it "
                "preservation-first: say what must stay, then the one change you want, and that the "
                "result must visibly show it.\n\n"
                "Load the MiniMax H3 diffusion model, its Qwen3-VL text encoder (CLIP type minimax) "
                "and the video VAE in the loader, or link a VNCSS Config node. No mask is required: "
                "the bbox is the working area. There is no negative prompt."
            ),
            examples=(
                "Keep the identity, face, hair, clothing, camera and environment from <Picture 1>. "
                "Use the body pose and limb positions from <Picture 2>. The final pose must visibly match <Picture 2>.",
            ),
            negative_prompt=False,
            sources=(
                "https://github.com/astropuzzo/ComfyUI-MiniMax-H3-Image-Studio",
                "README.md#minimax-h3-region-editing",
            ),
        ),
    )
    key: str = "minimax_h3"
    aliases: tuple[str, ...] = ("minimaxh3", "minimax-h3", "h3")
    defaults: dict[str, Any] = field(default_factory=lambda: {
        "clip_type": "minimax",
        "steps": 20,
        "sampler_name": "res_multistep",
        "scheduler": "simple",
        "cfg": 1.0,
        "denoise": 1.0,
        "frame_count": 5,
        "ref_image_size": "match",
        "minimax_h3_lora_name": "",
        "minimax_h3_lora_strength": 0.0,
    })
    is_edit_model: bool = True
    lora_requirements: tuple[LoraRequirement, ...] = (
        LoraRequirement(
            name_setting="minimax_h3_lora_name",
            strength_setting="minimax_h3_lora_strength",
            default_strength=0.0,
            require_positive_strength=True,
            description="MiniMax H3 turbo LoRA (TaoMate 3-step)",
        ),
    )

    def uses_edit_masked_latents(self, mode: str) -> bool:
        return False

    def uses_differential_diffusion(self, mode: str) -> bool:
        return False

    def encode_prompt(self, clip: Any, text: str, gen_settings: dict[str, Any]):
        # The H3 conditioning (prompt + reference pictures) is built in one call
        # by MiniMaxH3ReferenceToVideo inside sample_latent; stash the prompt and
        # return a placeholder that the pipeline never samples.
        gen_settings["_h3_prompt"] = text or ""
        gen_settings["_h3_clip"] = clip
        return [[torch.zeros(1, 4), {}]]

    def validate_conditioning(self, positive, negative, gen_settings):
        return None

    def encode_draw_prompts(self, ctx):
        positive = self.encode_prompt(ctx.clip, ctx.request.positive_text, ctx.settings)
        return positive, positive  # H3's BasicGuider has no negative conditioning.

    def create_empty_latent(self, width: int, height: int, gen_settings, draw_id: str = "unknown"):
        return {"samples": torch.zeros(1, 16, 8, 8)}

    def prepare_reference_conditioning(self, positive, negative, vae, image_tensor, gen_settings, draw_id="unknown"):
        gen_settings["_h3_reference_image"] = image_tensor
        gen_settings["_h3_vae"] = vae
        return positive, negative

    def _h3_reference_images(self, gen_settings: dict[str, Any]) -> dict[str, Any]:
        slots = _reference_image_slots(gen_settings.get("_h3_reference_image"), gen_settings)
        return {f"ref_image_{slot}": value for slot, value in slots.items()}

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
        # The node's own loader supplies clip/vae; a linked VNCSS Config wins and may add the
        # (optional) audio VAE, which only matters for reference audio.
        external = gen_settings.get("_external") or {}
        clip = external.get("clip") or gen_settings.get("_h3_clip")
        vae = external.get("vae") or gen_settings.get("_h3_vae")
        audio_vae = external.get("audio_vae")
        if clip is None:
            raise RuntimeError("[VNCCS UniCanvas] MiniMax H3 needs its text encoder: select a CLIP (type minimax) in the loader.")
        prompt = str(gen_settings.get("_h3_prompt") or "")
        refs = self._h3_reference_images(gen_settings)
        target_w = int(width or 1344) // 32 * 32
        target_h = int(height or 768) // 32 * 32
        length = int(self.defaults.get("frame_count", 5))

        positive_h3, latent_h3 = _call_comfy_node(
            "MiniMaxH3ReferenceToVideo",
            clip=clip,
            vae=vae,
            audio_vae=audio_vae,
            prompt=prompt,
            width=target_w,
            height=target_h,
            length=length,
            ref_image_size=str(self.defaults.get("ref_image_size", "match")),
            ref_images=refs,
        )
        guider = _call_comfy_node("BasicGuider", model=model, conditioning=positive_h3)[0]
        noise = _call_comfy_node("RandomNoise", noise_seed=int(seed))[0]
        sampler_object = _call_comfy_node("KSamplerSelect", sampler_name=sampler_name or "res_multistep")[0]
        sigmas = _call_comfy_node(
            "BasicScheduler",
            model=model,
            scheduler=scheduler or "simple",
            steps=int(steps),
            denoise=float(denoise),
        )[0]
        with _report_comfy_sampling_progress(draw_id, int(steps)):
            sampled = _call_comfy_node(
                "SamplerCustomAdvanced",
                noise=noise,
                guider=guider,
                sampler=sampler_object,
                sigmas=sigmas,
                latent_image=latent_h3,
            )[0]
        _uc_log(draw_id, "MiniMax H3 region edit sampled", {
            "width": target_w, "height": target_h, "steps": steps,
            "refs": sorted(refs), "seed": seed,
        })
        return sampled

    def decode_samples(self, vae: Any, samples: Any, gen_settings: dict[str, Any]):
        # The tiling widgets are passed explicitly because _call_comfy_node cannot fill in
        # missing required parameters; the values are the ComfyUI core widget defaults, so
        # the result matches a graph run. Cores that do not declare a keyword drop it in
        # _call_comfy_node's signature filter instead of failing.
        decoded = _call_comfy_node(
            "VAEDecodeTiled",
            samples=samples,
            vae=vae,
            tile_size=512,
            overlap=64,
            temporal_size=64,
            temporal_overlap=8,
        )[0]
        if hasattr(decoded, "shape") and len(decoded.shape) == 4 and decoded.shape[0] > 1:
            return decoded[:1]  # H3 returns a frame packet; the still is the first frame
        return decoded
