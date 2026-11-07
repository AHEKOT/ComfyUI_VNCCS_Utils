"""Small independent tensors exercise projection and model adapters, without weights."""
import copy
import sys
from types import ModuleType, SimpleNamespace

import pytest

torch = pytest.importorskip("torch")
from PIL import Image
from helpers.backend_package import service_package

load = service_package("vnccs_factory_texturing_tensors_test")
texturing = load("nodes.factory3d.texturing")
materials = load("nodes.factory3d.materials")
generation = load("nodes.factory3d.generation")


def sample_image(image, uv):
    grid = (uv * 2 - 1).reshape(1, 1, -1, 2)
    return torch.nn.functional.grid_sample(image.permute(2, 0, 1)[None], grid,
        align_corners=False, padding_mode="border")[0, :, 0].T


def test_projection_rejects_hidden_backfaces_and_feathers_silhouette():
    projection = texturing._Projection.__new__(texturing._Projection)
    projection.device = torch.device("cpu")
    projection.radius = 1
    projection.positions = torch.tensor([[[0., 0., 0.], [0., 0., -1.], [.2, 0., 0.]]])
    projection.normals = torch.tensor([[[0., 0., 1.], [0., 0., 1.], [0., 0., -1.]]])
    projection.covered = torch.ones(1, 3, dtype=torch.bool)
    projection.triangles = projection.bvh = None
    def front_plane(origins, directions, *_args, **_kwargs):
        return -origins[:, 2] / directions[:, 2], None, torch.ones(len(origins), dtype=torch.bool)
    projection.core = SimpleNamespace(_closest_hit_rays_bvh=front_plane, _sample_image01=sample_image)
    eye = torch.tensor([0., 0., 3.])
    basis = (torch.tensor([0., 0., -1.]), torch.tensor([1., 0., 0.]), torch.tensor([0., 1., 0.]))
    grid, weight = projection.project(eye, basis, torch.ones(32, 32, dtype=torch.bool), lambda: None)
    assert grid[0, 0].tolist() == pytest.approx([.5, .5])
    assert weight[0, 0] > .9
    assert weight[0, 1] == 0  # The front plane occludes this texel.
    assert weight[0, 2] == 0  # Back-facing normal.
    _, edge_weight = projection.project(eye, basis, torch.zeros(32, 32, dtype=torch.bool), lambda: None)
    assert not bool(edge_weight.any())


def test_blend_keeps_unseen_texels_and_favors_face_on_detail():
    atlas = torch.zeros(1, 3, 3)
    source = torch.ones_like(atlas)
    previous = torch.tensor([[0., 1., 0.]])
    incoming = torch.tensor([[1., .01, 0.]])
    result, total = texturing.blend_projection(atlas, source, incoming, previous)
    assert torch.all(result[0, 0] == 1)
    assert torch.all(result[0, 1] < .01)
    assert torch.all(result[0, 2] == 0)
    assert total.tolist()[0] == pytest.approx([1, 1.01, 0])


def test_marigold_channel_contract_is_linear_material_and_srgb_albedo():
    prediction = torch.zeros(2, 4, 4, 3)
    prediction[0] = .25
    prediction[1, ..., 0] = .6
    prediction[1, ..., 1] = .9
    albedo, roughness, metallic = materials.appearance_maps(prediction)
    assert torch.all(albedo == .25)
    assert torch.all(roughness == .6)
    assert torch.all(metallic == .9)
    with pytest.raises(RuntimeError, match="layout"):
        materials.appearance_maps(prediction[:1])
    prediction[0, 0, 0, 0] = float("nan")
    with pytest.raises(RuntimeError, match="non-finite"):
        materials.appearance_maps(prediction)


@pytest.fixture
def comfy_stubs(monkeypatch):
    comfy, extras = ModuleType("comfy"), ModuleType("comfy_extras")
    comfy.model_management = SimpleNamespace(get_torch_device=lambda: torch.device("cpu"))
    extras.nodes_mesh_postprocess = SimpleNamespace()
    extras.nodes_save_3d = SimpleNamespace()
    for name, value in {"comfy": comfy, "comfy.model_management": comfy.model_management,
                        "comfy_extras": extras, "comfy_extras.nodes_mesh_postprocess": extras.nodes_mesh_postprocess,
                        "comfy_extras.nodes_save_3d": extras.nodes_save_3d}.items():
        monkeypatch.setitem(sys.modules, name, value)
    return comfy


@pytest.mark.parametrize("cancel", [False, True])
def test_views_are_sequential_and_materials_publish_after_files(tmp_path, monkeypatch, comfy_stubs, cancel):
    calls, rendered_atlases, snapshots = [], [], []
    class Projection:
        def __init__(self, *_args):
            self.device = torch.device("cpu")
            self.atlas = torch.full((16, 16, 3), .3)
            self.weights = torch.zeros(16, 16)
            self.covered = torch.ones(16, 16, dtype=torch.bool)
            self.center, self.radius = torch.zeros(3), 1
            self.triangles = self.bvh = self.positions = self.normals = None
        def camera(self, eye): return eye, None
        def render(self, _eye, _basis, atlas):
            if atlas.shape[-1] == 3 and atlas is self.atlas: rendered_atlases.append(atlas.clone())
            return atlas.clone(), self.covered
        def project(self, *_args): return torch.zeros(16, 16, 2), torch.ones(16, 16)
        def sample(self, image, _grid): return image
        def fill(self, atlas): return atlas
    monkeypatch.setattr(texturing, "_Projection", Projection)
    def node(name, **args):
        calls.append((name, args))
        if name == "UNETLoader":
            return (SimpleNamespace(clone=lambda: SimpleNamespace(set_model_unet_function_wrapper=lambda callback: None)),)
        if name == "TextEncodeQwenImage21": return "positive", "negative", {"samples": "empty"}
        if name == "VAEDecode": return (torch.full((1, 16, 16, 4), .8),)
        if name == "VAEEncode": return ({"samples": args["pixels"]},)
        if name == "SetLatentNoiseMask": return (args["samples"],)
        return (object(),)
    def sampler(*_args, **params):
        assert params["steps"] == 8 and params["cfg"] == 1
        if cancel: raise RuntimeError("cancelled")
        return "sample"
    def extract(_directory, records, _output, _seed, *, check_cancel, on_view):
        for index, _record in enumerate(records):
            on_view(index, (torch.full((16, 16, 3), .2), torch.full((16, 16, 1), .7), torch.full((16, 16, 1), .9)))
    def publish(snapshot):
        for view in snapshot["views"]:
            for name in ("base", "refined"):
                if name in view: assert (tmp_path / view[name]).is_file()
        for name in snapshot.get("atlas", {}).values(): assert (tmp_path / name).is_file()
        snapshots.append(copy.deepcopy(snapshot))
    monkeypatch.setattr(texturing, "_call_node", node)
    monkeypatch.setattr(texturing, "_sampler", sampler)
    monkeypatch.setattr(texturing, "extract_materials", extract)
    monkeypatch.setattr(texturing, "release_runtime_memory", lambda: None)
    Image.new("RGB", (16, 16), "red").save(tmp_path / "reference.png")
    kwargs = dict(material_model_directory=tmp_path, emit=lambda *_args: None,
                  check_cancel=lambda: None, publish=publish)
    if cancel:
        with pytest.raises(RuntimeError, match="cancelled"):
            texturing.run_texture_pass(SimpleNamespace(), tmp_path, tmp_path / "reference.png", 7, **kwargs)
        assert not (tmp_path / "view_0_refined.png").exists()
        assert snapshots[-1]["phase"] == "views"
        return
    result = texturing.run_texture_pass(SimpleNamespace(), tmp_path, tmp_path / "reference.png", 7, **kwargs)
    assert len(rendered_atlases) == 6
    assert not torch.equal(rendered_atlases[0], rendered_atlases[1])
    assert snapshots[-1]["phase"] == "complete"
    assert snapshots[-1]["coverage"] == 1
    assert all(view["state"] == "complete" for view in snapshots[-1]["views"])
    for value, expected in zip(result, (.2, .7, .9)):
        assert torch.allclose(value, torch.full_like(value, expected))
    assert calls[0][1]["unet_name"] == "qwen_image_2.1_turbo_int8_convrot.safetensors"
    assert not any("lora" in name.lower() for name, _ in calls)
    assert len([call for call in calls if call[0] == "TextEncodeQwenImage21"]) == 6


def test_material_adapter_uses_local_weights_and_cleans_up_on_cancel(tmp_path, monkeypatch, comfy_stubs):
    calls, hooks = [], []
    sampling = False
    class Pipeline:
        unet = SimpleNamespace(register_forward_pre_hook=lambda callback: hooks.append(callback) or SimpleNamespace(remove=lambda: calls.append("remove")))
        @classmethod
        def from_pretrained(cls, *args, **kwargs):
            calls.append(kwargs)
            return cls()
        def to(self, device): calls.append(str(device)); return self
        def set_progress_bar_config(self, **kwargs): pass
        def __call__(self, *_args, **_kwargs):
            nonlocal sampling
            sampling = True
            hooks[0](None, None)
    monkeypatch.setitem(sys.modules, "diffusers", SimpleNamespace(MarigoldIntrinsicsPipeline=Pipeline))
    monkeypatch.setattr(generation, "release_runtime_memory", lambda: calls.append("release"))
    Image.new("RGB", (16, 16)).save(tmp_path / "view.png")
    def cancel():
        if sampling: raise RuntimeError("cancelled")
    with pytest.raises(RuntimeError, match="cancelled"):
        materials.extract_materials(tmp_path, [{"refined": "view.png"}], tmp_path, 1,
                                   check_cancel=cancel, on_view=lambda *_args: None)
    options = next(item for item in calls if isinstance(item, dict))
    assert options["local_files_only"] and options["use_safetensors"]
    assert options["token"] is False
    assert calls[-3:] == ["remove", "cpu", "release"]


@pytest.mark.parametrize("enabled", [False, True])
def test_mesh_pipeline_runs_refinement_only_when_enabled(tmp_path, monkeypatch, enabled):
    published, refined, saved = [], [], []
    def node(name, **kwargs):
        if name == "ImageCropToMask": return (torch.zeros(1, 16, 16, 3),)
        if name == "BakeTextureFromVoxel": return "base", "metallic", "roughness"
        if name == "ApplyTextureToMesh": return (kwargs,)
        if name in ("MeshToFile3D", "MeshSmoothNormals"): return (kwargs["mesh"],)
        return ("first", "second", "third", "fourth")
    def save(mesh, path):
        saved.append((mesh, path.name))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"glTF" + b"\0" * 32)
    def refine(*_args, **_kwargs):
        refined.append(True)
        return "refined base", "refined roughness", "refined metallic"
    monkeypatch.setattr(generation, "_call_node", node)
    monkeypatch.setattr(generation, "_sampler", lambda *_args, **_kwargs: "sample")
    monkeypatch.setattr(generation, "_save_file3d", save)
    monkeypatch.setattr(generation, "release_runtime_memory", lambda: None)
    monkeypatch.setattr(generation, "runtime_status", lambda _provider, **_kwargs: {"ready": True})
    monkeypatch.setattr(texturing, "run_texture_pass", refine)
    settings = generation.normalize_mesh_settings({"provider": "trellis2", "remove_background": "0", "refine_textures": enabled, "seed": 1})
    generation.run_mesh_generation("trellis2", Image.new("RGB", (16, 16)),
        tmp_path / "model" / "model.glb", tmp_path / "prepared.png", settings,
        emit=lambda *_args: None, check_cancel=lambda: None,
        material_model_directory=tmp_path if enabled else None, publish=published.append)
    assert bool(refined) is enabled
    assert bool(published) is enabled
    assert (tmp_path / "texturing" / "preview.glb").exists() is enabled
    final_mesh, filename = saved[-1]
    assert filename == "model.glb"
    assert final_mesh["base_color"] == ("refined base" if enabled else "base")
    assert final_mesh["metallic"] == ("refined metallic" if enabled else "metallic")
    assert final_mesh["roughness"] == ("refined roughness" if enabled else "roughness")
