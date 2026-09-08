import importlib.util
import io
import json
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def module_from(path, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ConditioningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = module_from("api/factory3d_conditioning.py", "conditioning_service_test")
        torch = types.ModuleType("torch")
        torch.from_numpy = lambda array: array
        with mock.patch.dict(sys.modules, {"torch": torch}):
            cls.nodes = module_from("nodes/factory3d_render.py", "conditioning_nodes_test")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.scene = {"scene_id": "a" * 32, "schema_version": 12, "revision": 1, "render_revision": 1,
                      "objects": [{"object_id": "b" * 32}], "cameras": [], "camera": {
                          "position": [0, 0, 3], "target": [0, 0, 0], "up": [0, 1, 0], "fov": 42},
                      "architecture": {"rooms": [{"room_id": "c" * 32}]}}
        def validate(value, label="id"):
            if not isinstance(value, str) or len(value) != 32 or any(c not in "abcdef0123456789" for c in value):
                raise ValueError(label)
            return value
        def atomic(path, value):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(value, allow_nan=False))
        self.backend = types.SimpleNamespace(
            _validate_id=validate, resolve_scene_dir=lambda _id: self.root, load_scene=lambda _id: self.scene,
            _STATE_LOCK=threading.RLock(), _atomic_json=atomic, MAX_SCENE_CAMERAS=32)
        self.handle = self.service.create_scene_handle(self.backend, self.scene, "17")

    def prepare(self):
        return self.service.prepare_capture(self.backend, self.handle, "Mesh geometry", 64, 64, 0.1, 100)

    def parts(self, job):
        valid = np.zeros((64, 64), bool); valid[8:56, 8:56] = True
        ids = np.zeros((64, 64), np.uint32)
        ids[valid] = job["entity_ids"]["object:" + "b" * 32]
        ids[32:56, 8:56] = job["entity_ids"]["room:" + "c" * 32]
        packed_depth = np.zeros_like(ids); packed_depth[valid] = round(2 / 3000 * 16777215)
        def rgba24(values):
            return np.stack([values >> 16, (values >> 8) & 255, values & 255, valid.astype(np.uint32) * 255], -1).astype(np.uint8)
        normal = np.zeros((64, 64, 4), np.uint8); normal[valid] = [128, 128, 255, 255]
        rgb = np.full((64, 64, 4), 255, np.uint8)
        result = {}
        for key, pixels in {"rgb": rgb, "normal": normal, "object_id": rgba24(ids), "depth": rgba24(packed_depth)}.items():
            source = io.BytesIO(); Image.fromarray(pixels).save(source, format="PNG"); result[key] = source.getvalue()
        f = 1 / np.tan(np.radians(21)); near = 0.02; far = 3000
        world = np.eye(4); world[2, 3] = 3
        projection = np.array([[f, 0, 0, 0], [0, f, 0, 0],
                               [0, 0, -(far + near) / (far - near), -2 * far * near / (far - near)], [0, 0, -1, 0]])
        metadata = {"renderer_build": self.service.BUILD, "shot_id": "current", "clip_near": near, "clip_far": far,
                    "projection_matrix": projection.flatten(order="F").tolist(), "camera_world_matrix": world.flatten(order="F").tolist()}
        return result, metadata

    def complete(self, job=None):
        job = job or self.prepare()
        parts, metadata = self.parts(job)
        self.service.store_shot(self.backend, self.scene["scene_id"], job["job_id"], 0, parts, metadata)
        return self.service.publish_capture(self.backend, self.scene["scene_id"], job["job_id"])

    def test_metric_depth_ids_masks_and_list_contract(self):
        capture = self.complete()
        directory, manifest = self.service.load_capture(self.backend, capture)
        metric = np.fromfile(directory / "0/depth.f32", dtype="<f4").reshape(64, 64)
        self.assertLess(abs(float(metric[20, 20]) - 2), 0.001)
        self.assertEqual(metric[0, 0], 0)
        outputs = self.nodes.capture_outputs(self.backend, self.service, capture)
        self.assertEqual([len(output) for output in outputs[:6]], [1] * 6)
        self.assertEqual(outputs[0][0].shape, (1, 64, 64, 3))
        self.assertEqual(outputs[3][0].shape, (1, 64, 64))
        self.assertEqual(outputs[3][0][0, 20, 20], 1)
        self.assertEqual(outputs[1][0][0, 0, 0, 0], 0)
        with mock.patch.object(self.nodes, "_services", return_value=(self.backend, self.service)):
            masks, _ = self.nodes.VNCCS_FactoryMask().mask(capture, "object:" + "b" * 32)
            self.assertEqual(masks[0][0, 20, 20], 1)
            self.assertEqual(masks[0][0, 40, 20], 0)
            inverse, _ = self.nodes.VNCCS_FactoryMask().mask(capture, "object:" + "b" * 32, True)
            np.testing.assert_array_equal(inverse[0], 1 - masks[0])
            with self.assertRaisesRegex(ValueError, "Unknown"):
                self.nodes.VNCCS_FactoryMask().mask(capture, "wrong")
        self.assertEqual(self.nodes.VNCCS_FactoryRender.OUTPUT_IS_LIST, (True,) * 6 + (False,))
        self.assertEqual(manifest["shots"][0]["shot_id"], "current")

    def test_snapshot_and_capture_are_immutable_after_later_scene_edits(self):
        capture = self.complete()
        self.scene["revision"] += 1
        cached = self.prepare()
        self.assertEqual(cached["capture"], capture)
        with self.assertRaisesRegex(ValueError, "changed"):
            self.service.prepare_capture(self.backend, self.handle, "Mesh geometry", 128, 64, 0.1, 100)
        self.service.load_capture(self.backend, capture)

    def test_missing_parts_and_revision_change_never_publish(self):
        job = self.prepare()
        with self.assertRaisesRegex(ValueError, "incomplete"):
            self.service.publish_capture(self.backend, self.scene["scene_id"], job["job_id"])
        parts, metadata = self.parts(job)
        self.service.store_shot(self.backend, self.scene["scene_id"], job["job_id"], 0, parts, metadata)
        self.scene["render_revision"] += 1
        with self.assertRaisesRegex(ValueError, "changed"):
            self.service.publish_capture(self.backend, self.scene["scene_id"], job["job_id"])
        self.assertFalse((self.root / "conditioning/captures" / job["signature"]).exists())

    def test_upload_rejects_bad_geometry_and_duplicate_shots(self):
        job = self.prepare(); parts, metadata = self.parts(job)
        for key, value in [("clip_far", float("nan")), ("projection_matrix", [1]), ("shot_id", "wrong")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.service.store_shot(self.backend, self.scene["scene_id"], job["job_id"], 0, parts, {**metadata, key: value})
        bad = dict(parts); bad["object_id"] = parts["rgb"]
        with self.assertRaisesRegex(ValueError, "unknown entity"):
            self.service.store_shot(self.backend, self.scene["scene_id"], job["job_id"], 0, bad, metadata)
        self.service.store_shot(self.backend, self.scene["scene_id"], job["job_id"], 0, parts, metadata)
        with self.assertRaisesRegex(ValueError, "already uploaded"):
            self.service.store_shot(self.backend, self.scene["scene_id"], job["job_id"], 0, parts, metadata)

    def test_asset_change_and_path_escape_are_rejected(self):
        (self.root / "asset.bin").write_bytes(b"first")
        self.handle = self.service.create_scene_handle(self.backend, self.scene)
        (self.root / "asset.bin").write_bytes(b"second")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.prepare()
        with self.assertRaises(ValueError):
            self.service.load_capture(self.backend, {"scene_id": "../bad", "capture_hash": "d" * 64})

    def test_deleted_entity_ids_are_not_reused(self):
        first = self.prepare()["entity_ids"]
        self.scene["objects"] = [{"object_id": "d" * 32}]
        self.handle = self.service.create_scene_handle(self.backend, self.scene)
        second = self.prepare()["entity_ids"]
        self.assertGreater(second["object:" + "d" * 32], max(first.values()))
        self.assertEqual(second["room:" + "c" * 32], first["room:" + "c" * 32])

    def test_corrupted_part_is_rejected_and_cancel_does_not_remove_complete_capture(self):
        capture = self.complete()
        directory, _ = self.service.load_capture(self.backend, capture)
        job = self.service.prepare_capture(self.backend, self.handle, "Mesh geometry", 128, 64, 0.1, 100)
        self.service.fail_job(self.backend, self.scene["scene_id"], job["job_id"], "cancelled")
        self.assertEqual(self.service.read_job(self.backend, self.scene["scene_id"], job["job_id"])["status"], "failed")
        self.assertTrue((directory / "manifest.json").exists())
        (directory / "0/depth.f32").write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "integrity"):
            self.service.load_capture(self.backend, capture)

    def test_real_scene_storage_supports_handles_and_rejects_unsaved_camera_changes(self):
        helpers = module_from("tests/test_factory3d_backend.py", "conditioning_backend_helpers")
        _, backend = helpers.load_modules()
        with mock.patch.object(backend, "_factory_root", return_value=self.root / "real"):
            scene = backend.create_scene("Conditioning storage")
            scene = backend.update_scene(scene["scene_id"], {"camera": {
                "position": [0, 0, 3], "target": [0, 0, 0], "up": [0, 1, 0], "fov": 42}})
            handle = self.service.create_scene_handle(backend, scene, "17")
            self.service._snapshot(backend, handle, verify_current=True)
            backend.update_scene(scene["scene_id"], {"camera": scene["camera"]})
            self.service._snapshot(backend, handle, verify_current=True)
            backend.update_scene(scene["scene_id"], {"camera": {**scene["camera"], "fov": 50}})
            with self.assertRaisesRegex(ValueError, "changed"):
                self.service.prepare_capture(backend, handle, "Mesh geometry", 64, 64, 0.1, 100)

    def test_multiple_shots_preserve_order_and_camera_mismatch_is_rejected(self):
        self.scene["cameras"] = [{**self.scene["camera"], "camera_id": "e" * 32},
                                 {**self.scene["camera"], "camera_id": "d" * 32}]
        self.handle = self.service.create_scene_handle(self.backend, self.scene, "17")
        job = self.prepare()
        parts, metadata = self.parts(job)
        wrong = {**metadata, "camera_world_matrix": np.eye(4).flatten(order="F").tolist()}
        with self.assertRaisesRegex(ValueError, "frozen shot"):
            self.service.store_shot(self.backend, self.scene["scene_id"], job["job_id"], 0, parts, wrong)
        for index, shot in enumerate(job["shots"]):
            self.service.store_shot(self.backend, self.scene["scene_id"], job["job_id"], index, parts,
                                    {**metadata, "shot_id": shot["shot_id"]})
        handle = self.service.publish_capture(self.backend, self.scene["scene_id"], job["job_id"])
        outputs = self.nodes.capture_outputs(self.backend, self.service, handle)
        self.assertEqual([len(value) for value in outputs[:6]], [3] * 6)
        self.assertEqual([json.loads(value)["shot_id"] for value in outputs[5]], ["current", "e" * 32, "d" * 32])


if __name__ == "__main__":
    unittest.main()
