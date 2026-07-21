import json
import unittest

from nodes.vnccs_nodes import VNCCS_VisualPositionControl


class VisualCameraControlTests(unittest.TestCase):
    def test_accepts_random_metadata(self):
        node = VNCCS_VisualPositionControl()
        camera_data = json.dumps(
            {
                "azimuth": 270,
                "elevation": 30,
                "distance": "wide shot",
                "include_trigger": False,
                "random": True,
            }
        )

        self.assertEqual(node.generate_prompt_from_json(camera_data), (
            "left side view elevated shot wide shot",
        ))

    def test_invalid_json_uses_defaults(self):
        node = VNCCS_VisualPositionControl()

        self.assertEqual(node.generate_prompt_from_json("{broken"), (
            "<sks> front view eye-level shot medium shot",
        ))


if __name__ == "__main__":
    unittest.main()
