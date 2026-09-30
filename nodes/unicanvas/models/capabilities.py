"""Declarative description of what a model family can do.

A family states its capabilities as data instead of the shared draw code checking
its key: which generation tasks it offers (text-to-image, inpaint, image-to-video,
reference-to-video, image-to-3D ...), which inputs it accepts (prompt, image,
video ...), which reference images it reads and how the prompt refers to them,
and a prompt guide the frontend shows behind the "?" next to the prompt.

The same description is served to the widget by ``/vnccs/unicanvas/assets``, so the
UI can offer task selection, reference slots and prompt help without hard-coding
model keys.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any


class MediaKind(str, Enum):
    """What flows into or out of a generation."""

    TEXT = "text"
    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"
    MESH = "mesh"
    PANORAMA = "panorama"


class ModelRole(str, Enum):
    """Generators create from a prompt; edit models transform the canvas and reference images."""

    GENERATOR = "generator"
    EDIT = "edit"


@dataclass(frozen=True)
class PromptGuide:
    """Prompt help for the "?" next to the prompt: a one-line hint and a short guide (Markdown)."""

    hint: str
    guide: str
    examples: tuple[str, ...] = ()
    negative_prompt: bool = True
    # Where the advice comes from (model card, author guide, project doc), shown with the help.
    sources: tuple[str, ...] = ()

    def describe(self) -> dict[str, Any]:
        return {
            "hint": self.hint,
            "guide": self.guide,
            "examples": list(self.examples),
            "negative_prompt": self.negative_prompt,
            "sources": list(self.sources),
        }


@dataclass(frozen=True)
class GenerationTask:
    """One thing a family can generate, e.g. ``image_to_video``.

    ``canvas_mode`` links the task to the canvas draw mode that runs it today
    (``txt2img``, ``img2img``, ``inpaint``, ``outpaint``). ``available=False`` declares a
    capability of the model that has no canvas pipeline yet, so the UI can show it as
    upcoming and the draw path rejects it cleanly. ``prompt_guide`` overrides the family's
    prompt guide for this task (e.g. video prompts differ from image-edit prompts).
    """

    key: str
    label: str
    inputs: frozenset[MediaKind]
    output: MediaKind
    canvas_mode: str | None = None
    available: bool = True
    description: str = ""
    prompt_guide: PromptGuide | None = None

    def planned(self) -> GenerationTask:
        return replace(self, available=False)

    def with_prompt_guide(self, guide: PromptGuide) -> GenerationTask:
        return replace(self, prompt_guide=guide)

    def describe(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "inputs": sorted(kind.value for kind in self.inputs),
            "output": self.output.value,
            "canvas_mode": self.canvas_mode,
            "available": self.available,
            "description": self.description,
            "prompt_guide": self.prompt_guide.describe() if self.prompt_guide is not None else None,
        }


_T, _I, _V, _M, _P = MediaKind.TEXT, MediaKind.IMAGE, MediaKind.VIDEO, MediaKind.MESH, MediaKind.PANORAMA

STANDARD_TASKS: dict[str, GenerationTask] = {
    task.key: task
    for task in (
        GenerationTask("text_to_image", "Text to image", frozenset({_T}), _I, "txt2img",
                       description="Generate the bbox content from the prompt."),
        GenerationTask("image_to_image", "Image to image", frozenset({_T, _I}), _I, "img2img",
                       description="Rework the pixels inside the bbox guided by the prompt."),
        GenerationTask("inpaint", "Inpaint", frozenset({_T, _I}), _I, "inpaint",
                       description="Regenerate only the masked area."),
        GenerationTask("outpaint", "Outpaint", frozenset({_T, _I}), _I, "outpaint",
                       description="Extend the image into the empty part of the bbox."),
        GenerationTask("text_to_video", "Text to video", frozenset({_T}), _V),
        GenerationTask("image_to_video", "Image to video", frozenset({_T, _I}), _V),
        GenerationTask("reference_to_video", "Reference to video", frozenset({_T, _I}), _V,
                       description="Animate from the working area plus reference pictures."),
        GenerationTask("video_to_video", "Video to video", frozenset({_T, _V}), _V),
        GenerationTask("text_to_3d", "Text to 3D", frozenset({_T}), _M),
        GenerationTask("image_to_3d", "Image to 3D", frozenset({_I}), _M),
        GenerationTask("panorama_view", "Panorama view", frozenset({_T, _P}), _I,
                       description="Generate a scene from a chosen angle of a 360 panorama."),
    )
}

CANVAS_MODE_TASKS: dict[str, GenerationTask] = {
    task.canvas_mode: task for task in STANDARD_TASKS.values() if task.canvas_mode
}

CANVAS_TASKS: tuple[GenerationTask, ...] = tuple(CANVAS_MODE_TASKS.values())


def task_for_canvas_mode(mode: str) -> GenerationTask:
    task = CANVAS_MODE_TASKS.get(str(mode or ""))
    if task is None:
        raise ValueError("mode must be txt2img, img2img, inpaint or outpaint")
    return task


@dataclass(frozen=True)
class ReferenceInputs:
    """Extra pictures an edit family reads besides the canvas working area.

    ``slot_label`` is how the prompt names slot ``n`` (slot 1 is the working area),
    e.g. ``"<image{n}>"`` for Qwen-Image-2.1 or ``"<Picture {n}>"`` for MiniMax H3.
    """

    max_images: int
    accepts: frozenset[MediaKind] = frozenset({MediaKind.IMAGE})
    slot_label: str = "Picture {n}"

    def describe(self) -> dict[str, Any]:
        return {
            "max_images": self.max_images,
            "accepts": sorted(kind.value for kind in self.accepts),
            "slot_label": self.slot_label,
        }


DEFAULT_PROMPT_GUIDE = PromptGuide(
    hint="Describe what should appear inside the bbox.",
    guide=(
        "Describe the subject, its appearance, the setting, the lighting and the style. "
        "For inpaint and outpaint describe what belongs in the masked or empty area, "
        "not the whole picture."
    ),
    sources=("docs/UNICANVAS_MODEL_MODULES.md",),
)


@dataclass(frozen=True)
class ModelCapabilities:
    """Everything the shared code and the UI need to know about a family, as data."""

    label: str = ""
    tasks: tuple[GenerationTask, ...] = CANVAS_TASKS
    references: ReferenceInputs | None = None
    prompt_guide: PromptGuide = DEFAULT_PROMPT_GUIDE
    requires_source_image: bool = False
    source_image_message: str = ""
    requires_external_config: bool = False
    external_config_message: str = ""
    supports_pose_edit: bool = False
    default_loader: str | None = None
    extra: tuple[tuple[str, Any], ...] = field(default_factory=tuple)

    @property
    def accepts(self) -> frozenset[MediaKind]:
        kinds: set[MediaKind] = set()
        for task in self.tasks:
            kinds.update(task.inputs)
        if self.references is not None:
            kinds.update(self.references.accepts)
        return frozenset(kinds)

    @property
    def outputs(self) -> frozenset[MediaKind]:
        return frozenset(task.output for task in self.tasks)

    def declared_task(self, key: str) -> GenerationTask | None:
        """The family's own declaration of a task (it may be planned), or None."""
        for task in self.tasks:
            if task.key == key:
                return task
        return None

    def supports_task(self, key: str) -> bool:
        task = self.declared_task(key)
        return task is not None and task.available

    def prompt_guide_for(self, task_key: str | None) -> PromptGuide:
        """The task's own prompt guide when it declares one, else the family guide."""
        task = self.declared_task(task_key) if task_key else None
        return task.prompt_guide if task is not None and task.prompt_guide is not None else self.prompt_guide

    def task(self, key: str) -> GenerationTask:
        task = self.declared_task(key)
        if task is None:
            raise KeyError(key)
        return task

    def describe(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "tasks": [task.describe() for task in self.tasks],
            "accepts": sorted(kind.value for kind in self.accepts),
            "outputs": sorted(kind.value for kind in self.outputs),
            "references": self.references.describe() if self.references is not None else None,
            "prompt_guide": self.prompt_guide.describe(),
            "requires_source_image": self.requires_source_image,
            "requires_external_config": self.requires_external_config,
            "supports_pose_edit": self.supports_pose_edit,
            "default_loader": self.default_loader,
            **dict(self.extra),
        }
