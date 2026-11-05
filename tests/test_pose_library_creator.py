"""Creator contracts and real library writes, without models or PyTorch."""

import base64
from contextlib import nullcontext
from concurrent.futures import ThreadPoolExecutor
import io
import inspect
import json
from types import ModuleType, SimpleNamespace

import numpy as np
from PIL import Image
import pytest

from helpers.backend_package import service_package, stub_imports


load = service_package("pose_creator_test")
creator = load("nodes.pose_library_creator")
bridge = load("nodes.unicanvas.comfy_bridge")
metadata = {"name": "Raised Hand", "category": "Standing", "tags": ["standing", "raised hand"]}


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(creator.library, "get_library_path", lambda: str(tmp_path))
    monkeypatch.setattr(creator.library, "load_pose_repositories", lambda: [])
    return tmp_path


def preview():
    buffer = io.BytesIO()
    Image.new("RGBA", (4, 8), (40, 80, 120, 90)).save(buffer, "PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def test_metadata_accepts_fences_preserves_existing_category_and_deduplicates_tags():
    value = {**metadata, "category": "standing", "tags": ["Standing", "standing", " raised hand "]}
    result = creator.parse_pose_metadata("<think>ignored</think>```json\n" + json.dumps(value) + "\n```", ["Standing"])
    assert result == {**metadata, "tags": ["Standing", "raised hand"]}
    assert creator.parse_pose_metadata(json.dumps({**metadata, "category": "Balancing"}), ["Standing"])["category"] == "Balancing"


@pytest.mark.parametrize("value", [
    "not json", "{}", "[]", json.dumps({**metadata, "category": ["Standing", "Action"]}),
    json.dumps({**metadata, "name": "../"}), json.dumps({**metadata, "tags": "standing"}),
    json.dumps({**metadata, "tags": []}), json.dumps({**metadata, "tags": [7]}),
    json.dumps({**metadata, "name": "x" * 81}), json.dumps({**metadata, "prompt": "not allowed"}),
])
def test_invalid_metadata_is_rejected(value):
    with pytest.raises(ValueError):
        creator.parse_pose_metadata(value, [])


def test_creates_new_entries_without_overwriting_and_round_trips_preview(store):
    pose = {"type": "scene_pose", "bones": {"head": [5, 0, 0]}, "prompt": "", "pose_prompts": [""]}
    first = creator.save_created_pose(pose, preview(), metadata, lambda: None)
    original = (store / first["path"]).read_bytes()
    second = creator.save_created_pose(pose, preview(), metadata, lambda: None)
    assert second["name"] == "Raised Hand A"
    third = creator.save_created_pose(pose, preview(), metadata, lambda: None)
    assert third["name"] == "Raised Hand B"
    assert (store / first["path"]).read_bytes() == original
    loaded, status = creator.library.get_pose(first["name"], first)
    assert status == 200
    assert loaded["pose"]["prompt"] == ""
    assert loaded["pose"]["_library"]["tags"] == metadata["tags"]
    saved_preview, _ = creator.library.find_preview(str((store / first["path"]).parent), first["name"])
    with Image.open(saved_preview) as image:
        assert image.size == (4, 8)
        assert image.mode == "RGB", "library cards use the existing compressed WebP format"


def test_letter_suffix_skips_existing_variants_and_continues_after_z(store):
    pose = {"bones": {"head": [5, 0, 0]}, "prompt": ""}
    originals = {}
    for suffix in ["", *(f" {chr(letter)}" for letter in range(ord("A"), ord("Z") + 1)), " AA"]:
        result, status = creator.library.save_pose({**metadata, "name": metadata["name"] + suffix, "pose": pose})
        assert status == 200
        path = store / result["path"]
        originals[path] = path.read_bytes()
    saved = creator.save_created_pose(pose, preview(), metadata, lambda: None)
    assert saved["name"] == "Raised Hand AB"
    assert all(path.read_bytes() == original for path, original in originals.items())


def test_concurrent_creators_reserve_distinct_letter_variants(store):
    def save(index):
        return creator.save_created_pose({"bones": {"head": [index, 0, 0]}, "prompt": ""},
                                         preview(), metadata, lambda: None)
    with ThreadPoolExecutor(max_workers=4) as pool:
        saved = list(pool.map(save, range(4)))
    assert {item["name"] for item in saved} == {"Raised Hand", "Raised Hand A", "Raised Hand B", "Raised Hand C"}
    for index, item in enumerate(saved):
        loaded, status = creator.library.get_pose(item["name"], item)
        assert status == 200
        assert loaded["pose"]["bones"]["head"] == [index, 0, 0]


def test_cancelled_or_failed_save_creates_no_entry(store, monkeypatch):
    def interrupt():
        raise RuntimeError("cancelled")
    with pytest.raises(RuntimeError, match="cancelled"):
        creator.save_created_pose({"prompt": ""}, preview(), metadata, interrupt)
    assert list(store.iterdir()) == []
    monkeypatch.setattr(creator.library.os, "replace", lambda *args: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(RuntimeError, match="disk full"):
        creator.save_created_pose({"prompt": ""}, preview(), metadata, lambda: None)
    assert not list(store.rglob("*.json"))
    assert not list(store.rglob("*.webp"))


def test_default_settings_match_execution_and_expose_no_turbo():
    comfy = ModuleType("comfy")
    comfy.samplers = SimpleNamespace(KSampler=SimpleNamespace(SAMPLERS=["euler"], SCHEDULERS=["simple"]))
    with stub_imports({"comfy": comfy, "comfy.samplers": comfy.samplers}):
        schema = creator.VNCCS_PoseLibraryCreator.INPUT_TYPES()
        inputs = schema["required"]
    defaults = {"seed": 0, "resolution_scale": 1.0, "steps": 8, "cfg": 1.0,
                "sampler_name": "euler", "scheduler": "simple"}
    signature = inspect.signature(creator.VNCCS_PoseLibraryCreator.generate)
    for name, expected in defaults.items():
        assert inputs[name][1]["default"] == expected
        assert signature.parameters[name].default == expected
    assert inputs["seed"][1]["control_after_generate"] == "fixed"
    assert "viggle_turbo" not in inputs
    assert "viggle_turbo" not in signature.parameters
    for name in ("category", "tags"):
        assert name not in inputs
        assert schema["optional"][name][1]["default"] == signature.parameters[name].default == ""
        assert schema["optional"][name][1]["dynamicPrompts"] is False


@pytest.mark.parametrize("steps,cfg,sampler,scheduler", [(8, 1.0, "euler", "simple"), (25, 3.0, "heun", "normal")])
def test_qi2_orders_references_clones_model_and_preserves_sampling(monkeypatch, steps, cfg, sampler, scheduler):
    calls = []
    class Model:
        def __init__(self, patches):
            self.patches = dict(patches)
        def clone(self):
            return Model(self.patches)
    model, clip, vae = Model({"external_pose_lora": 0.75}), object(), object()
    pose, character = SimpleNamespace(shape=(1, 1024, 1024, 3)), object()
    decoded = SimpleNamespace(detach=lambda: SimpleNamespace(cpu=lambda: "decoded"))
    def call(name, **kwargs):
        calls.append((name, kwargs))
        if name == "QwenImage21Cache":
            kwargs["model"].cache_enabled = True
        if name == "TextEncodeQwenImage21":
            return ("positive", "negative", "encoder latent must not be used")
        if name == "VAEDecode":
            return (decoded,)
        return (kwargs.get("model", name),)
    monkeypatch.setattr(bridge, "_call_comfy_node", call)
    result = creator.VNCCS_PoseLibraryCreator()._infer(model, clip, vae, pose, character,
                                                      17, 1.0, steps, cfg, sampler, scheduler)
    assert result == "decoded"
    assert calls[0][1]["model"] is not model
    assert not hasattr(model, "cache_enabled")
    assert [name for name, _args in calls] == ["QwenImage21Cache", "TextEncodeQwenImage21",
                                             "EmptyLatentImage", "KSampler", "VAEDecode"]
    encoded = dict(calls)["TextEncodeQwenImage21"]
    assert encoded["images"] == {"image_1": pose, "image_2": character}
    assert encoded["resolution"] == 1024
    assert encoded["prompt"] == "Draw character from image2"
    assert encoded["clip"] is clip and encoded["vae"] is vae
    sampling = dict(calls)["KSampler"]
    assert sampling["model"].patches == model.patches == {"external_pose_lora": 0.75}
    assert sampling["model"] is calls[0][1]["model"]
    assert sampling["latent_image"] == "EmptyLatentImage"
    assert "SamplerCustomAdvanced" not in dict(calls)
    assert (sampling["steps"], sampling["cfg"], sampling["denoise"]) == (steps, cfg, 1.0)
    assert (sampling["sampler_name"], sampling["scheduler"], sampling["seed"]) == (sampler, scheduler, 17)


@pytest.fixture
def runtime(monkeypatch):
    class Interrupted(Exception):
        pass
    manage = ModuleType("comfy.model_management")
    manage.InterruptProcessingException = Interrupted
    manage.throw_exception_if_processing_interrupted = lambda: None
    comfy = ModuleType("comfy")
    comfy.model_management = manage
    torch = ModuleType("torch")
    torch.is_tensor = lambda value: isinstance(value, np.ndarray)
    torch.isfinite = np.isfinite
    torch.inference_mode = nullcontext
    with stub_imports({"torch": torch, "comfy": comfy, "comfy.model_management": manage}):
        monkeypatch.setattr(bridge, "_call_comfy_node", lambda name, **kwargs: (kwargs["image"],))
        yield manage


@pytest.mark.parametrize("failure", [None, "render", "infer", "describe", "cancel"])
def test_pipeline_only_publishes_after_every_stage_succeeds(store, runtime, monkeypatch, failure):
    node = creator.VNCCS_PoseLibraryCreator()
    events = []
    node._emit = lambda _node, _run, stage, message, **kwargs: events.append(stage)
    image = np.zeros((1, 8, 4, 3), dtype=np.float32)
    def stage(name, result):
        def run(*args):
            if failure == name:
                raise ValueError(name + " failed")
            if failure == "cancel" and name == "describe":
                raise runtime.InterruptProcessingException()
            return result
        return run
    node._render_pose = stage("render", (image, {"prompt": "", "pose_prompts": [""], "bones": {}}))
    node._infer = stage("infer", image)
    node._describe = stage("describe", (metadata, preview()))
    if failure:
        with pytest.raises((ValueError, runtime.InterruptProcessingException)):
            node.generate(None, None, None, image, image, unique_id="7")
        assert creator.library.scan_poses() == []
        assert events[-1] == ("cancelled" if failure == "cancel" else "error")
    else:
        result = node.generate(None, None, None, image, image, unique_id="7")
        assert result["result"][0] is image
        assert result["ui"]["pose_library_result"][0]["name"] == "Raised Hand"
        assert events == ["recognize", "generate", "describe", "save", "done"]
        assert len(creator.library.scan_poses()) == 1


def test_multiple_images_are_rejected_without_silently_discarding_them(runtime):
    node = creator.VNCCS_PoseLibraryCreator()
    with pytest.raises(ValueError, match="PoseImage must contain one"):
        node.generate(None, None, None, np.zeros((2, 8, 8, 3)), np.zeros((1, 8, 8, 3)), unique_id="7")


@pytest.mark.parametrize("category,tags,expected_category,expected_tags", [
    ("", "", "Standing", ["standing", "raised hand"]),
    ("   ", " , , ", "Standing", ["standing", "raised hand"]),
    ("  Custom  ", " STANDING, Wave, wave, raised hand ", "Custom", ["standing", "raised hand", "Wave"]),
    ("standing", "", "standing", ["standing", "raised hand"]),
    ("", "Wave, wave", "Standing", ["standing", "raised hand", "Wave"]),
])
def test_manual_metadata_overrides_round_trip_through_pipeline(store, runtime, monkeypatch,
                                                              category, tags, expected_category, expected_tags):
    node = creator.VNCCS_PoseLibraryCreator()
    node._emit = lambda *args, **kwargs: None
    image = np.zeros((1, 8, 4, 3), dtype=np.float32)
    node._render_pose = lambda *args: (image, {"bones": {}, "prompt": ""})
    node._infer = lambda *args: image
    monkeypatch.setattr(creator, "_image_preview", lambda _image: preview())
    # An unusable model category must not matter when the user supplies one.
    raw = json.dumps({**metadata, "category": ["Ignored", "Invalid"] if category.strip() else "Standing"})
    with stub_imports({"pose_creator_test.nodes.unicanvas.prompt_enhance":
                       SimpleNamespace(generate_text=lambda *args, **kwargs: raw)}):
        result = node.generate(None, None, None, image, image, unique_id="7", category=category, tags=tags)
    saved = result["ui"]["pose_library_result"][0]
    loaded, status = creator.library.get_pose(saved["name"], saved)
    assert status == 200
    assert saved["category"] == loaded["pose"]["_library"]["category"] == expected_category
    assert saved["tags"] == loaded["pose"]["_library"]["tags"] == expected_tags
    assert metadata == {"name": "Raised Hand", "category": "Standing", "tags": ["standing", "raised hand"]}


@pytest.mark.parametrize("fields", [
    {"category": ["Standing"]}, {"category": "x" * 81}, {"category": "bad\x00category"},
    {"tags": ["standing"]}, {"tags": "x" * 4097}, {"tags": "x" * 65}, {"tags": "bad\x00tag"},
])
def test_invalid_manual_metadata_fails_before_generation(store, runtime, fields):
    node = creator.VNCCS_PoseLibraryCreator()
    node._render_pose = lambda *args: pytest.fail("Invalid metadata must fail before pose reconstruction")
    image = np.zeros((1, 8, 4, 3), dtype=np.float32)
    with pytest.raises(ValueError):
        node.generate(None, None, None, image, image, unique_id="7", **fields)
    assert list(store.iterdir()) == []


@pytest.mark.parametrize("failure", [None, "obsolete", "browser error", "dimensions", "pose", "skeleton"])
def test_real_capture_file_bridge_validates_run_and_payload(tmp_path, monkeypatch, failure):
    torch = ModuleType("torch")
    torch.from_numpy = lambda array: SimpleNamespace(unsqueeze=lambda axis: np.expand_dims(array, axis))
    node = creator.VNCCS_PoseLibraryCreator()
    node._emit = lambda *args, **kwargs: None
    def send(event, detail, client):
        assert event == "vnccs_pose_library_creator_render"
        assert client == "browser-session"
        payload = {"sync_token": detail["run_id"], "captured_images": [preview()],
                   "pose": {"type": "scene_pose", "bones": {}, "prompt": "", "pose_prompts": [""],
                            "characters": [{"poses": [{"bones": {}, "prompt": ""}]}]}}
        if failure == "obsolete":
            payload["sync_token"] = "old"
        if failure == "browser error":
            payload["sync_error"] = "WebGL unavailable"
        if failure == "pose":
            payload["pose"] = {}
        if failure == "skeleton":
            payload["pose"]["characters"] = [{}]
        (tmp_path / "vnccs_debug_7_9_current.json").write_text(json.dumps(payload))
    sam = SimpleNamespace(process_image_to_pose_json=lambda image: '{"joint_names":["pelvis"]}',
                          progress=SimpleNamespace(start_task=lambda task: None, task_context=lambda task: nullcontext()))
    with stub_imports({"torch": torch, "pose_creator_test.vnccs_sam3d": sam,
                       "folder_paths": SimpleNamespace(get_temp_directory=lambda: str(tmp_path)),
                       "server": SimpleNamespace(PromptServer=SimpleNamespace(instance=SimpleNamespace(send_sync=send, client_id="browser-session")))}):
        if failure:
            with pytest.raises(RuntimeError):
                node._render_pose(None, 5 if failure == "dimensions" else 4, 8, "7:9", "current", lambda: None)
        else:
            image, pose = node._render_pose(None, 4, 8, "7:9", "current", lambda: None)
            assert image.shape == (1, 8, 4, 3)
            assert pose["prompt"] == ""
    assert not list(tmp_path.iterdir()), "consumed captures must be removed"


def test_capture_wait_interrupts_immediately_and_progress_failure_is_non_destructive(tmp_path):
    class Interrupted(Exception):
        pass
    def interrupt():
        raise Interrupted()
    with stub_imports({"torch": ModuleType("torch"),
                       "folder_paths": SimpleNamespace(get_temp_directory=lambda: str(tmp_path))}):
        pose_studio = load("nodes.pose_studio")
        with pytest.raises(Interrupted):
            pose_studio.VNCCS_PoseStudio()._wait_for_frontend_sync("7", 0, timeout=float("inf"), interrupt_check=interrupt)
    def disconnected(*args):
        raise OSError("browser disconnected")
    with stub_imports({"server": SimpleNamespace(PromptServer=SimpleNamespace(instance=SimpleNamespace(send_sync=disconnected)))}):
        creator.VNCCS_PoseLibraryCreator()._emit("7", "run", "done", "Saved")
