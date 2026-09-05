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

    def test_node_contract_exposes_current_and_saved_camera_renders_as_a_list(self):
        node = self.module.VNCCS_3DFactory
        self.assertEqual(node.RETURN_TYPES, ("IMAGE",))
        self.assertEqual(node.RETURN_NAMES, ("preview",))
        self.assertEqual(node.OUTPUT_IS_LIST, (True,))
        self.assertIn("factory_data", node.INPUT_TYPES()["required"])
        self.assertEqual(node.CATEGORY, "VNCCS/3D")

    def test_capture_eligibility_matches_shared_frontend_cases(self):
        cases = json.loads((ROOT / "tests/fixtures/factory3d/renderable_scenes.json").read_text())
        for case in cases:
            with self.subTest(case=case["name"]):
                self.assertEqual(self.module._has_renderable_scene(case["scene"]), case["renderable"])

    def test_architecture_only_execution_requests_a_fresh_capture(self):
        scene_id = "a" * 32
        for kind in ("walls", "rooms"):
            with self.subTest(kind=kind):
                scene = {
                    "scene_id": scene_id,
                    "objects": [],
                    "cameras": [],
                    "architecture": {kind: [{"name": "Architecture"}]},
                }
                backend = types.SimpleNamespace(load_scene=lambda _id: scene)
                with (
                    mock.patch.object(self.module, "_backend", return_value=backend),
                    mock.patch.object(self.module, "_request_scene_preview", return_value=True) as request,
                    mock.patch.object(self.module, "_wait_for_scene_capture_set", return_value=["room.png"]) as wait,
                    mock.patch.object(self.module, "_preview_tensor", return_value="architecture-render") as tensor,
                    mock.patch.object(self.module, "_empty_image") as empty,
                ):
                    result = self.module.VNCCS_3DFactory().load_scene(
                        json.dumps({"scene_id": scene_id}), unique_id="17",
                    )
                self.assertEqual(result, (["architecture-render"],))
                request.assert_called_once()
                self.assertEqual(request.call_args.args[:2], ("17", scene))
                token = request.call_args.args[2]
                self.assertEqual(len(token), 32)
                wait.assert_called_once_with(backend, scene_id, capture_token=token)
                tensor.assert_called_once_with("room.png")
                empty.assert_not_called()

    def test_state_validation_rejects_future_editor_without_rewriting(self):
        for version in (99, -1, 18.5, True, "18"):
            with self.subTest(version=version):
                with self.assertRaisesRegex(ValueError, "Unsupported"):
                    self.module._parse_state(json.dumps({"schema_version": version}))

    def test_state_validation_accepts_opaque_ids_and_rejects_paths(self):
        valid = json.dumps(
            {
                "schema_version": 17,
                "scene_id": "a" * 32,
                "selected_object_id": "b" * 32,
                "selected_object_ids": ["b" * 32, "c" * 32],
                "selected_group_id": "d" * 32,
                "collapsed_group_ids": ["d" * 32],
                "scene_snapshot": {
                    "name": "Scene",
                    "levels": [{
                        "level_id": "f" * 32,
                        "name": "Level 1",
                        "elevation": 0.0,
                        "height": 2.8,
                        "slab_thickness": 0.15,
                        "visible": True,
                    }],
                    "render": {
                        "width": 1920,
                        "height": 1080,
                        "aspect": "16:9",
                        "show_camera_frame": True,
                    },
                    "camera": {
                        "position": [2.0, 3.0, 4.0],
                        "target": [0.0, 0.0, 0.0],
                        "up": [0.0, 1.0, 0.0],
                        "fov": 42.0,
                    },
                    "cameras": [{
                        "camera_id": "e" * 32,
                        "name": "Camera 1",
                        "position": [1.0, 2.0, 3.0],
                        "target": [0.0, 0.0, 0.0],
                        "up": [0.0, 1.0, 0.0],
                        "fov": 48.0,
                        "level_id": "f" * 32,
                        "building_id": "",
                    }],
                    "objects": [
                        {
                            "object_id": "b" * 32,
                            "transform": {},
                            "visible": True,
                            "level_id": "f" * 32,
                            "building_id": "",
                        },
                        {
                            "object_id": "c" * 32,
                            "transform": {},
                            "visible": False,
                            "level_id": "f" * 32,
                            "building_id": "",
                        },
                    ],
                    "layers": [{
                        "type": "group",
                        "group_id": "d" * 32,
                        "name": "Group",
                        "visible": True,
                        "children": ["b" * 32, "c" * 32],
                    }],
                    "architecture": {
                        "materials": [],
                        "buildings": [],
                        "walls": [],
                        "rooms": [],
                        "openings": [],
                    },
                    "camera_tracks": [],
                    "lighting": {
                        "shadows": {
                            "enabled": True,
                            "quality": "medium",
                            "bias": -0.0002,
                            "normal_bias": 0.0015,
                        },
                        "lights": [{
                            "light_id": "1" * 32,
                            "name": "Practical",
                            "level_id": "f" * 32,
                            "building_id": "",
                            "kind": "point",
                            "position": [1.0, 2.4, 3.0],
                            "target": [1.0, 0.0, 3.0],
                            "color": "#ff0088",
                            "intensity": 10.0,
                            "distance": 8.0,
                            "angle": 45.0,
                            "penumbra": 0.2,
                            "cast_shadow": True,
                            "visible": True,
                        }],
                    },
                },
                "viewer_state": {
                    "view_mode": "plan",
                    "zoom_sensitivity": 0.1,
                    "plan_camera": {"target": [0.0, 0.0], "zoom": 24.0},
                },
                "editor_view": {
                    "view_mode": "plan",
                    "plan_tool": "room",
                    "active_level_id": "f" * 32,
                    "active_building_id": "",
                    "interior_cutaway": {"plan": True, "three_d": False},
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

    def test_state_validation_keeps_buildings_optional_and_validates_local_light_references(self):
        level_id = "f" * 32
        light_id = "1" * 32
        point_light = {
            "light_id": light_id,
            "name": "Practical",
            "level_id": level_id,
            "building_id": "",
            "kind": "point",
            "position": [1.0, 2.4, 3.0],
            "target": [1.0, 0.0, 3.0],
            "intensity": 10.0,
            "distance": 8.0,
            "angle": 45.0,
            "penumbra": 0.2,
        }
        empty_building_scene = {
            "schema_version": 17,
            "scene_id": "a" * 32,
            "scene_snapshot": {
                "objects": [],
                "layers": [],
                "levels": [{
                    "level_id": level_id,
                    "elevation": 0.0,
                    "height": 2.8,
                    "slab_thickness": 0.15,
                }],
                "architecture": {
                    "materials": [],
                    "buildings": [],
                    "walls": [],
                    "rooms": [],
                    "openings": [],
                },
                "lighting": {
                    "shadows": {"enabled": True, "quality": "medium"},
                    "lights": [point_light],
                },
            },
        }
        self.assertTrue(
            self.module.VNCCS_3DFactory.VALIDATE_INPUTS(
                json.dumps(empty_building_scene)
            )
        )

        standalone_room = json.loads(json.dumps(empty_building_scene))
        polygon = [[0.0, 0.0], [4.0, 0.0], [4.0, 3.0], [0.0, 3.0]]
        wall_ids = [character * 32 for character in "2345"]
        standalone_room["scene_snapshot"]["architecture"]["walls"] = [
            {
                "wall_id": wall_ids[index],
                "level_id": level_id,
                "building_id": "",
                "start": polygon[index],
                "end": polygon[(index + 1) % len(polygon)],
                "thickness": 0.12,
                "height": 2.8,
                "elevation_offset": 0.0,
            }
            for index in range(len(polygon))
        ]
        standalone_room["scene_snapshot"]["architecture"]["rooms"] = [{
            "room_id": "6" * 32,
            "level_id": level_id,
            "building_id": "",
            "polygon": polygon,
            "wall_ids": wall_ids,
        }]
        self.assertTrue(
            self.module.VNCCS_3DFactory.VALIDATE_INPUTS(
                json.dumps(standalone_room)
            )
        )

        duplicate_light = json.loads(json.dumps(empty_building_scene))
        duplicate_light["scene_snapshot"]["lighting"]["lights"].append(point_light)
        self.assertIsInstance(
            self.module.VNCCS_3DFactory.VALIDATE_INPUTS(json.dumps(duplicate_light)),
            str,
        )

        unknown_level = json.loads(json.dumps(empty_building_scene))
        unknown_level["scene_snapshot"]["lighting"]["lights"][0]["level_id"] = "e" * 32
        self.assertIsInstance(
            self.module.VNCCS_3DFactory.VALIDATE_INPUTS(json.dumps(unknown_level)),
            str,
        )

        unknown_building = json.loads(json.dumps(empty_building_scene))
        unknown_building["scene_snapshot"]["lighting"]["lights"][0]["building_id"] = "d" * 32
        self.assertIsInstance(
            self.module.VNCCS_3DFactory.VALIDATE_INPUTS(json.dumps(unknown_building)),
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
            _scene_capture_files=mock.Mock(side_effect=FileNotFoundError("no set")),
            resolve_scene_dir=lambda _scene_id: ROOT,
        )
        state = json.dumps({"schema_version": 2, "scene_id": scene_id})
        with (
            mock.patch.object(self.module, "_backend", return_value=backend),
            mock.patch.object(self.module, "_preview_tensor", return_value="3d-scene-render") as render,
        ):
            result = self.module.VNCCS_3DFactory().load_scene(state)
        render.assert_called_once_with(preview_path)
        self.assertEqual(result[0], ["3d-scene-render"])

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
            _scene_capture_files=mock.Mock(side_effect=FileNotFoundError("stale")),
            resolve_scene_dir=lambda _scene_id: ROOT,
        )
        state = json.dumps({"schema_version": 2, "scene_id": scene_id})
        with (
            mock.patch.object(self.module, "_backend", return_value=backend),
            mock.patch.object(self.module.time, "sleep"),
            mock.patch.object(
                self.module.time,
                "monotonic",
                side_effect=[0.0, 61.0],
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "current 3D scene preview"):
                self.module.VNCCS_3DFactory().load_scene(state)

    def test_execution_requests_a_token_bound_preview_from_the_live_widget(self):
        scene_id = "a" * 32
        capture_token = "c" * 32
        preview_path = ROOT / "preview" / "scene.png"
        camera_path = ROOT / "preview" / "camera.png"
        camera_id = "d" * 32
        scene = {
            "scene_id": scene_id,
            "revision": 4,
            "render_revision": 7,
            "objects": [{"object_id": "b" * 32}],
            "cameras": [{
                "camera_id": camera_id,
                "name": "Camera 1",
                "position": [1, 2, 3],
                "target": [0, 0, 0],
                "up": [0, 1, 0],
                "fov": 42,
            }],
            "capture_set": {},
        }
        events = []

        def send_sync(name, payload):
            events.append((name, payload))
            scene["capture_set"]["capture_token"] = payload["capture_token"]

        def capture_files(value, expected_capture_token=""):
            if (
                expected_capture_token
                and value["capture_set"].get("capture_token") != expected_capture_token
            ):
                raise FileNotFoundError("capture pending")
            return [preview_path, camera_path]

        backend = types.SimpleNamespace(
            load_scene=lambda _scene_id: scene,
            _scene_capture_files=capture_files,
            resolve_scene_dir=lambda _scene_id: ROOT,
        )
        server = types.ModuleType("server")
        server.PromptServer = types.SimpleNamespace(
            instance=types.SimpleNamespace(send_sync=send_sync),
        )
        state = json.dumps({"schema_version": 4, "scene_id": scene_id})
        token_value = types.SimpleNamespace(hex=capture_token)
        with (
            mock.patch.dict(sys.modules, {"server": server}),
            mock.patch.object(self.module.uuid, "uuid4", return_value=token_value),
            mock.patch.object(self.module, "_backend", return_value=backend),
            mock.patch.object(
                self.module,
                "_preview_tensor",
                side_effect=lambda path: (
                    "fresh-current" if path == preview_path else "fresh-camera"
                ),
            ),
        ):
            result = self.module.VNCCS_3DFactory().load_scene(state, unique_id="17")

        self.assertEqual(result[0], ["fresh-current", "fresh-camera"])
        self.assertEqual(events[0][0], "vnccs_req_3d_factory_preview")
        self.assertEqual(events[0][1]["node_id"], "17")
        self.assertEqual(events[0][1]["capture_token"], capture_token)


if __name__ == "__main__":
    unittest.main()
