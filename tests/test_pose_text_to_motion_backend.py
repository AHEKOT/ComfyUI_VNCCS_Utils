"""Pose Studio text-to-motion backend: model registry, pose conversion, request
validation and the Kimodo / HY-Motion runners.

Runs without torch, Kimodo or HY-Motion; they are replaced by small stubs where needed.
"""

import asyncio
import threading
import time
import contextlib
import importlib.util
import json
import math
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "vnccs_text_to_motion_test_api"


def _load_package():
    folder = ROOT / "api" / "text_to_motion"
    package = types.ModuleType(PACKAGE)
    package.__path__ = [str(folder)]
    sys.modules[PACKAGE] = package
    modules = {}
    # Dependencies first, so each module's relative imports find their siblings.
    for name in ("transform", "soma", "smplh", "base", "manager_policy", "registry", "service", "kimodo_backend", "ardy_backend", "hymotion_backend", "unimate_backend", "worker_protocol", "worker_runtime"):
        spec = importlib.util.spec_from_file_location(f"{PACKAGE}.{name}", folder / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        modules[name] = module
    return modules


_MODULES = _load_package()
TRANSFORM = _MODULES["transform"]
SOMA = _MODULES["soma"]
SMPLH = _MODULES["smplh"]
BASE = _MODULES["base"]
REGISTRY = _MODULES["registry"]
SERVICE = _MODULES["service"]
HYMOTION = _MODULES["hymotion_backend"]
KIMODO_BACKEND = _MODULES["kimodo_backend"]
ARDY = _MODULES["ardy_backend"]
PROTOCOL = _MODULES["worker_protocol"]
RUNTIME = _MODULES["worker_runtime"]
UNIMATE = _MODULES["unimate_backend"]
MANAGER_POLICY = _MODULES["manager_policy"]

# Kimodo SOMA 77-joint skeleton (name, parent, rest position in meters), copied from
# kimodo/assets/skeletons/somaskel77 of https://github.com/nv-tlabs/kimodo (Apache-2.0).
SOMA77 = [
    ("Hips", None, (0.0, 0.0, 0.0)),
    ("Spine1", "Hips", (-0.0001, 0.05, -0.0005)),
    ("Spine2", "Spine1", (-0.0001, 0.1213, -0.0008)),
    ("Chest", "Spine2", (-0.0001, 0.1968, -0.009)),
    ("Neck1", "Chest", (-0.002, 0.4599, -0.0145)),
    ("Neck2", "Neck1", (-0.002, 0.537, 0.0085)),
    ("Head", "Neck2", (-0.002, 0.5983, 0.028)),
    ("HeadEnd", "Head", (-0.0019, 0.7589, 0.0097)),
    ("Jaw", "Head", (-0.0019, 0.603, 0.059)),
    ("LeftEye", "Head", (0.0301, 0.6521, 0.1039)),
    ("RightEye", "Head", (-0.0342, 0.6519, 0.1036)),
    ("LeftShoulder", "Chest", (0.0161, 0.4292, 0.0421)),
    ("LeftArm", "LeftShoulder", (0.1653, 0.4292, -0.0129)),
    ("LeftForeArm", "LeftArm", (0.4527, 0.4292, -0.0129)),
    ("LeftHand", "LeftForeArm", (0.7236, 0.4292, -0.0129)),
    ("LeftHandThumb1", "LeftHand", (0.7464, 0.4152, 0.019)),
    ("LeftHandThumb2", "LeftHandThumb1", (0.7865, 0.397, 0.0354)),
    ("LeftHandThumb3", "LeftHandThumb2", (0.8145, 0.397, 0.0354)),
    ("LeftHandThumbEnd", "LeftHandThumb3", (0.8463, 0.397, 0.0354)),
    ("LeftHandIndex1", "LeftHand", (0.7561, 0.4238, 0.0101)),
    ("LeftHandIndex2", "LeftHandIndex1", (0.8197, 0.424, 0.0119)),
    ("LeftHandIndex3", "LeftHandIndex2", (0.8564, 0.424, 0.0119)),
    ("LeftHandIndex4", "LeftHandIndex3", (0.8796, 0.424, 0.0119)),
    ("LeftHandIndexEnd", "LeftHandIndex4", (0.9072, 0.4222, 0.0107)),
    ("LeftHandMiddle1", "LeftHand", (0.7552, 0.4316, -0.0029)),
    ("LeftHandMiddle2", "LeftHandMiddle1", (0.8172, 0.429, -0.0129)),
    ("LeftHandMiddle3", "LeftHandMiddle2", (0.8607, 0.429, -0.0129)),
    ("LeftHandMiddle4", "LeftHandMiddle3", (0.8907, 0.429, -0.0129)),
    ("LeftHandMiddleEnd", "LeftHandMiddle4", (0.9137, 0.426, -0.0132)),
    ("LeftHandRing1", "LeftHand", (0.7524, 0.4286, -0.0161)),
    ("LeftHandRing2", "LeftHandRing1", (0.811, 0.4238, -0.0298)),
    ("LeftHandRing3", "LeftHandRing2", (0.8545, 0.4238, -0.0298)),
    ("LeftHandRing4", "LeftHandRing3", (0.881, 0.4238, -0.0298)),
    ("LeftHandRingEnd", "LeftHandRing4", (0.9004, 0.4245, -0.0298)),
    ("LeftHandPinky1", "LeftHand", (0.7523, 0.4261, -0.0289)),
    ("LeftHandPinky2", "LeftHandPinky1", (0.8031, 0.4128, -0.0466)),
    ("LeftHandPinky3", "LeftHandPinky2", (0.8339, 0.4128, -0.0466)),
    ("LeftHandPinky4", "LeftHandPinky3", (0.8494, 0.4128, -0.0466)),
    ("LeftHandPinkyEnd", "LeftHandPinky4", (0.8688, 0.4112, -0.046)),
    ("RightShoulder", "Chest", (-0.0139, 0.4286, 0.0431)),
    ("RightArm", "RightShoulder", (-0.1643, 0.4286, -0.0123)),
    ("RightForeArm", "RightArm", (-0.4517, 0.4286, -0.0123)),
    ("RightHand", "RightForeArm", (-0.723, 0.4286, -0.0123)),
    ("RightHandThumb1", "RightHand", (-0.7458, 0.4148, 0.0193)),
    ("RightHandThumb2", "RightHandThumb1", (-0.7859, 0.3965, 0.0357)),
    ("RightHandThumb3", "RightHandThumb2", (-0.8138, 0.3965, 0.0357)),
    ("RightHandThumbEnd", "RightHandThumb3", (-0.8457, 0.3965, 0.0357)),
    ("RightHandIndex1", "RightHand", (-0.7555, 0.4234, 0.0105)),
    ("RightHandIndex2", "RightHandIndex1", (-0.819, 0.4235, 0.0123)),
    ("RightHandIndex3", "RightHandIndex2", (-0.8555, 0.4235, 0.0123)),
    ("RightHandIndex4", "RightHandIndex3", (-0.8788, 0.4235, 0.0123)),
    ("RightHandIndexEnd", "RightHandIndex4", (-0.9064, 0.4217, 0.0112)),
    ("RightHandMiddle1", "RightHand", (-0.7547, 0.4311, -0.0023)),
    ("RightHandMiddle2", "RightHandMiddle1", (-0.8165, 0.4285, -0.0123)),
    ("RightHandMiddle3", "RightHandMiddle2", (-0.86, 0.4285, -0.0123)),
    ("RightHandMiddle4", "RightHandMiddle3", (-0.89, 0.4285, -0.0123)),
    ("RightHandMiddleEnd", "RightHandMiddle4", (-0.913, 0.4255, -0.0126)),
    ("RightHandRing1", "RightHand", (-0.7519, 0.4279, -0.0154)),
    ("RightHandRing2", "RightHandRing1", (-0.8104, 0.4231, -0.0291)),
    ("RightHandRing3", "RightHandRing2", (-0.8538, 0.4231, -0.0291)),
    ("RightHandRing4", "RightHandRing3", (-0.8803, 0.4231, -0.0291)),
    ("RightHandRingEnd", "RightHandRing4", (-0.8997, 0.4238, -0.0291)),
    ("RightHandPinky1", "RightHand", (-0.7517, 0.4252, -0.0282)),
    ("RightHandPinky2", "RightHandPinky1", (-0.8026, 0.4118, -0.0459)),
    ("RightHandPinky3", "RightHandPinky2", (-0.8332, 0.4118, -0.0459)),
    ("RightHandPinky4", "RightHandPinky3", (-0.8487, 0.4118, -0.0459)),
    ("RightHandPinkyEnd", "RightHandPinky4", (-0.8681, 0.4103, -0.0453)),
    ("LeftLeg", "Hips", (0.1004, -0.0843, 0.026)),
    ("LeftShin", "LeftLeg", (0.1004, -0.5166, 0.0179)),
    ("LeftFoot", "LeftShin", (0.1004, -0.9381, -0.0169)),
    ("LeftToeBase", "LeftFoot", (0.1004, -0.9887, 0.1154)),
    ("LeftToeEnd", "LeftToeBase", (0.1003, -1.0052, 0.1806)),
    ("RightLeg", "Hips", (-0.1005, -0.083, 0.0262)),
    ("RightShin", "RightLeg", (-0.1005, -0.5166, 0.0181)),
    ("RightFoot", "RightShin", (-0.1005, -0.9377, -0.0166)),
    ("RightToeBase", "RightFoot", (-0.1005, -0.9885, 0.1162)),
    ("RightToeEnd", "RightToeBase", (-0.1004, -1.0049, 0.1808)),
]

SOMA_NAMES = [name for name, _, _ in SOMA77]
SOMA_PARENTS = [-1 if parent is None else SOMA_NAMES.index(parent) for _, parent, _ in SOMA77]
SOMA_REST = np.array([position for _, _, position in SOMA77], dtype=np.float64)

# Pose Studio landmark -> SOMA joint used to fabricate mannequin keypoints from a SOMA pose.
LANDMARKS = {
    "pelvis": "Hips", "spine_01": "Spine1", "spine_02": "Spine2", "spine_03": "Chest",
    "neck_01": "Neck1", "head": "Head",
}
for _side, _soma in (("l", "Left"), ("r", "Right")):
    LANDMARKS.update({
        f"clavicle_{_side}": f"{_soma}Shoulder", f"upperarm_{_side}": f"{_soma}Arm",
        f"lowerarm_{_side}": f"{_soma}ForeArm", f"hand_{_side}": f"{_soma}Hand",
        f"thigh_{_side}": f"{_soma}Leg", f"calf_{_side}": f"{_soma}Shin",
        f"foot_{_side}": f"{_soma}Foot", f"ball_{_side}": f"{_soma}ToeBase",
        f"thumb_01_{_side}": f"{_soma}HandThumb1", f"thumb_02_{_side}": f"{_soma}HandThumb2",
        f"thumb_03_{_side}": f"{_soma}HandThumb3",
    })
    for _finger in ("Index", "Middle", "Ring", "Pinky"):
        for _number, _joint in ((1, 2), (2, 3), (3, 4)):
            LANDMARKS[f"{_finger.lower()}_0{_number}_{_side}"] = f"{_soma}Hand{_finger}{_joint}"


def skeleton():
    return SOMA.SomaSkeleton(SOMA_NAMES, SOMA_PARENTS, SOMA_REST)


def rest_heading():
    return SOMA.heading_angle(SOMA_REST[SOMA_NAMES.index("RightLeg")], SOMA_REST[SOMA_NAMES.index("LeftLeg")])


def axis_angle(axis, degrees):
    axis = np.asarray(axis, dtype=np.float64)
    axis = axis / np.linalg.norm(axis)
    angle = math.radians(degrees)
    skew = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + math.sin(angle) * skew + (1 - math.cos(angle)) * skew @ skew


def posed_soma(local_rotations):
    """FK of a SOMA pose given local rotations {joint: 3x3}."""
    skel = skeleton()
    globals_ = np.tile(np.eye(3), (len(SOMA_NAMES), 1, 1))
    for joint in skel.order:
        parent = SOMA_PARENTS[joint]
        local = local_rotations.get(SOMA_NAMES[joint], np.eye(3))
        globals_[joint] = (globals_[parent] if parent >= 0 else np.eye(3)) @ local
    return skel.forward_kinematics(globals_, root_position=np.zeros(3)), globals_


# A walking-ish pose: bent knee, raised arm, twisted torso.
LOCAL_POSE = {
    "Spine2": axis_angle([0, 1, 0], 15),
    "Chest": axis_angle([1, 0, 0], 10),
    "LeftArm": axis_angle([0, 0, 1], -60),
    "LeftForeArm": axis_angle([0, 1, 0], 45),
    "RightArm": axis_angle([1, 0, 0], 40) @ axis_angle([0, 0, 1], 70),
    "LeftLeg": axis_angle([1, 0, 0], -35),
    "LeftShin": axis_angle([1, 0, 0], 60),
    "RightLeg": axis_angle([1, 0, 0], 20),
}


def world_keypoints(heading_degrees=60.0, scale=1.7, offset=(0.4, 2.0, -1.2)):
    positions, rotations = posed_soma(LOCAL_POSE)
    yaw = SOMA.yaw_matrix(math.radians(heading_degrees))
    world = (positions @ yaw.T) * scale + np.asarray(offset)
    keypoints = {name: world[SOMA_NAMES.index(joint)] for name, joint in LANDMARKS.items()}
    return keypoints, world, rotations, yaw


class SomaPoseConversionTests(unittest.TestCase):
    def test_start_pose_round_trips_through_the_frame_transform(self):
        keypoints, world, _, _ = world_keypoints()
        positions, rotations, transform = SOMA.solve_start_pose(skeleton(), keypoints)

        self.assertAlmostEqual(transform.scale, 1.7, places=6)
        self.assertAlmostEqual(transform.heading, math.radians(60.0) + rest_heading(), places=9)
        back = transform.to_pose_studio(positions)
        for name in ("pelvis", "lowerarm_l", "hand_l", "hand_r", "calf_l", "foot_l", "foot_r", "ball_r", "index_03_l"):
            joint = SOMA_NAMES.index(LANDMARKS[name])
            np.testing.assert_allclose(back[joint], keypoints[name], atol=1e-6, err_msg=name)
        # Head direction is approximated from neck_01 -> head, so allow a few millimeters.
        np.testing.assert_allclose(back[SOMA_NAMES.index("Head")], keypoints["head"], atol=0.02 * 1.7)
        for rotation in rotations:
            np.testing.assert_allclose(rotation @ rotation.T, np.eye(3), atol=1e-9)
            self.assertAlmostEqual(float(np.linalg.det(rotation)), 1.0, places=9)

    def test_start_pose_is_canonical_for_kimodo(self):
        keypoints, _, _, _ = world_keypoints(heading_degrees=-135.0)
        positions, _, _ = SOMA.solve_start_pose(skeleton(), keypoints)
        hips = [SOMA_NAMES.index("RightLeg"), SOMA_NAMES.index("LeftLeg")]
        self.assertAlmostEqual(SOMA.heading_angle(positions[hips[0]], positions[hips[1]]), 0.0, places=9)
        self.assertAlmostEqual(float(positions[:, 1].min()), 0.0, places=9)
        np.testing.assert_allclose(positions[SOMA_NAMES.index("Hips")][[0, 2]], [0.0, 0.0], atol=1e-9)

    def test_head_axes_drive_the_head_rotation(self):
        keypoints, _, _, yaw = world_keypoints()
        nod = axis_angle([1, 0, 0], 30)
        head_axes = {"up": yaw @ nod @ [0.0, 1.0, 0.0], "forward": yaw @ nod @ [0.0, 0.0, 1.0]}
        _, rotations, _ = SOMA.solve_start_pose(skeleton(), keypoints, head_axes)
        expected = SOMA.yaw_matrix(-rest_heading()) @ nod
        np.testing.assert_allclose(rotations[SOMA_NAMES.index("Head")], expected, atol=1e-9)

    def test_torso_follows_the_mannequin_rest_pose(self):
        # A mannequin whose rest spine leans back relative to SOMA's upright spine.
        rest_positions, _ = posed_soma({})
        lean = axis_angle([1, 0, 0], -25)
        rest = {name: rest_positions[SOMA_NAMES.index(joint)].copy() for name, joint in LANDMARKS.items()}
        for name in ("spine_01", "spine_02", "spine_03", "neck_01", "head"):
            rest[name] = lean @ rest[name]

        _, rotations, _ = SOMA.solve_start_pose(skeleton(), dict(rest), rest_keypoints=rest)
        for joint in ("Hips", "Spine1", "Spine2", "Chest", "Neck1"):
            np.testing.assert_allclose(rotations[SOMA_NAMES.index(joint)], np.eye(3), atol=1e-9, err_msg=joint)

        # Bend the whole upper body forward about the pelvis: SOMA's chest follows.
        bow = axis_angle([1, 0, 0], 30)
        current = dict(rest)
        for name, point in rest.items():
            if name.split("_")[0] not in ("thigh", "calf", "foot", "ball", "pelvis"):
                current[name] = bow @ point
        _, rotations, _ = SOMA.solve_start_pose(skeleton(), current, rest_keypoints=rest)
        chest = rotations[SOMA_NAMES.index("Chest")]
        np.testing.assert_allclose(chest, SOMA.yaw_matrix(-rest_heading()) @ bow @ SOMA.yaw_matrix(rest_heading()), atol=1e-6)

    def test_missing_landmarks_are_reported(self):
        keypoints, _, _, _ = world_keypoints()
        keypoints.pop("hand_l")
        with self.assertRaisesRegex(ValueError, "hand_l"):
            SOMA.solve_start_pose(skeleton(), keypoints)

    def test_soma_motion_maps_back_into_pose_studio(self):
        keypoints, world, rotations, yaw = world_keypoints()
        positions, _, transform = SOMA.solve_start_pose(skeleton(), keypoints)
        second = positions + np.array([0.0, 0.0, 0.5])
        source = SOMA.soma_motion(
            skeleton(), np.stack([positions, second])[None], np.stack([rotations, rotations])[None], 30.0,
        )
        aligned = TRANSFORM.align_to_start_pose(source, keypoints)
        motion = TRANSFORM.motion_to_pose_studio(source, aligned)

        self.assertEqual(motion["frame_count"], 2)
        self.assertEqual(set(motion["joints"]), set(TRANSFORM.MOTION_JOINT_KEYS))
        np.testing.assert_allclose(motion["joints"]["Hips"][0], keypoints["pelvis"], atol=1e-5)
        np.testing.assert_allclose(motion["joints"]["LeftHand"][0], keypoints["hand_l"], atol=1e-5)
        self.assertAlmostEqual(aligned.scale, transform.scale, places=6)
        # Half a meter forward in Kimodo space is 0.85 scene units along the mannequin's facing.
        step = np.asarray(motion["joints"]["Hips"][1]) - np.asarray(motion["joints"]["Hips"][0])
        np.testing.assert_allclose(step, TRANSFORM.yaw_matrix(aligned.heading) @ [0.0, 0.0, 0.85], atol=1e-5)
        head = motion["rotations"]["head"][0]
        expected = TRANSFORM.matrix_to_quaternion(TRANSFORM.yaw_matrix(aligned.heading) @ rotations[SOMA_NAMES.index("Head")])
        np.testing.assert_allclose(head, expected, atol=1e-5)

    def test_matrix_to_quaternion_matches_axis_angle(self):
        for axis, degrees in (([0, 1, 0], 90), ([1, 0, 0], 179), ([1, 1, 0], -120), ([0, 0, 1], 0)):
            unit = np.asarray(axis, dtype=np.float64) / np.linalg.norm(axis)
            half = math.radians(degrees) / 2
            expected = np.array([*(unit * math.sin(half)), math.cos(half)])
            quaternion = np.asarray(TRANSFORM.matrix_to_quaternion(axis_angle(axis, degrees)))
            if np.dot(quaternion, expected) < 0:
                quaternion = -quaternion
            np.testing.assert_allclose(quaternion, expected, atol=1e-9)



def smplh_rest():
    """A simple SMPL-H-like T-pose in meters (y up, facing +Z, left on +X)."""
    body = {
        "Pelvis": (0, 0.95, 0), "L_Hip": (0.09, 0.87, 0), "R_Hip": (-0.09, 0.87, 0),
        "Spine1": (0, 1.05, 0), "L_Knee": (0.1, 0.5, 0), "R_Knee": (-0.1, 0.5, 0),
        "Spine2": (0, 1.18, 0), "L_Ankle": (0.1, 0.08, 0), "R_Ankle": (-0.1, 0.08, 0),
        "Spine3": (0, 1.24, 0), "L_Foot": (0.1, 0.02, 0.12), "R_Foot": (-0.1, 0.02, 0.12),
        "Neck": (0, 1.45, 0), "L_Collar": (0.07, 1.38, 0), "R_Collar": (-0.07, 1.38, 0),
        "Head": (0, 1.55, 0.02), "L_Shoulder": (0.18, 1.4, 0), "R_Shoulder": (-0.18, 1.4, 0),
        "L_Elbow": (0.45, 1.4, 0), "R_Elbow": (-0.45, 1.4, 0), "L_Wrist": (0.7, 1.4, 0), "R_Wrist": (-0.7, 1.4, 0),
    }
    positions = np.zeros((len(SMPLH.JOINT_NAMES), 3))
    for index, name in enumerate(SMPLH.JOINT_NAMES):
        if name in body:
            positions[index] = body[name]
        else:
            wrist = positions[SMPLH.JOINT_NAMES.index(f"{name[0]}_Wrist")]
            positions[index] = wrist + [0.05 if name[0] == "L" else -0.05, 0, 0]
    return positions


class SmplhMotionTests(unittest.TestCase):
    def test_skeleton_tables_are_consistent(self):
        self.assertEqual(len(SMPLH.JOINT_NAMES), 52)
        self.assertEqual(len(SMPLH.PARENTS), 52)
        self.assertTrue(all(parent < index for index, parent in enumerate(SMPLH.PARENTS)))
        self.assertEqual(SMPLH.JOINT_NAMES[SMPLH.PARENTS[SMPLH.JOINT_NAMES.index("L_Index2")]], "L_Index1")
        self.assertEqual(set(SMPLH.MOTION_JOINTS), set(TRANSFORM.MOTION_JOINT_KEYS))
        self.assertTrue(set(SMPLH.MOTION_JOINTS.values()) <= set(SMPLH.JOINT_NAMES))

    def test_hymotion_output_lands_on_the_mannequin(self):
        keypoints, _, _, _ = world_keypoints(heading_degrees=90.0)
        rest = smplh_rest()
        turned = rest.copy()
        turned[SMPLH.JOINT_NAMES.index("L_Elbow")] = [0.18, 1.13, 0]
        local = np.tile(np.eye(3), (2, 52, 1, 1))
        local[1, SMPLH.JOINT_NAMES.index("Head")] = axis_angle([1, 0, 0], 20)
        source = SMPLH.smplh_motion(np.stack([rest, turned])[None], local[None], fps=30)

        motion = TRANSFORM.motion_to_pose_studio(source, TRANSFORM.align_to_start_pose(source, keypoints))
        np.testing.assert_allclose(motion["joints"]["Hips"][0], keypoints["pelvis"], atol=1e-6)
        right, left = np.asarray(motion["joints"]["RightUpLeg"][0]), np.asarray(motion["joints"]["LeftUpLeg"][0])
        self.assertAlmostEqual(
            TRANSFORM.heading_angle(right, left),
            TRANSFORM.heading_angle(keypoints["thigh_r"], keypoints["thigh_l"]),
            places=4,
        )
        # The head turn arrives as a world rotation change between the two frames.
        first, second = (np.asarray(q) for q in motion["rotations"]["head"])
        self.assertAlmostEqual(abs(float(np.dot(first, second))), math.cos(math.radians(10)), places=5)

    def test_body_only_output_is_accepted(self):
        rest = smplh_rest()[:22]
        source = SMPLH.smplh_motion(rest[None], np.tile(np.eye(3), (1, 22, 1, 1)), joint_names=SMPLH.BODY_JOINTS)
        self.assertEqual(source.rotations.shape, (1, 22, 3, 3))
        keypoints, _, _, _ = world_keypoints()
        motion = TRANSFORM.motion_to_pose_studio(source, TRANSFORM.align_to_start_pose(source, keypoints))
        self.assertIn("LeftHand", motion["joints"])

    def test_joints_a_model_lacks_are_left_out(self):
        keypoints, _, _, _ = world_keypoints()
        source = SMPLH.smplh_motion(smplh_rest()[None])
        source.joint_map = {key: value for key, value in source.joint_map.items() if "Toe" not in key}
        motion = TRANSFORM.motion_to_pose_studio(source, TRANSFORM.align_to_start_pose(source, keypoints))
        self.assertNotIn("LeftToeBase", motion["joints"])
        self.assertIn("LeftFoot", motion["joints"])
        self.assertEqual(motion["rotations"], {})

    def test_unimate_mixamo_output_lands_on_the_mannequin(self):
        keypoints, _, _, _ = world_keypoints(heading_degrees=90.0)
        rest = smplh_rest()[:22]
        # SMPL body joints renamed to their Mixamo counterparts, as UniMate's Mixamo features name them.
        to_mixamo = {smpl: key for key, smpl in SMPLH.MOTION_JOINTS.items()}
        names = [f"mixamorig:{to_mixamo.get(name, name)}" for name in SMPLH.BODY_JOINTS]
        source = UNIMATE.unimate_motion(np.stack([rest, rest]), names, fps=30)
        self.assertEqual(source.root, "Hips")
        self.assertEqual(source.hips, ("RightUpLeg", "LeftUpLeg"))
        motion = TRANSFORM.motion_to_pose_studio(source, TRANSFORM.align_to_start_pose(source, keypoints))
        np.testing.assert_allclose(motion["joints"]["Hips"][0], keypoints["pelvis"], atol=1e-6)
        self.assertIn("LeftHand", motion["joints"])
        self.assertEqual(motion["rotations"], {})

    def test_unimate_rejects_non_humanoid_skeletons(self):
        with self.assertRaises(ValueError):
            UNIMATE.unimate_motion(np.zeros((2, 3, 3)), ["Root", "Tail1", "Tail2"])

    def test_unimate_joint_names_are_cleaned(self):
        self.assertEqual(UNIMATE.clean_joint_name("mixamorig:LeftArm"), "LeftArm")
        self.assertEqual(UNIMATE.clean_joint_name("mixamorig1_LeftArm"), "LeftArm")
        self.assertEqual(UNIMATE.clean_joint_name("Armature|Hips"), "Hips")

    def test_unimate_needs_its_code_checkpoint_and_features(self):
        spec = REGISTRY.load_specs()["unimate-preview"]
        with tempfile.TemporaryDirectory() as folder:
            backend = UNIMATE.UniMateBackend(spec, Path(folder))
            backend.requires = ()
            with self.assertRaises(BASE.BackendUnavailable):
                backend.check_available()
            (backend.code_dir() / "unimate" / "inference").mkdir(parents=True)
            (backend.code_dir() / "unimate" / "inference" / "sample.py").write_text("")
            (backend.checkpoint_dir() / "checkpoints").mkdir(parents=True)
            (backend.checkpoint_dir() / "config.json").write_text("{}")
            for step in (100, 2500, 900):
                (backend.checkpoint_dir() / "checkpoints" / f"checkpoint_step_{step}.pt").write_text("x")
            self.assertEqual(UNIMATE.latest_checkpoint(backend.checkpoint_dir()).name, "checkpoint_step_2500.pt")
            with self.assertRaises(BASE.BackendUnavailable):
                backend.check_available()
            (backend.features_dir() / "mixamo").mkdir(parents=True)
            (backend.features_dir() / "mixamo" / "cond.npy").write_bytes(b"x")
            backend.check_available()

    def test_global_rotations_compose_parents_first(self):
        local = np.stack([axis_angle([0, 1, 0], 30), axis_angle([1, 0, 0], 40), axis_angle([0, 0, 1], 50)])[None]
        world = TRANSFORM.global_rotations_from_local(local, [-1, 0, 1])
        np.testing.assert_allclose(world[0, 2], local[0, 0] @ local[0, 1] @ local[0, 2], atol=1e-12)


class ModelRegistryTests(unittest.TestCase):
    def test_bundled_model_files_load(self):
        specs = REGISTRY.load_specs()
        self.assertEqual(list(specs)[:4], ["ardy-core-rp-20fps-h40", "kimodo-soma-rp-v1.1", "hy-motion-1.0-lite", "hy-motion-1.0"])
        self.assertEqual(specs["unimate-preview"].backend, "unimate")
        for spec in specs.values():
            self.assertIn(spec.backend, REGISTRY.BACKENDS)
            self.assertTrue(spec.code.get("url", "").startswith("https://"))
            self.assertTrue(spec.code.get("install"))
            self.assertTrue(any(w.role == "model" for w in spec.weights), spec.id)
            for weight in spec.weights:
                self.assertTrue(weight.url.startswith("https://huggingface.co/"), weight.repo_id)
            self.assertTrue(spec.license.get("name") and spec.license.get("url"))
            public = spec.public()
            json.dumps(public)
            self.assertTrue(0 < public["capabilities"]["duration"]["max"] <= 10.0)

    def test_hymotion_license_names_the_excluded_territories(self):
        for model_id in ("hy-motion-1.0-lite", "hy-motion-1.0"):
            license_info = REGISTRY.load_specs()[model_id].public()["license"]
            self.assertEqual(license_info["restricted_territories"], ["European Union", "United Kingdom", "South Korea"])
            self.assertIn(
                "THIS LICENSE AGREEMENT DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH KOREA",
                license_info["territory_notice"],
            )
            self.assertIn("Tencent HY-MOTION 1.0 is licensed under", license_info["notice"])
        self.assertEqual(REGISTRY.load_specs()["kimodo-soma-rp-v1.1"].license["restricted_territories"], [])

    def test_broken_or_unsafe_files_are_skipped(self):
        good = json.loads((REGISTRY.MODELS_CONFIG_DIR / "kimodo-soma-rp-v1.1.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            (folder / "a.json").write_text(json.dumps(good), encoding="utf-8")
            (folder / "b.json").write_text("{not json", encoding="utf-8")
            (folder / "c.json").write_text(json.dumps({**good, "id": "other", "backend": "nope"}), encoding="utf-8")
            unsafe = {**good, "id": "unsafe", "weights": [{"repo_id": "a/b", "local_dir": "../../etc"}]}
            (folder / "d.json").write_text(json.dumps(unsafe), encoding="utf-8")
            (folder / "e.json").write_text(json.dumps(good), encoding="utf-8")
            with mock.patch("builtins.print"):
                specs = REGISTRY.load_specs(folder)
        self.assertEqual(list(specs), ["kimodo-soma-rp-v1.1"])

    def test_spec_validation(self):
        for data, message in (
            ({"id": "Bad Id", "backend": "kimodo"}, "invalid model id"),
            ({"id": "x", "backend": ""}, "backend"),
            ({"id": "x", "backend": "kimodo", "weights": [{"repo_id": "no-slash"}]}, "repo id"),
            ({"id": "x", "backend": "kimodo", "capabilities": {"steps": {"min": 5, "max": 4, "default": 9}}}, "default"),
            ({"id": "x", "backend": "kimodo", "license": {"restricted_territories": "EU"}}, "territories"),
        ):
            with self.assertRaisesRegex(ValueError, message):
                BASE.MotionModelSpec.from_dict(data)


class SetupStepTests(unittest.TestCase):
    def spec(self, setup, **extra):
        return BASE.MotionModelSpec.from_dict({"id": "demo", "backend": "kimodo", "setup": setup, **extra})

    def test_bundled_models_have_a_guide_and_setup(self):
        for spec in REGISTRY.load_specs().values():
            self.assertTrue(spec.guide.get("summary"), spec.id)
            self.assertTrue(spec.setup, spec.id)
            public = spec.public()
            self.assertEqual(public["guide"], spec.guide)
            # Code checkouts are never installed through ComfyUI-Manager's git route.
            self.assertTrue(all(step["kind"] in BASE.SETUP_KINDS for step in spec.setup), spec.id)

    def test_pip_steps_need_safe_packages_and_modules(self):
        spec = self.spec([{"id": "pkgs", "kind": "pip", "packages": ["einops>=0.7", "git+https://github.com/nv-tlabs/kimodo"], "modules": ["einops"]}])
        self.assertEqual(spec.setup[0]["packages"][1], "git+https://github.com/nv-tlabs/kimodo")
        for bad in (["einops; rm -rf /"], ["--index-url=https://evil.invalid"], ["git+https://evil.invalid/x/y"], [], "einops"):
            with self.assertRaises(ValueError, msg=bad):
                self.spec([{"id": "pkgs", "kind": "pip", "packages": bad, "modules": ["einops"]}])
        with self.assertRaises(ValueError):
            self.spec([{"id": "pkgs", "kind": "pip", "packages": ["einops"]}])

    def test_steps_reject_unknown_kinds_duplicates_and_plain_links(self):
        with self.assertRaises(ValueError):
            self.spec([{"id": "code", "kind": "git"}])
        with self.assertRaises(ValueError):
            self.spec([{"id": "a", "kind": "auto"}, {"id": "a", "kind": "manual"}])
        with self.assertRaises(ValueError):
            self.spec([{"id": "a", "kind": "manual", "link": "http://example.invalid"}])

    def test_setup_status_checks_modules_and_backend_parts(self):
        spec = REGISTRY.load_specs()["unimate-preview"]
        with tempfile.TemporaryDirectory() as folder:
            backend = UNIMATE.UniMateBackend(spec, Path(folder))
            status = {step["id"]: step["done"] for step in backend.setup_status()}
            self.assertEqual(status["code"], False)
            self.assertEqual(status["checkpoint"], False)
            self.assertEqual(status["features"], False)
            (backend.features_dir() / "mixamo").mkdir(parents=True)
            (backend.features_dir() / "mixamo" / "cond.npy").write_bytes(b"x")
            self.assertTrue({step["id"]: step["done"] for step in backend.setup_status()}["features"])
        pip = BASE.MotionModelSpec.from_dict({"id": "demo", "backend": "kimodo", "setup": [
            {"id": "pkgs", "kind": "pip", "packages": ["tyro"], "modules": ["tyro"]}]})
        with mock.patch.object(BASE, "module_missing", side_effect=lambda name: name == "tyro"):
            self.assertFalse(KIMODO_BACKEND.KimodoBackend(pip, Path(".")).setup_status()[0]["done"])

    def test_hymotion_weights_step_reports_downloaded_files(self):
        spec = REGISTRY.load_specs()["hy-motion-1.0-lite"]
        with tempfile.TemporaryDirectory() as folder:
            backend = HYMOTION.HYMotionBackend(spec, Path(folder))
            self.assertFalse(backend.check_part("weights"))
            for source in spec.weights:
                for name in list(source.files) + ([source.index_file] if source.index_file else []):
                    path = backend.weights_dir(source) / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps({"weight_map": {"a": "shard-1.safetensors"}}) if name == source.index_file else "x")
                if source.index_file:
                    (backend.weights_dir(source) / "shard-1.safetensors").write_text("x")
            self.assertTrue(backend.check_part("weights"))

    def test_unimate_checkpoint_pick_takes_the_newest_step(self):
        names = [
            "README.md", "a/config.json", "a/dataset_stats.npy",
            "a/checkpoints/checkpoint_step_900.pt", "a/checkpoints/checkpoint_step_12000.pt",
            "b/config.json", "b/checkpoints/checkpoint_step_5.pt",
        ]
        picked = UNIMATE.pick_checkpoint_files(names)
        self.assertEqual(picked, {"prefix": "a/", "files": ["a/config.json", "a/dataset_stats.npy", "a/checkpoints/checkpoint_step_12000.pt"]})
        self.assertEqual(UNIMATE.pick_checkpoint_files(names, "b")["files"], ["b/config.json", "b/checkpoints/checkpoint_step_5.pt"])
        with self.assertRaises(ValueError):
            UNIMATE.pick_checkpoint_files(["README.md"])

    def test_list_models_includes_setup_status(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(REGISTRY, "default_models_dir", return_value=Path(folder)):
            models = {model["id"]: model for model in SERVICE.list_models()}
        self.assertIn("setup", models["unimate-preview"])
        self.assertTrue(all("done" in step for step in models["unimate-preview"]["setup"]))


class SetupRouteGuardTests(unittest.TestCase):
    def request(self, **headers):
        return types.SimpleNamespace(headers=headers)

    def test_download_route_requires_the_page_marker_and_same_origin(self):
        self.assertTrue(SERVICE._same_origin_request(self.request(**{"X-VNCCS-CSRF": "1", "Host": "localhost:8188", "Origin": "http://localhost:8188"})))
        self.assertFalse(SERVICE._same_origin_request(self.request(Host="localhost:8188")))
        self.assertFalse(SERVICE._same_origin_request(self.request(**{"X-VNCCS-CSRF": "1", "Sec-Fetch-Site": "cross-site"})))
        self.assertFalse(SERVICE._same_origin_request(self.request(**{"X-VNCCS-CSRF": "1", "Host": "localhost:8188", "Origin": "https://evil.invalid"})))

    def test_only_listed_download_steps_run(self):
        spec = REGISTRY.load_specs()["unimate-preview"]
        with self.assertRaises(ValueError):
            SERVICE.run_setup_download(spec, "code", "t1")
        with self.assertRaises(ValueError):
            SERVICE.run_setup_download(spec, "nope", "t1")


class ManagerPolicyTests(unittest.TestCase):
    def test_defaults_without_a_config(self):
        policy = MANAGER_POLICY.parse_policy("")
        self.assertEqual(policy, {"security_level": "normal", "allow_pip_install": False, "allow_git_url_install": False})

    def test_reads_flags_from_the_default_section(self):
        text = "[default]\nsecurity_level = Normal-\nallow_pip_install = True\n[other]\nallow_git_url_install = true\n"
        policy = MANAGER_POLICY.parse_policy(text)
        self.assertEqual(policy["security_level"], "normal-")
        self.assertTrue(policy["allow_pip_install"])
        self.assertFalse(policy["allow_git_url_install"])

    def test_install_policy_reports_the_listener(self):
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "config.ini")
            Path(path).write_text("[default]\nallow_pip_install = true\nallow_git_url_install = true\n")
            local = MANAGER_POLICY.install_policy(path, listen="127.0.0.1")
            self.assertTrue(local["flags_enabled"])
            self.assertTrue(local["listener_is_loopback"])
            self.assertFalse(MANAGER_POLICY.install_policy(path, listen="0.0.0.0")["listener_is_loopback"])
            self.assertFalse(MANAGER_POLICY.install_policy(path, listen="127.0.0.1,0.0.0.0")["listener_is_loopback"])

    def test_policy_reading_never_writes(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.ini"
            path.write_text("[default]\nsecurity_level = normal\n")
            before = path.read_text()
            MANAGER_POLICY.install_policy(str(path), listen="127.0.0.1")
            self.assertEqual(path.read_text(), before)
            self.assertEqual(sorted(p.name for p in Path(folder).iterdir()), ["config.ini"])


class CharacterCountTests(unittest.TestCase):
    def test_models_default_to_one_character(self):
        for spec in REGISTRY.load_specs().values():
            self.assertEqual(spec.public()["capabilities"]["max_characters"], 1)

    def test_more_characters_than_the_model_supports_are_rejected(self):
        payload = RequestTests.payload(RequestTests(), characters=2)
        with self.assertRaisesRegex(ValueError, "one character at a time"):
            SERVICE.parse_generation_request(payload)
        self.assertEqual(SERVICE.parse_generation_request(RequestTests.payload(RequestTests()))[1].characters, 1)

    def test_invalid_max_characters_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "max_characters"):
            BASE.MotionModelSpec.from_dict({"id": "x", "backend": "kimodo", "capabilities": {"max_characters": 0}})


class RequestTests(unittest.TestCase):
    def payload(self, **overrides):
        keypoints, _, _, _ = world_keypoints()
        data = {"prompt": "  a person  jumps ", "keypoints": {k: v.tolist() for k, v in keypoints.items()}}
        data.update(overrides)
        return data

    def test_valid_request_is_clamped_to_the_model(self):
        spec, request, task_id = SERVICE.parse_generation_request(
            self.payload(model="kimodo-soma-rp-v1.1", duration=99, seed=7, steps=3, task_id="a b/c"),
        )
        self.assertEqual(spec.id, "kimodo-soma-rp-v1.1")
        self.assertEqual(request.prompt, "a person jumps")
        self.assertEqual(request.duration, 10.0)
        self.assertEqual(request.seed, 7)
        self.assertEqual(request.steps, 10)
        self.assertIsNone(request.guidance)
        self.assertEqual(task_id, "abc")

        spec, request, _ = SERVICE.parse_generation_request(self.payload(model="hy-motion-1.0-lite", guidance=50))
        self.assertEqual(spec.backend, "hymotion")
        self.assertEqual(request.guidance, 10.0)
        self.assertEqual(request.steps, 50)

    def test_missing_or_negative_seed_is_randomized(self):
        for seed in (None, "", -1, "abc"):
            _, request, _ = SERVICE.parse_generation_request(self.payload(seed=seed))
            self.assertGreaterEqual(request.seed, 0)
            self.assertLessEqual(request.seed, SERVICE.MAX_SEED)

    def test_invalid_requests_are_rejected(self):
        for data, message in (
            (self.payload(prompt="   "), "prompt"),
            (self.payload(prompt="x" * (SERVICE.MAX_PROMPT_CHARS + 1)), "longer"),
            (self.payload(model="other"), "unknown"),
            (self.payload(keypoints={}), "landmarks"),
            ([], "object"),
        ):
            with self.assertRaisesRegex(ValueError, message):
                SERVICE.parse_generation_request(data)


class FakeSkeleton:
    def __init__(self):
        self.bone_order_names = list(SOMA_NAMES)
        self.joint_parents = np.array(SOMA_PARENTS)
        self.neutral_joints = SOMA_REST.copy()
        self.device = "cpu"


class FakeModel:
    fps = 30.0

    def __init__(self):
        self.skeleton = FakeSkeleton()
        self.calls = []

    def __call__(self, prompt, num_frames, **kwargs):
        self.calls.append((prompt, num_frames, kwargs))
        for _ in kwargs["progress_bar"](range(3)):
            pass
        start = kwargs["constraint_lst"][0].positions[0] if kwargs["constraint_lst"] else posed_soma({})[0]
        frames = np.stack([start + [0.0, 0.0, 0.01 * frame] for frame in range(num_frames)])
        rotations = np.tile(np.eye(3), (num_frames, len(SOMA_NAMES), 1, 1))
        return {"posed_joints": frames, "global_rot_mats": rotations}


class FakeConstraint:
    def __init__(self, skeleton, frame_indices, global_joints_positions, global_joints_rots):
        self.frame_indices = frame_indices
        self.positions = global_joints_positions
        self.rotations = global_joints_rots


def _stub_torch():
    torch = types.ModuleType("torch")
    torch.float32 = "float32"
    torch.tensor = lambda value, dtype=None, device=None: np.asarray(value)
    torch.as_tensor = lambda value: np.asarray(value)
    torch.device = lambda name: name
    torch.zeros = lambda *shape, device=None: np.zeros(shape)
    torch.no_grad = contextlib.nullcontext
    torch.cuda = types.SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None)
    return torch


def _stub_kimodo():
    return types.SimpleNamespace(FullBodyConstraintSet=FakeConstraint, seed_everything=lambda seed: None)


class RunnerTestCase(unittest.TestCase):
    #: Runner tests use fake models and must never download the managed weights.
    downloads_weights = False

    def setUp(self):
        SERVICE.unload_model()
        self._saved = {}
        if not self.downloads_weights:
            patcher = mock.patch.object(BASE.MotionBackend, "ensure_weights", lambda self, report, sources=None: {})
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        SERVICE._LOADED.update(id=None, backend=None)
        for name, module in self._saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def install(self, modules):
        for name, module in modules.items():
            self._saved.setdefault(name, sys.modules.get(name))
            sys.modules[name] = module

    def request(self, **overrides):
        return SERVICE.parse_generation_request(RequestTests.payload(RequestTests(), **overrides))

    def vendored(self, backend_module, backend_class, model, namespace):
        """Replace the vendored model code: load_vendored returns ``model``, _vendor ``namespace``."""
        self.install({"torch": _stub_torch()})
        for patcher in (
            mock.patch.object(backend_module, "_vendor", lambda: namespace),
            mock.patch.object(BASE.MotionBackend, "load_vendored", lambda self, family, report, device: model),
            mock.patch.object(backend_class, "requires", ()),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def missing_transformers(self):
        patcher = mock.patch.object(BASE, "module_missing", side_effect=lambda name: name == "transformers")
        patcher.start()
        self.addCleanup(patcher.stop)


class KimodoRunnerTests(RunnerTestCase):
    def test_generation_constrains_frame_zero_and_returns_pose_studio_motion(self):
        model = FakeModel()
        self.vendored(KIMODO_BACKEND, KIMODO_BACKEND.KimodoBackend, model, _stub_kimodo())
        spec, request, task_id = self.request(model="kimodo-soma-rp-v1.1", duration=2, seed=11, task_id="job1")

        motion = SERVICE.generate_motion(spec, request, task_id)

        prompt, num_frames, kwargs = model.calls[0]
        self.assertEqual((prompt, num_frames), ("a person jumps", 60))
        self.assertEqual(kwargs["num_denoising_steps"], 100)
        self.assertEqual(len(kwargs["constraint_lst"]), 1)
        self.assertEqual(kwargs["constraint_lst"][0].positions.shape, (1, 77, 3))
        self.assertEqual(motion["frame_count"], 60)
        self.assertEqual(motion["fps"], 30.0)
        self.assertEqual(motion["seed"], 11)
        self.assertEqual(motion["model"], "kimodo-soma-rp-v1.1")
        self.assertTrue(motion["start_pose_constraint"])
        np.testing.assert_allclose(motion["joints"]["Hips"][0], request.keypoints["pelvis"], atol=1e-5)
        self.assertEqual(len(motion["rotations"]["hand_l"]), 60)
        self.assertEqual(SERVICE.get_task("job1")["progress"], 97)

        spec, request, _ = self.request(model="kimodo-soma-rp-v1.1", use_start_pose=False)
        motion = SERVICE.generate_motion(spec, request)
        self.assertEqual(model.calls[1][2]["constraint_lst"], [])
        self.assertFalse(motion["start_pose_constraint"])
        np.testing.assert_allclose(motion["joints"]["Hips"][0], request.keypoints["pelvis"], atol=1e-5)
        self.assertTrue(SERVICE.unload_model())

    def test_vendored_models_need_no_extra_packages(self):
        # Every module the vendored ARDY / Kimodo code imports ships with ComfyUI.
        self.assertEqual(set(KIMODO_BACKEND.VENDORED_REQUIRES),
                         {"torch", "transformers", "safetensors", "einops", "scipy", "yaml", "pydantic", "huggingface_hub"})
        for model_id in ("kimodo-soma-rp-v1.1", "ardy-core-rp-20fps-h40"):
            spec = REGISTRY.load_specs()[model_id]
            self.assertEqual([step["kind"] for step in spec.setup], ["auto"], model_id)
            self.assertTrue(spec.options["repo_id"].startswith("nvidia/"))
            self.assertEqual(set(spec.options["text_encoder"]), {"base", "mntp", "supervised"})

    def test_missing_dependency_reports_it(self):
        self.missing_transformers()
        spec, request, _ = self.request(model="kimodo-soma-rp-v1.1")
        with self.assertRaises(BASE.BackendUnavailable) as caught:
            SERVICE.generate_motion(spec, request)
        self.assertIn("transformers", str(caught.exception))

    def test_models_route_lists_availability(self):
        self.missing_transformers()
        models = {model["id"]: model for model in SERVICE.list_models()}
        self.assertFalse(models["kimodo-soma-rp-v1.1"]["available"])
        self.assertIn("built into VNCCS Utils", models["kimodo-soma-rp-v1.1"]["install_hint"])
        self.assertFalse(models["hy-motion-1.0-lite"]["available"])
        self.assertEqual(len(models["hy-motion-1.0"]["license"]["restricted_territories"]), 3)

    def test_generate_route_reports_a_missing_model_as_503(self):
        self.missing_transformers()
        web = types.ModuleType("aiohttp.web")
        web.json_response = lambda data, status=200: types.SimpleNamespace(data=data, status=status)
        aiohttp = types.ModuleType("aiohttp")
        aiohttp.web = web
        self.install({"aiohttp": aiohttp, "aiohttp.web": web})
        payload = RequestTests.payload(RequestTests(), task_id="job2")

        class Request:
            headers = {"Content-Length": str(len(json.dumps(payload)))}
            can_read_body = True

            async def json(self):
                return payload

        response = asyncio.run(SERVICE.handle_generate(Request()))
        self.assertEqual(response.status, 503)
        self.assertTrue(response.data["model_missing"])
        self.assertIn("built into VNCCS Utils", response.data["install_hint"])
        self.assertEqual(SERVICE.get_task("job2")["status"], "error")


# ARDY Core 27 skeleton built from the SOMA rest pose (same body proportions).
CORE_JOINTS = [
    ("Hips", None, "Hips"), ("Spine", "Hips", "Spine1"), ("Spine1", "Spine", "Spine2"), ("Spine2", "Spine1", None),
    ("Spine3", "Spine2", "Chest"), ("Neck", "Spine3", "Neck1"), ("Head", "Neck", "Head"),
]
for _side in ("Right", "Left"):
    CORE_JOINTS += [
        (f"{_side}Shoulder", "Spine3", f"{_side}Shoulder"), (f"{_side}Arm", f"{_side}Shoulder", f"{_side}Arm"),
        (f"{_side}ForeArm", f"{_side}Arm", f"{_side}ForeArm"), (f"{_side}Hand", f"{_side}ForeArm", f"{_side}Hand"),
        (f"{_side}HandEnd", f"{_side}Hand", f"{_side}HandMiddle2"), (f"{_side}HandThumb1", f"{_side}Hand", f"{_side}HandThumb1"),
    ]
for _side in ("Right", "Left"):
    CORE_JOINTS += [
        (f"{_side}UpLeg", "Hips", f"{_side}Leg"), (f"{_side}Leg", f"{_side}UpLeg", f"{_side}Shin"),
        (f"{_side}Foot", f"{_side}Leg", f"{_side}Foot"), (f"{_side}ToeBase", f"{_side}Foot", f"{_side}ToeBase"),
    ]
CORE_NAMES = [name for name, _, _ in CORE_JOINTS]
CORE_PARENTS = [-1 if parent is None else CORE_NAMES.index(parent) for _, parent, _ in CORE_JOINTS]


def _core_rest():
    rest = []
    for name, _, soma in CORE_JOINTS:
        if soma is None:  # Spine2 sits between SOMA's Spine2 and Chest
            rest.append((SOMA_REST[SOMA_NAMES.index("Spine2")] + SOMA_REST[SOMA_NAMES.index("Chest")]) / 2)
        else:
            rest.append(SOMA_REST[SOMA_NAMES.index(soma)])
    return np.asarray(rest)


CORE_REST = _core_rest()


class FakeArdyModel:
    gen_horizon_len = 40
    num_frames_per_token = 4

    def __init__(self):
        self.skeleton = types.SimpleNamespace(
            bone_order_names=list(CORE_NAMES), joint_parents=np.array(CORE_PARENTS),
            neutral_joints=CORE_REST.copy(), device="cpu",
        )
        self.diffusion = types.SimpleNamespace(num_base_steps=10)
        self.calls = []
        model = self

        class MotionRep:
            fps = 20.0

            def create_conditions_from_constraints_batched(self, constraints, lengths, to_normalize, device):
                return ("observed", constraints), "mask"

            def inverse(self, motion, is_normalized):
                return motion

        self.motion_rep = MotionRep()

    def __call__(self, texts, num_frames, **kwargs):
        self.calls.append((texts, num_frames, kwargs))
        observed = kwargs["observed_motion"]
        start = observed[1][0].positions[0] if observed else CORE_REST - [0, CORE_REST[:, 1].min(), 0]
        frames = np.stack([start + [0.0, 0.0, 0.01 * frame] for frame in range(num_frames)])[None]
        rotations = np.tile(np.eye(3), (1, num_frames, len(CORE_NAMES), 1, 1))
        return {"posed_joints": frames, "global_rot_mats": rotations, "local_rot_mats": None,
                "root_positions": None, "foot_contacts": None}


def _stub_ardy():
    return types.SimpleNamespace(
        FullBodyConstraintSet=FakeConstraint, seed_everything=lambda seed: None,
        to_numpy=lambda value: value, length_to_mask=lambda lengths: "pad",
    )


class ArdyTests(RunnerTestCase):
    def test_ardy_is_the_default_model(self):
        self.assertEqual(SERVICE.default_model_id(), "ardy-core-rp-20fps-h40")
        self.assertTrue(REGISTRY.load_specs()["ardy-core-rp-20fps-h40"].capabilities["start_pose_constraint"])

    def test_core_start_pose_matches_the_mannequin(self):
        keypoints, _, _, _ = world_keypoints()
        solver = ARDY.solver_skeleton(CORE_NAMES, CORE_PARENTS, CORE_REST)
        positions, rotations, transform = SOMA.solve_start_pose(solver, keypoints)
        self.assertEqual(positions.shape, (len(CORE_NAMES), 3))
        self.assertAlmostEqual(float(positions[:, 1].min()), 0.0, places=6)
        # The hip line in the keyframe faces the same way as the mannequin's.
        right, left = (transform.to_pose_studio(positions[CORE_NAMES.index(n)][None])[0] for n in ("RightUpLeg", "LeftUpLeg"))
        self.assertAlmostEqual(TRANSFORM.heading_angle(right, left), TRANSFORM.heading_angle(keypoints["thigh_r"], keypoints["thigh_l"]), places=4)
        # The upper arm points where the mannequin's does.
        arm = positions[CORE_NAMES.index("LeftForeArm")] - positions[CORE_NAMES.index("LeftArm")]
        target = transform.to_pose_studio(positions[[CORE_NAMES.index("LeftArm"), CORE_NAMES.index("LeftForeArm")]])
        wanted = np.asarray(keypoints["lowerarm_l"]) - np.asarray(keypoints["upperarm_l"])
        got = target[1] - target[0]
        self.assertGreater(float(np.dot(got, wanted) / (np.linalg.norm(got) * np.linalg.norm(wanted))), 0.99)
        self.assertGreater(np.linalg.norm(arm), 0)

    def test_generation_constrains_frame_zero_and_lands_on_the_mannequin(self):
        model = FakeArdyModel()
        self.vendored(ARDY, ARDY.ArdyBackend, model, _stub_ardy())
        spec, request, task_id = self.request(duration=2, seed=3, guidance=3, task_id="ardy1")
        self.assertEqual(spec.backend, "ardy")
        motion = SERVICE.generate_motion(spec, request, task_id)
        texts, frames, kwargs = model.calls[0]
        self.assertEqual((texts, frames), (["a person jumps"], 40))
        self.assertEqual(kwargs["num_denoising_steps"], 10)
        self.assertEqual(kwargs["cfg_weight"], (3.0, 2.0))
        self.assertEqual(kwargs["crop_history_length"], 160)
        self.assertEqual(kwargs["observed_motion"][1][0].positions.shape, (1, len(CORE_NAMES), 3))
        self.assertEqual(motion["fps"], 20.0)
        self.assertTrue(motion["start_pose_constraint"])
        np.testing.assert_allclose(motion["joints"]["Hips"][0], request.keypoints["pelvis"], atol=1e-5)
        self.assertIn("LeftHand", motion["joints"])

        spec, request, _ = self.request(use_start_pose=False)
        SERVICE.generate_motion(spec, request)
        self.assertIsNone(model.calls[1][2]["observed_motion"])

    def test_core_motion_rejects_other_skeletons(self):
        with self.assertRaises(ValueError):
            ARDY.core_motion(["Root"], np.zeros((2, 1, 3)), None, 20)


class FakeWorkerBackend:
    """Stands in for a model inside the isolated worker: returns the SMPL-H rest pose moving forward."""

    loads = 0

    def __init__(self, spec, root):
        self.spec = spec

    def check_available(self):
        if self.spec.id == "hy-motion-1.0":
            raise BASE.BackendUnavailable("torch is missing in this environment", "install.sh hymotion")

    def load(self, report):
        FakeWorkerBackend.loads += 1
        report("Loading...", 5)

    def generate(self, request, report):
        report("Generating motion: step 1/1", 50)
        rest = smplh_rest()
        frames = int(round(request.duration * 30))
        return SMPLH.smplh_motion(np.stack([rest + [0, 0, 0.01 * i] for i in range(frames)]), fps=30)

    def unload(self):
        pass


class IsolatedWorkerTests(RunnerTestCase):
    def start_worker(self, root, **kwargs):
        specs = REGISTRY.load_specs()
        worker = RUNTIME.MotionWorker(root, "test", ["unimate-preview", "hy-motion-1.0"], specs=specs,
                                      make_backend=lambda spec: FakeWorkerBackend(spec, root), **kwargs)
        thread = threading.Thread(target=worker.run, kwargs={"poll": 0.01}, daemon=True)
        thread.start()
        for _ in range(200):
            if PROTOCOL.worker_for(root, "unimate-preview"):
                break
            time.sleep(0.01)
        self.addCleanup(lambda: (worker.stop(), thread.join(5)))
        return worker

    def test_payloads_round_trip(self):
        _, request, _ = self.request(duration=2, seed=4)
        back = PROTOCOL.request_from_dict(json.loads(json.dumps(PROTOCOL.request_to_dict(request))))
        self.assertEqual((back.prompt, back.duration, back.seed), (request.prompt, request.duration, request.seed))
        np.testing.assert_allclose(back.keypoints["pelvis"], request.keypoints["pelvis"])
        motion = SMPLH.smplh_motion(smplh_rest()[None], np.tile(np.eye(3), (1, 52, 1, 1)), fps=30)
        again = PROTOCOL.motion_from_dict(json.loads(json.dumps(PROTOCOL.motion_to_dict(motion))))
        np.testing.assert_allclose(again.positions, motion.positions, atol=1e-6)
        self.assertEqual(again.joint_map, motion.joint_map)
        self.assertEqual(again.legs, motion.legs)

    def test_stale_or_foreign_heartbeats_are_ignored(self):
        with tempfile.TemporaryDirectory() as folder:
            PROTOCOL.write_heartbeat(Path(folder), "old", ["x"])
            self.assertIsNotNone(PROTOCOL.worker_for(Path(folder), "x"))
            self.assertIsNone(PROTOCOL.worker_for(Path(folder), "x", now=time.time() + 60))
            PROTOCOL.write_json(PROTOCOL.heartbeat_path(Path(folder), "old"), {"protocol": 99, "models": ["x"], "updated_at": time.time()})
            self.assertIsNone(PROTOCOL.worker_for(Path(folder), "x"))
        with self.assertRaises(ValueError):
            PROTOCOL.safe_name("../escape")

    def test_comfyui_generates_through_the_worker_without_its_model_lock(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(REGISTRY, "default_models_dir", return_value=Path(folder)):
            root = Path(folder)
            self.start_worker(root)
            models = {m["id"]: m for m in SERVICE.list_models()}
            self.assertTrue(models["unimate-preview"]["available"])
            self.assertEqual(models["unimate-preview"]["runner"], "worker")
            worker_step = next(s for s in models["unimate-preview"]["setup"] if s["id"] == "worker")
            self.assertTrue(worker_step["done"])
            # The worker runs but cannot serve this model: the card says why.
            hy = models["hy-motion-1.0"]
            self.assertFalse(hy["available"])
            self.assertIn("torch is missing", next(s for s in hy["setup"] if s["id"] == "worker")["detail"])

            lock = SERVICE._model_operation_lock()
            self.assertTrue(lock.acquire(blocking=False))  # ComfyUI-side work holds the lock...
            try:
                spec, request, task_id = self.request(model="unimate-preview", duration=1, task_id="w1")
                motion = SERVICE.generate_motion(spec, request, task_id)  # ...and the worker job still runs
            finally:
                lock.release()
            self.assertEqual(motion["frame_count"], 30)
            np.testing.assert_allclose(motion["joints"]["Hips"][0], request.keypoints["pelvis"], atol=1e-5)
            self.assertIsNone(SERVICE._LOADED["backend"], "nothing was loaded into ComfyUI")
            leftovers = [p for p in (root / "jobs").rglob("*.json")]
            self.assertEqual(leftovers, [], "job files are cleaned up")

    def test_worker_errors_reach_the_browser(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            worker = self.start_worker(root)
            worker.ready["boom"] = types.SimpleNamespace(id="boom")
            spec, request, _ = self.request(duration=1)
            with self.assertRaises(PROTOCOL.WorkerError) as caught:
                PROTOCOL.run_job(root, "test", "nope", request, lambda *a: None, poll=0.01)
            self.assertTrue(caught.exception.unavailable)

    def test_idle_worker_frees_its_model(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            worker = RUNTIME.MotionWorker(root, "idle", ["unimate-preview"], idle_unload=0.01,
                                          make_backend=lambda spec: FakeWorkerBackend(spec, root))
            worker.probe()
            worker._backend(worker.ready["unimate-preview"], lambda *a: None)
            self.assertIsNotNone(worker.loaded)
            worker.last_job = time.time() - 1
            worker.step()
            self.assertIsNone(worker.loaded)


class FakeTransformer:
    def __init__(self):
        self.hooks = []

    def register_forward_hook(self, hook):
        self.hooks.append(hook)
        return types.SimpleNamespace(remove=lambda: self.hooks.remove(hook))


class FakeHYPipeline:
    output_mesh_fps = 30

    def __init__(self):
        self.motion_transformer = FakeTransformer()
        self._infer_noise_scheduler_cfg = {"validation_steps": 50}
        self.body_model = types.SimpleNamespace(parents=np.array(SMPLH.PARENTS), joint_names=list(SMPLH.JOINT_NAMES))
        self.calls = []

    def generate(self, text, seeds, duration, cfg_scale=None):
        self.calls.append((text, seeds, duration, cfg_scale))
        for _ in range(self._infer_noise_scheduler_cfg["validation_steps"]):
            for hook in list(self.motion_transformer.hooks):
                hook(None, None, None)
        frames = int(round(duration * self.output_mesh_fps))
        rest = smplh_rest()
        keypoints = np.stack([rest + [0.0, 0.0, 0.01 * frame] for frame in range(frames)])[None]
        rot6d = np.tile(np.array([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]), (1, frames, 52, 1))
        return {"keypoints3d": keypoints, "rot6d": rot6d}


class HYMotionRunnerTests(RunnerTestCase):
    def backend(self, models_dir=ROOT / "tests" / "no-such-models-dir"):
        spec = REGISTRY.load_specs()["hy-motion-1.0-lite"]
        return HYMOTION.HYMotionBackend(spec, Path(models_dir))

    def test_generation_is_text_only_and_mapped_from_smplh(self):
        geometry = types.ModuleType("hymotion.utils.geometry")
        geometry.rot6d_to_rotation_matrix = lambda rot6d: np.tile(np.eye(3), (np.asarray(rot6d).shape[0], 1, 1))
        self.install({"torch": _stub_torch(), "hymotion.utils.geometry": geometry})
        backend = self.backend()
        backend.pipeline = FakeHYPipeline()
        spec, request, _ = self.request(model="hy-motion-1.0-lite", duration=2, seed=5, steps=20, guidance=4)
        reports = []

        source = backend.generate(request, lambda message, progress: reports.append(progress))

        self.assertEqual(backend.pipeline.calls, [("a person jumps", [5], 2.0, 4.0)])
        self.assertEqual(backend.pipeline._infer_noise_scheduler_cfg["validation_steps"], 20)
        self.assertEqual(backend.pipeline.motion_transformer.hooks, [])
        self.assertAlmostEqual(max(reports), 95.0)
        self.assertEqual(source.positions.shape, (60, 52, 3))
        self.assertEqual(source.rotations.shape, (60, 52, 3, 3))
        motion = TRANSFORM.motion_to_pose_studio(source, TRANSFORM.align_to_start_pose(source, request.keypoints))
        np.testing.assert_allclose(motion["joints"]["Hips"][0], request.keypoints["pelvis"], atol=1e-6)

    def test_missing_checkout_and_lfs_pointers_are_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            self.install({"torch": _stub_torch(), "transformers": types.ModuleType("transformers"),
                          "yaml": types.ModuleType("yaml"), "torchdiffeq": types.ModuleType("torchdiffeq")})
            backend = self.backend(folder)
            with self.assertRaisesRegex(BASE.BackendUnavailable, "code was not found"):
                backend.check_available()
            self.assertEqual(backend.code_dir(), Path(folder) / "code" / "HY-Motion-1.0")
            code = backend.code_dir() / "hymotion" / "pipeline"
            code.mkdir(parents=True)
            (code / "motion_diffusion.py").write_text("", encoding="utf-8")
            assets = backend.body_model_dir()
            assets.mkdir(parents=True)
            (assets / "kintree.bin").write_bytes(b"version https://git-lfs.github.com/spec/v1\n")
            with self.assertRaisesRegex(BASE.BackendUnavailable, "git-lfs") as caught:
                backend.check_available()
            self.assertIn("git lfs", caught.exception.hint)
            (assets / "kintree.bin").write_bytes(np.array(SMPLH.PARENTS, dtype=np.int32).tobytes())
            backend.check_available()

    def test_relative_config_paths_resolve_against_the_checkout(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "stats").mkdir()
            args = {"mean_std_dir": "stats", "other": "not-a-path", "nested": {"dir": "stats"}, "n": 3}
            resolved = HYMOTION.HYMotionBackend._absolute_paths(args, Path(folder))
        self.assertEqual(resolved["mean_std_dir"], str(Path(folder) / "stats"))
        self.assertEqual(resolved["nested"]["dir"], str(Path(folder) / "stats"))
        self.assertEqual(resolved["other"], "not-a-path")
        self.assertEqual(resolved["n"], 3)


class BuiltInTextEncoderTests(unittest.TestCase):
    def test_nvidia_models_download_the_text_encoder_without_gated_repositories(self):
        for model_id in ("ardy-core-rp-20fps-h40", "kimodo-soma-rp-v1.1"):
            spec = REGISTRY.load_specs()[model_id]
            sources = spec.options["text_encoder"]
            self.assertEqual(set(sources), {"base", "mntp", "supervised"})
            self.assertEqual(sources["base"]["repo_id"], "NousResearch/Meta-Llama-3-8B-Instruct")
            self.assertTrue(all(len(source["revision"]) == 40 for source in sources.values()))
            self.assertFalse(any(source.gated for source in spec.weights))
            self.assertFalse(any(source.managed for source in spec.weights), "the vendored loader downloads them")


class WeightDownloadTests(RunnerTestCase):
    downloads_weights = True

    def test_files_are_fetched_one_by_one_without_credentials(self):
        calls = []

        def fake_download(**kwargs):
            calls.append(kwargs)
            target = Path(kwargs["local_dir"]) / kwargs["filename"]
            target.parent.mkdir(parents=True, exist_ok=True)
            if kwargs["filename"] == "model.safetensors.index.json":
                target.write_text(json.dumps({"weight_map": {"a": "part-1.safetensors", "b": "part-2.safetensors"}}))
            elif kwargs["filename"] == "preprocessor_config.json":
                raise type("EntryNotFoundError", (Exception,), {})("missing")
            else:
                target.write_bytes(b"x")

        hub = types.ModuleType("huggingface_hub")
        hub.hf_hub_download = fake_download
        self.install({"huggingface_hub": hub})
        spec = BASE.MotionModelSpec.from_dict({"id": "x", "backend": "hymotion", "weights": [
            {"role": "text_encoder_llm", "repo_id": "org/repo", "local_dir": "enc",
             "files": ["config.json"], "optional_files": ["preprocessor_config.json"],
             "index_file": "model.safetensors.index.json"}]})
        with tempfile.TemporaryDirectory() as folder:
            backend = HYMOTION.HYMotionBackend(spec, Path(folder))
            roles = backend.ensure_weights(lambda *_: None)
            names = sorted(call["filename"] for call in calls)
            self.assertEqual(roles, {"text_encoder_llm": Path(folder) / "enc"})
            self.assertEqual(names, ["config.json", "model.safetensors.index.json", "part-1.safetensors",
                                     "part-2.safetensors", "preprocessor_config.json"])
            self.assertTrue(all(call["token"] is False for call in calls))
            calls.clear()
            backend.ensure_weights(lambda *_: None)
            self.assertEqual([call["filename"] for call in calls], ["preprocessor_config.json"])

    def test_managed_weights_must_list_their_files(self):
        with self.assertRaisesRegex(ValueError, "list the files"):
            BASE.WeightSource.from_dict({"role": "model", "repo_id": "org/repo", "local_dir": "m"})


class SafePathTests(unittest.TestCase):
    def test_paths_stay_inside_the_models_folder(self):
        self.assertEqual(BASE.safe_relative_path("code/HY-Motion-1.0/", "x"), "code/HY-Motion-1.0")
        for bad in ("../x", "/abs", "a/../../b", "", "a b", "C:\\x"):
            with self.assertRaises(ValueError, msg=bad):
                BASE.safe_relative_path(bad, "x")


if __name__ == "__main__":
    unittest.main()
