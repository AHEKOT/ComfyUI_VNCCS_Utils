"""NVIDIA ARDY backend (https://github.com/nv-tlabs/ardy).

ARDY is NVIDIA's autoregressive successor to Kimodo, built for real-time
generation. Its released checkpoints use the 27-joint "Core" skeleton, whose joint
names are the Mixamo-style Pose Studio motion keys. Like Kimodo it accepts full-body
keyframes, so the mannequin's current pose becomes a frame-0 constraint. ARDY's
inference code is vendored (api/text_to_motion/vendor) and runs in ComfyUI's own
Python; its checkpoint and the shared LLM2Vec text encoder are downloaded once into
models/text_to_motion. Foot-skate post-processing (a C++ extension upstream) is not
available.
"""

from __future__ import annotations

import numpy as np

from .base import (
    MotionBackend,
    MotionRequest,
    empty_torch_cache,
    free_comfy_vram,
    torch_device,
)
from .kimodo_backend import VENDORED_REQUIRES
from .soma import SomaSkeleton, solve_start_pose
from .transform import SourceMotion


# Core joints renamed to the SOMA joint that plays the same role, so the SOMA start-pose
# solver (soma.solve_start_pose) can drive a Core skeleton. Joints without a counterpart
# keep their parent's rotation in the keyframe.
CORE_TO_SOMA = {
    "Hips": "Hips",
    "Spine": "Spine1",
    "Spine1": "Spine2",
    "Spine3": "Chest",
    "Neck": "Neck1",
    "Head": "Head",
}
for _side in ("Left", "Right"):
    CORE_TO_SOMA.update({
        f"{_side}Shoulder": f"{_side}Shoulder",
        f"{_side}Arm": f"{_side}Arm",
        f"{_side}ForeArm": f"{_side}ForeArm",
        f"{_side}Hand": f"{_side}Hand",
        # The hand end points along the middle finger, which the hand triad uses.
        f"{_side}HandEnd": f"{_side}HandMiddle2",
        f"{_side}UpLeg": f"{_side}Leg",
        f"{_side}Leg": f"{_side}Shin",
        f"{_side}Foot": f"{_side}Foot",
        f"{_side}ToeBase": f"{_side}ToeBase",
    })

# Pose Studio motion keys -> Core joints.
MOTION_JOINTS = {"Hips": "Hips", "Spine": "Spine", "Spine1": "Spine2", "Spine2": "Spine3", "Neck": "Neck", "Head": "Head"}
for _side in ("Left", "Right"):
    for _part in ("Shoulder", "Arm", "ForeArm", "Hand", "UpLeg", "Leg", "Foot", "ToeBase"):
        MOTION_JOINTS[f"{_side}{_part}"] = f"{_side}{_part}"

MOTION_ROTATIONS = {"head": "Head", "hand_l": "LeftHand", "hand_r": "RightHand", "foot_l": "LeftFoot", "foot_r": "RightFoot"}


def solver_skeleton(joint_names, parents, rest_positions) -> SomaSkeleton:
    """A Core skeleton under SOMA names (unmatched joints keep a unique placeholder name)."""
    names = [CORE_TO_SOMA.get(name, f"_core_{name}") for name in joint_names]
    return SomaSkeleton(names, parents, rest_positions)


def core_motion(joint_names, posed_joints, global_rotations, fps: float) -> SourceMotion:
    """Wrap ARDY Core output ([T,J,3] positions, [T,J,3,3] rotations, optional batch dim)."""
    positions = np.asarray(posed_joints, dtype=np.float64)
    rotations = None if global_rotations is None else np.asarray(global_rotations, dtype=np.float64)
    if positions.ndim == 4:
        positions = positions[0]
    if rotations is not None and rotations.ndim == 5:
        rotations = rotations[0]
    names = list(joint_names)
    if positions.ndim != 3 or positions.shape[1:] != (len(names), 3):
        raise ValueError("unexpected ARDY motion shape")
    if rotations is not None and rotations.shape != positions.shape[:2] + (3, 3):
        rotations = None
    missing = [joint for joint in MOTION_JOINTS.values() if joint not in names]
    if missing:
        raise ValueError(f"the ARDY skeleton lacks {', '.join(missing)}")
    return SourceMotion(
        fps=float(fps),
        joint_names=names,
        positions=positions,
        rotations=rotations,
        joint_map=dict(MOTION_JOINTS),
        rotation_map=dict(MOTION_ROTATIONS),
        hips=("RightUpLeg", "LeftUpLeg"),
        legs=(("RightUpLeg", "RightLeg", "RightFoot"), ("LeftUpLeg", "LeftLeg", "LeftFoot")),
        root="Hips",
    )


def _vendor():
    """The vendored ARDY pieces the backend calls (a function, so tests can replace it)."""
    from types import SimpleNamespace

    from .vendor.ardy.constraints import FullBodyConstraintSet
    from .vendor.ardy.motion_rep.tools import length_to_mask
    from .vendor.ardy.tools import seed_everything, to_numpy

    return SimpleNamespace(FullBodyConstraintSet=FullBodyConstraintSet, length_to_mask=length_to_mask,
                           seed_everything=seed_everything, to_numpy=to_numpy)


class ArdyBackend(MotionBackend):
    requires = VENDORED_REQUIRES

    def __init__(self, spec, models_dir):
        super().__init__(spec, models_dir)
        self.model = None
        self.joint_names = None
        self.skeleton = None

    @property
    def model_name(self) -> str:
        return str(self.spec.options.get("model_name") or "ARDY-Core-RP-20FPS-Horizon40")

    def load(self, report) -> None:
        if self.model is not None:
            return
        self.check_available()
        import torch

        report(f"Loading {self.spec.name} (the first run downloads the model and its text encoder)...", 6)
        free_comfy_vram()
        self.model = self.load_vendored("ardy", report, torch_device(torch))
        skeleton = self.model.skeleton
        parents = skeleton.joint_parents
        rest = skeleton.neutral_joints
        self.joint_names = list(skeleton.bone_order_names)
        self.skeleton = solver_skeleton(
            self.joint_names,
            [int(value) for value in (parents.tolist() if hasattr(parents, "tolist") else parents)],
            rest.detach().cpu().numpy() if hasattr(rest, "detach") else np.asarray(rest),
        )

    def _start_pose_constraint(self, positions, rotations):
        import torch

        FullBodyConstraintSet = _vendor().FullBodyConstraintSet
        device = getattr(self.model.skeleton, "device", None) or self.model.skeleton.joint_parents.device
        return FullBodyConstraintSet(
            self.model.skeleton,
            frame_indices=torch.tensor([0]),
            global_joints_positions=torch.tensor(positions[None], dtype=torch.float32, device=device),
            global_joints_rots=torch.tensor(rotations[None], dtype=torch.float32, device=device),
        )

    @staticmethod
    def _history_frames(fps: float, horizon: int, patch: int) -> int:
        """Longest history that fits ARDY's trained 10 s window (as scripts/generate.py does)."""
        window = (int(10 * fps) // patch) * patch
        return max(patch, ((window - horizon) // patch) * patch)

    def generate(self, request: MotionRequest, report):
        import torch

        vendor = _vendor()
        length_to_mask, seed_everything, to_numpy = vendor.length_to_mask, vendor.seed_everything, vendor.to_numpy
        model = self.model
        device = next(model.parameters()).device if hasattr(model, "parameters") else torch_device(torch)
        constraints = []
        if request.use_start_pose:
            report("Converting the current pose into an ARDY keyframe...", 12)
            positions, rotations, _ = solve_start_pose(
                self.skeleton, request.keypoints, request.head_axes, request.rest_keypoints or None,
            )
            constraints.append(self._start_pose_constraint(positions, rotations))

        seed_everything(request.seed)
        fps = float(model.motion_rep.fps)
        frames = max(2, int(round(request.duration * fps)))
        lengths = torch.tensor([frames], device=device)
        observed, mask = None, None
        if constraints:
            observed, mask = model.motion_rep.create_conditions_from_constraints_batched(
                constraints, lengths, to_normalize=True, device=device,
            )
        steps = int(model.diffusion.num_base_steps)
        if request.steps:
            steps = max(1, min(steps, int(request.steps)))
        text_weight = float(request.guidance or self.spec.capabilities["guidance"]["default"])
        report("Generating motion...", 20)
        with torch.no_grad():
            motion = model(
                [request.prompt],
                frames,
                num_denoising_steps=steps,
                pad_mask=length_to_mask(lengths),
                first_heading_angle=torch.zeros(1, device=device),
                motion_mask=mask,
                observed_motion=observed,
                cfg_weight=(text_weight, 2.0),
                crop_history_length=self._history_frames(fps, int(model.gen_horizon_len), int(model.num_frames_per_token)),
            )
            output = model.motion_rep.inverse(motion, is_normalized=True)
        # Upstream foot-skate post-processing needs its C++ extension, so the raw output is used.
        output = to_numpy(output)
        return core_motion(self.joint_names, output["posed_joints"], output.get("global_rot_mats"), fps)

    def unload(self) -> None:
        self.model = None
        self.skeleton = None
        self.joint_names = None
        empty_torch_cache()
