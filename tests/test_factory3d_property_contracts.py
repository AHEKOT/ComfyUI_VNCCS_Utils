import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("factory3d_property_schema", ROOT / "api/factory3d_schema.py")
schema = importlib.util.module_from_spec(spec)
spec.loader.exec_module(schema)


class LightPropertyContracts(unittest.TestCase):
    def test_shared_numeric_contract_survives_backend_normalization(self):
        cases = json.loads((ROOT / "tests/fixtures/factory3d/light_numeric_contract.json").read_text())
        for item in cases:
            with self.subTest(item["name"]):
                light = {"light_id": "a" * 32, "position": [0, 2, 0], "intensity": 1, "distance": 0}
                parts = item["path"].split(".")
                if len(parts) == 2:
                    light[parts[0]][int(parts[1])] = float(item["input"])
                else:
                    light[parts[0]] = float(item["input"])
                normalized = schema.normalize_lighting_extensions({"lights": [light]})["lights"][0]
                actual = normalized[parts[0]]
                if len(parts) == 2:
                    actual = actual[int(parts[1])]
                self.assertEqual(actual, item["expected"])


if __name__ == "__main__":
    unittest.main()
