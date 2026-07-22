import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "nodes" / "img2threejs_studio.py"


def load_module():
    if importlib.util.find_spec("torch") is None:
        torch_stub = types.ModuleType("torch")
        torch_stub.float32 = np.float32
        torch_stub.zeros = lambda shape, dtype=None: np.zeros(shape, dtype=dtype)
        torch_stub.from_numpy = lambda value: _ArrayTensor(value)
        sys.modules["torch"] = torch_stub
    spec = importlib.util.spec_from_file_location("vnccs_img2threejs_node_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _ArrayTensor:
    def __init__(self, value):
        self.value = np.asarray(value)

    @property
    def shape(self):
        return self.value.shape

    def unsqueeze(self, axis):
        return _ArrayTensor(np.expand_dims(self.value, axis))


class Img2ThreeJSNodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()

    def test_empty_state_has_stable_empty_outputs(self):
        result = self.module.VNCCS_Img2ThreeJSStudio().load_project("{}")
        self.assertEqual(tuple(result[0].shape), (1, 64, 64, 3))
        self.assertEqual(result[1:], ("", "", ""))

    def test_project_artifacts_are_loaded_from_resolved_project_only(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            Image.new("RGB", (12, 8), (20, 40, 60)).save(project / "preview.png")
            (project / "model.ts").write_text("export const model = 1;", encoding="utf-8")
            (project / "object-sculpt-spec.json").write_text('{"targetName":"Test"}', encoding="utf-8")
            original = self.module._project_dir
            project_id = "a" * 32
            self.module._project_dir = lambda value: project if value == project_id else None
            try:
                state = json.dumps({"schema_version": 1, "project_id": project_id})
                preview, source, sculpt_spec, project_path = self.module.VNCCS_Img2ThreeJSStudio().load_project(state)
            finally:
                self.module._project_dir = original

        self.assertEqual(tuple(preview.shape), (1, 8, 12, 3))
        self.assertEqual(source, "export const model = 1;")
        self.assertEqual(sculpt_spec, '{"targetName":"Test"}')
        self.assertEqual(project_path, str(project))

    def test_invalid_or_oversized_state_is_rejected(self):
        self.assertIsInstance(
            self.module.VNCCS_Img2ThreeJSStudio.VALIDATE_INPUTS("[1, 2]"),
            str,
        )
        self.assertIsInstance(
            self.module.VNCCS_Img2ThreeJSStudio.VALIDATE_INPUTS('{"project_id":"../../outside"}'),
            str,
        )
        with self.assertRaises(ValueError):
            self.module._parse_state("{" + ("x" * (self.module._MAX_STATE_CHARS + 1)))


if __name__ == "__main__":
    unittest.main()
