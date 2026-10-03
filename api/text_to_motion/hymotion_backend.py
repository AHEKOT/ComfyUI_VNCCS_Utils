"""Tencent HY-Motion 1.0 backend (https://github.com/Tencent-Hunyuan/HY-Motion-1.0).

HY-Motion is text-only: it cannot start from a given pose, so the browser applies
the motion's change since its first frame on top of the mannequin's current pose.
Its code is not a pip package; the user clones the repository (with git-lfs for the
body model assets) and this backend imports it from that folder.
"""

from __future__ import annotations

import functools
import sys
from pathlib import Path

from .base import (
    BackendUnavailable,
    MotionBackend,
    MotionRequest,
    empty_torch_cache,
    free_comfy_vram,
    safe_relative_path,
    torch_device,
)
from .smplh import smplh_motion


_LFS_POINTER_PREFIX = b"version https://git-lfs"
_CODE_MARKER = "hymotion/pipeline/motion_diffusion.py"


class HYMotionBackend(MotionBackend):
    requires = ("torch", "transformers", "yaml", "torchdiffeq")

    def __init__(self, spec, models_dir):
        super().__init__(spec, models_dir)
        self.pipeline = None

    # --- code checkout -----------------------------------------------------------

    def code_dir(self) -> Path:
        return self.find_code_dir("code/HY-Motion-1.0")

    def body_model_dir(self) -> Path:
        relative = self.spec.options.get("body_model_dir") or "scripts/gradio/static/assets/dump_wooden"
        return self.code_dir() / safe_relative_path(relative, "options.body_model_dir")

    def _body_model_pulled(self) -> bool:
        kintree = self.body_model_dir() / "kintree.bin"
        try:
            head = kintree.read_bytes()[: len(_LFS_POINTER_PREFIX)]
        except OSError:
            head = b""
        return bool(head) and head != _LFS_POINTER_PREFIX

    def check_part(self, name: str):
        if name == "code":
            return (self.code_dir() / _CODE_MARKER).is_file()
        if name == "body_model":
            return self._body_model_pulled()
        if name == "weights":
            return self.weights_ready()
        return None

    def check_available(self) -> None:
        super().check_available()
        code = self.code_dir()
        if not (code / _CODE_MARKER).is_file():
            raise BackendUnavailable(f"The {self.spec.name} code was not found in {code}.", self.install_hint())
        kintree = self.body_model_dir() / "kintree.bin"
        if not self._body_model_pulled():
            raise BackendUnavailable(
                f"The {self.spec.name} body model files in {kintree.parent} are missing or not pulled with git-lfs.",
                self.install_hint(),
            )

    # --- loading -----------------------------------------------------------------

    @staticmethod
    def _absolute_paths(args: dict, root: Path) -> dict:
        """Config paths such as the motion statistics folder are relative to the checkout."""
        resolved = {}
        for key, value in args.items():
            if isinstance(value, str) and value and not Path(value).is_absolute() and (root / value).exists():
                resolved[key] = str(root / value)
            elif isinstance(value, dict):
                resolved[key] = HYMotionBackend._absolute_paths(value, root)
            else:
                resolved[key] = value
        return resolved

    def load(self, report) -> None:
        if self.pipeline is not None:
            return
        self.check_available()
        code = str(self.code_dir())
        if code not in sys.path:
            sys.path.insert(0, code)
        try:
            import torch
            import yaml
            from hymotion.network.text_encoders import text_encoder
            from hymotion.pipeline import motion_diffusion
            from hymotion.pipeline.body_model import WoodenMesh
            from hymotion.utils.loaders import load_object
        except ImportError as exc:
            raise BackendUnavailable(f"{self.spec.name} could not be imported: {exc}", self.install_hint()) from exc

        roles = self.ensure_weights(report)
        if "model" not in roles:
            raise ValueError(f"{self.spec.id}: no weights with role 'model'")
        checkpoint = roles["model"] / safe_relative_path(self.spec.options.get("checkpoint_subdir") or ".", "options.checkpoint_subdir")
        config_path, weights_path = checkpoint / "config.yml", checkpoint / "latest.ckpt"
        if not config_path.is_file() or not weights_path.is_file():
            raise FileNotFoundError(f"{self.spec.name} checkpoint is incomplete in {checkpoint}")

        # Point the text encoders and body model at our downloads instead of the
        # repository's working-directory-relative defaults.
        if "text_encoder_llm" in roles:
            text_encoder.LLM_ENCODER_LAYOUT["qwen3"]["module_path"] = str(roles["text_encoder_llm"])
        if "text_encoder_clip" in roles:
            text_encoder.SENTENCE_EMB_LAYOUT["clipl"]["module_path"] = str(roles["text_encoder_clip"])
        motion_diffusion.WoodenMesh = functools.partial(WoodenMesh, model_path=str(self.body_model_dir()))

        report(f"Loading {self.spec.name} and its text encoders...", 8)
        free_comfy_vram()
        with open(config_path, "r", encoding="utf-8") as handle:
            config = yaml.safe_load(handle)
        pipeline = load_object(
            config["train_pipeline"],
            self._absolute_paths(dict(config["train_pipeline_args"]), Path(code)),
            network_module=config["network_module"],
            network_module_args=config["network_module_args"],
        )
        pipeline.load_in_demo(str(weights_path), build_text_encoder=True)
        pipeline.to(torch_device(torch))
        pipeline.eval()
        self.pipeline = pipeline

    # --- generation --------------------------------------------------------------

    def generate(self, request: MotionRequest, report):
        import torch
        from hymotion.utils.geometry import rot6d_to_rotation_matrix

        pipeline = self.pipeline
        steps = int(request.steps or self.spec.capabilities["steps"]["default"])
        scheduler = getattr(pipeline, "_infer_noise_scheduler_cfg", None)
        if isinstance(scheduler, dict):
            scheduler["validation_steps"] = steps

        calls = {"count": 0}

        def on_step(*_args):
            calls["count"] += 1
            report(f"Generating motion: step {min(calls['count'], steps)}/{steps}", 15 + 80 * min(1.0, calls["count"] / steps))

        report("Encoding the prompt...", 12)
        hook = pipeline.motion_transformer.register_forward_hook(on_step)
        try:
            output = pipeline.generate(request.prompt, [int(request.seed)], float(request.duration), cfg_scale=request.guidance)
        finally:
            hook.remove()

        positions = output["keypoints3d"]
        rot6d = output.get("rot6d")
        local = None
        if rot6d is not None:
            rot6d = torch.as_tensor(rot6d)
            matrices = rot6d_to_rotation_matrix(rot6d.reshape(-1, 6)).reshape(*rot6d.shape[:-1], 3, 3)
            local = matrices.cpu().numpy() if hasattr(matrices, "cpu") else matrices
        body = getattr(pipeline, "body_model", None)
        parents = getattr(body, "parents", None)
        names = getattr(body, "joint_names", None)
        return smplh_motion(
            positions.cpu().numpy() if hasattr(positions, "cpu") else positions,
            local,
            fps=float(getattr(pipeline, "output_mesh_fps", 30)),
            joint_names=list(names) if names else None,
            parents=parents.tolist() if hasattr(parents, "tolist") else parents,
        )

    def unload(self) -> None:
        self.pipeline = None
        empty_torch_cache()
