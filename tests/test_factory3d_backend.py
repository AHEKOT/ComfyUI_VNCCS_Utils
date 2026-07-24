import ast
import importlib.util
import io
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]


def load_modules():
    root_package = types.ModuleType("vnccs_factory_test")
    root_package.__path__ = [str(ROOT)]
    api_package = types.ModuleType("vnccs_factory_test.api")
    api_package.__path__ = [str(ROOT / "api")]
    sys.modules[root_package.__name__] = root_package
    sys.modules[api_package.__name__] = api_package

    gaussian_spec = importlib.util.spec_from_file_location(
        "vnccs_factory_test.api.gaussian_scene",
        ROOT / "api" / "gaussian_scene.py",
    )
    gaussian = importlib.util.module_from_spec(gaussian_spec)
    sys.modules[gaussian_spec.name] = gaussian
    gaussian_spec.loader.exec_module(gaussian)

    factory_spec = importlib.util.spec_from_file_location(
        "vnccs_factory_test.api.factory3d",
        ROOT / "api" / "factory3d.py",
    )
    factory = importlib.util.module_from_spec(factory_spec)
    sys.modules[factory_spec.name] = factory
    factory_spec.loader.exec_module(factory)
    return gaussian, factory


class FactoryBackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gaussian, cls.factory = load_modules()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.original_root = self.factory._factory_root
        self.original_model_root = self.factory._model_root
        self.original_category_roots = self.factory._category_roots
        self.factory._factory_root = lambda: self.root
        self.factory._model_root = lambda: self.root / "models"
        self.factory._category_roots = lambda _category: []

    def tearDown(self):
        self.factory._factory_root = self.original_root
        self.factory._model_root = self.original_model_root
        self.factory._category_roots = self.original_category_roots
        self.temporary.cleanup()

    def test_scenes_are_created_listed_and_updated(self):
        scene = self.factory.create_scene("First scene")
        self.assertRegex(scene["scene_id"], r"^[a-f0-9]{32}$")
        self.assertEqual(self.factory.list_scenes()[0]["name"], "First scene")

        updated = self.factory.update_scene(scene["scene_id"], {"name": "Renamed"})
        self.assertEqual(updated["name"], "Renamed")
        self.assertEqual(updated["revision"], 1)
        self.assertEqual(self.factory.load_scene(scene["scene_id"])["name"], "Renamed")
        unchanged = self.factory.update_scene(scene["scene_id"], {"name": "Renamed", "objects": []})
        self.assertEqual(unchanged["revision"], 1)

    def test_experimental_density_modes_are_supported_through_api_and_triposplat(self):
        capabilities = self.factory.capabilities()
        self.assertIn(524288, capabilities["gaussian_counts"])
        self.assertIn(1048576, capabilities["gaussian_counts"])
        self.assertEqual(capabilities["experimental_gaussian_counts"], [524288, 1048576])
        settings = self.factory._generation_settings({"num_gaussians": "524288"})
        self.assertEqual(settings["num_gaussians"], 524288)
        extreme = self.factory._generation_settings({"num_gaussians": "1048576"})
        self.assertEqual(extreme["num_gaussians"], 1048576)
        clamped = self.factory._generation_settings({"num_gaussians": "9999999"})
        self.assertEqual(clamped["num_gaussians"], 1048576)
        source = (ROOT / "triposplat_backend" / "triposplat.py").read_text(encoding="utf-8")
        self.assertIn("_NUM_GAUSSIANS_MAX = 1048576", source)

    def test_conditioning_resolution_settings_include_experimental_native_size_mode(self):
        capabilities = self.factory.capabilities()
        self.assertEqual(capabilities["conditioning_resolutions"], [1024, 1536, 2048])
        self.assertEqual(capabilities["experimental_conditioning_resolutions"], [1536, 2048])
        self.assertEqual(capabilities["defaults"]["conditioning_resolution"], 1024)
        self.assertFalse(capabilities["defaults"]["prevent_upscale"])

        settings = self.factory._generation_settings({
            "conditioning_resolution": "2048",
            "prevent_upscale": "1",
        })
        self.assertEqual(settings["conditioning_resolution"], 2048)
        self.assertTrue(settings["prevent_upscale"])
        with self.assertRaisesRegex(ValueError, "conditioning_resolution"):
            self.factory._generation_settings({"conditioning_resolution": "4096"})

        source = (ROOT / "triposplat_backend" / "triposplat.py").read_text(encoding="utf-8")
        self.assertIn("def _conditioning_canvas_size(", source)
        self.assertIn("(native_short_side // _IMAGE_PATCH_SIZE) * _IMAGE_PATCH_SIZE", source)
        self.assertIn("prevent_upscale=prevent_upscale", source)
        tree = ast.parse(source)
        helper = next(
            item
            for item in tree.body
            if isinstance(item, ast.FunctionDef) and item.name == "_conditioning_canvas_size"
        )
        namespace = {"_IMAGE_PATCH_SIZE": 16}
        exec(compile(ast.Module(body=[helper], type_ignores=[]), "<conditioning-helper>", "exec"), namespace)
        resolve = namespace["_conditioning_canvas_size"]
        self.assertEqual(resolve((1200, 800), 2048, True), 800)
        self.assertEqual(resolve((1024, 770), 2048, True), 768)
        self.assertEqual(resolve((1200, 800), 2048, False), 2048)
        self.assertEqual(resolve((4096, 3072), 1536, True), 1536)

    def test_generation_result_embeds_committed_public_scene_for_frontend_hydration(self):
        source = (ROOT / "api" / "factory3d.py").read_text(encoding="utf-8")
        self.assertIn('"scene": _public_scene(scene)', source)

    def test_object_updates_cannot_replace_server_file_metadata(self):
        scene = self.factory.create_scene("Scene")
        object_id = self.factory._new_id()
        scene["objects"].append(
            {
                "object_id": object_id,
                "name": "Object",
                "transform": self.gaussian.normalize_transform({}),
                "files": {"ply": "objects/original/model.ply"},
            }
        )
        self.factory._save_scene(scene)
        updated = self.factory.update_scene(
            scene["scene_id"],
            {
                "objects": [{
                    "object_id": object_id,
                    "name": "Moved",
                    "transform": {"position": [1, 2, 3], "scale": 2},
                    "files": {"ply": "../../escape.ply"},
                }]
            },
        )
        item = updated["objects"][0]
        self.assertEqual(item["name"], "Moved")
        self.assertEqual(item["transform"]["position"], [1.0, 2.0, 3.0])
        self.assertEqual(item["files"]["ply"], "objects/original/model.ply")

    def test_duplicate_object_has_independent_assets_and_transform(self):
        scene = self.factory.create_scene("Scene")
        object_id = self.factory._new_id()
        object_root = self.factory.resolve_scene_dir(scene["scene_id"]) / "objects" / object_id
        object_root.mkdir(parents=True)
        files = {}
        for key, name in {
            "reference": "reference.png",
            "prepared": "prepared.png",
            "ply": "model.ply",
            "splat": "model.splat",
        }.items():
            target = object_root / name
            target.write_bytes(f"{key}-asset".encode())
            files[key] = str(target.relative_to(self.factory.resolve_scene_dir(scene["scene_id"])))
        scene["objects"].append({
            "object_id": object_id,
            "name": "Machine",
            "created_at": 1,
            "transform": self.gaussian.normalize_transform({"position": [1, 2, 3]}),
            "files": files,
        })
        self.factory._save_scene(scene)

        result = self.factory.duplicate_object(scene["scene_id"], object_id)
        duplicate = self.factory._object_by_id(result["scene"], result["object_id"])
        self.assertEqual(duplicate["name"], "Machine — copy")
        self.assertEqual(duplicate["transform"]["position"], [1.0, 2.0, 3.0])
        self.assertNotEqual(duplicate["files"], files)
        for key in files:
            source = self.factory._object_file(scene["scene_id"], scene["objects"][0], key)
            copied = self.factory._object_file(scene["scene_id"], duplicate, key)
            self.assertNotEqual(source, copied)
            self.assertEqual(source.read_bytes(), copied.read_bytes())

        duplicate["transform"]["position"][0] = 99
        self.assertEqual(scene["objects"][0]["transform"]["position"][0], 1.0)

    def test_stale_scene_export_is_rebuilt_after_orientation_format_change(self):
        scene = self.factory.create_scene("Scene")
        object_id = self.factory._new_id()
        source = self.factory.resolve_scene_dir(scene["scene_id"]) / "objects" / object_id / "model.ply"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(b"source")
        stale_ply = self.factory.resolve_scene_dir(scene["scene_id"]) / "exports" / "scene-r0.ply"
        stale_splat = stale_ply.with_suffix(".splat")
        stale_ply.parent.mkdir(parents=True, exist_ok=True)
        stale_ply.write_bytes(b"stale")
        stale_splat.write_bytes(b"stale")
        scene["objects"].append(
            {
                "object_id": object_id,
                "name": "Object",
                "transform": self.gaussian.normalize_transform({}),
                "files": {"ply": str(source.relative_to(self.factory.resolve_scene_dir(scene["scene_id"])))},
            }
        )
        scene["exports"] = {
            "revision": scene["revision"],
            "format_version": self.factory.EXPORT_FORMAT_VERSION - 1,
            "files": {
                "ply": str(stale_ply.relative_to(self.factory.resolve_scene_dir(scene["scene_id"]))),
                "splat": str(stale_splat.relative_to(self.factory.resolve_scene_dir(scene["scene_id"]))),
            },
        }
        self.factory._save_scene(scene, bump_revision=False)

        def fake_export(_sources, ply, splat):
            Path(ply).parent.mkdir(parents=True, exist_ok=True)
            Path(ply).write_bytes(b"upright")
            Path(splat).write_bytes(b"upright")
            return {"ply": {"gaussians": 1, "objects": 1}}

        with mock.patch.object(self.factory, "export_gaussian_scene", side_effect=fake_export) as export:
            result = self.factory.ensure_scene_exports(scene["scene_id"])

        export.assert_called_once()
        self.assertIn(f"-v{self.factory.EXPORT_FORMAT_VERSION}-", result["ply"].name)
        saved = self.factory.load_scene(scene["scene_id"])
        self.assertEqual(saved["exports"]["format_version"], self.factory.EXPORT_FORMAT_VERSION)

    def test_invalid_scene_identifier_is_rejected(self):
        with self.assertRaises(ValueError):
            self.factory.resolve_scene_dir("../../outside")

    def test_reference_image_is_persisted_with_scene_and_public_path_is_safe(self):
        scene = self.factory.create_scene("Scene")
        stream = io.BytesIO()
        Image.new("RGB", (3, 2), (20, 40, 60)).save(stream, format="PNG")
        saved = self.factory.store_scene_reference(
            scene["scene_id"],
            stream.getvalue(),
            "my reference.png",
        )
        reference = saved["reference"]
        self.assertEqual(reference["name"], "my reference.png")
        self.assertEqual((reference["width"], reference["height"]), (3, 2))
        self.assertTrue(self.factory._scene_reference_file(saved).is_file())
        public = self.factory._public_scene(saved)["reference"]
        self.assertNotIn("file", public)
        self.assertEqual(
            public["url"],
            f"/vnccs/3d-factory/scenes/{scene['scene_id']}/reference",
        )

    def test_scene_preview_is_a_revision_bound_3d_render(self):
        scene = self.factory.create_scene("Scene")
        stream = io.BytesIO()
        Image.new("RGB", (320, 180), (12, 24, 48)).save(stream, format="PNG")
        saved = self.factory.store_scene_preview(scene["scene_id"], stream.getvalue())
        preview = saved["preview"]
        self.assertEqual((preview["width"], preview["height"]), (320, 180))
        self.assertEqual(preview["revision"], saved["revision"])
        self.assertTrue(self.factory._scene_preview_file(saved).is_file())
        public = self.factory._public_scene(saved)["preview"]
        self.assertNotIn("file", public)
        self.assertEqual(
            public["url"],
            f"/vnccs/3d-factory/scenes/{scene['scene_id']}/preview",
        )

        changed = self.factory.update_scene(scene["scene_id"], {"name": "Changed"})
        with self.assertRaisesRegex(FileNotFoundError, "stale"):
            self.factory._scene_preview_file(changed)

    def test_scene_preview_rejects_placeholder_sized_images(self):
        scene = self.factory.create_scene("Scene")
        stream = io.BytesIO()
        Image.new("RGB", (1, 1), (0, 0, 0)).save(stream, format="PNG")
        with self.assertRaisesRegex(ValueError, "only 1x1"):
            self.factory.store_scene_preview(scene["scene_id"], stream.getvalue())

    def test_weights_are_discovered_in_standard_comfy_model_directories(self):
        model_root = self.factory._model_root()
        for relative in self.factory._WEIGHT_FILES:
            path = model_root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"weight")

        status = self.factory._weights_status()
        self.assertTrue(status["ready"])
        self.assertEqual(Path(status["root"]), model_root)
        self.assertTrue(all(Path(item["resolved_path"]).is_file() for item in status["files"]))
        self.assertFalse(any("TripoSplat" in item["resolved_path"] for item in status["files"]))

    def test_weights_are_discovered_through_extra_model_paths_and_legacy_root(self):
        model_root = self.factory._model_root()
        extra_root = self.root / "extra_vae"
        self.factory._category_roots = lambda category: [extra_root] if category == "vae" else []

        expected = {}
        for relative in self.factory._WEIGHT_FILES:
            relative_path = Path(relative)
            if relative == "vae/flux2-vae.safetensors":
                path = extra_root / relative_path.name
            else:
                path = model_root / "TripoSplat" / relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"weight")
            expected[relative] = path.resolve()

        paths = self.factory._weight_paths()
        self.assertEqual(paths, expected)
        self.assertTrue(self.factory._weights_status()["ready"])

    def test_all_factory_api_routes_are_registered_on_the_comfy_route_table(self):
        class RouteTableStub:
            def __init__(self):
                self.definitions = []

            def _register(self, method, path):
                def decorator(handler):
                    self.definitions.append((method, path, handler))
                    return handler

                return decorator

            def get(self, path):
                return self._register("GET", path)

            def post(self, path):
                return self._register("POST", path)

            def patch(self, path):
                return self._register("PATCH", path)

            def delete(self, path):
                return self._register("DELETE", path)

        aiohttp_stub = types.ModuleType("aiohttp")
        aiohttp_stub.web = types.SimpleNamespace()
        routes = RouteTableStub()
        self.factory._REGISTERED = False
        try:
            with mock.patch.dict(sys.modules, {"aiohttp": aiohttp_stub}):
                self.factory.register_routes(routes)
        finally:
            self.factory._REGISTERED = False
        registered = {(method, path) for method, path, _handler in routes.definitions}
        expected = {
            ("GET", "/vnccs/3d-factory/capabilities"),
            ("POST", "/vnccs/3d-factory/weights/download"),
            ("GET", "/vnccs/3d-factory/scenes"),
            ("POST", "/vnccs/3d-factory/scenes"),
            ("GET", "/vnccs/3d-factory/scenes/{scene_id}"),
            ("PATCH", "/vnccs/3d-factory/scenes/{scene_id}"),
            ("POST", "/vnccs/3d-factory/scenes/{scene_id}/reference"),
            ("GET", "/vnccs/3d-factory/scenes/{scene_id}/reference"),
            ("POST", "/vnccs/3d-factory/scenes/{scene_id}/preview"),
            ("GET", "/vnccs/3d-factory/scenes/{scene_id}/preview"),
            ("POST", "/vnccs/3d-factory/scenes/{scene_id}/generate"),
            ("GET", "/vnccs/3d-factory/jobs/{job_id}"),
            ("POST", "/vnccs/3d-factory/jobs/{job_id}/cancel"),
            ("GET", "/vnccs/3d-factory/jobs/{job_id}/log"),
            ("PATCH", "/vnccs/3d-factory/scenes/{scene_id}/objects/{object_id}"),
            ("POST", "/vnccs/3d-factory/scenes/{scene_id}/objects/{object_id}/duplicate"),
            ("DELETE", "/vnccs/3d-factory/scenes/{scene_id}/objects/{object_id}"),
            ("GET", "/vnccs/3d-factory/scenes/{scene_id}/objects/{object_id}/asset/{kind}"),
            ("GET", "/vnccs/3d-factory/scenes/{scene_id}/objects/{object_id}/export/{format_name}"),
            ("POST", "/vnccs/3d-factory/scenes/{scene_id}/export"),
            ("GET", "/vnccs/3d-factory/scenes/{scene_id}/exports/{format_name}"),
        }
        self.assertTrue(expected.issubset(registered), expected.difference(registered))


if __name__ == "__main__":
    unittest.main()
