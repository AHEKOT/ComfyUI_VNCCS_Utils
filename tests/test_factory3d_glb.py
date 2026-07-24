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


def write_sphere_gaussians(
    path: Path,
    count: int = 6000,
    *,
    sh_rest: int = 0,
) -> None:
    names = [
        "x", "y", "z",
        "f_dc_0", "f_dc_1", "f_dc_2",
        "opacity",
        "scale_0", "scale_1", "scale_2",
        "rot_0", "rot_1", "rot_2", "rot_3",
        *(f"f_rest_{index}" for index in range(sh_rest)),
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
    for index in range(sh_rest):
        records[f"f_rest_{index}"] = np.float32(index / 100.0)
    header = [
        "ply",
        "format binary_little_endian 1.0",
        f"element vertex {count}",
        *(f"property float {name}" for name in names),
        "end_header",
        "",
    ]
    path.write_bytes("\n".join(header).encode("ascii") + records.tobytes())


def parse_glb(path: Path) -> tuple[dict, bytes]:
    payload = path.read_bytes()
    magic, version, total = struct.unpack_from("<4sII", payload, 0)
    if magic != b"glTF" or version != 2 or total != len(payload):
        raise AssertionError("invalid GLB header")
    json_length, json_kind = struct.unpack_from("<I4s", payload, 12)
    if json_kind != b"JSON":
        raise AssertionError("missing JSON chunk")
    document = json.loads(payload[20 : 20 + json_length].decode("utf-8"))
    binary_header = 20 + json_length
    binary_length, binary_kind = struct.unpack_from("<I4s", payload, binary_header)
    if binary_kind != b"BIN\x00":
        raise AssertionError("missing BIN chunk")
    binary = payload[binary_header + 8 : binary_header + 8 + binary_length]
    return document, binary


def read_float_attribute(
    document: dict,
    binary: bytes,
    name: str,
) -> np.ndarray:
    primitive = document["meshes"][0]["primitives"][0]
    accessor = document["accessors"][primitive["attributes"][name]]
    view = document["bufferViews"][accessor["bufferView"]]
    components = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    offset = int(view.get("byteOffset", 0)) + int(accessor.get("byteOffset", 0))
    count = int(accessor["count"]) * components
    return np.frombuffer(binary, dtype="<f4", count=count, offset=offset).reshape(
        int(accessor["count"]),
        components,
    )


class FactoryGLBTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gaussian, cls.mesh, cls.factory = load_modules()

    def test_gaussians_are_exported_with_khr_splat_attributes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "sphere.ply"
            target = root / "sphere.glb"
            write_sphere_gaussians(source)
            result = self.mesh.export_gaussian_scene_glb(
                [(source, {})],
                target,
                names=["Synthetic sphere"],
            )
            self.assertEqual(result["gaussians"], 6000)
            self.assertEqual(result["representation"], "gaussian-splatting")
            self.assertEqual(result["extension"], "KHR_gaussian_splatting")
            document, binary = parse_glb(target)
            self.assertEqual(document["nodes"][0]["name"], "Synthetic sphere")
            self.assertEqual(document["extensionsUsed"], ["KHR_gaussian_splatting"])
            primitive = document["meshes"][0]["primitives"][0]
            self.assertEqual(primitive["mode"], 0)
            self.assertNotIn("indices", primitive)
            attributes = document["meshes"][0]["primitives"][0]["attributes"]
            self.assertIn("POSITION", attributes)
            self.assertIn("COLOR_0", attributes)
            self.assertIn("KHR_gaussian_splatting:ROTATION", attributes)
            self.assertIn("KHR_gaussian_splatting:SCALE", attributes)
            self.assertIn("KHR_gaussian_splatting:OPACITY", attributes)
            self.assertIn("KHR_gaussian_splatting:SH_DEGREE_0_COEF_0", attributes)
            scale = read_float_attribute(
                document,
                binary,
                "KHR_gaussian_splatting:SCALE",
            )
            opacity = read_float_attribute(
                document,
                binary,
                "KHR_gaussian_splatting:OPACITY",
            )
            self.assertTrue(np.allclose(scale, 0.055, rtol=1e-5, atol=1e-7))
            self.assertTrue(
                np.allclose(opacity, 1.0 / (1.0 + np.exp(-4.0)), rtol=1e-5)
            )

    def test_all_available_spherical_harmonics_are_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "sphere.ply"
            target = root / "sh3.glb"
            write_sphere_gaussians(source, count=10, sh_rest=45)
            result = self.mesh.export_gaussian_ply_glb(
                source,
                target,
                name="SH3",
            )
            self.assertEqual(result["sh_degree"], 3)
            document, binary = parse_glb(target)
            attributes = document["meshes"][0]["primitives"][0]["attributes"]
            self.assertIn("KHR_gaussian_splatting:SH_DEGREE_3_COEF_6", attributes)
            degree_three_first = read_float_attribute(
                document,
                binary,
                "KHR_gaussian_splatting:SH_DEGREE_3_COEF_0",
            )
            self.assertTrue(
                np.allclose(degree_three_first[0], [0.08, 0.23, 0.38])
            )

    def test_scene_camera_is_embedded_as_a_gltf_camera(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "sphere.ply"
            target = root / "camera.glb"
            write_sphere_gaussians(source, count=10)
            metadata = {
                "camera": {
                    "position": [0.0, 1.0, 5.0],
                    "target": [0.0, 0.0, 0.0],
                    "up": [0.0, 1.0, 0.0],
                    "fov": 50.0,
                },
                "render": {"width": 1920, "height": 1080},
            }
            result = self.mesh.export_gaussian_ply_glb(
                source,
                target,
                metadata=metadata,
            )
            document, _binary = parse_glb(target)
            self.assertTrue(result["camera"])
            self.assertEqual(document["nodes"][1]["camera"], 0)
            self.assertAlmostEqual(
                document["cameras"][0]["perspective"]["aspectRatio"],
                1920 / 1080,
            )
            self.assertEqual(document["extras"]["vnccsScene"], metadata)

    def test_scene_glb_is_cached_and_exposed_by_the_factory_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original_root = self.factory._factory_root
            original_export = self.factory.export_gaussian_ply_glb
            self.factory._factory_root = lambda: root
            self.factory.export_gaussian_ply_glb = (
                lambda source, target, name="Gaussian scene",
                metadata=None: self.mesh.export_gaussian_ply_glb(
                    source,
                    target,
                    name=name,
                    metadata=metadata,
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
                self.assertEqual(
                    restored["exports"]["gaussian_glb"]["format_version"],
                    self.factory.GLB_FORMAT_VERSION,
                )
                self.assertEqual(
                    restored["exports"]["gaussian_glb"]["extension"],
                    "KHR_gaussian_splatting",
                )
                public = self.factory._public_scene(restored)
                self.assertTrue(public["exports"]["urls"]["glb"].endswith("/exports/glb"))
                self.assertTrue(
                    public["objects"][0]["urls"]["export_glb"].endswith("/export/glb")
                )
            finally:
                self.factory._factory_root = original_root
                self.factory.export_gaussian_ply_glb = original_export


if __name__ == "__main__":
    unittest.main()
