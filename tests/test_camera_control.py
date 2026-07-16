import json

from nodes.vnccs_nodes import VNCCS_VisualPositionControl


def test_visual_camera_control_accepts_random_metadata():
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

    assert node.generate_prompt_from_json(camera_data) == (
        "left side view elevated shot wide shot",
    )


def test_visual_camera_control_invalid_json_uses_defaults():
    node = VNCCS_VisualPositionControl()

    assert node.generate_prompt_from_json("{broken") == (
        "<sks> front view eye-level shot medium shot",
    )
