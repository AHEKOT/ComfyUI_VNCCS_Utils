"""Parsing a draw payload into a validated :class:`DrawRequest`.

The request resolves the model family, the generation task (from ``task`` or the
canvas ``mode``), the effective settings (VNCSS Config overrides, uploaded
reference images, preset and family defaults) and the sampling parameters. It knows
nothing about individual model families: family rules live in their modules.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from .debug import _uc_log
from .generation import _normalize_gen_settings
from .imaging import _decode_data_url, _pil_to_image_tensor
from .models.base import UniCanvasModelModule
from .models.capabilities import STANDARD_TASKS, GenerationTask, task_for_canvas_mode
from .models.registry import _get_unicanvas_model_module
from .progress import _set_draw_progress


# Uploaded Edit model reference images occupy the VNCSS Config reference slots.
MAX_UPLOADED_REFERENCES = 10  # the popover allows 4; VNCSS Config LoadImage references up to 10


@dataclass
class DrawRequest:
    payload: dict[str, Any]
    draw_id: str
    mode: str | None
    task: GenerationTask
    module: UniCanvasModelModule
    settings: dict[str, Any]
    external: Any
    seed: int
    batch_size: int
    steps: int
    cfg: float
    denoise: float
    sampler_name: str
    scheduler: str
    grow_mask_by: int
    mask_blur: int
    coherence_edge_size: int
    positive_text: str
    negative_text: str
    outpaint_prompt_suffix: str

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> DrawRequest:
        draw_id = str(payload.get("debug_id") or f"{int(time.time() * 1000)}")
        _set_draw_progress(draw_id, "queued", 0.01, 0, 0, "Queued")
        task_key = str(payload.get("task") or "").strip().lower()
        mode: str | None = None
        if not task_key:
            mode = str(payload.get("mode") or "img2img")
            task_for_canvas_mode(mode)  # rejects unknown canvas modes before any work

        external = payload.get("external")
        settings = _normalize_gen_settings(_request_settings(payload, external))
        settings.pop("_pose_edit_images", None)
        module = _get_unicanvas_model_module(settings.get("generation_mode"))
        task = _resolve_task(module, task_key, mode)
        if task_key:
            mode = task.canvas_mode or (str(payload["mode"]) if payload.get("mode") else None)
        settings["draw_mode"] = mode

        batch_size = max(1, min(99, int(settings.get("batch_size", 1) or 1)))
        settings["batch_size"] = batch_size
        denoise = 1.0 if mode == "txt2img" else float(settings.get("denoise", 0.65 if mode == "img2img" else 1.0))
        outpaint_suffix = module.outpaint_prompt_suffix() if mode == "outpaint" else ""
        request = cls(
            payload=payload,
            draw_id=draw_id,
            mode=mode,
            task=task,
            module=module,
            settings=settings,
            external=external,
            seed=int(settings.get("seed", 0)),
            batch_size=batch_size,
            steps=int(settings.get("steps", 24)),
            cfg=float(settings.get("cfg", 7.0)),
            denoise=denoise,
            sampler_name=str(settings.get("sampler_name") or settings.get("sampler") or "euler"),
            scheduler=str(settings.get("scheduler") or "normal"),
            grow_mask_by=int(settings.get("grow_mask_by", 6)),
            mask_blur=int(settings.get("mask_blur", 16)),
            coherence_edge_size=int(settings.get("canvas_coherence_edge_size", 16)),
            positive_text=_append_prompt_suffix(str(settings.get("positive", "")), outpaint_suffix),
            negative_text=str(settings.get("negative", "")),
            outpaint_prompt_suffix=outpaint_suffix,
        )
        request.log()
        return request

    def log(self) -> None:
        settings = self.settings
        _uc_log(
            self.draw_id,
            "request",
            {
                "mode": self.mode,
                "task": self.task.key,
                "bbox": self.payload.get("bbox"),
                "inference_size": self.payload.get("inference_size"),
                "output_size": self.payload.get("output_size"),
                "source_empty": self.payload.get("source_empty"),
                "generation_mode": settings.get("generation_mode"),
                "model_loader": settings.get("model_loader"),
                "ckpt_name": settings.get("ckpt_name"),
                "diffusion_model_name": settings.get("diffusion_model_name"),
                "gguf_model_name": settings.get("gguf_model_name"),
                "clip_name": settings.get("clip_name"),
                "clip_type": settings.get("clip_type"),
                "vae_name": settings.get("vae_name"),
                "lora_stack_count": len(settings.get("lora_stack") or []) if isinstance(settings.get("lora_stack"), list) else None,
                "mode_settings_keys": sorted(str(key) for key in settings.get("mode_settings", {}).keys()) if isinstance(settings.get("mode_settings"), dict) else None,
                "turbo_enabled": settings.get("turbo_enabled"),
                "seed": self.seed,
                "batch_size": self.batch_size,
                "steps": self.steps,
                "cfg": self.cfg,
                "denoise": self.denoise,
                "sampler_name": self.sampler_name,
                "scheduler": self.scheduler,
                "grow_mask_by": self.grow_mask_by,
                "mask_blur": self.mask_blur,
                "canvas_coherence_edge_size": self.coherence_edge_size,
                "outpaint_prompt_suffix": self.outpaint_prompt_suffix or None,
                "positive_len": len(self.positive_text),
                "negative_len": len(self.negative_text),
            },
        )


def _append_prompt_suffix(prompt: str, suffix: str) -> str:
    prompt = str(prompt or "").strip()
    suffix = str(suffix or "").strip()
    if not suffix:
        return prompt
    if suffix.lower() in prompt.lower():
        return prompt
    if not prompt:
        return suffix
    return f"{prompt}, {suffix}"


def _resolve_task(module: UniCanvasModelModule, task_key: str, mode: str | None) -> GenerationTask:
    if not task_key:
        canvas_task = task_for_canvas_mode(mode or "")
        return module.capabilities.declared_task(canvas_task.key) or canvas_task
    declared = module.capabilities.declared_task(task_key)
    if declared is not None:
        return declared
    standard = STANDARD_TASKS.get(task_key)
    if standard is None:
        raise ValueError(f"[VNCCS UniCanvas] Unknown UniCanvas task '{task_key}'.")
    return standard


def _request_settings(payload: dict[str, Any], external: Any) -> dict[str, Any]:
    """Merge the payload settings with the VNCSS Config block and uploaded references."""
    gen_settings = payload.get("settings")
    if not isinstance(gen_settings, dict):
        # Graph generation hands the node state's settings over as "gen_settings".
        gen_settings = payload.get("gen_settings")
    gen_settings = dict(gen_settings) if isinstance(gen_settings, dict) else {}
    if external:
        # A VNCSS_CONFIG draw forwards its own model block, so the pass-through loader owns the assets.
        gen_settings["_external"] = external
        gen_settings["model_loader"] = "external"
        # _normalize_gen_settings merges the selected preset over these settings before inferring the
        # loader, and every preset ships its own model_loader/generation_mode (the widget defaults
        # select the "sdxl" preset), which would silently replace the wired config. Drop the preset
        # selection keys so the external block always wins; non-external draws are untouched.
        gen_settings.pop("model_selection_mode", None)
        gen_settings.pop("selected_preset_id", None)
        # The config overrides the node's model-side settings: its model already carries the config
        # LoRA stack and its reference inputs fill the numbered slots, so the node's own LoRA stack,
        # Turbo LoRA and uploaded references (greyed out in the widget) must not stack on top.
        gen_settings["lora_stack"] = []
        gen_settings["turbo_enabled"] = False
        gen_settings.pop("edit_reference_images", None)
    # Widget-uploaded Edit model reference images (spec 9): the upload popover is
    # an alternative to the VNCSS Config reference inputs and occupies the same
    # numbered slots (reference_image_N -> <Picture N+1>).
    edit_refs = gen_settings.get("edit_reference_images")
    if isinstance(edit_refs, list) and edit_refs:
        external_block = gen_settings.get("_external")
        if not isinstance(external_block, dict):
            external_block = {}
            gen_settings["_external"] = external_block
        references = external_block.get("references")
        if not isinstance(references, dict):
            references = {}
            external_block["references"] = references
        uploads = [item for item in edit_refs if isinstance(item, str) and item][:MAX_UPLOADED_REFERENCES]
        for index, value in enumerate(uploads):
            name = f"reference_image_{index + 1}"
            if references.get(name) is None:
                references[name] = _pil_to_image_tensor(_decode_data_url(value, "RGB"))
    return gen_settings
