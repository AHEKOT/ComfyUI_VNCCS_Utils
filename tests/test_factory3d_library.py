import importlib.util
import io
import sys
import tempfile
import types
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]


def load_modules():
    package = types.ModuleType("vnccs_library_test")
    package.__path__ = [str(ROOT)]
    api_package = types.ModuleType("vnccs_library_test.api")
    api_package.__path__ = [str(ROOT / "api")]
    sys.modules[package.__name__] = package
    sys.modules[api_package.__name__] = api_package
    modules = {}
    for name in (
        "gaussian_scene",
        "gaussian_mesh",
        "factory3d",
        "factory3d_library",
    ):
        spec = importlib.util.spec_from_file_location(
            f"vnccs_library_test.api.{name}",
            ROOT / "api" / f"{name}.py",
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        modules[name] = module
    return modules["factory3d"], modules["factory3d_library"]


def preview_data_url():
    image = Image.new("RGBA", (96, 96), (20, 30, 40, 255))
    payload = io.BytesIO()
    image.save(payload, "PNG")
    import base64

    return "data:image/png;base64," + base64.b64encode(payload.getvalue()).decode()


class FactoryLibraryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.factory, cls.library = load_modules()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.original_factory_root = self.factory._factory_root
        self.original_model_root = self.factory._model_root
        self.original_library_root = self.library._root
        self.factory._factory_root = lambda: self.root / "output"
        self.factory._model_root = lambda: self.root / "models"
        self.library._root = lambda: (self.root / "ModelLibrary").resolve()

    def tearDown(self):
        self.factory._factory_root = self.original_factory_root
        self.factory._model_root = self.original_model_root
        self.library._root = self.original_library_root
        self.temporary.cleanup()

    def make_scene(self):
        scene = self.factory.create_scene("Library scene")
        object_id = self.factory._new_id()
        root = self.factory.resolve_scene_dir(scene["scene_id"])
        object_root = root / "objects" / object_id
        object_root.mkdir(parents=True)
        Image.new("RGBA", (64, 64), (200, 80, 40, 255)).save(
            object_root / "prepared.png"
        )
        (object_root / "model.ply").write_bytes(b"synthetic-ply")
        (object_root / "model.splat").write_bytes(b"\0" * 32)
        scene["objects"].append(
            {
                "object_id": object_id,
                "name": "Library object",
                "created_at": 1,
                "gaussians": 1,
                "seed": 7,
                "transform": self.factory.normalize_transform({}),
                "files": {
                    "prepared": f"objects/{object_id}/prepared.png",
                    "ply": f"objects/{object_id}/model.ply",
                    "splat": f"objects/{object_id}/model.splat",
                },
            }
        )
        scene["layers"] = [{"type": "object", "object_id": object_id}]
        self.factory._save_scene(scene)
        return self.factory.load_scene(scene["scene_id"]), object_id

    def test_object_package_round_trip_is_native_and_incremental(self):
        scene, object_id = self.make_scene()
        record = self.library.save_asset(
            {
                "scene_id": scene["scene_id"],
                "object_id": object_id,
                "asset_type": "object",
                "name": "Saved prop",
                "category": "Props",
                "tags": ["metal"],
                "preview": preview_data_url(),
            }
        )
        self.assertEqual(record["asset_type"], "object")
        self.assertEqual(record["gaussians"], 1)
        self.assertTrue(record["has_preview"])
        self.assertEqual(len(self.library._read_records()), 1)

        result = self.library.load_asset(
            record["asset_id"],
            repository=record["repository"],
            category=record["category"],
            scene_id=scene["scene_id"],
        )
        self.assertFalse(result["created_scene"])
        restored = self.factory.load_scene(scene["scene_id"])
        self.assertEqual(len(restored["objects"]), 2)
        imported = self.factory._object_by_id(restored, result["object_id"])
        self.assertEqual(
            self.factory._object_file(restored["scene_id"], imported, "ply").read_bytes(),
            b"synthetic-ply",
        )

        updated = self.library.update_asset(
            record["asset_id"],
            {
                "repository": record["repository"],
                "old_category": record["category"],
                "name": "Renamed prop",
                "category": "Architecture",
                "description": "Edited through the Pose-style inspector.",
                "tags": ["building"],
            },
        )
        self.assertEqual(updated["name"], "Renamed prop")
        self.assertEqual(updated["category"], "Architecture")
        self.assertFalse(
            self.library._paths(
                record["repository"],
                record["category"],
                record["asset_id"],
            )["meta"].exists()
        )

    def test_scene_package_preserves_camera_render_lighting_and_layers(self):
        scene, object_id = self.make_scene()
        scene["camera"] = {"position": [8, 7, 6], "target": [1, 2, 3], "fov": 55}
        scene["render"] = {
            "width": 1600,
            "height": 900,
            "aspect": "16:9",
            "show_camera_frame": True,
        }
        scene["lighting"] = {
            "preset": "sunset",
            "intensity": 0.8,
            "color": "#ff865f",
            "azimuth": 58,
            "elevation": 11,
            "ambient": 0.28,
            "background": "#25141b",
        }
        scene["layers"] = [
            {
                "type": "group",
                "group_id": self.factory._new_id(),
                "name": "Architecture",
                "visible": True,
                "children": [object_id],
            }
        ]
        self.factory._save_scene(scene)
        record = self.library.save_asset(
            {
                "scene_id": scene["scene_id"],
                "asset_type": "scene",
                "name": "Complete set",
                "preview": preview_data_url(),
            }
        )
        result = self.library.load_asset(
            record["asset_id"],
            repository=record["repository"],
            category=record["category"],
        )
        self.assertTrue(result["created_scene"])
        restored = self.factory.load_scene(result["scene"]["scene_id"])
        self.assertEqual(restored["camera"]["position"], [8.0, 7.0, 6.0])
        self.assertEqual(restored["render"]["width"], 1600)
        self.assertEqual(restored["lighting"]["preset"], "sunset")
        self.assertEqual(restored["layers"][0]["type"], "group")
        self.assertEqual(len(restored["layers"][0]["children"]), 1)

    def test_pose_or_foreign_records_can_never_enter_factory_library(self):
        foreign_id = "a" * 24
        root = self.library._root()
        category = root / self.library.LOCAL_REPOSITORY / "Uncategorized"
        category.mkdir(parents=True)
        (category / f"{foreign_id}.json").write_text(
            """{
              "schema": "vnccs-pose-library/v1",
              "asset_id": "aaaaaaaaaaaaaaaaaaaaaaaa",
              "asset_type": "pose",
              "name": "Fighting A",
              "repository": "local_user_models",
              "category": "Uncategorized"
            }""",
            encoding="utf-8",
        )
        (category / f"{foreign_id}.vnccs3d").write_bytes(b"not-a-gaussian-package")

        self.assertEqual(self.library._read_records(), [])
        with self.assertRaises(FileNotFoundError):
            self.library._find_record(foreign_id)

    def test_routes_register_on_factory_comfyui_route_table(self):
        class RouteTable:
            def __init__(self):
                self.definitions = []

            def _add(self, method, path):
                def decorator(handler):
                    self.definitions.append((method, path, handler))
                    return handler

                return decorator

            def get(self, path):
                return self._add("GET", path)

            def post(self, path):
                return self._add("POST", path)

            def put(self, path):
                return self._add("PUT", path)

            def delete(self, path):
                return self._add("DELETE", path)

        routes = RouteTable()
        original_aiohttp = sys.modules.get("aiohttp")
        sys.modules["aiohttp"] = types.SimpleNamespace(web=types.SimpleNamespace())
        try:
            self.library.register_routes(routes)
        finally:
            if original_aiohttp is None:
                sys.modules.pop("aiohttp", None)
            else:
                sys.modules["aiohttp"] = original_aiohttp
        paths = {(method, path) for method, path, _handler in routes.definitions}
        self.assertIn(("GET", "/vnccs/3d-factory/library/items"), paths)
        self.assertIn(("POST", "/vnccs/3d-factory/library/items"), paths)
        self.assertIn(
            ("PUT", "/vnccs/3d-factory/library/items/{asset_id}"),
            paths,
        )
        self.assertIn(
            ("GET", "/vnccs/3d-factory/library/repositories"),
            paths,
        )


if __name__ == "__main__":
    unittest.main()
