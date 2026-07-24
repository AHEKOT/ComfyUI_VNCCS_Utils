import ast
import importlib.util
import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
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
        self.assertEqual(scene["schema_version"], 4)
        self.assertEqual(scene["render_revision"], 0)
        self.assertEqual(
            scene["render"],
            {
                "width": 1024,
                "height": 1024,
                "aspect": "1:1",
                "show_camera_frame": False,
            },
        )
        self.assertEqual(scene["camera"]["fov"], 42.0)
        self.assertEqual(scene["lighting"]["preset"], "day")
        self.assertEqual(scene["lighting"]["color"], "#fff1d6")
        self.assertEqual(self.factory.list_scenes()[0]["name"], "First scene")

        updated = self.factory.update_scene(scene["scene_id"], {"name": "Renamed"})
        self.assertEqual(updated["name"], "Renamed")
        self.assertEqual(updated["revision"], 0)
        self.assertEqual(self.factory.load_scene(scene["scene_id"])["name"], "Renamed")
        unchanged = self.factory.update_scene(scene["scene_id"], {"name": "Renamed", "objects": []})
        self.assertEqual(unchanged["revision"], 0)

    def test_scene_lighting_is_normalized_persisted_and_invalidates_preview_only(self):
        scene = self.factory.create_scene("Lighting")
        updated = self.factory.update_scene(
            scene["scene_id"],
            {
                "lighting": {
                    "preset": "sunset",
                    "intensity": 1.25,
                    "color": "#FF865F",
                    "azimuth": 418,
                    "elevation": 11,
                    "ambient": 0.28,
                    "background": "#25141B",
                }
            },
        )
        self.assertEqual(updated["revision"], 0)
        self.assertEqual(updated["render_revision"], 1)
        self.assertEqual(
            updated["lighting"],
            {
                "preset": "sunset",
                "intensity": 1.25,
                "color": "#ff865f",
                "azimuth": 58.0,
                "elevation": 11.0,
                "ambient": 0.28,
                "background": "#25141b",
            },
        )
        restored = self.factory.load_scene(scene["scene_id"])
        self.assertEqual(restored["lighting"], updated["lighting"])
        off = self.factory.update_scene(
            scene["scene_id"],
            {
                "lighting": {
                    "preset": "off",
                    "intensity": 0,
                    "color": "#ffffff",
                    "azimuth": 325,
                    "elevation": 42,
                    "ambient": 1,
                    "background": "#171b25",
                }
            },
        )
        self.assertEqual(off["lighting"]["preset"], "off")
        self.assertEqual(off["lighting"]["background"], "#171b25")

    def test_experimental_density_modes_are_supported_through_api_and_triposplat(self):
        capabilities = self.factory.capabilities()
        self.assertEqual(capabilities["formats"], ["ply", "splat", "glb"])
        self.assertIn(524288, capabilities["gaussian_counts"])
        self.assertIn(1048576, capabilities["gaussian_counts"])
        self.assertEqual(capabilities["experimental_gaussian_counts"], [524288, 1048576])
        self.assertNotIn("erode_radius", capabilities["defaults"])
        self.assertTrue(capabilities["defaults"]["remove_background"])
        self.assertEqual(capabilities["scene_render"]["min_side"], 64)
        self.assertEqual(capabilities["scene_render"]["max_side"], 4096)
        self.assertIn("16:9", capabilities["scene_render"]["aspect_presets"])
        settings = self.factory._generation_settings({"num_gaussians": "524288"})
        self.assertEqual(settings["num_gaussians"], 524288)
        self.assertTrue(settings["remove_background"])
        self.assertNotIn("erode_radius", settings)
        extreme = self.factory._generation_settings({"num_gaussians": "1048576"})
        self.assertEqual(extreme["num_gaussians"], 1048576)
        clamped = self.factory._generation_settings({"num_gaussians": "9999999"})
        self.assertEqual(clamped["num_gaussians"], 1048576)
        source = (ROOT / "data" / "triposplat" / "triposplat.py").read_text(encoding="utf-8")
        self.assertIn("_NUM_GAUSSIANS_MAX = 1048576", source)

    def test_background_removal_defaults_on_and_can_be_disabled(self):
        self.assertTrue(self.factory._generation_settings({})["remove_background"])
        self.assertFalse(
            self.factory._generation_settings({"remove_background": "0"})["remove_background"]
        )
        self.assertFalse(
            self.factory._generation_settings({"remove_background": "false"})["remove_background"]
        )
        source = (ROOT / "data" / "triposplat" / "triposplat.py").read_text(encoding="utf-8")
        self.assertIn("remove_background: bool = True", source)
        self.assertIn('image = image.convert("RGBA")', source)
        self.assertNotIn('image = image.convert("RGB").convert("RGBA")', source)

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

        source = (ROOT / "data" / "triposplat" / "triposplat.py").read_text(encoding="utf-8")
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

    def test_triposplat_runtime_is_relocated_and_safety_fixes_are_executable(self):
        source_path = ROOT / "data" / "triposplat" / "triposplat.py"
        self.assertTrue(source_path.is_file())
        self.assertFalse((ROOT / "triposplat_backend" / "triposplat.py").exists())
        source = source_path.read_text(encoding="utf-8")
        self.assertNotIn("list(map(tuple", source)
        self.assertIn("generator=generator", source)
        self.assertIn("GaussianValidationError", source)
        model_source = (ROOT / "data" / "triposplat" / "model.py").read_text(encoding="utf-8")
        self.assertIn('register_buffer("pos_pe"', model_source)
        self.assertIn('"prepared_context"', model_source)

        tree = ast.parse(source)
        helpers = [
            item
            for item in tree.body
            if isinstance(item, ast.FunctionDef)
            and item.name in {"_safe_preprocess_scale", "_foreground_bbox"}
        ]
        namespace = {
            "np": np,
            "_MAX_PREPROCESS_PIXELS": 4096 * 4096,
            "_MAX_PREPROCESS_SIDE": 16384,
            "_ALPHA_BBOX_THRESHOLD": 8,
        }
        exec(compile(ast.Module(body=helpers, type_ignores=[]), "<triposplat-safety>", "exec"), namespace)

        alpha = np.zeros((8, 8), dtype=np.uint8)
        alpha[2, 3] = 255
        self.assertEqual(namespace["_foreground_bbox"](alpha), [3, 2, 4, 3])
        with self.assertRaisesRegex(ValueError, "empty foreground mask"):
            namespace["_foreground_bbox"](np.zeros((8, 8), dtype=np.uint8))

        scale = namespace["_safe_preprocess_scale"](1, 20_000_000, 2048)
        self.assertLessEqual(round(20_000_000 * scale), 16384)

    def test_quaternion_conversion_handles_half_turns_and_rejects_zero_norm(self):
        source = (ROOT / "data" / "triposplat" / "triposplat.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        helpers = [
            item
            for item in tree.body
            if isinstance(item, ast.FunctionDef)
            and item.name in {"_normalize_quaternions", "_quat_to_matrix", "_matrix_to_quat"}
        ]

        class TestGaussianValidationError(ValueError):
            pass

        namespace = {
            "np": np,
            "_QUATERNION_EPSILON": 1e-12,
            "GaussianValidationError": TestGaussianValidationError,
        }
        exec(compile(ast.Module(body=helpers, type_ignores=[]), "<quaternion-helpers>", "exec"), namespace)

        quaternions = np.asarray(
            [
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
                [0.0, 0.0, 0.0, 1.0],
            ],
            dtype=np.float32,
        )
        matrices = namespace["_quat_to_matrix"](quaternions)
        recovered = namespace["_matrix_to_quat"](matrices)
        alignment = np.abs(np.sum(quaternions * recovered, axis=1))
        np.testing.assert_allclose(alignment, np.ones(4), atol=1e-5)
        with self.assertRaisesRegex(TestGaussianValidationError, "invalid quaternion"):
            namespace["_quat_to_matrix"](np.zeros((1, 4), dtype=np.float32))

    def test_numeric_payload_validation_rejects_nan_and_degenerate_rotation(self):
        names = [
            "x", "y", "z",
            "f_dc_0", "f_dc_1", "f_dc_2",
            "opacity",
            "scale_0", "scale_1", "scale_2",
            "rot_0", "rot_1", "rot_2", "rot_3",
        ]
        dtype = np.dtype([(name, "<f4") for name in names])

        def write_ply(path: Path, record: np.ndarray) -> None:
            header = [
                "ply",
                "format binary_little_endian 1.0",
                "element vertex 1",
                *(f"property float {name}" for name in names),
                "end_header",
                "",
            ]
            path.write_bytes("\n".join(header).encode("ascii") + record.tobytes())

        valid = np.zeros(1, dtype=dtype)
        valid["scale_0"] = valid["scale_1"] = valid["scale_2"] = -2.0
        valid["rot_0"] = 1.0
        good_path = self.root / "good.ply"
        write_ply(good_path, valid)
        report = self.gaussian.validate_ply_payload(good_path)
        self.assertEqual(report["gaussians"], 1)

        invalid = valid.copy()
        invalid["x"] = np.nan
        bad_path = self.root / "nan.ply"
        write_ply(bad_path, invalid)
        with self.assertRaisesRegex(ValueError, "NaN/Inf"):
            self.gaussian.validate_ply_payload(bad_path)

        invalid = valid.copy()
        for index in range(4):
            invalid[f"rot_{index}"] = 0.0
        bad_rotation = self.root / "rotation.ply"
        write_ply(bad_rotation, invalid)
        with self.assertRaisesRegex(ValueError, "degenerate quaternion"):
            self.gaussian.validate_ply_payload(bad_rotation)

        invalid = valid.copy()
        invalid["scale_0"] = -1e30
        bad_scale = self.root / "scale.ply"
        write_ply(bad_scale, invalid)
        with self.assertRaisesRegex(ValueError, "invalid scale"):
            self.gaussian.validate_ply_payload(bad_scale)

    def test_compact_splat_validation_reads_float_payload(self):
        record = np.zeros((1, 32), dtype=np.uint8)
        record[:, 0:12] = np.asarray([[0.0, 0.0, 0.0]], dtype="<f4").view(np.uint8)
        record[:, 12:24] = np.asarray([[1.0, 1.0, 1.0]], dtype="<f4").view(np.uint8)
        path = self.root / "valid.splat"
        path.write_bytes(record.tobytes())
        self.assertEqual(self.gaussian.validate_splat_payload(path, 1)["gaussians"], 1)

        record[:, 12:24] = np.asarray([[np.nan, 1.0, 1.0]], dtype="<f4").view(np.uint8)
        path.write_bytes(record.tobytes())
        with self.assertRaisesRegex(ValueError, "NaN/Inf"):
            self.gaussian.validate_splat_payload(path, 1)

        record[:, 12:24] = np.asarray([[1.0, 1.0, 1.0]], dtype="<f4").view(np.uint8)
        record[:, 28:32] = 128
        path.write_bytes(record.tobytes())
        with self.assertRaisesRegex(ValueError, "degenerate rotation"):
            self.gaussian.validate_splat_payload(path, 1)

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
            "visible": True,
            "transform": self.gaussian.normalize_transform({"position": [1, 2, 3]}),
            "files": files,
        })
        group_id = self.factory._new_id()
        scene["layers"] = [{
            "type": "group",
            "group_id": group_id,
            "name": "Machines",
            "visible": True,
            "children": [object_id],
        }]
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
        group = result["scene"]["layers"][0]
        self.assertEqual(group["group_id"], group_id)
        self.assertEqual(group["children"], [object_id, result["object_id"]])

    def test_scene_layers_preserve_order_groups_visibility_and_render_revision(self):
        scene = self.factory.create_scene("Layered")
        object_ids = [self.factory._new_id() for _ in range(3)]
        for index, object_id in enumerate(object_ids):
            scene["objects"].append({
                "object_id": object_id,
                "name": f"Object {index + 1}",
                "visible": True,
                "transform": self.gaussian.normalize_transform({}),
                "files": {},
            })
        scene["layers"] = [
            {"type": "object", "object_id": object_ids[0]},
            {"type": "object", "object_id": object_ids[1]},
            {"type": "object", "object_id": object_ids[2]},
        ]
        self.factory._save_scene(scene, bump_revision=False)
        group_id = self.factory._new_id()
        layers = [
            {
                "type": "group",
                "group_id": group_id,
                "name": "Foreground",
                "visible": True,
                "children": [object_ids[1], object_ids[0]],
            },
            {"type": "object", "object_id": object_ids[2]},
        ]

        grouped = self.factory.update_scene(scene["scene_id"], {"layers": layers})
        self.assertEqual(grouped["revision"], 0)
        self.assertEqual(grouped["layers"], layers)
        self.assertEqual(self.factory._visible_object_ids(grouped), set(object_ids))

        hidden_group = json.loads(json.dumps(layers))
        hidden_group[0]["visible"] = False
        hidden = self.factory.update_scene(scene["scene_id"], {"layers": hidden_group})
        self.assertEqual(hidden["revision"], 1)
        self.assertEqual(self.factory._visible_object_ids(hidden), {object_ids[2]})
        self.assertEqual(hidden["exports"], {})

        object_hidden = self.factory.update_scene(
            scene["scene_id"],
            {
                "layers": layers,
                "objects": [{"object_id": object_ids[2], "visible": False}],
            },
        )
        self.assertEqual(object_hidden["revision"], 2)
        self.assertEqual(
            self.factory._visible_object_ids(object_hidden),
            {object_ids[0], object_ids[1]},
        )

        with self.assertRaisesRegex(ValueError, "duplicate object"):
            self.factory.update_scene(
                scene["scene_id"],
                {
                    "layers": [
                        {"type": "object", "object_id": object_ids[0]},
                        {
                            "type": "group",
                            "group_id": self.factory._new_id(),
                            "children": [object_ids[0]],
                        },
                    ]
                },
            )

    def test_hidden_objects_are_excluded_only_from_combined_scene_export(self):
        scene = self.factory.create_scene("Visibility")
        visible_id = self.factory._new_id()
        hidden_id = self.factory._new_id()
        for object_id, visible in ((visible_id, True), (hidden_id, False)):
            root = self.factory.resolve_scene_dir(scene["scene_id"]) / "objects" / object_id
            root.mkdir(parents=True)
            source = root / "model.ply"
            source.write_bytes(object_id.encode())
            scene["objects"].append({
                "object_id": object_id,
                "name": object_id,
                "visible": visible,
                "transform": self.gaussian.normalize_transform({}),
                "files": {
                    "ply": str(source.relative_to(
                        self.factory.resolve_scene_dir(scene["scene_id"])
                    ))
                },
            })
        scene["layers"] = [
            {"type": "object", "object_id": visible_id},
            {"type": "object", "object_id": hidden_id},
        ]
        self.factory._save_scene(scene, bump_revision=False)

        combined = self.factory._scene_sources(self.factory.load_scene(scene["scene_id"]))
        self.assertEqual(len(combined), 1)
        self.assertIn(visible_id, str(combined[0][0]))
        individual = self.factory._scene_sources(
            self.factory.load_scene(scene["scene_id"]),
            hidden_id,
        )
        self.assertEqual(len(individual), 1)
        self.assertIn(hidden_id, str(individual[0][0]))

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

        captured_metadata = {}

        def fake_export(_sources, ply, splat, *, metadata=None):
            captured_metadata.update(metadata or {})
            Path(ply).parent.mkdir(parents=True, exist_ok=True)
            Path(ply).write_bytes(b"upright")
            Path(splat).write_bytes(b"upright")
            return {
                "ply": {"gaussians": 1, "objects": 1},
                "splat": {"gaussians": 1},
            }

        with mock.patch.object(self.factory, "export_gaussian_scene", side_effect=fake_export) as export:
            result = self.factory.ensure_scene_exports(scene["scene_id"])

        export.assert_called_once()
        self.assertIn(f"-v{self.factory.EXPORT_FORMAT_VERSION}-", result["ply"].name)
        self.assertTrue(result["camera"].is_file())
        camera_manifest = json.loads(result["camera"].read_text(encoding="utf-8"))
        self.assertEqual(camera_manifest["camera"]["position"], [2.8, 2.1, 4.2])
        self.assertEqual(camera_manifest["camera"]["target"], [0.0, 0.0, 0.0])
        self.assertEqual(camera_manifest["camera"]["fov"], 42.0)
        self.assertEqual(camera_manifest["render"]["width"], 1024)
        self.assertEqual(camera_manifest["assets"]["splat"]["sha256"], self.factory._sha256_file(result["splat"]))
        self.assertEqual(captured_metadata["camera"], camera_manifest["camera"])
        saved = self.factory.load_scene(scene["scene_id"])
        self.assertEqual(saved["exports"]["format_version"], self.factory.EXPORT_FORMAT_VERSION)
        self.assertEqual(saved["exports"]["render_revision"], saved["render_revision"])
        self.assertIn("camera", saved["exports"]["files"])

        updated = self.factory.update_scene(
            scene["scene_id"],
            {
                "camera": {
                    "position": [7, 6, 5],
                    "target": [1, 2, 3],
                    "fov": 61,
                },
                "render": {
                    "width": 1920,
                    "height": 1080,
                    "aspect": "16:9",
                    "show_camera_frame": True,
                },
            },
        )
        with mock.patch.object(
            self.factory,
            "export_gaussian_scene",
            side_effect=fake_export,
        ) as camera_export:
            refreshed = self.factory.ensure_scene_exports(scene["scene_id"])
        camera_export.assert_called_once()
        refreshed_manifest = json.loads(refreshed["camera"].read_text(encoding="utf-8"))
        self.assertEqual(refreshed_manifest["camera"]["position"], [7.0, 6.0, 5.0])
        self.assertEqual(refreshed_manifest["camera"]["target"], [1.0, 2.0, 3.0])
        self.assertEqual(refreshed_manifest["camera"]["fov"], 61.0)
        self.assertEqual(refreshed_manifest["render"]["width"], 1920)
        self.assertEqual(refreshed_manifest["render"]["height"], 1080)
        self.assertEqual(
            refreshed_manifest["render_revision"],
            updated["render_revision"],
        )

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
        scene = self.factory.update_scene(
            scene["scene_id"],
            {
                "render": {
                    "width": 320,
                    "height": 180,
                    "aspect": "16:9",
                    "show_camera_frame": True,
                },
            },
        )
        stream = io.BytesIO()
        Image.new("RGB", (320, 180), (12, 24, 48)).save(stream, format="PNG")
        capture_token = "c" * 32
        saved = self.factory.store_scene_preview(
            scene["scene_id"],
            stream.getvalue(),
            capture_token=capture_token,
        )
        preview = saved["preview"]
        self.assertEqual((preview["width"], preview["height"]), (320, 180))
        self.assertEqual(preview["revision"], saved["revision"])
        self.assertEqual(preview["render_revision"], saved["render_revision"])
        self.assertTrue(self.factory._scene_preview_file(saved).is_file())
        self.assertTrue(
            self.factory._scene_preview_file(saved, capture_token).is_file()
        )
        with self.assertRaisesRegex(FileNotFoundError, "execution capture"):
            self.factory._scene_preview_file(saved, "d" * 32)
        failed = self.factory.store_scene_preview_error(
            scene["scene_id"],
            "d" * 32,
            "GPU context was lost",
        )
        self.assertEqual(failed["preview_sync"]["status"], "failed")
        self.assertEqual(failed["preview_sync"]["error"], "GPU context was lost")
        public = self.factory._public_scene(saved)["preview"]
        self.assertNotIn("file", public)
        self.assertEqual(
            public["url"],
            f"/vnccs/3d-factory/scenes/{scene['scene_id']}/preview",
        )

        renamed = self.factory.update_scene(scene["scene_id"], {"name": "Changed"})
        self.assertEqual(
            self.factory._scene_preview_file(renamed),
            self.factory._scene_preview_file(saved),
        )
        changed = self.factory.update_scene(
            scene["scene_id"],
            {
                "objects": [],
                "layers": [],
            },
        )
        self.assertEqual(changed["revision"], saved["revision"])
        scene_with_object = self.factory.load_scene(scene["scene_id"])
        object_id = self.factory._new_id()
        scene_with_object["objects"].append({
            "object_id": object_id,
            "name": "Object",
            "visible": True,
            "transform": self.gaussian.normalize_transform({}),
            "files": {},
        })
        scene_with_object["layers"].append({"type": "object", "object_id": object_id})
        self.factory._save_scene(scene_with_object, bump_revision=False)
        changed = self.factory.update_scene(
            scene["scene_id"],
            {
                "objects": [{
                    "object_id": object_id,
                    "transform": {"position": [1, 0, 0]},
                }],
            },
        )
        with self.assertRaisesRegex(FileNotFoundError, "stale"):
            self.factory._scene_preview_file(changed)

    def test_scene_render_dimensions_and_camera_invalidate_only_the_preview(self):
        scene = self.factory.create_scene("Camera")
        first = self.factory.update_scene(
            scene["scene_id"],
            {
                "render": {
                    "width": 1920,
                    "height": 1080,
                    "aspect": "16:9",
                    "show_camera_frame": True,
                }
            },
        )
        self.assertEqual(first["revision"], 0)
        self.assertEqual(first["render_revision"], 1)
        self.assertEqual(first["render"]["width"], 1920)
        self.assertEqual(first["render"]["height"], 1080)

        wrong = io.BytesIO()
        Image.new("RGB", (1024, 1024), (1, 2, 3)).save(wrong, format="PNG")
        with self.assertRaisesRegex(ValueError, "configured export frame is 1920x1080"):
            self.factory.store_scene_preview(scene["scene_id"], wrong.getvalue())

        exact = io.BytesIO()
        Image.new("RGB", (1920, 1080), (4, 5, 6)).save(exact, format="PNG")
        saved = self.factory.store_scene_preview(scene["scene_id"], exact.getvalue())
        self.assertTrue(self.factory._scene_preview_file(saved).is_file())

        camera = self.factory.update_scene(
            scene["scene_id"],
            {
                "camera": {
                    "position": [3, 4, 5],
                    "target": [0.5, 0.25, -1],
                    "fov": 55,
                }
            },
        )
        self.assertEqual(camera["revision"], 0)
        self.assertEqual(camera["render_revision"], 2)
        self.assertEqual(camera["camera"]["position"], [3.0, 4.0, 5.0])
        self.assertEqual(camera["camera"]["fov"], 55.0)
        with self.assertRaisesRegex(FileNotFoundError, "camera or resolution"):
            self.factory._scene_preview_file(camera)
        with self.assertRaisesRegex(ValueError, "camera or export frame changed"):
            self.factory.store_scene_preview(
                scene["scene_id"],
                exact.getvalue(),
                saved["revision"],
                saved["render_revision"],
            )

        frame_only = self.factory.update_scene(
            scene["scene_id"],
            {
                "render": {
                    **camera["render"],
                    "show_camera_frame": False,
                }
            },
        )
        self.assertEqual(frame_only["revision"], 0)
        self.assertEqual(frame_only["render_revision"], 2)

    def test_legacy_preview_with_wrong_dimensions_is_not_exposed(self):
        scene = self.factory.create_scene("Legacy")
        root = self.factory.resolve_scene_dir(scene["scene_id"])
        preview_path = root / "preview" / "scene.png"
        preview_path.parent.mkdir(parents=True)
        Image.new("RGB", (1154, 1280), (1, 1, 1)).save(preview_path, format="PNG")
        scene["preview"] = {
            "file": str(preview_path.relative_to(root)),
            "width": 1154,
            "height": 1280,
            "revision": 0,
        }
        self.factory._save_scene(scene, bump_revision=False)
        loaded = self.factory.load_scene(scene["scene_id"])
        with self.assertRaisesRegex(FileNotFoundError, "dimensions"):
            self.factory._scene_preview_file(loaded)
        self.assertNotIn("url", self.factory._public_scene(loaded)["preview"])

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
