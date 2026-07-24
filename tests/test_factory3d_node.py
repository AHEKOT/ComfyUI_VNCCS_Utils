import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load_node_module():
    torch_stub = types.ModuleType("torch")
    torch_stub.Tensor = object
    torch_stub.float32 = "float32"
    torch_stub.zeros = lambda *args, **kwargs: ("zeros", args, kwargs)
    torch_stub.from_numpy = lambda value: value
    spec = importlib.util.spec_from_file_location(
        "vnccs_factory_node_test.nodes.factory3d",
        ROOT / "nodes" / "factory3d.py",
    )
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict(sys.modules, {"torch": torch_stub}):
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
    return module


class FactoryNodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_node_module()

    def test_node_contract_exposes_scene_assets_and_persistent_state(self):
        node = self.module.VNCCS_3DFactory
        self.assertEqual(
            node.RETURN_NAMES,
            ("preview", "scene_ply", "scene_splat", "scene_manifest"),
        )
        self.assertIn("factory_data", node.INPUT_TYPES()["required"])
        self.assertEqual(node.CATEGORY, "VNCCS/3D")

    def test_state_validation_accepts_opaque_ids_and_rejects_paths(self):
        valid = json.dumps(
            {
                "schema_version": 4,
                "scene_id": "a" * 32,
                "selected_object_id": "b" * 32,
                "selected_object_ids": ["b" * 32, "c" * 32],
                "selected_group_id": "d" * 32,
                "collapsed_group_ids": ["d" * 32],
                "scene_snapshot": {
                    "name": "Scene",
                    "render": {
                        "width": 1920,
                        "height": 1080,
                        "aspect": "16:9",
                        "show_camera_frame": True,
                    },
                    "camera": {
                        "position": [2.0, 3.0, 4.0],
                        "target": [0.0, 0.0, 0.0],
                        "fov": 42.0,
                    },
                    "objects": [
                        {"object_id": "b" * 32, "transform": {}, "visible": True},
                        {"object_id": "c" * 32, "transform": {}, "visible": False},
                    ],
                    "layers": [{
                        "type": "group",
                        "group_id": "d" * 32,
                        "name": "Group",
                        "visible": True,
                        "children": ["b" * 32, "c" * 32],
                    }],
                },
                "source": {
                    "scene_id": "a" * 32,
                    "url": f"/vnccs/3d-factory/scenes/{'a' * 32}/reference",
                },
            }
        )
        self.assertTrue(self.module.VNCCS_3DFactory.VALIDATE_INPUTS(valid))
        invalid = json.dumps({"scene_id": "../../outside"})
        self.assertIsInstance(
            self.module.VNCCS_3DFactory.VALIDATE_INPUTS(invalid),
            str,
        )
        invalid_snapshot = json.dumps(
            {"scene_id": "a" * 32, "scene_snapshot": {"objects": [{"object_id": "../bad"}]}}
        )
        self.assertIsInstance(
            self.module.VNCCS_3DFactory.VALIDATE_INPUTS(invalid_snapshot),
            str,
        )
        duplicate_hierarchy = json.dumps(
            {
                "scene_id": "a" * 32,
                "scene_snapshot": {
                    "objects": [
                        {"object_id": "b" * 32},
                        {"object_id": "c" * 32},
                    ],
                    "layers": [
                        {"type": "object", "object_id": "b" * 32},
                        {
                            "type": "group",
                            "group_id": "d" * 32,
                            "children": ["b" * 32, "c" * 32],
                        },
                    ],
                },
            }
        )
        self.assertIsInstance(
            self.module.VNCCS_3DFactory.VALIDATE_INPUTS(duplicate_hierarchy),
            str,
        )
        invalid_source = json.dumps(
            {
                "scene_id": "a" * 32,
                "source": {
                    "scene_id": "a" * 32,
                    "url": "https://example.com/reference.png",
                },
            }
        )
        self.assertIsInstance(
            self.module.VNCCS_3DFactory.VALIDATE_INPUTS(invalid_source),
            str,
        )
        invalid_render = json.dumps(
            {
                "scene_id": "a" * 32,
                "scene_snapshot": {
                    "objects": [],
                    "layers": [],
                    "render": {
                        "width": 8192,
                        "height": 1080,
                        "aspect": "16:9",
                        "show_camera_frame": True,
                    },
                },
            }
        )
        self.assertIsInstance(
            self.module.VNCCS_3DFactory.VALIDATE_INPUTS(invalid_render),
            str,
        )
        invalid_camera = json.dumps(
            {
                "scene_id": "a" * 32,
                "scene_snapshot": {
                    "objects": [],
                    "layers": [],
                    "camera": {
                        "position": [0, 0, 1],
                        "target": [0, 0, 0],
                        "fov": 200,
                    },
                },
            }
        )
        self.assertIsInstance(
            self.module.VNCCS_3DFactory.VALIDATE_INPUTS(invalid_camera),
            str,
        )

    def test_preview_output_uses_saved_3d_scene_render_not_object_reference(self):
        scene_id = "a" * 32
        preview_path = ROOT / "preview" / "scene.png"
        backend = types.SimpleNamespace(
            load_scene=lambda _scene_id: {
                "scene_id": scene_id,
                "objects": [{
                    "object_id": "b" * 32,
                    "files": {
                        "prepared": "objects/b/prepared.png",
                        "reference": "objects/b/reference.png",
                    },
                }],
            },
            _scene_preview_file=lambda _scene: preview_path,
            ensure_scene_exports=lambda _scene_id: None,
            resolve_scene_dir=lambda _scene_id: ROOT,
        )
        state = json.dumps({"schema_version": 2, "scene_id": scene_id})
        with (
            mock.patch.object(self.module, "_backend", return_value=backend),
            mock.patch.object(self.module, "_preview_tensor", return_value="3d-scene-render") as render,
        ):
            result = self.module.VNCCS_3DFactory().load_scene(state)
        render.assert_called_once_with(preview_path)
        self.assertEqual(result[0], "3d-scene-render")

    def test_nonempty_scene_without_current_preview_fails_instead_of_returning_black_square(self):
        scene_id = "a" * 32
        scene = {
            "scene_id": scene_id,
            "objects": [{"object_id": "b" * 32}],
        }
        backend = types.SimpleNamespace(
            load_scene=lambda _scene_id: scene,
            update_scene=lambda _scene_id, _snapshot: scene,
            _scene_preview_file=mock.Mock(side_effect=FileNotFoundError("stale")),
            ensure_scene_exports=mock.Mock(),
            resolve_scene_dir=lambda _scene_id: ROOT,
        )
        state = json.dumps({"schema_version": 2, "scene_id": scene_id})
        with (
            mock.patch.object(self.module, "_backend", return_value=backend),
            mock.patch.object(self.module.time, "sleep"),
            mock.patch.object(
                self.module.time,
                "monotonic",
                side_effect=[0.0, 31.0],
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "no current 3D scene preview"):
                self.module.VNCCS_3DFactory().load_scene(state)
        backend.ensure_scene_exports.assert_not_called()


if __name__ == "__main__":
    unittest.main()
