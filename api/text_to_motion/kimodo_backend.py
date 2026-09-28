"""NVIDIA Kimodo backend (https://github.com/nv-tlabs/kimodo).

Kimodo generates on the SOMA skeleton and accepts a full-body keyframe, so the
mannequin's current pose becomes a frame-0 constraint and the motion starts
exactly there. Kimodo downloads its checkpoint and text encoder itself (into the
Hugging Face cache, or $CHECKPOINT_DIR / $TEXT_ENCODERS_DIR when the user sets them).
"""

from __future__ import annotations

from .base import (
    BackendUnavailable,
    MotionBackend,
    MotionRequest,
    empty_torch_cache,
    free_comfy_vram,
    torch_device,
)
from .soma import SomaSkeleton, soma_motion, solve_start_pose


class KimodoBackend(MotionBackend):
    requires = ("torch", "kimodo")

    def __init__(self, spec, models_dir):
        super().__init__(spec, models_dir)
        self.model = None
        self.skeleton = None

    @property
    def model_name(self) -> str:
        return str(self.spec.options.get("model_name") or "Kimodo-SOMA-RP-v1.1")

    def load(self, report) -> None:
        if self.model is not None:
            return
        try:
            import torch
            from kimodo import load_model
        except ImportError as exc:
            raise BackendUnavailable(f"{self.spec.name} is not installed.", self.install_hint()) from exc

        self.ensure_weights(report)
        report(f"Loading {self.spec.name} (the first run downloads the model and its text encoder)...", 6)
        free_comfy_vram()
        self.model = load_model(self.model_name, device=torch_device(torch))
        self.skeleton = self._soma_skeleton(self.model)

    @staticmethod
    def _soma_skeleton(model) -> SomaSkeleton:
        skeleton = model.skeleton
        parents = skeleton.joint_parents
        rest = skeleton.neutral_joints
        return SomaSkeleton(
            list(skeleton.bone_order_names),
            [int(value) for value in (parents.tolist() if hasattr(parents, "tolist") else parents)],
            rest.detach().cpu().numpy() if hasattr(rest, "detach") else rest,
        )

    def _start_pose_constraint(self, positions, rotations):
        import torch
        from kimodo.constraints import FullBodyConstraintSet

        device = getattr(self.model.skeleton, "device", "cpu")
        return FullBodyConstraintSet(
            self.model.skeleton,
            frame_indices=torch.tensor([0]),
            global_joints_positions=torch.tensor(positions[None], dtype=torch.float32, device=device),
            global_joints_rots=torch.tensor(rotations[None], dtype=torch.float32, device=device),
        )

    @staticmethod
    def _progress_bar(report, steps: int):
        def wrap(iterable, *args, **kwargs):
            items = list(iterable)
            total = max(1, len(items) or steps)
            for index, item in enumerate(items):
                report(f"Generating motion: step {index + 1}/{total}", 15 + 80 * index / total)
                yield item

        return wrap

    def generate(self, request: MotionRequest, report):
        constraints = []
        if request.use_start_pose:
            report("Converting the current pose into a Kimodo keyframe...", 12)
            positions, rotations, _ = solve_start_pose(
                self.skeleton, request.keypoints, request.head_axes, request.rest_keypoints or None,
            )
            constraints.append(self._start_pose_constraint(positions, rotations))

        from kimodo.tools import seed_everything

        seed_everything(request.seed)
        fps = float(self.model.fps)
        steps = int(request.steps or self.spec.capabilities["steps"]["default"])
        output = self.model(
            request.prompt,
            max(2, int(round(request.duration * fps))),
            num_denoising_steps=steps,
            constraint_lst=constraints,
            post_processing=True,
            return_numpy=True,
            progress_bar=self._progress_bar(report, steps),
        )
        return soma_motion(self.skeleton, output["posed_joints"], output.get("global_rot_mats"), fps)

    def unload(self) -> None:
        self.model = None
        self.skeleton = None
        empty_torch_cache()
