"""Base class every UniCanvas model family adapter derives from."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, ClassVar

import torch
from PIL import Image

from ..constants import OUTPAINT_PROMPT_SUFFIX
from ..debug import _latent_debug, _uc_log
from ..latents import _encode_source_latent, _prepare_masked_generation_latent, _unwrap_latent_samples
from ..loras import LoraRequirement, _apply_lora_requirements, _apply_lora_stack, _clone_model_clip
from ..masking import _make_edit_outpaint_reference_rgb, _sample_transparent_outpaint_rgb
from ..sampling import _sample_generation_latent_default
from .capabilities import MediaKind, ModelCapabilities, ModelRole


if TYPE_CHECKING:
    from ..draw_pipeline import DrawContext
    from ..draw_request import DrawRequest


@dataclass(frozen=True)
class UniCanvasModelModule:
    """Backend adapter for one UniCanvas model family.

    The frontend cannot rely on graph connections for model objects because the
    draw action runs inside the widget before a workflow execution starts. Each
    model family therefore owns its own loader contract and generation quirks.

    A family is extended in three ways, from the lightest to the heaviest:

    * data: ``defaults``, ``capabilities`` (tasks, inputs, references, prompt
      guide) and ``lora_requirements``;
    * hooks: the ``*_draw_*`` / ``prepare_*`` methods below, which the default
      ``ImageDrawPipeline`` calls with the shared ``DrawContext`` at fixed points;
    * a whole draw path: ``draw_pipeline_class`` names a pipeline subclass
      (video, 3D or panorama families replace entire stages there).
    """

    key: str
    aliases: tuple[str, ...]
    defaults: dict[str, Any]
    is_edit_model: bool = False
    # LoRAs the family applies itself (turbo, mandatory edit adapters ...), before the user stack.
    lora_requirements: tuple[LoraRequirement, ...] = ()
    # What the family offers (tasks, inputs, references, prompt guide), as data.
    capabilities: ModelCapabilities = ModelCapabilities()

    # The draw path; None selects draw_pipeline.ImageDrawPipeline.
    draw_pipeline_class: ClassVar[type | None] = None
    # Settings keys the family stashes during a draw, dropped before the VAE decode.
    sampling_scratch_keys: ClassVar[tuple[str, ...]] = ()
    decode_tile_size: ClassVar[int] = 512

    @property
    def label(self) -> str:
        return self.capabilities.label or self.key

    @property
    def role(self) -> ModelRole:
        return ModelRole.EDIT if self.is_edit_model else ModelRole.GENERATOR

    def describe(self) -> dict[str, Any]:
        """JSON-safe self-description served to the widget by ``/vnccs/unicanvas/assets``."""
        return {
            "key": self.key,
            "aliases": list(self.aliases),
            "defaults": self.defaults,
            "is_edit_model": self.is_edit_model,
            "role": self.role.value,
            "capabilities": self.capabilities.describe(),
            "lora_requirements": [rule.describe() for rule in self.lora_requirements],
        }

    # -- settings and request validation ------------------------------------------------

    def normalize_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        """Last step of settings normalisation: validate or pin family-specific values."""
        return settings

    def validate_request(self, request: DrawRequest) -> None:
        """Reject a draw this family cannot run, before any pixel work or model loading."""
        capabilities = self.capabilities
        if capabilities.requires_external_config and not request.external:
            raise RuntimeError(
                capabilities.external_config_message
                or f"[VNCCS UniCanvas] {self.label} requires a connected VNCSS Config node."
            )
        task = request.task
        if capabilities.supports_task(task.key):
            return
        if capabilities.declared_task(task.key) is not None:
            raise ValueError(f"[VNCCS UniCanvas] {self.label}: {task.label} is not available in UniCanvas yet.")
        if capabilities.requires_source_image and MediaKind.IMAGE not in task.inputs:
            raise ValueError(self._source_image_message())
        raise ValueError(f"[VNCCS UniCanvas] {self.label} does not support {task.label}.")

    def validate_source(self, ctx: DrawContext) -> None:
        """Reject a decoded source this family cannot work from (e.g. an empty bbox)."""
        if not self.capabilities.requires_source_image:
            return
        if ctx.source_empty or ctx.source_rgba.getextrema()[3][1] == 0:
            raise ValueError(self._source_image_message())

    def _source_image_message(self) -> str:
        return self.capabilities.source_image_message or f"{self.label} requires an image inside the bbox."

    # -- draw hooks (called by ImageDrawPipeline) ---------------------------------------

    def prepare_pose_edit(self, ctx: DrawContext) -> None:
        """Pose Studio layers: the pose render and the background are the references; full denoise."""
        ctx.denoise = 1.0
        ctx.settings["denoise"] = 1.0

    def prepare_draw_assets(self, ctx: DrawContext) -> None:
        """Load family extras (patches, ControlNets) right after the base models."""

    def preload_vae(self, ctx: DrawContext) -> None:
        """Pin the VAE on the device before sampling when the family needs it."""

    def release_vae(self, ctx: DrawContext) -> None:
        """Undo :meth:`preload_vae` after decoding."""

    def bind_draw_assets(self, ctx: DrawContext) -> None:
        """Remember clip/vae for later stages: called after loading and again after the LoRAs."""

    def encode_draw_prompts(self, ctx: DrawContext) -> tuple[Any, Any]:
        positive = self.encode_prompt(ctx.clip, ctx.request.positive_text, ctx.settings)
        negative = self.encode_prompt(ctx.clip, ctx.request.negative_text, ctx.settings)
        self.validate_conditioning(positive, negative, ctx.settings)
        return positive, negative

    def on_mask_prepared(self, ctx: DrawContext) -> None:
        """React to the prepared denoise mask (``ctx.mask`` may be None after an empty mask)."""

    def on_masked_mode_dropped(self, ctx: DrawContext) -> None:
        """An empty inpaint/outpaint mask turned the draw into img2img: release mask-only resources."""

    def prepare_masked_inputs(self, ctx: DrawContext) -> None:
        """Stash the source/mask tensors a masked draw needs (inpaint patches and the like)."""

    def prepare_generation_latent(self, ctx: DrawContext) -> Any:
        """The latent sampling starts from: empty, masked (inpaint/outpaint) or the encoded source."""
        if ctx.latent_source == "empty":
            return self.create_empty_latent(ctx.width, ctx.height, ctx.settings, draw_id=ctx.draw_id)
        if ctx.latent_source == "masked":
            ctx.positive, ctx.negative, latent = self.prepare_masked_latent(ctx)
            return latent
        return _encode_source_latent(ctx.vae, ctx.image_tensor, None, ctx.request.grow_mask_by, draw_id=ctx.draw_id)

    def prepare_masked_latent(self, ctx: DrawContext) -> tuple[Any, Any, Any]:
        return _prepare_masked_generation_latent(
            model_module=self,
            mode=ctx.mode,
            positive=ctx.positive,
            negative=ctx.negative,
            vae=ctx.vae,
            image_tensor=ctx.image_tensor,
            mask=ctx.mask,
            grow_mask_by=ctx.request.grow_mask_by,
            draw_id=ctx.draw_id,
            gen_settings=ctx.settings,
        )

    def after_latent_prepared(self, ctx: DrawContext) -> None:
        """The batched generation latent is in ``ctx.latent``."""

    def supports_step_cache(self, settings: dict[str, Any]) -> bool:
        """Whether ComfyUI's EasyCache may skip steps for this run (see performance.py)."""
        return True

    def prepare_model_for_sampling(self, ctx: DrawContext) -> Any:
        """Last model patch before sampling (after every LoRA)."""
        return ctx.model

    # -- model primitives ---------------------------------------------------------------

    def uses_edit_masked_latents(self, mode: str) -> bool:
        return mode in {"inpaint", "outpaint"}

    def uses_differential_diffusion(self, mode: str) -> bool:
        return mode in {"inpaint", "outpaint"}

    def outpaint_prompt_suffix(self) -> str:
        return OUTPAINT_PROMPT_SUFFIX if self.is_edit_model else ""

    def prepare_outpaint_reference_image(self, source_rgba: Image.Image, mask_image: Image.Image, draw_id: str) -> Image.Image:
        if self.is_edit_model:
            return _make_edit_outpaint_reference_rgb(source_rgba, draw_id)
        return _sample_transparent_outpaint_rgb(source_rgba, draw_id)

    def apply_loras(self, model: Any, clip: Any, gen_settings: dict[str, Any]):
        """Declared ``lora_requirements`` first, then the user's LoRA stack. Do not override:
        declare a :class:`LoraRequirement` instead."""
        model, clip, skip = _apply_lora_requirements(model, clip, self.lora_requirements, gen_settings)
        return _apply_lora_stack(model, clip, gen_settings.get("lora_stack") or [], skip)

    def encode_prompt(self, clip: Any, text: str, _gen_settings: dict[str, Any]):
        tokens = clip.tokenize(text or "")
        cond, pooled = clip.encode_from_tokens(tokens, return_pooled=True)
        return [[cond, {"pooled_output": pooled}]]

    def validate_conditioning(self, _positive: Any, _negative: Any, _gen_settings: dict[str, Any]) -> None:
        return None

    def clone_assets(self, model: Any, clip: Any) -> tuple[Any, Any]:
        return _clone_model_clip(model, clip)

    def create_empty_latent(self, width: int, height: int, _gen_settings: dict[str, Any], draw_id: str = "unknown") -> dict[str, Any]:
        import nodes

        batch_size = max(1, int((_gen_settings or {}).get("batch_size", 1) or 1))
        encoded = nodes.EmptyLatentImage().generate(width, height, batch_size)[0]
        _uc_log(draw_id, "created empty SD latent", _latent_debug(encoded))
        return encoded

    def decode_samples(self, vae: Any, samples: Any, _gen_settings: dict[str, Any]):
        latent_samples = _unwrap_latent_samples(samples)
        tile_size = self.decode_tile_size
        overlap = min(64, max(32, tile_size // 4))
        _uc_log(str((_gen_settings or {}).get("_draw_id") or "unknown"), "VAE tiled decode", {"tile_size": tile_size, "overlap": overlap})
        return vae.decode_tiled(latent_samples, tile_x=tile_size, tile_y=tile_size, overlap=overlap)

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


def _reference_image_slots(image_tensor: Any, gen_settings: dict[str, Any] | None) -> dict[int, Any]:
    """Map Edit model reference images to their numbered slots (spec 3 and 9).

    Slot 1 is the canvas working area; slots 2..11 hold the VNCSS Config
    reference images (reference_image_1..10) in socket order. Gaps are
    preserved: a reference in socket position N always occupies slot N+1.
    Shared by the MiniMax H3 (<Picture N>) and Qwen-Image-2.1 (<image N>)
    modules.
    """
    from ...vncss_config import REFERENCE_INPUTS

    slots: dict[int, Any] = {}
    if image_tensor is not None:
        slots[1] = image_tensor
    external_refs = ((gen_settings or {}).get("_external") or {}).get("references") or {}
    for slot, name in enumerate(REFERENCE_INPUTS, start=2):
        value = external_refs.get(name)
        if value is not None:
            slots[slot] = value
    return slots
