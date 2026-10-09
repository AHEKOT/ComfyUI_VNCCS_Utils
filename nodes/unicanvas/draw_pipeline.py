"""The canvas draw path as an extensible pipeline.

:class:`ImageDrawPipeline` runs one draw in stages (template method). Model-family
specifics never appear here: every place where a family behaves differently calls a
hook on the family (``UniCanvasModelModule``) with the shared :class:`DrawContext`.
A family that needs a different path altogether (video, 3D, panorama views ...) sets
``draw_pipeline_class`` to its own subclass and overrides whole stages.

This module sits below ``models`` in the package layering (it never imports the
registry), so family modules may subclass the pipeline without import cycles.
"""

from __future__ import annotations

import contextlib
import gc
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import torch
from PIL import Image, ImageChops

from .constants import _MAX_PIXELS
from .crop_stitch import CROP_SETTING, crop_image, plan_crop, stitch_image, stitch_mask
from .debug import _tensor_debug, _uc_log, debug_enabled
from .imaging import (
    _decode_data_url,
    _image_tensor_to_pil_list,
    _pil_to_image_tensor,
    _pil_rgba_to_image_tensor,
    _pil_to_mask_image,
    _pil_to_mask_tensor,
)
from .latents import _repeat_conditioning_batch, _repeat_latent_batch
from .loaders import _load_generation_assets
from .locks import _COMFY_MODEL_OP_LOCK
from .masking import _combine_mask_with_source_alpha, _make_gradient_denoise_mask, _make_gradient_paste_mask
from .performance import apply_step_cache, performance_label, step_cache_skip_reason
from .progress import _set_draw_progress, interrupt_types, set_interrupt
from .prompt_enhance import _release_generation_state, apply_auto_enhance
from .sampling import _apply_differential_diffusion, _ensure_direct_sampling_prompt_context, _release_generation_sampling_refs


if TYPE_CHECKING:
    from .draw_request import DrawRequest
    from .models.base import UniCanvasModelModule

MASKED_MODES = frozenset({"inpaint", "outpaint"})
# Settings every draw may carry that are only needed until sampling finishes.
COMMON_SCRATCH_KEYS = ("_pose_edit_images", "_edit_layers_reference")


def _save_temp_image(image: Image.Image, prefix: str = "VNCCS_UniCanvas") -> dict[str, str]:
    import folder_paths

    output_dir = folder_paths.get_temp_directory()
    full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        prefix, output_dir, image.width, image.height
    )
    file = f"{filename}_{counter:05}_.png"
    image.save(f"{full_output_folder}/{file}", compress_level=1)
    return {"filename": file, "subfolder": subfolder, "type": "temp"}


def prepare_pose_edit_images(module: UniCanvasModelModule, payload: dict[str, Any], size: tuple[int, int], supported_labels: list[str]) -> list[Image.Image] | None:
    """Validate the explicit Pose Studio contract before loading model assets."""
    pose_edit = payload.get("pose_edit")
    if pose_edit is None:
        return None
    if module is None or not module.capabilities.supports_pose_edit:
        raise ValueError(f"Pose layers require {' or '.join(supported_labels) or 'a pose-capable edit model'}")
    if payload.get("mode") != "img2img" or payload.get("source_empty"):
        raise ValueError("Pose editing requires img2img with two reference images")
    if not isinstance(pose_edit, dict) or set(pose_edit) != {"image1", "image2"}:
        raise ValueError("Pose editing requires image1 (pose) and image2 (background and character)")
    images = []
    for key in ("image1", "image2"):
        rgba = _decode_data_url(str(pose_edit[key] or ""), "RGBA")
        if rgba.size != size:
            raise ValueError(f"Pose {key} dimensions must match inference_size")
        background = Image.new("RGBA", size, (255, 255, 255, 255))
        background.alpha_composite(rgba)
        images.append(background.convert("RGB"))
    return images


@dataclass
class DrawContext:
    """Mutable state of one draw, shared by the pipeline stages and the family hooks."""

    request: DrawRequest
    settings: dict[str, Any]
    mode: str | None
    denoise: float
    source_rgba: Image.Image | None = None
    source: Image.Image | None = None
    reference_source: Image.Image | None = None
    source_empty: bool = False
    width: int = 0
    height: int = 0
    output_size: tuple[int, int] = (0, 0)
    pose_images: list[Image.Image] | None = None
    model: Any = None
    clip: Any = None
    vae: Any = None
    positive: Any = None
    negative: Any = None
    mask: torch.Tensor | None = None
    mask_image: Image.Image | None = None
    paste_mask_image: Image.Image | None = None
    image_tensor: torch.Tensor | None = None
    reference_image_tensor: torch.Tensor | None = None
    latent: Any = None
    decoded: Any = None
    result_images: list[Image.Image] = field(default_factory=list)
    # Inpaint crop-and-stitch (crop_stitch.py): the plan, the uncropped source and the cropped mask.
    crop_plan: Any = None
    full_source_rgba: Image.Image | None = None
    cropped_mask_rgba: Image.Image | None = None

    @property
    def draw_id(self) -> str:
        return self.request.draw_id

    @property
    def is_masked(self) -> bool:
        return self.mode in MASKED_MODES and self.mask is not None

    @property
    def latent_source(self) -> str:
        """Where the generation latent comes from by default: ``empty``, ``masked`` or ``source``."""
        if self.mode == "txt2img" or (self.source_empty and self.mask is None):
            return "empty"
        if self.is_masked:
            return "masked"
        return "source"


class ImageDrawPipeline:
    """txt2img / img2img / inpaint / outpaint on the canvas, producing images."""

    def __init__(self, module: UniCanvasModelModule, request: DrawRequest, supported_pose_labels: list[str] | None = None):
        self.module = module
        self.request = request
        self.supported_pose_labels = supported_pose_labels or []
        self.ctx = DrawContext(request=request, settings=request.settings, mode=request.mode, denoise=request.denoise)

    # -- template ---------------------------------------------------------------------

    def run(self) -> dict[str, Any]:
        try:
            return self._run()
        except interrupt_types():
            self.free_after_interrupt()
            raise

    def free_after_interrupt(self) -> None:
        """Stop pressed: drop this draw's tensors and clean up unused models."""
        ctx = self.ctx
        ctx.model = ctx.clip = ctx.vae = ctx.positive = ctx.negative = ctx.latent = ctx.decoded = None
        ctx.image_tensor = ctx.reference_image_tensor = ctx.mask = None
        ctx.result_images = []
        with contextlib.suppress(Exception):
            _release_generation_sampling_refs(ctx.settings, ctx.draw_id, COMMON_SCRATCH_KEYS + tuple(self.module.sampling_scratch_keys))
        with _COMFY_MODEL_OP_LOCK, contextlib.suppress(Exception):
            set_interrupt(False)
            _release_generation_state()
            import comfy.model_management as model_management

            model_management.cleanup_models()
        gc.collect()
        with contextlib.suppress(Exception):
            import comfy.model_management as model_management

            model_management.soft_empty_cache(True)
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        _set_draw_progress(ctx.draw_id, "cancelled", 1.0, 0, 0, "Stopped - VRAM freed")

    def _run(self) -> dict[str, Any]:
        self.prepare_source()
        self.check_sizes()
        self.crop_to_mask()
        with contextlib.ExitStack() as model_session:
            model_session.enter_context(_COMFY_MODEL_OP_LOCK)
            model_session.enter_context(torch.inference_mode())
            self.load_models()
            self.apply_loras()
            self.enhance_prompts()
            self.encode_prompts()
            self.prepare_mask()
            self.prepare_inputs()
            self.condition()
            self.prepare_latent()
            self.sample()
            self.decode()
        self.fit_to_output()
        return self.save_result()

    # -- stages -----------------------------------------------------------------------

    def prepare_source(self) -> None:
        ctx, payload = self.ctx, self.request.payload
        pose_payload = payload.get("pose_edit")
        source_url = pose_payload.get("image2") if isinstance(pose_payload, dict) else payload.get("image")
        ctx.source_rgba = _decode_data_url(str(source_url or ""), "RGBA")
        ctx.source = ctx.reference_source = ctx.source_rgba.convert("RGB")
        ctx.width, ctx.height = ctx.source.size
        ctx.source_empty = bool(payload.get("source_empty"))
        ctx.pose_images = prepare_pose_edit_images(self.module, payload, (ctx.width, ctx.height), self.supported_pose_labels)
        if ctx.pose_images:
            ctx.source = ctx.reference_source = ctx.pose_images[1]
            self.module.prepare_pose_edit(ctx)
        self.module.validate_source(ctx)

    def check_sizes(self) -> None:
        ctx, payload = self.ctx, self.request.payload
        inference_payload = payload.get("inference_size") or {}
        expected_width = int(inference_payload.get("width") or ctx.width)
        expected_height = int(inference_payload.get("height") or ctx.height)
        if (ctx.width, ctx.height) != (expected_width, expected_height):
            raise ValueError(
                f"inference_size mismatch: payload says {expected_width}x{expected_height}, image is {ctx.width}x{ctx.height}"
            )
        output_payload = payload.get("output_size") or {}
        output_width = int(output_payload.get("width") or ctx.width)
        output_height = int(output_payload.get("height") or ctx.height)
        if output_width < 1 or output_height < 1:
            raise ValueError("output_size must be positive")
        if output_width * output_height > _MAX_PIXELS:
            raise ValueError("output_size is too large")
        ctx.output_size = (output_width, output_height)

    def crop_to_mask(self) -> None:
        """Inpaint: generate only the area around the mask (plus context) at full resolution."""
        ctx, payload = self.ctx, self.request.payload
        enabled = ctx.settings.get(CROP_SETTING, True)
        if ctx.mode != "inpaint" or ctx.pose_images or enabled is False or str(enabled).lower() in {"false", "0", "off"}:
            return
        mask = _decode_data_url(str(payload.get("mask") or ""), "RGBA")
        if mask.size != ctx.source.size:
            mask = mask.resize(ctx.source.size, Image.Resampling.BILINEAR)
        plan = plan_crop(mask, ctx.source.size)
        if plan is None:
            return
        ctx.crop_plan = plan
        ctx.full_source_rgba = ctx.source_rgba
        ctx.source_rgba = crop_image(ctx.source_rgba, plan)
        ctx.source = ctx.reference_source = ctx.source_rgba.convert("RGB")
        ctx.cropped_mask_rgba = crop_image(mask, plan, Image.Resampling.BILINEAR)
        ctx.width, ctx.height = plan.work_size
        _uc_log(ctx.draw_id, "inpaint crop-and-stitch", {"box": plan.box, "work_size": plan.work_size, "full_size": plan.full_size})

    def load_models(self) -> None:
        ctx, steps = self.ctx, self.request.steps
        _set_draw_progress(ctx.draw_id, "loading", 0.08, 0, steps, "Loading models")
        model, clip, ctx.vae = _load_generation_assets(ctx.settings)
        ctx.model, ctx.clip = self.module.clone_assets(model, clip)
        ctx.settings["_draw_id"] = ctx.draw_id
        self.module.prepare_draw_assets(ctx)
        self.module.preload_vae(ctx)
        self.module.bind_draw_assets(ctx)

    def apply_loras(self) -> None:
        ctx = self.ctx
        _set_draw_progress(ctx.draw_id, "loras", 0.14, 0, self.request.steps, "Applying LoRAs")
        ctx.model, ctx.clip = self.module.apply_loras(ctx.model, ctx.clip, ctx.settings)
        self.module.bind_draw_assets(ctx)

    def enhance_prompts(self) -> None:
        """Auto prompt enhance (settings.prompt_enhance, sent only when enabled and no config is linked)."""
        ctx = self.ctx
        edit_source = None if ctx.mode == "txt2img" or ctx.source_empty else ctx.source
        apply_auto_enhance(self.request, ctx.clip, edit_source)

    def encode_prompts(self) -> None:
        ctx = self.ctx
        _set_draw_progress(ctx.draw_id, "conditioning", 0.2, 0, self.request.steps, "Encoding prompts")
        ctx.positive, ctx.negative = self.module.encode_draw_prompts(ctx)

    def prepare_mask(self) -> None:
        ctx, request = self.ctx, self.request
        _set_draw_progress(ctx.draw_id, "preparing", 0.26, 0, request.steps, "Preparing source")
        if ctx.mode not in MASKED_MODES:
            _uc_log(ctx.draw_id, "mask skipped", {"reason": f"mode is {ctx.mode}"})
            return
        mask_image = ctx.cropped_mask_rgba if ctx.cropped_mask_rgba is not None else _decode_data_url(str(request.payload.get("mask") or ""), "RGBA")
        if mask_image.size != ctx.source.size:
            _uc_log(ctx.draw_id, "mask resized to source size", {"from": mask_image.size, "to": ctx.source.size})
            mask_image = mask_image.resize(ctx.source.size, Image.Resampling.BILINEAR)
        if ctx.mode == "outpaint":
            mask_image = _combine_mask_with_source_alpha(mask_image, ctx.source_rgba)
        denoise_mask_image, expanded_mask_area = _make_gradient_denoise_mask(mask_image, request.coherence_edge_size, ctx.draw_id)
        ctx.paste_mask_image = _make_gradient_paste_mask(expanded_mask_area, request.mask_blur, ctx.draw_id)
        if ctx.mode == "outpaint":
            ctx.source = ctx.reference_source = self.module.prepare_outpaint_reference_image(ctx.source_rgba, mask_image, ctx.draw_id)
        ctx.mask_image = mask_image
        ctx.mask = _pil_to_mask_tensor(denoise_mask_image)
        if float(ctx.mask.sum().item()) <= 0.0:
            self.drop_empty_mask()
        self.module.on_mask_prepared(ctx)
        if ctx.mask_image is not None and debug_enabled():
            self.log_mask_debug()

    def drop_empty_mask(self) -> None:
        ctx = self.ctx
        _uc_log(
            ctx.draw_id,
            "empty masked-mode mask converted to img2img",
            {
                "from_mode": ctx.mode,
                "reason": "masked generation with an empty mask produces an empty paste mask and applies zero result pixels",
            },
        )
        ctx.mode = "img2img"
        ctx.settings["draw_mode"] = ctx.mode
        self.module.on_masked_mode_dropped(ctx)
        ctx.mask = None
        ctx.mask_image = None
        ctx.paste_mask_image = None

    def log_mask_debug(self) -> None:
        ctx = self.ctx
        _uc_log(
            ctx.draw_id,
            "mask decoded",
            {
                "full_mask_size": ctx.mask_image.size,
                "note": "active_bbox_gt_0_01 is only the non-zero mask area inside the full inference image",
                "tensor": _tensor_debug(ctx.mask),
            },
        )
        source_debug = _save_temp_image(ctx.source, f"VNCCS_UniCanvas_{ctx.draw_id}_source")
        mask_debug = _save_temp_image(_pil_to_mask_image(ctx.mask_image), f"VNCCS_UniCanvas_{ctx.draw_id}_mask")
        paste_mask_debug = (
            _save_temp_image(ctx.paste_mask_image, f"VNCCS_UniCanvas_{ctx.draw_id}_paste_mask")
            if ctx.paste_mask_image is not None
            else None
        )
        _uc_log(ctx.draw_id, "debug input images saved", {"source": source_debug, "mask": mask_debug, "paste_mask": paste_mask_debug})

    def prepare_inputs(self) -> None:
        ctx = self.ctx
        if self.module.is_edit_model and (ctx.mode == "txt2img" or ctx.source_empty):
            ctx.source = ctx.reference_source = Image.new("RGB", (ctx.width, ctx.height), (0, 0, 0))
            _uc_log(ctx.draw_id, "edit-model txt2img source replaced with black reference image", {"size": ctx.source.size})
        ctx.image_tensor = _pil_to_image_tensor(ctx.source)
        ctx.reference_image_tensor = _pil_to_image_tensor(ctx.reference_source)
        if self.module.is_edit_model and ctx.settings.get("edit_use_layers_as_reference") is True and ctx.full_source_rgba is not None:
            ctx.settings["_edit_layers_reference"] = _pil_to_image_tensor(ctx.full_source_rgba.convert("RGB"))
        if ctx.pose_images:
            ctx.settings["_pose_edit_images"] = [_pil_to_image_tensor(image) for image in ctx.pose_images]
        _uc_log(
            ctx.draw_id,
            "source prepared",
            {
                "size": ctx.source.size,
                "tensor": _tensor_debug(ctx.image_tensor),
                "reference_size": ctx.reference_source.size,
                "reference_tensor": _tensor_debug(ctx.reference_image_tensor),
            },
        )
        self.module.prepare_masked_inputs(ctx)

    def condition(self) -> None:
        ctx = self.ctx
        ctx.positive, ctx.negative = self.module.prepare_reference_conditioning(
            positive=ctx.positive,
            negative=ctx.negative,
            vae=ctx.vae,
            image_tensor=ctx.reference_image_tensor,
            gen_settings=ctx.settings,
            draw_id=ctx.draw_id,
        )
        if not self.module.is_edit_model and self.module.uses_differential_diffusion(ctx.mode) and ctx.is_masked:
            ctx.model = _apply_differential_diffusion(ctx.model, ctx.draw_id, strength=1.0)

    def prepare_latent(self) -> None:
        ctx, request = self.ctx, self.request
        _set_draw_progress(ctx.draw_id, "latent", 0.32, 0, request.steps, "Preparing latent")
        ctx.latent = _repeat_latent_batch(self.module.prepare_generation_latent(ctx), request.batch_size, ctx.draw_id)
        self.module.after_latent_prepared(ctx)
        ctx.positive = _repeat_conditioning_batch(ctx.positive, request.batch_size, ctx.draw_id, "positive")
        ctx.negative = _repeat_conditioning_batch(ctx.negative, request.batch_size, ctx.draw_id, "negative")

    def sample(self) -> None:
        ctx, request = self.ctx, self.request
        ctx.model = self.module.prepare_model_for_sampling(ctx)
        # Step cache (EasyCache) and the attention/VAE summary shown in the progress bar.
        note = step_cache_skip_reason(ctx.settings, request.steps) or ("" if self.module.supports_step_cache(ctx.settings) else "not with this family's settings")
        cached_model = ctx.model if note else apply_step_cache(ctx.model, ctx.settings, request.steps)
        cached = cached_model is not ctx.model
        ctx.model = cached_model
        ctx.settings["_performance"] = performance_label(ctx.settings, cached, note if not cached else "")
        _uc_log(ctx.draw_id, "performance", {"summary": ctx.settings["_performance"]})
        # Core samplers report progress for "the current prompt"; a graph-less draw (and a family
        # with its own sample_latent) has none unless a queued prompt ran since startup.
        _ensure_direct_sampling_prompt_context()
        ctx.latent = self.module.sample_latent(
            model=ctx.model,
            positive=ctx.positive,
            negative=ctx.negative,
            latent=ctx.latent,
            seed=request.seed,
            steps=request.steps,
            cfg=request.cfg,
            sampler_name=request.sampler_name,
            scheduler=request.scheduler,
            denoise=ctx.denoise,
            gen_settings=ctx.settings,
            draw_id=ctx.draw_id,
            width=ctx.width,
            height=ctx.height,
        )
        # Drop sampling-only references before the VAE decode needs the memory.
        ctx.model = ctx.clip = ctx.positive = ctx.negative = None
        ctx.image_tensor = ctx.reference_image_tensor = ctx.mask = None
        _release_generation_sampling_refs(ctx.settings, ctx.draw_id, COMMON_SCRATCH_KEYS + tuple(self.module.sampling_scratch_keys))

    def decode(self) -> None:
        ctx, steps = self.ctx, self.request.steps
        _set_draw_progress(ctx.draw_id, "decoding", 0.88, steps, steps, "Decoding")
        ctx.decoded = self.module.decode_samples(ctx.vae, ctx.latent, ctx.settings)
        _uc_log(ctx.draw_id, "decoded image tensor", _tensor_debug(ctx.decoded))
        ctx.result_images = _image_tensor_to_pil_list(ctx.decoded)
        self.module.release_vae(ctx)

    def fit_to_output(self) -> None:
        ctx = self.ctx
        if ctx.crop_plan is not None:
            # Stitch: the generated crop goes back into its box; the paste mask stays inside it.
            plan = ctx.crop_plan
            ctx.result_images = [stitch_image(image, ctx.full_source_rgba, plan) for image in ctx.result_images]
            if ctx.paste_mask_image is not None:
                ctx.paste_mask_image = stitch_mask(ctx.paste_mask_image, plan)
            if ctx.mask_image is not None:
                ctx.mask_image = stitch_mask(ctx.mask_image.convert("RGBA").getchannel("A"), plan)
            ctx.width, ctx.height = plan.full_size
        masked = ctx.mode in MASKED_MODES and ctx.mask_image is not None
        resized = []
        for result_image in ctx.result_images:
            if result_image.size != ctx.output_size:
                event = "masked result resized to output size" if masked else "result resized to output size"
                _uc_log(ctx.draw_id, event, {"from": result_image.size, "to": ctx.output_size})
                result_image = result_image.resize(ctx.output_size, Image.Resampling.LANCZOS)
            resized.append(result_image)
        ctx.result_images = resized
        if masked:
            _uc_log(
                ctx.draw_id,
                "masked-region output",
                {
                    "note": "Returning raw generated pixels plus paste mask; frontend stores only masked regions as the layer.",
                    "result_count": len(ctx.result_images),
                    "result_size": ctx.result_images[0].size if ctx.result_images else ctx.output_size,
                    "paste_mask_size": ctx.paste_mask_image.size if ctx.paste_mask_image is not None else ctx.mask_image.size,
                },
            )

    def save_result(self) -> dict[str, Any]:
        ctx, request = self.ctx, self.request
        steps = request.steps
        _set_draw_progress(ctx.draw_id, "saving", 0.96, steps, steps, "Saving result")
        saved_images = [
            _save_temp_image(result_image, f"VNCCS_UniCanvas_{ctx.draw_id}_{index + 1:02d}")
            for index, result_image in enumerate(ctx.result_images)
        ]
        if not saved_images:
            raise RuntimeError("Generation returned no decoded images")
        saved_mask = None
        if ctx.mode in MASKED_MODES and ctx.paste_mask_image is not None:
            mask_to_save = ctx.paste_mask_image
            if mask_to_save.size != ctx.output_size:
                mask_to_save = mask_to_save.resize(ctx.output_size, Image.Resampling.BILINEAR)
            saved_mask = _save_temp_image(mask_to_save, f"VNCCS_UniCanvas_{ctx.draw_id}_result_mask")
        _uc_log(
            ctx.draw_id,
            "result saved",
            {"image": saved_images[0], "images": saved_images, "mask": saved_mask, "count": len(saved_images), "size": ctx.output_size},
        )
        _set_draw_progress(ctx.draw_id, "complete", 1.0, steps, steps, "Complete")
        result = {
            "status": "ok",
            "image": saved_images[0],
            "images": saved_images,
            "mask": saved_mask,
            "width": ctx.output_size[0],
            "height": ctx.output_size[1],
            "inference_width": ctx.width,
            "inference_height": ctx.height,
            "generation_mode": ctx.settings.get("generation_mode", self.module.key),
            "task": request.task.key,
            "debug_id": ctx.draw_id,
            "performance": ctx.settings.get("_performance", ""),
        }
        if request.payload.get("return_tensor"):
            tensor_images = ctx.result_images
            if saved_mask is not None:
                source = ctx.full_source_rgba if ctx.crop_plan is not None else ctx.source_rgba
                source = source.convert("RGBA").resize(ctx.output_size, Image.Resampling.LANCZOS)
                tensor_images = []
                for image in ctx.result_images:
                    patch = image.convert("RGBA")
                    patch.putalpha(ImageChops.multiply(patch.getchannel("A"), mask_to_save.convert("L")))
                    tensor_images.append(Image.alpha_composite(source, patch))
            result["tensor"] = torch.cat([
                (_pil_rgba_to_image_tensor(image) if image.mode == "RGBA" else _pil_to_image_tensor(image))
                for image in tensor_images
            ])
        return result
