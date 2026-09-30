"""The draw path is a pipeline a model family can extend or replace, without touching shared code."""

import ast
import base64
import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar

import pytest
import torch
from PIL import Image

from nodes.unicanvas import draw, draw_pipeline
from nodes.unicanvas.draw_pipeline import DrawContext, ImageDrawPipeline
from nodes.unicanvas.models import UNICANVAS_MODEL_MODULES
from nodes.unicanvas.models.base import UniCanvasModelModule
from nodes.unicanvas.models.capabilities import CANVAS_TASKS, STANDARD_TASKS, ModelCapabilities, PromptGuide

ROOT = Path(__file__).resolve().parents[1]
GUIDE = PromptGuide(hint="Describe it", guide="A test family that echoes what the pipeline hands it.")


def png(alpha=255, size=64):
    buffer = io.BytesIO()
    Image.new("RGBA", (size, size), (10, 20, 30, alpha)).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


@dataclass(frozen=True)
class EchoFamily(UniCanvasModelModule):
    """A plugin family: no ComfyUI, just records what the default pipeline asks of it."""

    key: str = "test_echo"
    aliases: tuple[str, ...] = ()
    defaults: dict[str, Any] = field(default_factory=lambda: {"steps": 2, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple"})
    capabilities: ModelCapabilities = ModelCapabilities(
        label="Echo",
        prompt_guide=GUIDE,
        tasks=CANVAS_TASKS + (STANDARD_TASKS["image_to_video"].planned(),),
    )
    log: list = field(default_factory=list, compare=False)

    def clone_assets(self, model, clip):
        return model, clip

    def encode_prompt(self, clip, text, gen_settings):
        self.log.append(("encode", text))
        return [[text, {}]]

    def create_empty_latent(self, width, height, gen_settings, draw_id="unknown"):
        self.log.append(("empty", width, height))
        return {"samples": torch.zeros(1, 4, height // 8, width // 8)}

    def sample_latent(self, **kwargs):
        self.log.append(("sample", kwargs["model"], kwargs["denoise"]))
        return kwargs["latent"]

    def decode_samples(self, vae, samples, gen_settings):
        return torch.full((1, 64, 64, 3), 0.5)


@pytest.fixture()
def register(monkeypatch):
    monkeypatch.setattr(draw_pipeline, "_save_temp_image", lambda image, prefix="x": {"filename": prefix, "size": image.size})

    def _register(family):
        monkeypatch.setitem(UNICANVAS_MODEL_MODULES, family.key, family)
        return family

    return _register


def run(key="test_echo", mode="txt2img", external=True, **extra):
    payload = {
        "debug_id": "pipeline-test",
        "mode": mode,
        "image": png(),
        "settings": {"generation_mode": key, "positive": "a cat", "negative": "blurry"},
    }
    if external:
        payload["external"] = {"model": "M", "clip": "C", "vae": "V"}
    payload.update(extra)
    return draw._run_unicanvas_draw(payload)


def test_plugin_family_runs_through_the_default_pipeline(register):
    family = register(EchoFamily())
    result = run()
    assert result["status"] == "ok"
    assert result["generation_mode"] == "test_echo"
    assert result["task"] == "text_to_image"
    assert len(result["images"]) == 1
    assert family.log == [("encode", "a cat"), ("encode", "blurry"), ("empty", 64, 64), ("sample", "M", 1.0)]


class EchoPipeline(ImageDrawPipeline):
    def run(self):
        return {"status": "custom", "task": self.request.task.key, "family": self.module.key}


@dataclass(frozen=True)
class CustomPathFamily(EchoFamily):
    key: str = "test_custom_path"
    draw_pipeline_class: ClassVar[type] = EchoPipeline


def test_a_family_can_own_its_draw_path(register):
    register(CustomPathFamily())
    assert run("test_custom_path", mode="img2img") == {"status": "custom", "task": "image_to_image", "family": "test_custom_path"}


@dataclass(frozen=True)
class LatentHookFamily(EchoFamily):
    key: str = "test_latent_hook"
    seen: list = field(default_factory=list, compare=False)

    def prepare_generation_latent(self, ctx):
        self.seen.append((type(ctx), ctx.mode, ctx.width, ctx.height, ctx.request.task.key, ctx.vae))
        return self.create_empty_latent(ctx.width, ctx.height, ctx.settings, ctx.draw_id)

    def prepare_model_for_sampling(self, ctx):
        return "patched-" + str(ctx.model)


def test_family_hooks_receive_the_draw_context(register):
    family = register(LatentHookFamily())
    result = run("test_latent_hook", mode="img2img")
    assert result["status"] == "ok"
    assert family.seen == [(DrawContext, "img2img", 64, 64, "image_to_image", "V")]
    assert ("sample", "patched-M", pytest.approx(0.65)) in family.log


def test_task_can_be_requested_by_name(register):
    family = register(LatentHookFamily(key="test_task_name"))
    result = run("test_task_name", mode=None, task="image_to_image")
    assert result["task"] == "image_to_image"
    assert family.seen[0][1] == "img2img"


def test_planned_task_is_rejected_before_loading(register, monkeypatch):
    register(EchoFamily())
    monkeypatch.setattr(draw_pipeline, "_load_generation_assets", lambda settings: pytest.fail("must not load"))
    with pytest.raises(ValueError, match="Image to video is not available in UniCanvas yet"):
        run(task="image_to_video")


def test_unsupported_task_is_rejected(register):
    register(EchoFamily(key="test_txt_only", capabilities=ModelCapabilities(
        label="Text only", prompt_guide=GUIDE, tasks=(STANDARD_TASKS["text_to_image"],))))
    with pytest.raises(ValueError, match="Text only does not support Inpaint"):
        run("test_txt_only", mode="inpaint", mask=png())
    with pytest.raises(ValueError, match="Unknown UniCanvas task"):
        run("test_txt_only", task="sculpt")


def test_external_config_requirement_fails_before_loading(register, monkeypatch):
    register(EchoFamily(key="test_needs_config", capabilities=ModelCapabilities(
        label="Needs config", prompt_guide=GUIDE, requires_external_config=True, default_loader="diffusion_model",
        external_config_message="[VNCCS UniCanvas] Needs config.")))
    monkeypatch.setattr(draw_pipeline, "_load_generation_assets", lambda settings: pytest.fail("must not load"))
    with pytest.raises(RuntimeError, match=r"\[VNCCS UniCanvas\] Needs config\."):
        run("test_needs_config", external=False)


def test_source_image_requirement(register, monkeypatch):
    register(EchoFamily(key="test_needs_image", capabilities=ModelCapabilities(
        label="Needs image", prompt_guide=GUIDE, requires_source_image=True,
        source_image_message="Needs an image.",
        tasks=tuple(STANDARD_TASKS[key] for key in ("image_to_image", "inpaint")))))
    monkeypatch.setattr(draw_pipeline, "_load_generation_assets", lambda settings: pytest.fail("must not load"))
    with pytest.raises(ValueError, match="Needs an image"):
        run("test_needs_image", mode="txt2img")
    with pytest.raises(ValueError, match="Needs an image"):
        run("test_needs_image", mode="img2img", source_empty=True)
    with pytest.raises(ValueError, match="Needs an image"):
        run("test_needs_image", mode="img2img", image=png(alpha=0))


@dataclass(frozen=True)
class ScratchFamily(EchoFamily):
    key: str = "test_scratch"
    sampling_scratch_keys: ClassVar[tuple[str, ...]] = ("_echo_scratch",)

    def encode_prompt(self, clip, text, gen_settings):
        gen_settings["_echo_scratch"] = object()
        return super().encode_prompt(clip, text, gen_settings)

    def decode_samples(self, vae, samples, gen_settings):
        assert "_echo_scratch" not in gen_settings
        return super().decode_samples(vae, samples, gen_settings)


def test_family_scratch_state_is_released_before_decode(register):
    register(ScratchFamily())
    assert run("test_scratch")["status"] == "ok"


# --- shared code stays family-agnostic -------------------------------------------------

SHARED_DRAW_MODULES = ("draw.py", "draw_request.py", "draw_pipeline.py", "generation.py", "latents.py", "sampling.py", "loras.py")


def _family_names():
    names = set()
    for module in UNICANVAS_MODEL_MODULES.values():
        names.add(module.key)
        names.update(module.aliases)
    return names | {"illustrious"}


@pytest.mark.parametrize("filename", SHARED_DRAW_MODULES)
def test_shared_draw_code_never_names_a_model_family(filename):
    tree = ast.parse((ROOT / "nodes" / "unicanvas" / filename).read_text(encoding="utf-8"))
    literals = {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)}
    assert not (literals & _family_names()), f"{filename} branches on model families: {sorted(literals & _family_names())}"


@pytest.mark.parametrize("filename", SHARED_DRAW_MODULES)
def test_shared_draw_code_never_compares_family_keys(filename):
    source = (ROOT / "nodes" / "unicanvas" / filename).read_text(encoding="utf-8")
    assert ".key ==" not in source and ".key in " not in source and "model_key" not in source
