"""Qwen-Image-2.1 model family, Viggle turbo LoRA (spec section 9).

Model stack (official Qwen-Image-2.1 architecture, ComfyUI-native weights from
Comfy-Org/Qwen-Image-2.1): 7B / 32-layer single-stream DiT diffusion model,
Qwen3-VL 8B text encoder (encodes instructions and condition images), and the
64-channel RGBA image VAE with 16x spatial compression. Loading follows ComfyUI
core (>= 0.37) node semantics: UNETLoader, CLIPLoader (type "qwen_image") and
VAELoader, driven through ``DiffusionModelUniCanvasLoader``.
"""

from __future__ import annotations

import math
import os
import threading
from dataclasses import dataclass, field
from typing import Any, ClassVar

import torch
from PIL import Image

from ..comfy_bridge import _call_comfy_node
from ..debug import _conditioning_debug, _latent_debug, _uc_log
from ..loaders import _load_generation_assets
from .. import loras
from ..loras import LoraRequirement, _lora_name_matches
from ..paths import _get_full_path_agnostic, _resolve_model_filename, _safe_get_folder_paths
from ..progress import _set_draw_progress
from ..sampling import _ensure_direct_sampling_prompt_context, _suppress_direct_sampling_comfy_progress
from .base import UniCanvasModelModule, _reference_image_slots
from .capabilities import STANDARD_TASKS, ModelCapabilities, PromptGuide, ReferenceInputs
from .qwen_image21_viggle import apply_viggle_turbo_lora, has_viggle_turbo, viggle_turbo_sigmas


# Transparent-RGBA prompt convention from the official Qwen space (spec 9):
# wrap the description and the model renders real transparency.
QWEN_IMAGE21_RGBA_PROMPT_PREFIX = "This is an RGBA image with transparency."
QWEN_IMAGE21_RGBA_PROMPT_SUFFIX = "The image has alpha channel and the background is transparent."

# Official Qwen-Image-2.1 subject-extraction instruction (Comfy-Org workflow
# template image_qwen_image_2_1_background_removal.json) used by
# QwenImage21UniCanvasModule.remove_background().
QWEN_IMAGE21_SUBJECT_EXTRACTION_PROMPT = "Remove the background, and output a PNG image"

def _qwen21_encoder_resolution(width: int, height: int) -> int:
    """TextEncodeQwenImage21's ``resolution``: the side of a square with the generation's area.

    The node resizes every reference to about ``resolution x resolution`` pixels (aspect kept,
    multiples of 32). Passing the pixel count instead (width * height) asked it for a
    million-by-million image and failed with a MemoryError.
    """
    side = math.sqrt(max(1, int(width)) * max(1, int(height)))
    return max(32, int(round(side / 32)) * 32)


QWEN_IMAGE21_DEFAULTS: dict[str, Any] = {
    "generation_mode": "qwen_image21",
    "model_loader": "diffusion_model",
    "diffusion_model_name": "qwen_image_2.1_int8_convrot.safetensors",
    "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
    "vae_name": "qwen_image_2.1_vae_bf16.safetensors",
    "clip_type": "qwen_image",
    "sampler": "euler",
    "sampler_name": "euler",
    "scheduler": "simple",
    # Viggle turbo on by default: 6 steps at CFG 1 (verified subject extraction in ~9 s).
    "steps": 6,
    "cfg": 1.0,
    "denoise": 1.0,
    "qwen21_turbo_enabled": True,
    "qwen_lora_name": "",  # filled below with the turbo LoRA name
    "qwen_lora_strength": 1.0,
    "qwen21_opaque_output": False,
    "qwen21_outpaint_lora_name": "",  # filled below with the outpaint LoRA name
    "qwen21_outpaint_lora_strength": 1.0,
    "lora_stack": [],
}

# Viggle QI2.1 turbo (v0.2.1, 6-step DMD distillation, https://huggingface.co/Viggle/
# Qwen-Image-2.1-viggle-turbo): the LoRA student variant applied over the base
# transformer, following the same "turbo switch" pattern as the other families.
QWEN21_TURBO_LORA_REPO_ID = "Viggle/Qwen-Image-2.1-viggle-turbo"
QWEN21_TURBO_LORA_REVISION = "b77064be8b3f0b1a13c6a212067cb3d281c60c84"
QWEN21_TURBO_LORA_FILENAME = "Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors"
QWEN21_TURBO_LORA_NAME = f"QI2/Viggle/{QWEN21_TURBO_LORA_FILENAME}"
QWEN21_TURBO_STEPS = 6
QWEN_IMAGE21_DEFAULTS["qwen_lora_name"] = QWEN21_TURBO_LORA_NAME

# AusBoss QI2.1 outpaint LoRA v2 (https://huggingface.co/ausboss/Qwen-Image-2.1-Outpaint-LoRA):
# trained on canvases padded with flat gray #808080 and one fixed instruction, optionally
# followed by "Scene: <description>". Applied automatically in outpaint mode.
QWEN21_OUTPAINT_LORA_REPO_ID = "ausboss/Qwen-Image-2.1-Outpaint-LoRA"
QWEN21_OUTPAINT_LORA_REVISION = "449336db42ff074aee970ba0facc0ac0feb77863"
QWEN21_OUTPAINT_LORA_FILENAME = "qwen-image-2.1-outpaint-v2.safetensors"
QWEN21_OUTPAINT_LORA_NAME = f"ausboss/{QWEN21_OUTPAINT_LORA_FILENAME}"
QWEN21_OUTPAINT_FILL = (128, 128, 128)
QWEN21_OUTPAINT_INSTRUCTION = (
    "Outpaint the image: replace the solid gray areas with a seamless continuation of the scene, "
    "keeping the existing picture unchanged."
)
QWEN_IMAGE21_DEFAULTS["qwen21_outpaint_lora_name"] = QWEN21_OUTPAINT_LORA_NAME

_QWEN21_TURBO_LORA_LOCK = threading.Lock()
_QWEN21_TURBO_LORA_DOWNLOAD: dict[str, Any] = {"status": "missing", "progress": 0.0, "message": "Missing"}
_QWEN21_OUTPAINT_LORA_LOCK = threading.Lock()
_QWEN21_OUTPAINT_LORA_DOWNLOAD: dict[str, Any] = {"status": "missing", "progress": 0.0, "message": "Missing"}


def _resolve_hf_lora(repo_id: str, revision: str, filename: str, lora_name: str, lock, status: dict[str, Any], label: str) -> str:
    """Resolve a pinned Hugging Face LoRA, downloading it into models/loras/<dir of lora_name>/.

    Returns the ComfyUI loras-relative name used by _apply_lora_cached. Any installed copy
    with the same file name counts (e.g. loras/qwen/<file>).
    """
    import shutil

    import folder_paths

    def installed_name() -> str | None:
        name = _resolve_model_filename(folder_paths, "loras", lora_name)
        path = _get_full_path_agnostic(folder_paths, "loras", name)
        return name if path and os.path.exists(path) else None

    found = installed_name()
    if found:
        return found
    with lock:
        found = installed_name()
        if found:
            return found
        status.update({"status": "downloading", "progress": 0.1, "message": f"Downloading {label}"})
        try:
            from huggingface_hub import hf_hub_download

            cached = hf_hub_download(repo_id=repo_id, filename=filename, revision=revision, token=False)
            lora_dirs = _safe_get_folder_paths(folder_paths, "loras")
            if not lora_dirs:
                raise RuntimeError("no ComfyUI loras folder is configured")
            target_dir = os.path.join(lora_dirs[0], os.path.dirname(lora_name))
            os.makedirs(target_dir, exist_ok=True)
            target = os.path.join(target_dir, filename)
            if os.path.abspath(cached) != os.path.abspath(target):
                shutil.copyfile(cached, target)
            status.update({"status": "success", "progress": 1.0, "message": "Installed"})
            return lora_name
        except Exception as exc:
            status.update({"status": "error", "progress": 0.0, "message": str(exc)})
            raise RuntimeError(f"[VNCCS UniCanvas] {label} download failed: {exc}") from exc


def resolve_qwen21_turbo_lora() -> str:
    """Resolve (downloading when missing) the Viggle QI2.1 turbo LoRA into models/loras/QI2/Viggle/."""
    return _resolve_hf_lora(
        QWEN21_TURBO_LORA_REPO_ID, QWEN21_TURBO_LORA_REVISION, QWEN21_TURBO_LORA_FILENAME, QWEN21_TURBO_LORA_NAME,
        _QWEN21_TURBO_LORA_LOCK, _QWEN21_TURBO_LORA_DOWNLOAD, "Viggle QI2.1 turbo LoRA",
    )


def resolve_qwen21_outpaint_lora() -> str:
    """Resolve (downloading when missing) the AusBoss QI2.1 outpaint LoRA into models/loras/ausboss/."""
    return _resolve_hf_lora(
        QWEN21_OUTPAINT_LORA_REPO_ID, QWEN21_OUTPAINT_LORA_REVISION, QWEN21_OUTPAINT_LORA_FILENAME,
        QWEN21_OUTPAINT_LORA_NAME, _QWEN21_OUTPAINT_LORA_LOCK, _QWEN21_OUTPAINT_LORA_DOWNLOAD, "QI2.1 outpaint LoRA",
    )


def _qwen21_image_size(image: Any) -> tuple[int, int]:
    """Return (height, width) of a (B,H,W,C) or (H,W,C) image tensor."""
    shape = tuple(int(value) for value in (getattr(image, "shape", ()) or ()))
    if len(shape) >= 4:
        return shape[1], shape[2]
    if len(shape) == 3:
        return shape[0], shape[1]
    return 0, 0


# Editing prompts are short imperatives with a preserve clause (Qwen-Image-2.1 prompt guide,
# https://github.com/kjranyone/qwen-image-2.1-prompt-guide - image-editing.md).
QWEN_IMAGE21_EDIT_PROMPT_GUIDE = PromptGuide(
    hint="Change X to Y. Keep everything else unchanged.",
    guide=(
        "Editing prompts are short imperative sentences in one paragraph: name only what should "
        "change and lock the rest with a preserve clause (\"Keep everything else unchanged\"). "
        "Refer to preserved things by role or position instead of re-describing them, use "
        "affirmative, decisive wording, and make one logical change per pass - chain a few small "
        "edits for big changes.\n\n"
        "With references, give each image a role: <image1> is the working area (the canvas to "
        "modify) and <image2>, <image3>, ... are donors of a person, product, background or style "
        "(\"Place <image2>'s character in <image1>. Keep hairstyle, clothing and facial features "
        "identical.\"). For inpaint describe only the masked region; for outpaint describe what "
        "extends into the empty area. Text to keep or write goes in quotes, verbatim."
    ),
    examples=(
        "Change the background to a sunset beach. Keep the subject, pose, and lighting unchanged.",
        "Re-render <image1> in the art style of <image2>. Preserve subject identity, clothing, and layout.",
    ),
    sources=("https://github.com/kjranyone/qwen-image-2.1-prompt-guide/blob/main/skills/qwen-image-prompt-en/references/image-editing.md",),
)


@dataclass(frozen=True)
class QwenImage21UniCanvasModule(UniCanvasModelModule):
    """UniCanvas adapter for Qwen-Image-2.1 (RGBA by default).

    Sampling defaults are flow matching (cfg 1.0) with euler/simple and 40
    steps (size via the inference scale). All draw modes work: txt2img,
    img2img, inpaint and outpaint, where inpaint is img2img with mask
    paste-back (no InpaintModelConditioning context). Reference editing wires
    the working area to <image1> and the Edit model references to <image2..5>
    in socket order, with the module assembling the QI2.1 <image N>
    instruction. Output is RGBA with real transparency unless the
    "opaque output" switch disables the RGBA prompting and flattens.
    """

    capabilities: ModelCapabilities = ModelCapabilities(
        label="Qwen Edit 2.1",
        tasks=(
            STANDARD_TASKS["text_to_image"],
            *(STANDARD_TASKS[key].with_prompt_guide(QWEN_IMAGE21_EDIT_PROMPT_GUIDE) for key in ("image_to_image", "inpaint", "outpaint")),
        ),
        references=ReferenceInputs(max_images=10, slot_label="<image{n}>"),
        default_loader="diffusion_model",
        prompt_guide=PromptGuide(
            hint="Fluent English sentences, subject first; text to draw goes in \"double quotes\"",
            guide=(
                "Qwen-Image-2.1 is prompted with natural sentences, never tag lists or (term:1.5) "
                "weights. Front-load the subject, then environment, style, composition and lighting. "
                "Any text that must appear in the image goes in double quotes, verbatim. Do not add "
                "quality boosters (masterpiece, 8K, highly detailed) and do not write aspect ratios or "
                "resolution in the prompt - use the size controls. Layouts and posters need a longer, "
                "observational paragraph.\n\n"
                "Output is RGBA with real transparency by default: the module wraps your prompt in the "
                "official RGBA sentences ('opaque output' turns that off). With reference images "
                "connected, name them <image2>, <image3>, ... (the working area is <image1>); with no "
                "references do not use tags. At CFG 1 (the default and the Viggle turbo) the negative "
                "prompt has no effect."
            ),
            examples=('A neon shop sign that reads "GRAND OPENING", rainy night, reflections on wet pavement.',),
            sources=(
                "https://github.com/kjranyone/qwen-image-2.1-prompt-guide",
                "README.md#qwen-image-21",
            ),
        ),
    )

    key: str = "qwen_image21"
    aliases: tuple[str, ...] = ("qwen-image-2.1", "qwen_image_21", "qwenimage21", "qi21", "qwen21")
    defaults: dict[str, Any] = field(default_factory=lambda: dict(QWEN_IMAGE21_DEFAULTS))
    is_edit_model: bool = True
    sampling_scratch_keys: ClassVar[tuple[str, ...]] = (
        "_qwen21_latent",
        "_qwen21_clip",
        "_qwen21_prompts",
        "_qwen21_prompt",
        "_qwen21_negative_prompt",
    )
    lora_requirements: tuple[LoraRequirement, ...] = (
        LoraRequirement(
            name_setting="qwen_lora_name",
            strength_setting="qwen_lora_strength",
            default_strength=0.0,
            require_positive_strength=True,
            clip_strength=0.0,
            # Looked up at call time so the lazy download (and tests) can replace it.
            resolver=lambda: resolve_qwen21_turbo_lora(),
            resolve_match=QWEN21_TURBO_LORA_NAME,
            # Only the Viggle turbo runs unmerged (and then samples on its own schedule).
            apply=lambda model, clip, name, strength: (
                apply_viggle_turbo_lora(model, clip, name, strength)
                if _lora_name_matches(name, QWEN21_TURBO_LORA_NAME)
                else loras._apply_lora_cached(model, clip, name, strength, clip_strength=0.0)
            ),
            description="Qwen-Image-2.1 LoRA (Viggle turbo downloads on first use)",
        ),
        LoraRequirement(
            name_setting="qwen21_outpaint_lora_name",
            strength_setting="qwen21_outpaint_lora_strength",
            draw_modes=frozenset({"outpaint"}),
            require_positive_strength=True,
            clip_strength=0.0,
            resolver=lambda: resolve_qwen21_outpaint_lora(),
            resolve_match=QWEN21_OUTPAINT_LORA_NAME,
            description="Qwen-Image-2.1 outpaint LoRA (AusBoss v2, outpaint mode only, downloads on first use)",
        ),
    )

    def on_masked_mode_dropped(self, ctx) -> None:
        # An empty outpaint mask turned the draw into img2img after the LoRAs were applied:
        # rebuild the model so the outpaint LoRA does not leak into the img2img run.
        if self.lora_requirements[1].resolve({**ctx.settings, "draw_mode": "outpaint"}) is None:
            return
        model, clip, _vae = _load_generation_assets(ctx.settings)
        ctx.model, ctx.clip = self.apply_loras(*self.clone_assets(model, clip), ctx.settings)
        self.bind_draw_assets(ctx)

    def outpaint_prompt_suffix(self) -> str:
        # Outpaint builds its own instruction (QWEN21_OUTPAINT_INSTRUCTION) in assemble_instruction.
        return ""

    def prepare_outpaint_reference_image(self, source_rgba: Image.Image, mask_image: Image.Image, draw_id: str) -> Image.Image:
        # The outpaint LoRA was trained on canvases padded with flat gray #808080.
        background = Image.new("RGBA", source_rgba.size, (*QWEN21_OUTPAINT_FILL, 255))
        background.alpha_composite(source_rgba.convert("RGBA"))
        _uc_log(draw_id, "QI2.1 outpaint reference flattened on gray", {"source_size": source_rgba.size})
        return background.convert("RGB")

    def uses_edit_masked_latents(self, mode: str) -> bool:
        # Inpaint and outpaint are img2img runs with mask paste-back (spec 9).
        return False

    def uses_differential_diffusion(self, mode: str) -> bool:
        return False

    def output_is_opaque(self, gen_settings: dict[str, Any] | None) -> bool:
        return bool((gen_settings or {}).get("qwen21_opaque_output", False))

    def resolve_generation_size(self, width: int, height: int, gen_settings: dict[str, Any] | None) -> tuple[int, int]:
        # Size comes from the canvas box and the inference scale; no fixed aspect presets.
        return int(width), int(height)

    def reference_image_slots(self, image_tensor: Any, gen_settings: dict[str, Any] | None) -> dict[int, Any]:
        """QI2.1 <image N> wiring (spec 3 and 9).

        Slot 1 is the canvas working area; slots 2..5 are the Edit model
        reference images in socket order.
        """
        return _reference_image_slots(image_tensor, gen_settings)

    def assemble_instruction(self, prompt: str, slots, opaque_output: bool = False, outpaint: bool = False) -> str:
        """Assemble the QI2.1 instruction: <image N> slot framing, the user
        prompt, and (unless opaque output) the transparent-RGBA convention.

        Outpaint uses the outpaint LoRA's trained instruction verbatim, with the
        user prompt as its optional "Scene:" description and no RGBA wrapping.
        """
        body = str(prompt or "").strip()
        if outpaint:
            parts = [QWEN21_OUTPAINT_INSTRUCTION]
            references = [f"<image{slot}>" for slot in sorted(slots) if slot != 1]
            if references:
                parts.append(f"Reference images: {', '.join(references)}.")
            if body:
                parts.append(f"Scene: {body}")
            return " ".join(parts)
        parts = []
        if 1 in slots:
            parts.append("Working area: <image1>.")
        references = [f"<image{slot}>" for slot in sorted(slots) if slot != 1]
        if references:
            parts.append(f"Reference images: {', '.join(references)}.")
        if body:
            parts.append(body)
        instruction = " ".join(parts)
        if not opaque_output:
            instruction = f"{QWEN_IMAGE21_RGBA_PROMPT_PREFIX} {instruction} {QWEN_IMAGE21_RGBA_PROMPT_SUFFIX}".strip()
        return instruction

    def create_empty_latent(self, width: int, height: int, gen_settings: dict[str, Any], draw_id: str = "unknown") -> dict[str, Any]:
        width, height = self.resolve_generation_size(width, height, gen_settings)
        batch_size = max(1, int((gen_settings or {}).get("batch_size", 1) or 1))
        latent = torch.zeros(
            [batch_size, 64, max(1, int(height) // 16), max(1, int(width) // 16)],
            dtype=torch.float32,
        )
        encoded = {"samples": latent}
        _uc_log(draw_id, "created empty Qwen-Image-2.1 RGBA latent", _latent_debug(encoded))
        return encoded

    def encode_prompt(self, clip: Any, text: str, gen_settings: dict[str, Any]):
        # The Qwen3-VL encoder needs the <image N> condition images, so the real
        # encode is deferred to prepare_reference_conditioning. The draw flow
        # calls this for the positive prompt first and the negative prompt
        # second; collect both for the deferred encode.
        prompts = gen_settings.setdefault("_qwen21_prompts", [])
        prompts.append(text or "")
        gen_settings["_qwen21_prompt"] = prompts[0]
        gen_settings["_qwen21_negative_prompt"] = prompts[1] if len(prompts) > 1 else ""
        gen_settings.setdefault("_qwen21_clip", clip)
        return [[torch.zeros(1, 4), {}]]

    def prepare_reference_conditioning(
        self,
        positive: Any,
        negative: Any,
        vae: Any,
        image_tensor: torch.Tensor,
        gen_settings: dict[str, Any],
        draw_id: str = "unknown",
    ) -> tuple[Any, Any]:
        if vae is None:
            raise RuntimeError("[VNCCS UniCanvas] Qwen-Image-2.1 requires the 64-channel RGBA image VAE.")
        clip = gen_settings.get("_qwen21_clip") or (gen_settings.get("_external") or {}).get("clip")
        if clip is None:
            raise RuntimeError("[VNCCS UniCanvas] Qwen-Image-2.1 requires a Qwen3-VL text encoder (CLIP).")
        slots = self.reference_image_slots(image_tensor, gen_settings)
        if str(gen_settings.get("draw_mode") or "") == "txt2img":
            # Pure text-to-image has no working area; references keep fixed slots.
            slots.pop(1, None)
        opaque = self.output_is_opaque(gen_settings)
        outpaint = str(gen_settings.get("draw_mode") or "") == "outpaint"
        instruction = self.assemble_instruction(gen_settings.get("_qwen21_prompt"), slots, opaque, outpaint=outpaint)
        negative_prompt = str(gen_settings.get("_qwen21_negative_prompt") or "")
        condition_images = {slot: self._prepare_qi21_condition_image(tensor) for slot, tensor in slots.items()}
        image_h, image_w = _qwen21_image_size(image_tensor)
        target_w, target_h = self.resolve_generation_size(image_w, image_h, gen_settings)
        positive, negative = self._encode_qi21(
            clip=clip,
            vae=vae,
            prompt=instruction,
            negative_prompt=negative_prompt,
            images=condition_images,
            resolution=_qwen21_encoder_resolution(target_w, target_h),
            draw_id=draw_id,
        )
        gen_settings["_qwen21_latent"] = self._qwen21_working_latent(vae, image_tensor, gen_settings, draw_id)
        _uc_log(
            draw_id,
            "Qwen-Image-2.1 conditioning prepared",
            {
                "slots": sorted(slots),
                "opaque_output": opaque,
                "generation_size": [target_w, target_h],
                "positive": _conditioning_debug(positive),
                "negative": _conditioning_debug(negative),
            },
        )
        return positive, negative

    def decode_samples(self, vae: Any, samples: Any, gen_settings: dict[str, Any]):
        decoded = super().decode_samples(vae, samples, gen_settings)
        if self.output_is_opaque(gen_settings) and torch.is_tensor(decoded) and int(decoded.shape[-1]) == 4:
            # "opaque output" flattens the RGBA result onto white and drops alpha.
            rgba = decoded.float()
            alpha = rgba[..., 3:4].clamp(0.0, 1.0)
            return (rgba[..., :3] * alpha + (1.0 - alpha)).clamp(0.0, 1.0)
        return decoded

    def remove_background(self, image: torch.Tensor, settings: dict[str, Any] | None = None) -> torch.Tensor:
        """QI2.1 RGBA subject extraction over the pixels (spec 10.3).

        Contract: (H,W,3) float 0..1 in, (H,W,4) float 0..1 out where the
        alpha channel carries the extracted subject mask. ``settings`` (loader,
        model files, steps, cfg, scheduler, seed) override the family defaults.
        """
        pixels = self._require_rgb_pixels(image)
        rgba = self._subject_extraction(pixels, settings)
        return self._coerce_rgba_result(rgba, pixels.shape[:2])

    def _require_rgb_pixels(self, image: Any) -> torch.Tensor:
        if not torch.is_tensor(image):
            raise ValueError("[VNCCS UniCanvas] Remove bg – QI2.1 expects a torch.Tensor (H,W,3) float 0..1 image.")
        if image.ndim != 3 or int(image.shape[-1]) != 3:
            raise ValueError(
                f"[VNCCS UniCanvas] Remove bg – QI2.1 expects a (H,W,3) image tensor, got {tuple(image.shape)}."
            )
        if not torch.is_floating_point(image):
            raise ValueError("[VNCCS UniCanvas] Remove bg – QI2.1 expects a float 0..1 image tensor.")
        return image.clamp(0.0, 1.0)

    def _coerce_rgba_result(self, rgba: Any, size) -> torch.Tensor:
        if not torch.is_tensor(rgba):
            raise RuntimeError("[VNCCS UniCanvas] Remove bg – QI2.1 subject extraction returned no image.")
        result = rgba.detach().float()
        while result.ndim > 3 and int(result.shape[0]) == 1:
            result = result[0]
        if result.ndim == 4:
            result = result[0]
        if result.ndim != 3 or int(result.shape[-1]) != 4:
            raise RuntimeError(
                "[VNCCS UniCanvas] Remove bg – QI2.1 subject extraction must return an RGBA image, "
                f"got {tuple(result.shape)}."
            )
        target_h, target_w = int(size[0]), int(size[1])
        if (int(result.shape[0]), int(result.shape[1])) != (target_h, target_w):
            result = torch.nn.functional.interpolate(
                result.permute(2, 0, 1).unsqueeze(0),
                size=(target_h, target_w),
                mode="bilinear",
                align_corners=False,
            )[0].permute(1, 2, 0)
        return result.clamp(0.0, 1.0)

    def _subject_extraction(self, pixels: torch.Tensor, settings: dict[str, Any] | None = None) -> torch.Tensor:
        """Run the QI2.1 RGBA subject-extraction flow over the pixels.

        Uses the by-name QI2.1 stack (UNETLoader/CLIPLoader/VAELoader
        semantics) with the official extraction instruction wrapped in the
        transparent-RGBA prompt convention so the flow returns real alpha.
        """
        draw_id = "remove_background"
        # The public contract hands over (H,W,3) pixels; run the flow over the
        # batched (1,H,W,3) layout that every other call path uses.
        if pixels.ndim == 3:
            pixels = pixels.unsqueeze(0)
        gen_settings = dict(QWEN_IMAGE21_DEFAULTS)
        gen_settings.update(settings or {})
        if "lora_stack" in (settings or {}):
            # Remove bg picks its (turbo) LoRA explicitly, "None" included: no family default.
            # A picked Viggle turbo still goes through the family rule (unmerged + its schedule);
            picked = next(
                (item for item in gen_settings.get("lora_stack") or []
                 if isinstance(item, dict) and _lora_name_matches(item.get("name"), QWEN21_TURBO_LORA_NAME)),
                None,
            )
            gen_settings["qwen_lora_name"] = QWEN21_TURBO_LORA_NAME if picked else ""
            if picked:
                gen_settings["qwen_lora_strength"] = float(picked.get("strength", 1.0))
        gen_settings["draw_mode"] = "img2img"
        gen_settings["_draw_id"] = draw_id
        gen_settings["qwen21_opaque_output"] = False
        try:
            model, clip, vae = _load_generation_assets(gen_settings)
        except Exception as exc:
            raise RuntimeError(
                "[VNCCS UniCanvas] Remove bg – QI2.1 requires a Qwen-Image-2.1 stack "
                f"(UNETLoader/CLIPLoader/VAELoader): {exc}"
            ) from exc
        # The family's LoRA rules plus the optional turbo LoRA picked for Remove bg.
        model, clip = self.apply_loras(model, clip, gen_settings)
        gen_settings["_qwen21_clip"] = clip
        gen_settings["_qwen21_prompt"] = str(gen_settings.get("prompt") or "").strip() or QWEN_IMAGE21_SUBJECT_EXTRACTION_PROMPT
        gen_settings["_qwen21_negative_prompt"] = ""
        positive, negative = self.prepare_reference_conditioning(None, None, vae, pixels, gen_settings, draw_id)
        latent = gen_settings.get("_qwen21_latent")
        if not isinstance(latent, dict):
            pixels_h, pixels_w = _qwen21_image_size(pixels)
            latent = self.create_empty_latent(int(pixels_w), int(pixels_h), gen_settings, draw_id)
        sampled = self.sample_latent(
            model=model,
            positive=positive,
            negative=negative,
            latent=latent,
            seed=int(gen_settings.get("seed") or 0),
            steps=int(gen_settings.get("steps") or 40),
            cfg=float(gen_settings.get("cfg") or 1.0),
            sampler_name=str(gen_settings.get("sampler_name") or "euler"),
            scheduler=str(gen_settings.get("scheduler") or "simple"),
            denoise=1.0,
            gen_settings=gen_settings,
            draw_id=draw_id,
        )
        decoded = self.decode_samples(vae, sampled, gen_settings)
        if torch.is_tensor(decoded) and decoded.ndim == 4:
            return decoded[0]
        return decoded

    def _prepare_qi21_condition_image(self, image: Any) -> torch.Tensor:
        if not torch.is_tensor(image):
            raise ValueError("[VNCCS UniCanvas] Qwen-Image-2.1 condition image must be a tensor.")
        tensor = image
        if tensor.ndim == 3:
            tensor = tensor.unsqueeze(0)
        if not torch.is_floating_point(tensor):
            tensor = tensor.float()
        if tensor.numel() and float(tensor.detach().max()) > 1.5:
            tensor = tensor / 255.0
        tensor = tensor.clamp(0.0, 1.0)
        channels = int(tensor.shape[-1])
        if channels == 1:
            return tensor.repeat(1, 1, 1, 3)
        return tensor[..., :3]

    def _qwen21_working_latent(self, vae: Any, image_tensor: torch.Tensor, gen_settings: dict[str, Any], draw_id: str = "unknown"):
        """VAE-encode the <image1> working area as the img2img start latent."""
        has_working_area = (
            torch.is_tensor(image_tensor)
            and image_tensor.numel() > 0
            and float(image_tensor.detach().max()) > 0.0
        )
        if str(gen_settings.get("draw_mode") or "") == "txt2img" or not has_working_area:
            return None
        source_h, source_w = _qwen21_image_size(image_tensor)
        target_w, target_h = self.resolve_generation_size(source_w, source_h, gen_settings)
        pixels = self._prepare_qi21_condition_image(image_tensor)
        if (int(pixels.shape[2]), int(pixels.shape[1])) != (int(target_w), int(target_h)):
            pixels = torch.nn.functional.interpolate(
                pixels.movedim(-1, 1),
                size=(int(target_h), int(target_w)),
                mode="bilinear",
                align_corners=False,
            ).movedim(1, -1)
        rgba = torch.cat([pixels, torch.ones_like(pixels[..., :1])], dim=-1)
        encoded = vae.encode(rgba)
        latent = encoded if isinstance(encoded, dict) else {"samples": encoded}
        _uc_log(draw_id, "Qwen-Image-2.1 working-area latent encoded", _latent_debug(latent))
        return latent

    def _encode_qi21(
        self,
        clip: Any,
        vae: Any,
        prompt: str,
        negative_prompt: str,
        images: dict[int, Any],
        resolution: int,
        draw_id: str = "unknown",
    ) -> tuple[Any, Any]:
        """Encode the instruction and <image N> condition images with the
        Qwen3-VL 8B text encoder through ComfyUI core's TextEncodeQwenImage21.

        The node takes the condition images as its Autogrow ``images`` dict
        ({"image_1": ..., "image_2": ...}). V3 nodes are called through a
        ``**kwargs`` wrapper, so executor-style "images.image_N" keys must not be
        passed as well: execute() rejects them.
        """
        slot_images = {f"image_{slot}": tensor for slot, tensor in sorted(images.items())}
        encoded = _call_comfy_node(
            "TextEncodeQwenImage21",
            clip=clip,
            vae=vae,
            prompt=prompt,
            negative_prompt=negative_prompt or "",
            resolution=int(resolution),
            images=slot_images,
        )
        if encoded is None:
            raise RuntimeError("[VNCCS UniCanvas] Qwen-Image-2.1 text encoding returned no conditioning.")
        if isinstance(encoded, (list, tuple)):
            positive = encoded[0]
            negative = encoded[1] if len(encoded) > 1 else None
        else:
            positive = encoded
            negative = None
        if negative is None:
            negative = [(torch.zeros_like(cond[0]), cond[1]) for cond in positive]
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
        external = (gen_settings or {}).get("_external")
        config_loras = loras._active_lora_names(external.get("lora_stack") if isinstance(external, dict) else None)
        # A turbo merged by a linked VNCSS Config still needs the student schedule.
        if not (has_viggle_turbo(model) or loras._lora_name_in(QWEN21_TURBO_LORA_NAME, config_loras)):
            return super().sample_latent(
                model, positive, negative, latent, seed, steps, cfg, sampler_name, scheduler, denoise, gen_settings, draw_id
            )
        # The Viggle 6-step student is only clean on its own shifted timesteps: a
        # steps/scheduler KSampler run lands between them and renders aberrations.
        import comfy.sample as comfy_sample
        import comfy.samplers as comfy_samplers

        _ensure_direct_sampling_prompt_context()
        latent_image = comfy_sample.fix_empty_latent_channels(model, latent["samples"], latent.get("downscale_ratio_spacial"))
        sigmas = viggle_turbo_sigmas(latent, denoise)
        total = len(sigmas) - 1
        _uc_log(draw_id, "Viggle turbo sampling", {"sigmas": [round(float(s), 4) for s in sigmas], "cfg": cfg, "seed": seed})

        def on_step(step: int, *_args: Any) -> None:
            current = min(int(step) + 1, total)
            _set_draw_progress(draw_id, "sampling", 0.35 + 0.5 * current / total, current, total, f"Sampling step {current}/{total}")

        _set_draw_progress(draw_id, "sampling", 0.35, 0, total, f"Sampling 0/{total}")
        with _suppress_direct_sampling_comfy_progress():
            samples = comfy_sample.sample_custom(
                model,
                comfy_sample.prepare_noise(latent_image, seed, latent.get("batch_index")),
                float(cfg),
                comfy_samplers.sampler_object("euler"),
                sigmas,
                positive,
                negative,
                latent_image,
                noise_mask=latent.get("noise_mask"),
                callback=on_step,
                disable_pbar=True,
                seed=seed,
            )
        out = dict(latent)
        out.pop("downscale_ratio_spacial", None)
        out["samples"] = samples
        _uc_log(draw_id, "Viggle turbo sampling output", _latent_debug(out))
        return out

    # -- draw hooks -----------------------------------------------------------------------

    def prepare_generation_latent(self, ctx) -> Any:
        # Qwen-Image-2.1 owns its 64-channel RGBA latents: the <image1> working-area latent
        # is prepared during reference conditioning and inpaint/outpaint are img2img runs
        # with mask paste-back (spec 9), so no InpaintModelConditioning context is built.
        latent = ctx.settings.get("_qwen21_latent")
        if not isinstance(latent, dict):
            latent = self.create_empty_latent(ctx.width, ctx.height, ctx.settings, draw_id=ctx.draw_id)
        _uc_log(ctx.draw_id, "Qwen-Image-2.1 latent prepared", {"mode": ctx.mode, "latent": _latent_debug(latent)})
        return latent
