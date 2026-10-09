"""ARDY Core inference with BF16 motion and the prepared ConvRot INT4 encoder.

The current mannequin pose can constrain frame zero. Upstream C++ foot-skate
post-processing is not included.
"""

from __future__ import annotations

import numpy as np

from .base import (
    BackendUnavailable,
    MotionBackend,
    MotionRequest,
    empty_torch_cache,
    free_comfy_vram,
    safe_relative_path,
    torch_device,
)
from .soma import SomaSkeleton, solve_start_pose
from .transform import SourceMotion

VENDORED_REQUIRES = (
    "torch", "transformers", "safetensors", "einops", "yaml", "pydantic",
    "huggingface_hub", "numpy", "tqdm",
)


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

MOTION_ROTATIONS = {
    "pelvis": "Hips", "spine_01": "Spine", "spine_02": "Spine2", "spine_03": "Spine3",
    "neck_01": "Neck", "head": "Head",
}
for _side, _suffix in (("Left", "l"), ("Right", "r")):
    for _bone, _joint in (("clavicle", "Shoulder"), ("upperarm", "Arm"), ("lowerarm", "ForeArm"),
                         ("hand", "Hand"), ("thigh", "UpLeg"), ("calf", "Leg"),
                         ("foot", "Foot"), ("ball", "ToeBase")):
        MOTION_ROTATIONS[f"{_bone}_{_suffix}"] = f"{_side}{_joint}"


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

    def check_part(self, name: str):
        compact = self.spec.options.get("compact_dir")
        if name == "compact" and compact:
            folder = self.models_dir / safe_relative_path(compact, "options.compact_dir")
            motion_file = "motion.bf16.safetensors" if self.spec.options.get("motion_precision") == "bf16" else "motion.safetensors"
            source = next(source for source in self.spec.weights if source.local_dir == compact)
            return all(self.weight_file_ready(source, file, folder) for file in (
                "config.yaml", motion_file, "text_encoder/config.json",
                "text_encoder/model.safetensors", "text_encoder/tokenizer.json",
                "stats/motion/mean.npy", "stats/motion/std.npy", "stats/pre_quantization/mean.npy",
                "stats/pre_quantization/std.npy", "stats/post_quantization/mean.npy", "stats/post_quantization/std.npy",
            ))
        return super().check_part(name)

    def check_available(self) -> None:
        if not self.spec.options.get("compact_dir"):
            raise BackendUnavailable("ARDY requires the compact ConvRot INT4 model files.", self.install_hint())
        super().check_available()
        if self.spec.options.get("compact_dir"):
            if not self.check_part("compact"):
                raise BackendUnavailable("The compact ConvRot INT4 files are missing or incomplete.", self.install_hint())
            try:
                from comfy_kitchen.tensor import TensorCoreConvRotW4A4Layout  # noqa: F401
            except ImportError as exc:
                raise BackendUnavailable("This compact model needs comfy-kitchen with ConvRot W4A4 support.",
                                         "Update ComfyUI's supported comfy-kitchen dependency.") from exc

    def run_download(self, step: dict, report) -> None:
        if step.get("check") != "compact":
            return super().run_download(step, report)
        self.ensure_weights(report)
        if not self.check_part("compact"):
            raise BackendUnavailable("The downloaded BF16 motion / INT4 encoder bundle is incomplete.", self.install_hint())

    def load(self, report) -> None:
        if self.model is not None:
            return
        self.check_available()
        import torch

        report(f"Loading {self.spec.name}...", 6)
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
        from contextlib import nullcontext

        use_bf16 = self.spec.options.get("motion_precision") == "bf16" and str(device).startswith("cuda")
        precision = torch.autocast("cuda", dtype=torch.bfloat16) if use_bf16 else nullcontext()
        with torch.no_grad(), precision:
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
        # Keep skeleton reconstruction and motion statistics outside neural autocast.
        with torch.no_grad():
            output = model.motion_rep.inverse(motion.float() if use_bf16 else motion, is_normalized=True)
        # Upstream foot-skate post-processing needs its C++ extension, so the raw output is used.
        output = to_numpy(output)
        return core_motion(self.joint_names, output["posed_joints"], output.get("global_rot_mats"), fps)

    def unload(self) -> None:
        self.model = None
        self.skeleton = None
        self.joint_names = None
        from .vendor.loaders import release_text_encoder

        release_text_encoder()
        empty_torch_cache()
