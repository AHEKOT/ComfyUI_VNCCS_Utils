import importlib.util
import math
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "api" / "gaussian_scene.py"


def load_module():
    spec = importlib.util.spec_from_file_location("vnccs_factory_gaussian_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class GaussianSceneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()

    def _write_ply(self, path, xyz=(1.0, 0.0, 0.0)):
        names = [
            "x", "y", "z", "nx", "ny", "nz",
            "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
            "scale_0", "scale_1", "scale_2",
            "rot_0", "rot_1", "rot_2", "rot_3",
        ]
        dtype = np.dtype([(name, "<f4") for name in names])
        record = np.zeros(1, dtype=dtype)
        record["x"], record["y"], record["z"] = xyz
        record["rot_0"] = 1
        path.write_bytes(self.module._ply_header(1, dtype) + record.tobytes())

    def test_translation_rotation_and_uniform_scale_are_baked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.ply"
            target = root / "target.ply"
            self._write_ply(source)
            self.module.export_scene_ply(
                [(
                    source,
                    {
                        "position": [1, 2, 3],
                        "rotation": [0, 0, 90],
                        "scale": 2,
                    },
                )],
                target,
            )
            info = self.module.inspect_ply(target)
            data = np.memmap(target, mode="r", dtype=info.dtype, offset=info.data_offset, shape=(1,))

            self.assertTrue(np.allclose([data["x"][0], data["y"][0], data["z"][0]], [1, 2, 5], atol=1e-5))
            self.assertAlmostEqual(float(data["scale_0"][0]), math.log(2), places=5)
            self.assertTrue(
                np.allclose(
                    [data["rot_0"][0], data["rot_1"][0], data["rot_2"][0], data["rot_3"][0]],
                    [-0.5, 0.5, 0.5, 0.5],
                    atol=1e-5,
                )
            )

    def test_identity_scene_transform_bakes_triposplat_viewer_orientation(self):
        names = [
            "x", "y", "z", "nx", "ny", "nz",
            "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
            "scale_0", "scale_1", "scale_2",
            "rot_0", "rot_1", "rot_2", "rot_3",
        ]
        dtype = np.dtype([(name, "<f4") for name in names])
        record = np.zeros(1, dtype=dtype)
        record["x"], record["y"], record["z"] = (1, 2, 3)
        record["rot_0"] = 1
        transformed = self.module._transform_records(record, {})

        self.assertTrue(
            np.allclose(
                [transformed["x"][0], transformed["y"][0], transformed["z"][0]],
                [3, -2, 1],
                atol=1e-5,
            )
        )
        self.assertTrue(
            np.allclose(
                [
                    transformed["rot_0"][0],
                    transformed["rot_1"][0],
                    transformed["rot_2"][0],
                    transformed["rot_3"][0],
                ],
                [0, math.sqrt(0.5), 0, math.sqrt(0.5)],
                atol=1e-5,
            )
        )

    def test_scene_merge_and_splat_conversion_preserve_count(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.ply"
            second = root / "second.ply"
            merged = root / "scene.ply"
            splat = root / "scene.splat"
            self._write_ply(first, (0, 0, 0))
            self._write_ply(second, (1, 0, 0))
            result = self.module.export_gaussian_scene(
                [(first, {}), (second, {"position": [4, 0, 0]})],
                merged,
                splat,
            )

            self.assertEqual(result["ply"]["objects"], 2)
            self.assertEqual(result["ply"]["gaussians"], 2)
            self.assertEqual(self.module.inspect_ply(merged).vertex_count, 2)
            self.assertEqual(splat.stat().st_size, 2 * 32)

    def test_invalid_transform_is_bounded(self):
        transform = self.module.normalize_transform(
            {"position": [float("inf"), -9999999, "bad"], "rotation": [720, 0, 0], "scale": -1}
        )
        self.assertEqual(transform["position"], [0.0, -100000.0, 0.0])
        self.assertEqual(transform["rotation"], [0.0, 0.0, 0.0])
        self.assertEqual(transform["scale"], 0.001)


if __name__ == "__main__":
    unittest.main()
