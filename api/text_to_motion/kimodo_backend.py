"""NVIDIA Kimodo backend (https://github.com/nv-tlabs/kimodo).

Kimodo generates on the SOMA skeleton and accepts a full-body keyframe, so the
mannequin's current pose becomes a frame-0 constraint and the motion starts
exactly there. Kimodo's inference code is vendored (api/text_to_motion/vendor) and
runs in ComfyUI's own Python; its checkpoint and the shared LLM2Vec text encoder are
downloaded once into models/text_to_motion. Foot-skate post-processing (a C++
extension upstream) is not available.
"""

from __future__ import annotations

from .base import (
    MotionBackend,
    MotionRequest,
    empty_torch_cache,
    free_comfy_vram,
    torch_device,
)
from .soma import SomaSkeleton, soma_motion, solve_start_pose

# Python modules the vendored code needs; all of them ship with ComfyUI.
VENDORED_REQUIRES = ("torch", "transformers", "safetensors", "einops", "scipy", "yaml", "pydantic", "huggingface_hub")


def _vendor():
    """The vendored Kimodo pieces the backend calls (a function, so tests can replace it)."""
    from types import SimpleNamespace

    from .vendor.kimodo.constraints import FullBodyConstraintSet
    from .vendor.kimodo.tools import seed_everything

    return SimpleNamespace(FullBodyConstraintSet=FullBodyConstraintSet, seed_everything=seed_everything)


class KimodoBackend(MotionBackend):
    requires = VENDORED_REQUIRES

    def __init__(self, spec, models_dir):
        super().__init__(spec, models_dir)
        self.model = None
        self.skeleton = None
        self.output_skeleton = None

    @property
    def model_name(self) -> str:
        return str(self.spec.options.get("model_name") or "Kimodo-SOMA-RP-v1.1")

    def load(self, report) -> None:
        if self.model is not None:
            return
        self.check_available()
        import torch

        report(f"Loading {self.spec.name} (the first run downloads the model and its text encoder)...", 6)
        free_comfy_vram()
        self.model = self.load_vendored("kimodo", report, torch_device(torch))
        # Kimodo-SOMA works on a 30-joint skeleton (the keyframe uses it) and returns the motion
        # expanded to the 77-joint one with relaxed hands.
        self.skeleton = self._soma_skeleton(self.model.skeleton)
        self.output_skeleton = self._soma_skeleton(getattr(self.model.skeleton, "somaskel77", self.model.skeleton))

    @staticmethod
    def _soma_skeleton(skeleton) -> SomaSkeleton:
        parents = skeleton.joint_parents
        rest = skeleton.neutral_joints
        return SomaSkeleton(
            list(skeleton.bone_order_names),
            [int(value) for value in (parents.tolist() if hasattr(parents, "tolist") else parents)],
            rest.detach().cpu().numpy() if hasattr(rest, "detach") else rest,
        )

    def _start_pose_constraint(self, positions, rotations):
        import torch

        FullBodyConstraintSet = _vendor().FullBodyConstraintSet
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

        _vendor().seed_everything(request.seed)
        fps = float(self.model.fps)
        steps = int(request.steps or self.spec.capabilities["steps"]["default"])
        output = self.model(
            request.prompt,
            max(2, int(round(request.duration * fps))),
            num_denoising_steps=steps,
            num_samples=1,  # keeps the batch dimension Kimodo's output conversion expects
            constraint_lst=constraints,
            post_processing=False,  # needs the upstream C++ motion_correction extension
            return_numpy=True,
            progress_bar=self._progress_bar(report, steps),
        )
        return soma_motion(self.output_skeleton, output["posed_joints"], output.get("global_rot_mats"), fps)

    def unload(self) -> None:
        self.model = None
        self.skeleton = None
        self.output_skeleton = None
        empty_torch_cache()
