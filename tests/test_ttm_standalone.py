"""The inference package works without its parent repository or tensor imports."""

import importlib.util
import ast
import json
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "nodes" / "posestudio" / "ttm"


class StandalonePackageTests(unittest.TestCase):
    def test_dependency_manifest_covers_the_inference_imports(self):
        external = set()
        for path in MODULE.rglob("*.py"):
            if "build" in path.parts:
                continue
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.Import):
                    external.update(alias.name.split(".")[0] for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
                    external.add(node.module.split(".")[0])
        # Host integrations and the unused optional compilation helper are not runtime dependencies.
        external -= set(sys.stdlib_module_names) | {"comfy", "folder_paths", "torch_tensorrt"}
        distributions = {"yaml": "PyYAML", "comfy_kitchen": "comfy-kitchen"}
        required = {distributions.get(name, name) for name in external}
        listed = set((MODULE / "requirements.txt").read_text().splitlines())
        self.assertEqual(listed, required)

    def test_detached_package_has_ardy_config_assets_and_lazy_dependencies(self):
        with tempfile.TemporaryDirectory() as folder:
            detached = Path(folder).resolve() / "ttm"
            shutil.copytree(MODULE, detached, ignore=shutil.ignore_patterns("__pycache__"))
            spec = importlib.util.spec_from_file_location(
                "detached_ttm", detached / "__init__.py", submodule_search_locations=[str(detached)],
            )
            package = importlib.util.module_from_spec(spec)
            before = set(sys.modules)
            with mock.patch.dict(sys.modules, {"detached_ttm": package}):
                spec.loader.exec_module(package)
                from detached_ttm import registry, service

                self.assertEqual(list(package.load_specs()), ["ardy-core-rp-20fps-h40"])
                backend = package.create_backend("weights")
                self.assertEqual(backend.models_dir, Path("weights"))
                self.assertEqual(backend.spec.options["motion_precision"], "bf16")
                self.assertEqual(backend.spec.options["compact_dir"], "ARDY-Core-RP-20FPS-Horizon40-int4")
                self.assertEqual(len(backend.spec.weights[0].files), 24)
                self.assertTrue(registry.MODELS_CONFIG_DIR.is_relative_to(detached))
                with mock.patch.dict(sys.modules, {"folder_paths": None}):
                    self.assertTrue(registry.default_models_dir().is_relative_to(detached))
                self.assertTrue((detached / "vendor/ardy/assets/skeletons/cskel27/joints.p").is_file())
                self.assertNotIn("torch", set(sys.modules) - before)
                self.assertNotIn("transformers", set(sys.modules) - before)
                self.assertEqual(service.ROUTE_PREFIX, "/vnccs/pose_studio/motion")

    def test_relocated_adapter_shares_the_comfy_model_lock(self):
        from nodes.posestudio.ttm import service

        lock = threading.Lock()
        host = type("Host", (), {"_COMFY_MODEL_OP_LOCK": lock})()
        with mock.patch.object(service, "__package__", "plugin.nodes.posestudio.ttm"), \
             mock.patch.dict(sys.modules, {"plugin.nodes.unicanvas": host}):
            self.assertIs(service._model_operation_lock(), lock)
        self.assertIs(service._model_operation_lock(), service._MODEL_LOCK)

    def test_backend_unload_releases_encoder(self):
        from nodes.posestudio.ttm import create_backend
        from nodes.posestudio.ttm.vendor import loaders

        backend = create_backend(Path("models"))
        backend.model = object()
        loaders._ENCODER.update(key="fixture", encoder=object())
        with mock.patch("nodes.posestudio.ttm.ardy_backend.empty_torch_cache"):
            backend.unload()
        self.assertIsNone(backend.model)
        self.assertEqual(loaders._ENCODER, {"key": None, "encoder": None})

    def test_removed_family_cannot_be_enabled_by_adding_a_spec(self):
        from nodes.posestudio.ttm import registry

        spec = json.loads((registry.MODELS_CONFIG_DIR / "ardy-core-rp-20fps-h40.json").read_text())
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "removed.json").write_text(json.dumps({**spec, "backend": "kimodo"}))
            with mock.patch("builtins.print"):
                self.assertEqual(registry.load_specs(Path(folder)), {})
        self.assertFalse((MODULE / "kimodo_backend.py").exists())
        self.assertFalse((MODULE / "vendor" / "kimodo").exists())
