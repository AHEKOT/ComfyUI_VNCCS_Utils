import ast
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _load_animation_payload_validator():
    source_path = ROOT / "__init__.py"
    tree = ast.parse(source_path.read_text())
    selected = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "_vnccs_validate_pose_animation_payload"
    ]
    namespace = {
        "json": json,
        "_POSE_ANIMATION_CACHE_MAX_KEYS": 100,
        "_POSE_ANIMATION_CACHE_MAX_TOTAL_CHARS": 100_000,
    }
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(source_path), "exec"), namespace)
    return namespace


VALIDATOR = _load_animation_payload_validator()


def _clip(character_marker, key_count=1):
    return {
        "basePose": {"character": character_marker},
        "tracks": {
            "root": {
                "keys": [
                    {"frame": index, "value": [0, 0, 0, 1]}
                    for index in range(key_count)
                ],
            },
        },
    }


class PoseAnimationSceneCacheValidationTests(unittest.TestCase):
    def test_accepts_primary_clip_plus_three_character_clips(self):
        animation = {
            **_clip("main"),
            "primaryCharacterId": "character-1",
            "characterAnimations": [
                {"id": f"character-{index}", "animation": _clip(index)}
                for index in range(2, 5)
            ],
        }

        validated, revision = VALIDATOR["_vnccs_validate_pose_animation_payload"]({
            "animation": animation,
            "revision": "7",
        })

        self.assertIs(validated, animation)
        self.assertEqual(revision, 7)
        self.assertEqual(len(validated["characterAnimations"]), 3)

    def test_rejects_more_than_four_total_character_clips(self):
        animation = {
            **_clip("main"),
            "characterAnimations": [
                {"id": f"character-{index}", "animation": _clip(index)}
                for index in range(2, 6)
            ],
        }

        with self.assertRaisesRegex(ValueError, "at most three"):
            VALIDATOR["_vnccs_validate_pose_animation_payload"]({"animation": animation})

    def test_rejects_malformed_nested_character_clip(self):
        animation = {
            **_clip("main"),
            "characterAnimations": [{"id": "character-2", "animation": None}],
        }

        with self.assertRaisesRegex(ValueError, "character animation must be an object"):
            VALIDATOR["_vnccs_validate_pose_animation_payload"]({"animation": animation})

    def test_key_limit_is_aggregated_across_every_character_clip(self):
        original_limit = VALIDATOR["_POSE_ANIMATION_CACHE_MAX_KEYS"]
        VALIDATOR["_POSE_ANIMATION_CACHE_MAX_KEYS"] = 3
        try:
            animation = {
                **_clip("main", key_count=2),
                "characterAnimations": [
                    {"id": "character-2", "animation": _clip("second", key_count=2)},
                ],
            }
            with self.assertRaisesRegex(ValueError, "animation key limit is 3"):
                VALIDATOR["_vnccs_validate_pose_animation_payload"]({"animation": animation})
        finally:
            VALIDATOR["_POSE_ANIMATION_CACHE_MAX_KEYS"] = original_limit


if __name__ == "__main__":
    unittest.main()
