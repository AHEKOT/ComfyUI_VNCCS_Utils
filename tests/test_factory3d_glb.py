import importlib.util
import json
import struct
import sys
import tempfile
import types
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]


def load_modules():
    package = types.ModuleType("vnccs_glb_test")
    package.__path__ = [str(ROOT)]
    api_package = types.ModuleType("vnccs_glb_test.api")
    api_package.__path__ = [str(ROOT / "api")]
    sys.modules[package.__name__] = package
    sys.modules[api_package.__name__] = api_package
    modules = {}
    for name in ("gaussian_scene", "gaussian_mesh", "factory3d"):
        spec = importlib.util.spec_from_file_location(
            f"vnccs_glb_test.api.{name}",
            ROOT / "api" / f"{name}.py",
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        modules[name] = module
    return modules["gaussian_scene"], modules["gaussian_mesh"], modules["factory3d"]


def write_sphere_gaussians(path: Path, count: int = 6000) -> None:
    names = [
        "x", "y", "z",
        "f_dc_0", "f_dc_1", "f_dc_2",
        "opacity",
        "scale_0", "scale_1", "scale_2",
        "rot_0", "rot_1", "rot_2", "rot_3",
    ]
    dtype = np.dtype([(name, "<f4") for name in names])
    records = np.zeros(count, dtype=dtype)
    golden = np.pi * (3.0 - np.sqrt(5.0))
    y = 1.0 - 2.0 * (np.arange(count, dtype=np.float32) + 0.5) / count
    radius = np.sqrt(np.maximum(0.0, 1.0 - y * y))
    theta = golden * np.arange(count, dtype=np.float32)
    records["x"] = np.cos(theta) * radius
    records["y"] = y
    records["z"] = np.sin(theta) * radius
    # SH DC values which decode to a warm orange vertex color.
    records["f_dc_0"] = 1.15
    records["f_dc_1"] = 0.15
    records["f_dc_2"] = -0.75
    records["opacity"] = 4.0
    for index in range(3):
        records[f"scale_{index}"] = np.log(0.055)
    records["rot_0"] = 1.0
    header = [
        "ply",
        "format binary_little_endian 1.0",
        f"element vertex {count}",
        *(f"property float {name}" for name in names),
        "end_header",
        "",
    ]
    path.write_bytes("\n".join(header).encode("ascii") + records.tobytes())


class FactoryGLBTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gaussian, cls.mesh, cls.factory = load_modules()

    def test_gaussian_surface_is_exported_as_colored_indexed_glb(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "sphere.ply"
            target = root / "sphere.glb"
            write_sphere_gaussians(source)
            result = self.mesh.export_gaussian_scene_glb(
                [(source, {})],
                target,
                names=["Synthetic sphere"],
                resolution=64,
            )
            self.assertGreater(result["vertices"], 100)
            self.assertGreater(result["triangles"], 100)
            payload = target.read_bytes()
            magic, version, total = struct.unpack_from("<4sII", payload, 0)
            self.assertEqual(magic, b"glTF")
            self.assertEqual(version, 2)
            self.assertEqual(total, len(payload))
            json_length, json_kind = struct.unpack_from("<I4s", payload, 12)
            self.assertEqual(json_kind, b"JSON")
            document = json.loads(payload[20 : 20 + json_length].decode("utf-8"))
            self.assertEqual(document["nodes"][0]["name"], "Synthetic sphere")
            attributes = document["meshes"][0]["primitives"][0]["attributes"]
            self.assertIn("POSITION", attributes)
            self.assertIn("NORMAL", attributes)
            self.assertIn("COLOR_0", attributes)
            self.assertIn("indices", document["meshes"][0]["primitives"][0])

    def test_scene_glb_is_cached_and_exposed_by_the_factory_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original_root = self.factory._factory_root
            original_export = self.factory.export_gaussian_scene_glb
            self.factory._factory_root = lambda: root
            self.factory.export_gaussian_scene_glb = (
                lambda sources, target, names=None: self.mesh.export_gaussian_scene_glb(
                    sources,
                    target,
                    names=names,
                    resolution=64,
                )
            )
            try:
                scene = self.factory.create_scene("GLB scene")
                object_id = self.factory._new_id()
                object_root = (
                    self.factory.resolve_scene_dir(scene["scene_id"])
                    / "objects"
                    / object_id
                )
                object_root.mkdir(parents=True)
                source = object_root / "model.ply"
                write_sphere_gaussians(source)
                (object_root / "model.splat").write_bytes(b"placeholder")
                scene["objects"].append(
                    {
                        "object_id": object_id,
                        "name": "Sphere",
                        "visible": True,
                        "transform": self.gaussian.normalize_transform({}),
                        "files": {
                            "ply": str(
                                source.relative_to(
                                    self.factory.resolve_scene_dir(scene["scene_id"])
                                )
                            ),
                            "splat": str(
                                (object_root / "model.splat").relative_to(
                                    self.factory.resolve_scene_dir(scene["scene_id"])
                                )
                            ),
                        },
                    }
                )
                scene["layers"] = [{"type": "object", "object_id": object_id}]
                self.factory._save_scene(scene)
                result = self.factory.ensure_scene_glb(scene["scene_id"])
                self.assertTrue(result["glb"].is_file())
                restored = self.factory.load_scene(scene["scene_id"])
                self.assertIn("glb", restored["exports"]["files"])
                public = self.factory._public_scene(restored)
                self.assertTrue(public["exports"]["urls"]["glb"].endswith("/exports/glb"))
                self.assertTrue(
                    public["objects"][0]["urls"]["export_glb"].endswith("/export/glb")
                )
            finally:
                self.factory._factory_root = original_root
                self.factory.export_gaussian_scene_glb = original_export


if __name__ == "__main__":
    unittest.main()
