import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _validate_animation_payload(data):
    animation = data.get("animation")
    if not isinstance(animation, dict):
        raise ValueError("animation must be an object")
    total_keys = 0
    animations = [animation]
    character_animations = animation.get("characterAnimations", [])
    if character_animations is not None:
        if not isinstance(character_animations, list) or len(character_animations) > 3:
            raise ValueError("animation.characterAnimations must contain at most three entries")
        for entry in character_animations:
            nested = entry.get("animation") if isinstance(entry, dict) else None
            if not isinstance(nested, dict):
                raise ValueError("character animation must be an object")
            animations.append(nested)
    for clip in animations:
        tracks = clip.get("tracks", {})
        if not isinstance(tracks, dict):
            raise ValueError("animation.tracks must be an object")
        for track in tracks.values():
            if not isinstance(track, dict):
                continue
            keys = track.get("keys", [])
            if not isinstance(keys, list):
                raise ValueError("animation track keys must be a list")
            total_keys += len(keys)
            if total_keys > 100:
                raise ValueError("animation contains too many keyframes")
    if len(json.dumps(animation, separators=(",", ":"))) > 100_000:
        raise ValueError("animation payload is too large")
    return animation, int(data.get("revision") or 0)


VALIDATOR = {"_vnccs_validate_pose_animation_payload": _validate_animation_payload}


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
        animation = {
            **_clip("main", key_count=60),
            "characterAnimations": [
                {"id": "character-2", "animation": _clip("second", key_count=41)},
            ],
        }
        with self.assertRaisesRegex(ValueError, "too many keyframes"):
            VALIDATOR["_vnccs_validate_pose_animation_payload"]({"animation": animation})


if __name__ == "__main__":
    unittest.main()
