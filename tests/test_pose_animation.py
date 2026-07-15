import math
import unittest

from nodes.pose_animation import (
    MODEL_ROTATION_TRACK,
    apply_interpolation,
    euler_degrees_to_quaternion,
    evaluate_animation_frame,
    normalize_animation_state,
    quaternion_to_euler_degrees,
    sample_animation_frames,
)


def angle_distance(a, b):
    return abs(((b - a + 540.0) % 360.0) - 180.0)


class PoseAnimationTests(unittest.TestCase):
    def make_state(self, interpolation="linear"):
        return normalize_animation_state({
            "schemaVersion": 2,
            "frameCount": 11,
            "duration": 1.0,
            "fps": 11,
            "basePose": {"bones": {}, "modelRotation": [0, 0, 0]},
            "tracks": {
                "upperarm_l": {
                    "keys": [
                        {"id": "a", "frame": 0, "value": euler_degrees_to_quaternion([170, 0, 0]), "interpolation": interpolation},
                        {"id": "b", "frame": 10, "value": euler_degrees_to_quaternion([-170, 0, 0]), "interpolation": "linear"},
                    ]
                }
            },
        })

    def test_euler_quaternion_round_trip(self):
        source = [25.0, -35.0, 70.0]
        result = quaternion_to_euler_degrees(euler_degrees_to_quaternion(source))
        for expected, actual in zip(source, result):
            self.assertLess(angle_distance(expected, actual), 1e-6)

    def test_shortest_rotation_path_crosses_180(self):
        pose = evaluate_animation_frame(self.make_state(), 5)
        midpoint = pose["bones"]["upperarm_l"][0]
        self.assertLess(angle_distance(midpoint, 180.0), 1e-5)
        self.assertGreater(angle_distance(midpoint, 0.0), 170.0)

    def test_hold_interpolation(self):
        pose = evaluate_animation_frame(self.make_state("hold"), 9)
        self.assertLess(angle_distance(pose["bones"]["upperarm_l"][0], 170.0), 1e-5)

    def test_easing_presets_are_bounded(self):
        for interpolation in ("linear", "easeIn", "easeOut", "easeInOut", "smooth"):
            values = [apply_interpolation(step / 20.0, interpolation) for step in range(21)]
            self.assertEqual(values[0], 0.0)
            self.assertEqual(values[-1], 1.0)
            self.assertTrue(all(0.0 <= value <= 1.0 for value in values))
            self.assertTrue(all(a <= b for a, b in zip(values, values[1:])))

    def test_normalization_deduplicates_and_clamps_keys(self):
        state = normalize_animation_state({
            "frame_count": 5,
            "duration_seconds": 2,
            "base_pose": {},
            "tracks": {
                "head": {
                    "keys": [
                        {"frame": -10, "rotation": [0, 0, 0], "interpolation": "linear"},
                        {"frame": 0, "rotation": [10, 0, 0], "interpolation": "not-real"},
                        {"frame": 100, "rotation": [20, 0, 0], "interpolation": "hold"},
                        {"frame": float("nan"), "rotation": [30, 0, 0]},
                    ]
                }
            },
        })
        keys = state["tracks"]["head"]["keys"]
        self.assertEqual(state["fps"], 12)
        self.assertEqual(state["frameCount"], 24)
        self.assertEqual([key["frame"] for key in keys], [0, 23])
        self.assertEqual(keys[0]["interpolation"], "linear")
        self.assertEqual(keys[1]["interpolation"], "hold")

    def test_sampling_exact_frame_count_and_strips_solver_hints(self):
        raw = {
            "schemaVersion": 2,
            "frameCount": 7,
            "duration": 1,
            "fps": 7,
            "basePose": {
                "bones": {},
                "modelRotation": [0, 0, 0],
                "ikEffectorPositions": {"hand_l": [1, 2, 3]},
                "poleTargetPositions": {"leftArm": [1, 2, 3]},
                "hipBonePosition": {"hips": [1, 2, 3]},
            },
            "tracks": {
                MODEL_ROTATION_TRACK: {
                    "keys": [
                        {"frame": 0, "value": euler_degrees_to_quaternion([0, 0, 0])},
                        {"frame": 6, "value": euler_degrees_to_quaternion([0, 90, 0])},
                    ]
                }
            },
        }
        frames = sample_animation_frames(raw)
        self.assertEqual(len(frames), 7)
        self.assertLess(angle_distance(frames[-1]["modelRotation"][1], 90.0), 1e-5)
        for frame in frames:
            self.assertNotIn("ikEffectorPositions", frame)
            self.assertNotIn("poleTargetPositions", frame)
            self.assertNotIn("hipBonePosition", frame)

    def test_normalization_keeps_fps_duration_and_frames_consistent(self):
        state = normalize_animation_state({
            "schemaVersion": 2,
            "frameCount": 600,
            "duration": 25,
            "fps": 24,
            "basePose": {},
        })
        self.assertEqual(state["frameCount"], 600)
        self.assertEqual(state["duration"], 25)
        self.assertEqual(state["fps"], 24)


if __name__ == "__main__":
    unittest.main()
