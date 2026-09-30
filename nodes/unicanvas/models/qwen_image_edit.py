"""Qwen-Image-Edit (2509/2511) model family."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, ClassVar

import torch

from ..comfy_bridge import _call_node_method
from ..debug import _conditioning_debug, _latent_debug, _tensor_debug, _uc_log
from ..loras import LoraRequirement
from ..sampling import _sample_generation_latent_default
from .base import UniCanvasModelModule, _reference_image_slots
from .capabilities import ModelCapabilities, PromptGuide, ReferenceInputs


QWEN_IMAGE_EDIT_TURBO_LORA_NAME = "qwen/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"

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
class QwenImageEditUniCanvasModule(UniCanvasModelModule):
    sampling_scratch_keys: ClassVar[tuple[str, ...]] = ("_qwen_edit_reference_image", "_qwen_edit_mask", "_qwen_edit_latent")
    capabilities: ModelCapabilities = ModelCapabilities(
        label="Qwen Edit",
        references=ReferenceInputs(max_images=10, slot_label="Picture {n}"),
        supports_pose_edit=True,
        default_loader="gguf",
        prompt_guide=PromptGuide(
            hint="Replace the man's hat with a dark brown beret; keep his smile, short hair and gray jacket unchanged",
            guide=(
                "Write one direct, specific edit instruction (the rules of Qwen's official edit prompt "
                "enhancer). Add / delete / replace: name the target and give the minimal details that "
                "pin it down - category, color, size, orientation, position (\"Add a light-gray cat in "
                "the bottom-right corner, sitting and facing the camera\"); for replacements write "
                "\"Replace Y with X\" and describe X briefly.\n\n"
                "Text edits: put every text in English double quotes, keep its language and "
                "capitalization (Replace \"xx\" to \"yy\"). People: keep their identity - age, hairstyle, "
                "expression, outfit - and list what stays unchanged; expression or make-up changes must "
                "be natural and subtle. Style: describe the style by its key visual features and put it "
                "at the end when there are other changes. Old photo colorization uses \"Restore and "
                "colorize the photo.\"\n\n"
                "Content filling: inpaint starts with \"Perform inpainting on this image. The original "
                "caption is: \" and outpaint with \"Extend the image beyond its boundaries using "
                "outpainting. The original caption is: \", followed by a caption. Several pictures: the "
                "working area is Picture 1 and references are Picture 2, Picture 3, ... - say which "
                "picture's element changes and what stays (\"Replace the girl of Picture 1 with the boy of "
                "Picture 2, keeping Picture 1's background unchanged\"). With the Lightning LoRA (CFG 1) "
                "the negative prompt has no effect."
            ),
            examples=(
                "Replace the man's hat with a dark brown beret; keep smile, short hair, and gray jacket unchanged",
                "Change the girl in Picture 1 to the ink-wash style of Picture 2 - rendered in black-and-white watercolor with soft color transitions.",
            ),
            sources=(
                "https://github.com/QwenLM/Qwen-Image/blob/a76c8a3873c369a097aafd7ea229b7404659043c/src/examples/tools/prompt_utils.py#L181",
                "README.md#edit-model-reference-images",
            ),
        ),
    )
    lora_requirements: tuple[LoraRequirement, ...] = (
        LoraRequirement(
            name_setting="qwen_lora_name",
            match=QWEN_IMAGE_EDIT_TURBO_LORA_NAME,
            strength_setting="qwen_lora_strength",
            default_strength=0.0,
            require_positive_strength=True,
            clip_strength=0.0,
            description="Qwen-Image-Edit-2511 Lightning 4-step",
        ),
    )

    def clone_assets(self, model: Any, clip: Any) -> tuple[Any, Any]:
        return model, clip

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
        vl_references = gen_settings.get("_pose_edit_images") or [image_tensor]
        if gen_settings.get("_pose_edit_images"):
            reference = vl_references[0]
        draw_mode = str(gen_settings.get("draw_mode") or "")
        mask = gen_settings.get("_qwen_edit_mask")
        if not gen_settings.get("_pose_edit_images") and draw_mode in {"inpaint", "outpaint"} and torch.is_tensor(mask):
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

        for slot, value in sorted(_reference_image_slots(image_tensor, gen_settings).items()):
            if slot != 1 and torch.is_tensor(value):
                vl_references.append(value)
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

    # -- draw hooks -----------------------------------------------------------------------

    def prepare_pose_edit(self, ctx) -> None:
        super().prepare_pose_edit(ctx)
        ctx.settings["qwen_latent_image_index"] = 1

    def bind_draw_assets(self, ctx) -> None:
        ctx.settings["_qwen_edit_clip"] = ctx.clip
        ctx.settings["_qwen_edit_vae"] = ctx.vae

    def encode_draw_prompts(self, ctx) -> tuple[Any, Any]:
        _uc_log(
            ctx.draw_id,
            "Qwen Image Edit prompt encoding deferred",
            {"reason": "Qwen Image Edit 2511 needs the prepared reference image and VL image tokens"},
        )
        return [], []

    def on_mask_prepared(self, ctx) -> None:
        if ctx.mask is not None:
            ctx.settings["_qwen_edit_mask"] = ctx.mask

    def prepare_generation_latent(self, ctx) -> Any:
        reference_latent = ctx.settings.get("_qwen_edit_latent")
        if ctx.latent_source == "source" and isinstance(reference_latent, dict):
            _uc_log(
                ctx.draw_id,
                "Qwen Image Edit uses encoder reference latent",
                {"reason": "matches VNCCS_QWEN_Encoder output latent", "latent": _latent_debug(reference_latent)},
            )
            return reference_latent
        return super().prepare_generation_latent(ctx)

    def prepare_masked_latent(self, ctx) -> tuple[Any, Any, Any]:
        _uc_log(
            ctx.draw_id,
            "Qwen Image Edit masked latent uses prepared reference latent",
            {"reason": "Qwen Image Edit 2511 edits from reference_latents instead of SDXL inpaint conditioning"},
        )
        image_tensor = ctx.image_tensor
        batch_size = max(1, int((ctx.settings or {}).get("batch_size", 1) or 1))
        return ctx.positive, ctx.negative, {
            "samples": torch.zeros(
                [batch_size, 16, max(1, image_tensor.shape[1] // 8), max(1, image_tensor.shape[2] // 8)],
                dtype=image_tensor.dtype,
            )
        }

    def after_latent_prepared(self, ctx) -> None:
        ctx.settings["_qwen_edit_latent"] = ctx.latent
