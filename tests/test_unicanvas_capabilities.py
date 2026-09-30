"""Every model family describes itself: tasks, accepted inputs, references and a prompt guide."""

import json

import pytest

from nodes.unicanvas.assets import _get_unicanvas_assets
from nodes.unicanvas.models import UNICANVAS_MODEL_MODULES
from nodes.unicanvas.models.capabilities import (
    CANVAS_MODE_TASKS,
    STANDARD_TASKS,
    GenerationTask,
    MediaKind,
    ModelCapabilities,
    ModelRole,
    PromptGuide,
    ReferenceInputs,
    task_for_canvas_mode,
)
from nodes.unicanvas.models.registry import _get_unicanvas_model_module


def _families():
    return list({module.key: module for module in UNICANVAS_MODEL_MODULES.values()}.values())


# --- vocabulary -----------------------------------------------------------------------


def test_canvas_modes_map_to_standard_tasks():
    assert task_for_canvas_mode("txt2img").key == "text_to_image"
    assert task_for_canvas_mode("img2img").key == "image_to_image"
    assert task_for_canvas_mode("inpaint").key == "inpaint"
    assert task_for_canvas_mode("outpaint").key == "outpaint"
    assert set(CANVAS_MODE_TASKS) == {"txt2img", "img2img", "inpaint", "outpaint"}
    with pytest.raises(ValueError, match="mode must be"):
        task_for_canvas_mode("sculpt")


def test_standard_tasks_cover_video_3d_and_panorama():
    for key in ("text_to_video", "image_to_video", "reference_to_video", "image_to_3d", "panorama_view"):
        assert key in STANDARD_TASKS
    assert STANDARD_TASKS["image_to_video"].output is MediaKind.VIDEO
    assert MediaKind.IMAGE in STANDARD_TASKS["image_to_video"].inputs
    assert STANDARD_TASKS["image_to_3d"].output is MediaKind.MESH


def test_task_inputs_and_json_description():
    task = GenerationTask("demo", "Demo", frozenset({MediaKind.TEXT, MediaKind.IMAGE}), MediaKind.IMAGE)
    assert task.describe() == {
        "key": "demo",
        "label": "Demo",
        "inputs": ["image", "text"],
        "output": "image",
        "canvas_mode": None,
        "available": True,
        "description": "",
        "prompt_guide": None,
    }


def test_capabilities_derive_accepted_inputs_from_tasks_and_references():
    capabilities = ModelCapabilities(
        label="Demo",
        tasks=(STANDARD_TASKS["text_to_image"], STANDARD_TASKS["image_to_video"]),
        references=ReferenceInputs(max_images=2, accepts=frozenset({MediaKind.IMAGE, MediaKind.VIDEO}), slot_label="<Picture {n}>"),
        prompt_guide=PromptGuide(hint="h", guide="g"),
    )
    assert capabilities.accepts == frozenset({MediaKind.TEXT, MediaKind.IMAGE, MediaKind.VIDEO})
    assert capabilities.outputs == frozenset({MediaKind.IMAGE, MediaKind.VIDEO})
    assert capabilities.supports_task("image_to_video")
    assert not capabilities.supports_task("inpaint")
    assert capabilities.task("text_to_image").key == "text_to_image"
    assert capabilities.declared_task("image_to_video").key == "image_to_video"
    assert capabilities.declared_task("inpaint") is None
    with pytest.raises(KeyError):
        capabilities.task("inpaint")


# --- built-in families ----------------------------------------------------------------


@pytest.mark.parametrize("module", _families(), ids=lambda module: module.key)
def test_every_family_describes_itself(module):
    capabilities = module.capabilities
    assert isinstance(capabilities, ModelCapabilities)
    assert capabilities.label
    assert capabilities.tasks, "a family must declare at least one task"
    assert capabilities.prompt_guide.hint.strip()
    assert len(capabilities.prompt_guide.guide.strip()) > 40
    assert (module.role is ModelRole.EDIT) == module.is_edit_model
    described = module.describe()
    json.dumps(described)
    assert described["key"] == module.key
    assert described["capabilities"]["prompt_guide"]["hint"] == capabilities.prompt_guide.hint


@pytest.mark.parametrize("module", _families(), ids=lambda module: module.key)
def test_available_canvas_tasks_have_a_canvas_mode(module):
    for task in module.capabilities.tasks:
        if task.available and task.output is MediaKind.IMAGE:
            assert task.canvas_mode in CANVAS_MODE_TASKS, task.key


def test_generator_families_support_all_canvas_modes():
    for key in ("sdxl", "anima", "z_image"):
        capabilities = _get_unicanvas_model_module(key).capabilities
        assert _get_unicanvas_model_module(key).role is ModelRole.GENERATOR
        for mode in ("txt2img", "img2img", "inpaint", "outpaint"):
            assert capabilities.supports_task(task_for_canvas_mode(mode).key), (key, mode)


def test_krea2_edit_needs_a_source_image():
    capabilities = _get_unicanvas_model_module("krea2_edit").capabilities
    assert capabilities.requires_source_image
    assert not capabilities.supports_task("text_to_image")
    assert capabilities.supports_task("image_to_image")


def test_edit_families_declare_their_reference_slots():
    assert _get_unicanvas_model_module("qwen_image21").capabilities.references.slot_label == "<image{n}>"
    assert _get_unicanvas_model_module("minimax_h3").capabilities.references.slot_label == "<Picture {n}>"
    assert _get_unicanvas_model_module("qwen_image_edit").capabilities.references.max_images >= 1
    for key in ("sdxl", "anima", "z_image"):
        assert _get_unicanvas_model_module(key).capabilities.references is None


def test_minimax_h3_is_a_reference_to_video_model_used_for_stills():
    capabilities = _get_unicanvas_model_module("minimax_h3").capabilities
    # The VNCSS Config node is optional: the node's own loader supplies clip/vae.
    assert not capabilities.requires_external_config
    video = capabilities.task("reference_to_video")
    assert video.output is MediaKind.VIDEO
    assert video.available is False  # declared, not wired into the canvas yet
    assert capabilities.supports_task("image_to_image")


def test_pose_edit_support_is_declared():
    supported = {module.key for module in _families() if module.capabilities.supports_pose_edit}
    assert supported == {"qwen_image_edit", "flux_klein"}


def test_default_loaders_are_declared():
    assert _get_unicanvas_model_module("qwen_image_edit").capabilities.default_loader == "gguf"
    for key in ("anima", "flux_klein", "z_image", "krea2_edit", "qwen_image21"):
        assert _get_unicanvas_model_module(key).capabilities.default_loader == "diffusion_model", key
    assert _get_unicanvas_model_module("sdxl").capabilities.default_loader is None


def test_assets_route_exposes_family_descriptions():
    modules = {entry["key"]: entry for entry in _get_unicanvas_assets()["model_modules"]}
    assert set(modules) == {module.key for module in _families()}
    krea2 = modules["krea2_edit"]
    assert krea2["is_edit_model"] is True
    assert krea2["role"] == "edit"
    assert any(rule["required"] for rule in krea2["lora_requirements"])
    json.dumps(modules)


# --- task-specific prompt guides ------------------------------------------------------


def test_a_task_can_carry_its_own_prompt_guide():
    video_guide = PromptGuide(hint="Describe the motion", guide="Describe what moves and how the camera travels.")
    default_guide = PromptGuide(hint="Describe it", guide="The family-wide guide.")
    capabilities = ModelCapabilities(
        label="Demo",
        prompt_guide=default_guide,
        tasks=(STANDARD_TASKS["image_to_image"], STANDARD_TASKS["image_to_video"].with_prompt_guide(video_guide)),
    )
    assert capabilities.prompt_guide_for("image_to_video") is video_guide
    assert capabilities.prompt_guide_for("image_to_image") is default_guide
    assert capabilities.prompt_guide_for(None) is default_guide
    assert capabilities.prompt_guide_for("unknown") is default_guide
    described = {task["key"]: task for task in capabilities.describe()["tasks"]}
    assert described["image_to_video"]["prompt_guide"]["hint"] == "Describe the motion"
    assert described["image_to_image"]["prompt_guide"] is None


def test_minimax_h3_video_prompts_differ_from_image_edits():
    capabilities = _get_unicanvas_model_module("minimax_h3").capabilities
    edit = capabilities.prompt_guide_for("image_to_image")
    video = capabilities.prompt_guide_for("reference_to_video")
    assert video is not edit
    assert "<Picture" in video.hint or "<Picture" in video.guide
    assert "motion" in video.guide.lower()


def test_qwen_image21_generation_and_edit_prompts_differ():
    capabilities = _get_unicanvas_model_module("qwen_image21").capabilities
    generate = capabilities.prompt_guide_for("text_to_image")
    edit = capabilities.prompt_guide_for("image_to_image")
    assert generate is not edit
    assert "tag" in generate.guide.lower()  # natural sentences, never tag lists
    assert "Keep everything else unchanged" in edit.guide
    for task in ("inpaint", "outpaint"):
        assert capabilities.prompt_guide_for(task) is edit


@pytest.mark.parametrize("module", _families(), ids=lambda module: module.key)
def test_every_prompt_guide_cites_its_sources(module):
    capabilities = module.capabilities
    guides = [capabilities.prompt_guide] + [task.prompt_guide for task in capabilities.tasks if task.prompt_guide]
    for guide in guides:
        assert guide.sources, f"{module.key}: prompt help must say where its advice comes from"
        for source in guide.sources:
            assert source.startswith(("https://", "docs/", "README.md")), source
        assert guide.describe()["sources"] == list(guide.sources)


def test_qwen_edit_guide_follows_the_official_edit_prompt_enhancer_rules():
    guide = _get_unicanvas_model_module("qwen_image_edit").capabilities.prompt_guide
    assert any("QwenLM/Qwen-Image" in source and "prompt_utils.py" in source for source in guide.sources)
    assert not any("apiyi" in source for source in guide.sources)  # a text-to-image guide, not an edit guide
    assert "Replace Y with X" in guide.guide
    assert "English double quotes" in guide.guide
    assert "Perform inpainting on this image. The original caption is:" in guide.guide
    assert "Extend the image beyond its boundaries using outpainting" in guide.guide
    assert "Picture 2" in guide.guide
