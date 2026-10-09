import unittest
import tempfile
from pathlib import Path

from helpers.runtime_caches import load_runtime_caches


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
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.validator = load_runtime_caches(Path(temporary.name))
        self.validator["_POSE_ANIMATION_CACHE_MAX_KEYS"] = 100
        self.validator["_POSE_ANIMATION_CACHE_MAX_TOTAL_CHARS"] = 100_000

    def test_accepts_primary_clip_plus_three_character_clips(self):
        animation = {
            **_clip("main"),
            "primaryCharacterId": "character-1",
            "characterAnimations": [
                {"id": f"character-{index}", "animation": _clip(index)}
                for index in range(2, 5)
            ],
        }

        validated, revision = self.validator["_vnccs_validate_pose_animation_payload"]({
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
            self.validator["_vnccs_validate_pose_animation_payload"]({"animation": animation})

    def test_rejects_malformed_nested_character_clip(self):
        animation = {
            **_clip("main"),
            "characterAnimations": [{"id": "character-2", "animation": None}],
        }

        with self.assertRaisesRegex(ValueError, "character animation must be an object"):
            self.validator["_vnccs_validate_pose_animation_payload"]({"animation": animation})

    def test_key_limit_is_aggregated_across_every_character_clip(self):
        animation = {
            **_clip("main", key_count=60),
            "characterAnimations": [
                {"id": "character-2", "animation": _clip("second", key_count=41)},
            ],
        }
        with self.assertRaisesRegex(ValueError, "animation key limit"):
            self.validator["_vnccs_validate_pose_animation_payload"]({"animation": animation})

    def test_distinct_workflow_snapshots_survive_memory_eviction(self):
        write = self.validator["_vnccs_write_pose_animation_cache_file"]
        read = self.validator["vnccs_get_pose_animation_cache"]
        for animation_id, marker in (("node_snapshot_a", "original"), ("node_snapshot_b", "edited")):
            write(animation_id, {"revision": 1, "animation": _clip(marker)})
            read(animation_id)
        self.validator["VNCCS_POSE_ANIMATION_CACHE"].clear()
        self.assertEqual(read("node_snapshot_a")["animation"]["basePose"]["character"], "original")
        self.assertEqual(read("node_snapshot_b")["animation"]["basePose"]["character"], "edited")


if __name__ == "__main__":
    unittest.main()
