import base64
import io
import json

import pytest
torch = pytest.importorskip("torch")
from PIL import Image

from nodes.unicanvas.comfy_bridge import _call_comfy_node
from nodes.unicanvas.loaders import _MODEL_CACHE, _get_unicanvas_model_loader, _load_generation_assets
from nodes.unicanvas.models.minimax_h3 import MiniMaxH3UniCanvasModule
from nodes.unicanvas.models.registry import _get_unicanvas_model_module


def test_module_registered_with_aliases():
    module = _get_unicanvas_model_module("minimax_h3")
    assert isinstance(module, MiniMaxH3UniCanvasModule)
    assert _get_unicanvas_model_module("h3") is module
    assert _get_unicanvas_model_module("MiniMaxH3") is module
    assert module.key == "minimax_h3"
    assert module.is_edit_model is True


def test_defaults_follow_h3_recipe():
    module = _get_unicanvas_model_module("minimax_h3")
    assert module.defaults["steps"] == 20
    assert module.defaults["sampler_name"] == "res_multistep"
    assert module.defaults["scheduler"] == "simple"
    assert module.defaults["cfg"] == 1.0
    assert module.defaults["frame_count"] == 5


@pytest.mark.parametrize("negative", ["", "blurry"])
def test_draw_prompt_encoding_keeps_positive_for_h3_sampler(negative):
    from types import SimpleNamespace

    module = MiniMaxH3UniCanvasModule()
    ctx = SimpleNamespace(clip="CLIP", settings={}, request=SimpleNamespace(positive_text="a fox", negative_text=negative))
    positive, negative_conditioning = module.encode_draw_prompts(ctx)
    assert ctx.settings["_h3_prompt"] == "a fox"
    assert ctx.settings["_h3_clip"] == "CLIP"
    assert positive is negative_conditioning


def test_external_loader_passthrough():
    loader = _get_unicanvas_model_loader("external")
    external = {"model": "M", "clip": "C", "vae": "V"}
    model, clip, vae = loader.load({"_external": external}, draw_id="t")
    assert (model, clip, vae) == ("M", "C", "V")


def test_external_loader_requires_config():
    loader = _get_unicanvas_model_loader("external")
    with pytest.raises(RuntimeError, match=r"\[VNCCS UniCanvas\] External model block is missing\."):
        loader.load({}, draw_id="t")


def test_call_comfy_node_uses_registry(monkeypatch):
    import nodes as comfy_nodes

    class Dummy:
        FUNCTION = "run"

        def run(self, value):
            return ("ok", value)

    monkeypatch.setattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {"DummyNode": Dummy}, raising=False)
    assert _call_comfy_node("DummyNode", value=3) == ("ok", 3)


def test_call_comfy_node_missing_raises():
    with pytest.raises(RuntimeError, match=r"Required node 'NopeNode' is not available"):
        _call_comfy_node("NopeNode")


def _external_gen_settings(block):
    return {"model_loader": "external", "_external": block}


def test_sequential_external_blocks_load_their_own_assets():
    """Two external draws with different blocks must not share the first block's assets."""
    _MODEL_CACHE.clear()
    first = {"model": "M1", "clip": "C1", "vae": "V1"}
    second = {"model": "M2", "clip": "C2", "vae": "V2"}

    assert _load_generation_assets(_external_gen_settings(first)) == ("M1", "C1", "V1")
    assert _load_generation_assets(_external_gen_settings(second)) == ("M2", "C2", "V2")
    # The pass-through loader bypasses the model cache, so no external block is pinned.
    external_loader = _get_unicanvas_model_loader("external")
    assert external_loader.cache_key(_external_gen_settings(second)) not in _MODEL_CACHE


def test_repeated_external_block_loads_consistently():
    """The same external block loaded twice still yields its own triple."""
    _MODEL_CACHE.clear()
    block = {"model": "M", "clip": "C", "vae": "V"}

    assert _load_generation_assets(_external_gen_settings(block)) == ("M", "C", "V")
    assert _load_generation_assets(_external_gen_settings(block)) == ("M", "C", "V")


def test_reference_mapping_order(monkeypatch):
    module = _get_unicanvas_model_module("minimax_h3")
    captured = {}

    def fake_call(name, **kwargs):
        captured.setdefault(name, []).append(kwargs)
        if name == "MiniMaxH3ReferenceToVideo":
            return ("positive", "latent")
        if name == "BasicGuider":
            return ("guider",)
        if name == "RandomNoise":
            return ("noise",)
        if name == "KSamplerSelect":
            return ("sampler",)
        if name == "BasicScheduler":
            return ("sigmas",)
        if name == "SamplerCustomAdvanced":
            return ({"samples": torch.zeros(1, 4, 8, 8)}, {"samples": torch.zeros(1, 4, 8, 8)})
        raise AssertionError(name)

    monkeypatch.setattr("nodes.unicanvas.models.minimax_h3._call_comfy_node", fake_call)
    gen_settings = {
        "_h3_prompt": "Keep the face from <Picture 2>.",
        "_h3_reference_image": torch.zeros(1, 64, 64, 3),
        "_external": {
            "clip": "C",
            "vae": "V",
            "audio_vae": "A",
            "references": {
                "reference_image_1": torch.ones(1, 32, 32, 3),
                "reference_image_2": torch.full((1, 32, 32, 3), 2.0),
            },
        },
    }
    module.sample_latent(
        model="M", positive=None, negative=None, latent=None, seed=7,
        steps=20, cfg=1.0, sampler_name="res_multistep", scheduler="simple",
        denoise=1.0, gen_settings=gen_settings, draw_id="t", width=64, height=64,
    )
    encode_kwargs = captured["MiniMaxH3ReferenceToVideo"][0]
    refs = encode_kwargs["ref_images"]
    assert list(refs) == ["ref_image_1", "ref_image_2", "ref_image_3"]
    assert torch.equal(refs["ref_image_1"], torch.zeros(1, 64, 64, 3))
    assert torch.equal(refs["ref_image_2"], torch.ones(1, 32, 32, 3))
    assert torch.equal(refs["ref_image_3"], torch.full((1, 32, 32, 3), 2.0))
    assert encode_kwargs["prompt"] == "Keep the face from <Picture 2>."
    assert encode_kwargs["length"] == 5
    assert captured["BasicGuider"][0]["conditioning"] == "positive"
    assert captured["SamplerCustomAdvanced"][0]["latent_image"] == "latent"


def test_decode_samples_takes_first_frame(monkeypatch):
    module = _get_unicanvas_model_module("minimax_h3")
    frames = torch.zeros(5, 32, 32, 3)
    samples = torch.zeros(1, 4, 8, 8)
    captured = {}

    def fake_call(name, **kwargs):
        assert name == "VAEDecodeTiled", name
        captured.update(kwargs)
        return (frames,)

    monkeypatch.setattr("nodes.unicanvas.models.minimax_h3._call_comfy_node", fake_call)
    out = module.decode_samples("V", samples, {"_draw_id": "t"})
    assert out.shape[0] == 1
    assert torch.equal(out, frames[:1])
    # The tile widgets must be passed explicitly: _call_comfy_node cannot supply missing
    # required parameters, and it filters out keywords the installed core does not declare.
    assert captured["samples"] is samples
    assert captured["vae"] == "V"
    assert captured["tile_size"] == 512
    assert captured["overlap"] == 64
    assert captured["temporal_size"] == 64
    assert captured["temporal_overlap"] == 8


def test_decode_samples_single_frame_passes_through(monkeypatch):
    module = _get_unicanvas_model_module("minimax_h3")
    frame = torch.zeros(1, 32, 32, 3)
    monkeypatch.setattr(
        "nodes.unicanvas.models.minimax_h3._call_comfy_node",
        lambda name, **kwargs: (frame,) if name == "VAEDecodeTiled" else (_ for _ in ()).throw(AssertionError(name)),
    )
    out = module.decode_samples("V", torch.zeros(1, 4, 8, 8), {"_draw_id": "t"})
    assert out is frame
    assert out.shape[0] == 1


def test_sample_latent_requires_a_text_encoder_but_not_audio_vae(monkeypatch):
    module = _get_unicanvas_model_module("minimax_h3")
    import pytest

    with pytest.raises(RuntimeError, match=r"MiniMax H3 needs its text encoder"):
        module.sample_latent(
            model="M", positive=None, negative=None, latent=None, seed=1,
            steps=20, cfg=1.0, sampler_name="res_multistep", scheduler="simple",
            denoise=1.0,
            gen_settings={"_h3_prompt": "p", "_external": {}},
            draw_id="t", width=64, height=64,
        )

    # The node's own loader: clip/vae stashed by encode_prompt / prepare_reference_conditioning,
    # no config and no audio VAE.
    calls = {}

    def fake_node(name, **kwargs):
        calls[name] = kwargs
        if name == "MiniMaxH3ReferenceToVideo":
            return ("POS", {"samples": torch.zeros(1, 4, 8, 8)})
        return ("OUT",)

    monkeypatch.setattr("nodes.unicanvas.models.minimax_h3._call_comfy_node", fake_node)
    settings = {"_external": {}}
    module.encode_prompt("CLIP", "p", settings)
    module.prepare_reference_conditioning(None, None, "VAE", torch.zeros(1, 8, 8, 3), settings)
    module.sample_latent(
        model="M", positive=None, negative=None, latent=None, seed=1,
        steps=20, cfg=1.0, sampler_name="res_multistep", scheduler="simple",
        denoise=1.0, gen_settings=settings, draw_id="t", width=64, height=64,
    )
    h3 = calls["MiniMaxH3ReferenceToVideo"]
    assert h3["clip"] == "CLIP" and h3["vae"] == "VAE" and h3["audio_vae"] is None


def test_graph_generate_runs_draw_and_returns_tensor(monkeypatch):
    from nodes.unicanvas import node as uc
    from nodes.vncss_config import VNCCS_Config

    captured = {}

    def fake_draw(payload):
        captured.update(payload)
        return {"images": ["data:image/png;base64,AAAA"], "tensor": torch.zeros(1, 8, 8, 3)}

    monkeypatch.setattr(uc, "_run_unicanvas_draw", fake_draw)
    config = VNCCS_Config().execute(
        '{"loras": [], "edit_model": False}', model="M", clip="C", vae="V",
    )[0]
    node = uc.VNCCS_UniCanvas()
    state = {
        "state_id": "s1",
        "layers": [],
        "settings": {
            "draw_id": "draw-1",
            "generation_mode": "minimax_h3",
            "queued_draw": {
                "mode": "txt2img",
                "image": "data:image/png;base64,AAAA",
                "mask": "data:image/png;base64,BBBB",
                "source_empty": True,
                "bbox": {"x": 0, "y": 0, "width": 64, "height": 64},
                "inference_size": {"width": 64, "height": 64},
                "output_size": {"width": 64, "height": 64},
            },
        },
    }
    (image,) = node.export_state(
        json.dumps(state),
        config=config,
        unique_id="9",
    )
    assert captured["debug_id"] == "draw-1"
    assert captured["external"]["model"] == "M"
    assert captured["return_tensor"] is True
    assert image.shape == (1, 8, 8, 3)


def test_graph_generate_without_config_keeps_legacy_export(monkeypatch):
    from nodes.unicanvas import node as uc

    monkeypatch.setattr(
        uc, "_render_unicanvas_state_to_image_tensor", lambda state: torch.zeros(1, 4, 4, 3)
    )
    (image,) = uc.VNCCS_UniCanvas().export_state('{"layers": []}', config=None, unique_id="9")
    assert image.shape == (1, 4, 4, 3)


def test_result_store_roundtrip():
    from nodes.unicanvas.progress import _store_draw_result, _get_draw_result

    _store_draw_result("draw-x", {"images": ["data:x"], "mask": None})
    assert _get_draw_result("draw-x") == {"present": True, "images": ["data:x"], "mask": None}
    assert _get_draw_result("missing") == {"present": False}


def test_result_store_prunes_expired_entries():
    """Results are TTL-pruned on store and fetch; fresh entries survive both prunes."""
    import time

    from nodes.unicanvas import progress as uc

    uc._DRAW_RESULTS.clear()
    expired_at = time.time() - (uc._DRAW_RESULTS_TTL_SECONDS + 60)
    uc._DRAW_RESULTS["draw-old"] = {"images": ["data:old"], "mask": None, "stored_at": expired_at}

    uc._store_draw_result("draw-fresh", {"images": ["data:fresh"], "mask": None})
    # Pruned on store.
    assert "draw-old" not in uc._DRAW_RESULTS
    assert uc._get_draw_result("draw-fresh") == {"present": True, "images": ["data:fresh"], "mask": None}

    uc._DRAW_RESULTS["draw-old-2"] = {"images": ["data:old2"], "mask": None, "stored_at": expired_at}
    # Pruned on fetch, while the fresh entry survives.
    assert uc._get_draw_result("draw-old-2") == {"present": False}
    assert "draw-old-2" not in uc._DRAW_RESULTS
    assert "draw-fresh" in uc._DRAW_RESULTS
    uc._DRAW_RESULTS.clear()


def test_external_payload_selects_external_loader(monkeypatch):
    """A graph-generation payload forwards its VNCSS_CONFIG block to the pass-through loader."""
    from nodes.unicanvas import draw as uc

    buffer = io.BytesIO()
    Image.new("RGB", (64, 64), (0, 0, 0)).save(buffer, format="PNG")
    image_data_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    captured = {}

    def fake_load_assets(gen_settings):
        captured.update(gen_settings)
        raise RuntimeError("stop after asset selection")

    monkeypatch.setattr("nodes.unicanvas.draw_pipeline._load_generation_assets", fake_load_assets)
    with pytest.raises(RuntimeError, match="stop after asset selection"):
        uc._run_unicanvas_draw({
            "debug_id": "graph-draw",
            "mode": "txt2img",
            "image": image_data_url,
            "settings": {"generation_mode": "minimax_h3"},
            "external": {"model": "M", "clip": "C", "vae": "V", "audio_vae": "A", "references": {}},
        })
    assert captured["model_loader"] == "external"
    assert captured["generation_mode"] == "minimax_h3"
    assert captured["_external"]["model"] == "M"


def test_external_block_wins_over_preset_merge(monkeypatch):
    """Widget default settings select the 'sdxl' preset; a config-linked draw must still use the wired config."""
    from nodes.unicanvas import draw as uc

    image_buffer = io.BytesIO()
    Image.new("RGB", (64, 64), (0, 0, 0)).save(image_buffer, format="PNG")
    image_data_url = "data:image/png;base64," + base64.b64encode(image_buffer.getvalue()).decode("ascii")
    captured = {}

    def fake_load_assets(gen_settings):
        captured.update(gen_settings)
        raise RuntimeError("stop after asset selection")

    monkeypatch.setattr("nodes.unicanvas.draw_pipeline._load_generation_assets", fake_load_assets)
    # makeDefaultUniCanvasSettings() (web/vnccs_unicanvas.js): SDXL module defaults plus the
    # "presets" selection, the "sdxl" preset id and the checkpoint loader.
    widget_default_settings = {
        "model_selection_mode": "presets",
        "selected_preset_id": "sdxl",
        "model_loader": "checkpoint",
        "ckpt_name": "",
        "generation_mode": "minimax_h3",
    }
    with pytest.raises(RuntimeError, match="stop after asset selection"):
        uc._run_unicanvas_draw({
            "debug_id": "graph-draw",
            "mode": "txt2img",
            "image": image_data_url,
            "settings": dict(widget_default_settings),
            "external": {"model": "M", "clip": "C", "vae": "V", "audio_vae": "A", "references": {}},
        })
    assert captured["model_loader"] == "external"
    assert captured["generation_mode"] == "minimax_h3"
    assert captured["_external"]["model"] == "M"
    # The selected preset's own model block must not leak into the external draw.
    assert captured.get("ckpt_name") != "Illustrious/ILFlatMix.safetensors"


def test_external_config_overrides_node_loras_turbo_and_uploads(monkeypatch):
    """A linked config owns LoRAs and references: the node's greyed-out values never stack on top."""
    from nodes.unicanvas import draw as uc

    image_buffer = io.BytesIO()
    Image.new("RGB", (64, 64), (0, 0, 0)).save(image_buffer, format="PNG")
    image_data_url = "data:image/png;base64," + base64.b64encode(image_buffer.getvalue()).decode("ascii")
    captured = {}

    def fake_load_assets(gen_settings):
        captured.update(gen_settings)
        raise RuntimeError("stop after asset selection")

    monkeypatch.setattr("nodes.unicanvas.draw_pipeline._load_generation_assets", fake_load_assets)
    config_reference = object()
    with pytest.raises(RuntimeError, match="stop after asset selection"):
        uc._run_unicanvas_draw({
            "debug_id": "graph-draw",
            "mode": "txt2img",
            "image": image_data_url,
            "settings": {
                "generation_mode": "minimax_h3",
                "lora_stack": [{"name": "node_style.safetensors", "strength": 1.0, "enabled": True}],
                "turbo_enabled": True,
                "edit_reference_images": [image_data_url, image_data_url],
            },
            "external": {"model": "M", "clip": "C", "vae": "V", "audio_vae": "A",
                         "references": {"reference_image_1": config_reference}},
        })
    assert captured["lora_stack"] == []
    assert captured["turbo_enabled"] is False
    assert "edit_reference_images" not in captured
    assert captured["_external"]["references"] == {"reference_image_1": config_reference}


def test_node_draw_keeps_its_own_loras_and_uploads(monkeypatch):
    """Without a config the node's LoRA stack and uploaded references still apply."""
    from nodes.unicanvas import draw as uc

    image_buffer = io.BytesIO()
    Image.new("RGB", (64, 64), (0, 0, 0)).save(image_buffer, format="PNG")
    image_data_url = "data:image/png;base64," + base64.b64encode(image_buffer.getvalue()).decode("ascii")
    captured = {}

    def fake_load_assets(gen_settings):
        captured.update(gen_settings)
        raise RuntimeError("stop after asset selection")

    monkeypatch.setattr("nodes.unicanvas.draw_pipeline._load_generation_assets", fake_load_assets)
    stack = [{"name": "node_style.safetensors", "strength": 1.0, "enabled": True}]
    with pytest.raises(RuntimeError, match="stop after asset selection"):
        uc._run_unicanvas_draw({
            "debug_id": "node-draw",
            "mode": "txt2img",
            "image": image_data_url,
            "settings": {"generation_mode": "minimax_h3", "lora_stack": stack,
                         "edit_reference_images": [image_data_url]},
        })
    assert [item.get("name") for item in captured["lora_stack"]] == ["node_style.safetensors"]
    assert "reference_image_1" in captured["_external"]["references"]


def test_export_state_forwards_queued_draw_composition_keys(monkeypatch):
    """The queued path replays the frontend draw() composition keys verbatim."""
    from nodes.unicanvas import node as uc
    from nodes.vncss_config import VNCCS_Config

    captured = {}
    queued_draw = {
        "mode": "outpaint",
        "image": "data:image/png;base64,IMG",
        "mask": "data:image/png;base64,MASK",
        "source_empty": False,
        "bbox": {"x": 10, "y": 20, "width": 640, "height": 480},
        "inference_size": {"width": 1280, "height": 960},
        "output_size": {"width": 640, "height": 480},
        "pose_edit": {"image1": "data:image/png;base64,AAAA", "image2": "data:image/png;base64,BBBB"},
        "positive": "Use the edited pose and lighting from image 2",
        # Not composition keys: the node state owns the draw id and the generation settings,
        # so these must not cross the bridge from queued_draw.
        "debug_id": "frontend-debug-id",
        "settings": {"generation_mode": "sdxl"},
    }

    def fake_draw(payload):
        captured.update(payload)
        return {"images": [], "mask": None, "tensor": torch.zeros(1, 8, 8, 3)}

    monkeypatch.setattr(uc, "_run_unicanvas_draw", fake_draw)
    config = VNCCS_Config().execute(
        '{"loras": [], "edit_model": False}', model="M", clip="C", vae="V",
    )[0]
    state = {
        "state_id": "s1",
        "layers": [],
        "settings": {
            "draw_id": "draw-queued",
            "generation_mode": "minimax_h3",
            "queued_draw": queued_draw,
        },
    }
    (image,) = uc.VNCCS_UniCanvas().export_state(json.dumps(state), config=config, unique_id="9")

    for key in uc._QUEUED_DRAW_COMPOSITION_KEYS:
        assert captured[key] == queued_draw[key], key
    assert "settings" not in captured
    assert captured["debug_id"] == "draw-queued"
    assert captured["gen_settings"]["generation_mode"] == "minimax_h3"
    assert captured["gen_settings"]["positive"] == queued_draw["positive"]
    assert "positive" not in state["settings"], "the prompt override is one-shot"
    assert captured["external"]["model"] == "M"
    assert captured["return_tensor"] is True
    assert image.shape == (1, 8, 8, 3)


@pytest.mark.parametrize(
    "settings",
    [
        {"draw_id": "draw-1"},
        {"draw_id": "draw-1", "queued_draw": None},
        {"draw_id": "draw-1", "queued_draw": {}},
        {"draw_id": "draw-1", "queued_draw": "data:image/png;base64,IMG"},
        {"draw_id": "draw-1", "queued_draw": []},
    ],
)
def test_export_state_falls_back_to_canvas_render_without_queued_draw(monkeypatch, settings):
    """A plain Queue Prompt has no fresh composition: the node renders the canvas instead of raising."""
    from nodes.unicanvas import node as uc
    from nodes.vncss_config import VNCCS_Config

    rendered = []
    monkeypatch.setattr(
        uc,
        "_render_unicanvas_state_to_image_tensor",
        lambda state: rendered.append(state) or torch.zeros(1, 6, 6, 3),
    )
    monkeypatch.setattr(
        uc, "_run_unicanvas_draw", lambda payload: pytest.fail("draw must not run without a queued payload")
    )
    config = VNCCS_Config().execute(
        '{"loras": [], "edit_model": False}', model="M", clip="C", vae="V",
    )[0]
    state = {"state_id": "s1", "layers": [], "settings": settings}
    state_json = json.dumps(state)
    (image,) = uc.VNCCS_UniCanvas().export_state(state_json, config=config, unique_id="9")
    assert image.shape == (1, 6, 6, 3)
    assert rendered == [state_json]


def test_h3_without_connected_config_passes_validation():
    """MiniMax H3 no longer needs a VNCSS Config node: validation accepts a config-free draw."""
    from types import SimpleNamespace

    from nodes.unicanvas.models.capabilities import STANDARD_TASKS

    module = _get_unicanvas_model_module("minimax_h3")
    request = SimpleNamespace(external=None, task=STANDARD_TASKS["image_to_image"])
    module.validate_request(request)  # no RuntimeError about a VNCSS Config node

def test_h3_with_connected_config_reaches_the_external_loader(monkeypatch):
    """Regression guard for the H3 fail-fast: a forwarded external block still selects the pass-through loader."""
    from nodes.unicanvas import draw as uc

    captured = {}

    def fake_load_assets(gen_settings):
        captured.update(gen_settings)
        raise RuntimeError("stop after asset selection")

    monkeypatch.setattr("nodes.unicanvas.draw_pipeline._load_generation_assets", fake_load_assets)
    buffer = io.BytesIO()
    Image.new("RGB", (64, 64), (0, 0, 0)).save(buffer, format="PNG")
    image_data_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    with pytest.raises(RuntimeError, match="stop after asset selection"):
        uc._run_unicanvas_draw({
            "debug_id": "h3-with-config",
            "mode": "txt2img",
            "image": image_data_url,
            "settings": {"generation_mode": "minimax_h3"},
            "external": {"model": "M", "clip": "C", "vae": "V", "audio_vae": "A", "references": {}},
        })
    assert captured["model_loader"] == "external"
    assert captured["generation_mode"] == "minimax_h3"


def test_queued_draw_payload_reaches_the_real_draw_pipeline(monkeypatch):
    """The forwarded composition gets past source decoding instead of dying on 'Missing image data'."""
    from nodes.unicanvas import node as uc
    from nodes.vncss_config import VNCCS_Config

    image_buffer = io.BytesIO()
    Image.new("RGB", (64, 64), (10, 20, 30)).save(image_buffer, format="PNG")
    image_data_url = "data:image/png;base64," + base64.b64encode(image_buffer.getvalue()).decode("ascii")
    captured = {}

    def fake_load_assets(gen_settings):
        captured.update(gen_settings)
        raise RuntimeError("stop after asset selection")

    monkeypatch.setattr("nodes.unicanvas.draw_pipeline._load_generation_assets", fake_load_assets)
    config = VNCCS_Config().execute(
        '{"loras": [], "edit_model": False}', model="M", clip="C", vae="V",
    )[0]
    state = {
        "state_id": "s1",
        "layers": [],
        "settings": {
            "draw_id": "draw-real",
            # Widget defaults: the "presets" selection with the "sdxl" preset must not override the config.
            "model_selection_mode": "presets",
            "selected_preset_id": "sdxl",
            "model_loader": "checkpoint",
            "generation_mode": "minimax_h3",
            "queued_draw": {
                "mode": "img2img",
                "image": image_data_url,
                "mask": "data:image/png;base64,AAAA",
                "source_empty": False,
                "bbox": {"x": 0, "y": 0, "width": 64, "height": 64},
                "inference_size": {"width": 64, "height": 64},
                "output_size": {"width": 64, "height": 64},
            },
        },
    }
    with pytest.raises(RuntimeError, match="stop after asset selection"):
        uc.VNCCS_UniCanvas().export_state(json.dumps(state), config=config, unique_id="9")
    assert captured["model_loader"] == "external"
    assert captured["generation_mode"] == "minimax_h3"
    assert captured["draw_mode"] == "img2img"
    assert captured["_external"]["model"] == "M"


def test_turbo_lora_requirement_applies_only_with_positive_strength():
    module = _get_unicanvas_model_module("minimax_h3")
    (rule,) = module.lora_requirements
    assert rule.name_setting == "minimax_h3_lora_name"
    assert rule.resolve({"minimax_h3_lora_name": "H3/taomate_h3_3step_comfy.safetensors", "minimax_h3_lora_strength": 1.0}) is not None
    assert rule.resolve({"minimax_h3_lora_name": "H3/taomate_h3_3step_comfy.safetensors", "minimax_h3_lora_strength": 0}) is None
    assert rule.resolve({"minimax_h3_lora_name": "", "minimax_h3_lora_strength": 1.0}) is None
