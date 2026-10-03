"""UniMate backend (https://github.com/Friedrich-M/UniMate, SIGGRAPH Asia 2026).

UniMate animates arbitrary skeletons from text with one model. Its skeleton
conditioning comes from the canonicalized UniML3D features
(``dataset/features/<dataset>/``), so the backend picks one humanoid object type
from those features (a Mixamo character by default, whose joint names match the
Pose Studio motion keys) and maps the generated joints onto the mannequin.

UniMate is text-only (no start-pose keyframe) and generates a fixed 60-frame
window at 30 fps. Its code is not a pip package: the user clones the repository
and downloads the checkpoint folder; this backend imports it from there.
"""

from __future__ import annotations

import glob
import re
import sys
from pathlib import Path

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
from .transform import SourceMotion


_CHECKPOINT_RE = re.compile(r"checkpoint_step_(\d+)\.pt$")
_CODE_MARKER = "unimate/inference/sample.py"

# Mixamo bone names (prefix stripped) are the Pose Studio motion keys.
_MIXAMO_KEYS = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"]
for _side in ("Left", "Right"):
    _MIXAMO_KEYS += [f"{_side}{bone}" for bone in ("Shoulder", "Arm", "ForeArm", "Hand", "UpLeg", "Leg", "Foot", "ToeBase")]


def clean_joint_name(name) -> str:
    """``mixamorig:LeftArm`` / ``mixamorig1_LeftArm`` -> ``LeftArm``."""
    text = str(name).strip()
    for separator in (":", "|"):
        text = text.rsplit(separator, 1)[-1]
    return re.sub(r"^mixamorig\d*_?", "", text, flags=re.IGNORECASE)


def unimate_motion(positions, joint_names, fps: float = 30.0) -> SourceMotion:
    """Wrap UniMate world joint positions [T, J, 3] of a Mixamo-style humanoid."""
    positions = np.asarray(positions, dtype=np.float64)
    names = [clean_joint_name(name) for name in joint_names][: positions.shape[1]]
    if positions.ndim != 3 or positions.shape[2] != 3 or len(names) != positions.shape[1]:
        raise ValueError("unexpected UniMate motion shape")
    lookup = {name.lower(): name for name in names}
    joint_map = {key: lookup[key.lower()] for key in _MIXAMO_KEYS if key.lower() in lookup}
    required = ("Hips", "RightUpLeg", "LeftUpLeg", "RightLeg", "LeftLeg", "RightFoot", "LeftFoot")
    missing = [key for key in required if key not in joint_map]
    if missing:
        raise ValueError(f"the UniMate skeleton is not a Mixamo humanoid (missing {', '.join(missing)})")
    j = joint_map
    return SourceMotion(
        fps=float(fps),
        joint_names=names,
        positions=positions,
        rotations=None,
        joint_map=joint_map,
        rotation_map={},
        hips=(j["RightUpLeg"], j["LeftUpLeg"]),
        legs=((j["RightUpLeg"], j["RightLeg"], j["RightFoot"]), (j["LeftUpLeg"], j["LeftLeg"], j["LeftFoot"])),
        root=j["Hips"],
    )


def latest_checkpoint(folder: Path) -> Path | None:
    candidates = glob.glob(str(Path(folder) / "checkpoints" / "checkpoint_step_*.pt"))

    def step(path):
        match = _CHECKPOINT_RE.search(Path(path).name)
        return int(match.group(1)) if match else -1

    return Path(max(candidates, key=step)) if candidates else None


def pick_checkpoint_files(names, subdir: str = "") -> dict:
    """From a Hub file listing pick one experiment folder's config.json, dataset_stats.npy and its
    newest checkpoint. ``subdir`` chooses the folder; otherwise the first one that has a config."""
    names = [str(name) for name in names]
    configs = sorted(name for name in names if name.rsplit("/", 1)[-1] == "config.json")
    if subdir:
        prefix = subdir.strip("/") + "/"
        configs = [name for name in configs if name == prefix + "config.json"]
    if not configs:
        raise ValueError("the repository has no config.json" + (f" in {subdir!r}" if subdir else ""))
    for config in configs:
        prefix = config[: -len("config.json")]
        checkpoints = [n for n in names if n.startswith(prefix + "checkpoints/") and _CHECKPOINT_RE.search(n)]
        if not checkpoints:
            continue
        newest = max(checkpoints, key=lambda n: int(_CHECKPOINT_RE.search(n).group(1)))
        files = [config, newest]
        if prefix + "dataset_stats.npy" in names:
            files.insert(1, prefix + "dataset_stats.npy")
        return {"prefix": prefix, "files": files}
    raise ValueError("the repository has no checkpoints/checkpoint_step_*.pt next to a config.json")


class UniMateBackend(MotionBackend):
    requires = ("torch", "transformers", "torchdiffeq", "einops")

    def __init__(self, spec, models_dir):
        super().__init__(spec, models_dir)
        self.model = None
        self.config = None
        self.dataset = None
        self.encoder = None
        self.diffusion = None
        self.sampler = None
        self.device = None

    # --- folders -----------------------------------------------------------------

    def _folder(self, key: str, default: str) -> Path:
        return self.models_dir / safe_relative_path(self.spec.options.get(key) or default, f"options.{key}")

    def code_dir(self) -> Path:
        return self.find_code_dir("code/UniMate")

    def checkpoint_dir(self) -> Path:
        return self._folder("checkpoint_dir", "UniMate")

    def features_dir(self) -> Path:
        return self._folder("features_dir", "UniMate/features")

    @property
    def dataset_name(self) -> str:
        return str(self.spec.options.get("dataset") or "mixamo")

    @property
    def object_type(self) -> str:
        return str(self.spec.options.get("object_type") or "")

    def check_part(self, name: str):
        if name == "code":
            return (self.code_dir() / _CODE_MARKER).is_file()
        if name == "checkpoint":
            checkpoint = self.checkpoint_dir()
            return (checkpoint / "config.json").is_file() and latest_checkpoint(checkpoint) is not None
        if name == "features":
            return (self.features_dir() / self.dataset_name / "cond.npy").is_file()
        return None

    def run_download(self, step: dict, report) -> None:
        """Download the checkpoint: config.json, dataset_stats.npy and the newest checkpoint file."""
        if step.get("check") != "checkpoint":
            super().run_download(step, report)
        try:
            from huggingface_hub import HfApi, hf_hub_download
        except ImportError as exc:
            raise BackendUnavailable("huggingface_hub is not installed.", "pip install huggingface_hub") from exc
        source = next((w for w in self.spec.weights if w.role == "model"), None)
        if source is None:
            raise ValueError(f"{self.spec.id}: no weights with role 'model'")
        report(f"Listing {source.repo_id}...", 2)
        names = HfApi(token=False).list_repo_files(source.repo_id, revision=source.revision)
        wanted = pick_checkpoint_files(names, self.spec.options.get("checkpoint_subdir") or "")
        target = self.checkpoint_dir()
        prefix = wanted["prefix"]
        for index, name in enumerate(wanted["files"]):
            report(f"Downloading {name} ({index + 1}/{len(wanted['files'])})...", 5 + 90 * index / len(wanted["files"]))
            local = target / safe_relative_path(name[len(prefix):], "checkpoint file")
            if local.is_file() and local.stat().st_size > 0:
                continue
            path = hf_hub_download(
                repo_id=source.repo_id, filename=name, revision=source.revision,
                local_dir=str(target / "_download"), token=False,
            )
            local.parent.mkdir(parents=True, exist_ok=True)
            Path(path).replace(local)

    def check_available(self) -> None:
        super().check_available()
        if not (self.code_dir() / _CODE_MARKER).is_file():
            raise BackendUnavailable(f"The {self.spec.name} code was not found in {self.code_dir()}.", self.install_hint())
        checkpoint = self.checkpoint_dir()
        if not (checkpoint / "config.json").is_file() or latest_checkpoint(checkpoint) is None:
            raise BackendUnavailable(f"The {self.spec.name} checkpoint was not found in {checkpoint}.", self.install_hint())
        if not (self.features_dir() / self.dataset_name / "cond.npy").is_file():
            raise BackendUnavailable(
                f"The {self.spec.name} skeleton features were not found in {self.features_dir() / self.dataset_name}.",
                self.install_hint(),
            )

    # --- loading -----------------------------------------------------------------

    def load(self, report) -> None:
        if self.model is not None:
            return
        self.check_available()
        code = str(self.code_dir())
        if code not in sys.path:
            sys.path.insert(0, code)
        try:
            import torch
            from unimate.configs.schema import MainConfig
            from unimate.dataset.factory import create_dataset
            from unimate.inference import sample
            from unimate.models.factory import create_model
        except ImportError as exc:
            raise BackendUnavailable(f"{self.spec.name} could not be imported: {exc}", self.install_hint()) from exc

        checkpoint = self.checkpoint_dir()
        config = MainConfig.from_json(str(checkpoint / "config.json"))
        # Read the skeleton features from our folder instead of the repository-relative default.
        dataset_cfg = getattr(config, self.dataset_name, None)
        if dataset_cfg is not None and hasattr(dataset_cfg, "path"):
            dataset_cfg.path = str(self.features_dir() / self.dataset_name)
        config.dataset.dataset_list = [self.dataset_name]

        report(f"Loading {self.spec.name} (the first run downloads its text encoder)...", 8)
        free_comfy_vram()
        stats = checkpoint / "dataset_stats.npy"
        targets = {self.object_type} if self.object_type else None
        self.dataset = create_dataset(
            dataset_config=config.dataset,
            model_config=config.model,
            inference=True,
            target_object_types=targets,
            target_clip_stems=None,
            stats_path=str(stats) if stats.is_file() else None,
        )
        model = create_model(dataset_config=config.dataset, model_config=config.model)
        sample._load_checkpoint(model, str(latest_checkpoint(checkpoint)), config)
        self.device = torch_device(torch)
        self.diffusion, self.sampler = sample._build_diffusion(config)
        self.encoder = sample._make_text_encoder(config, self.device)
        model.to(self.device)
        model.eval()
        self.model = model
        self.config = config

    def _pick_object_type(self) -> str:
        from unimate.inference import sample

        known = sorted(sample._known_object_types(self.dataset))
        if self.object_type:
            if self.object_type not in known:
                raise ValueError(f"{self.spec.name}: object type {self.object_type!r} is not in the features")
            return self.object_type
        if not known:
            raise ValueError(f"{self.spec.name}: the features contain no skeletons")
        return known[0]

    # --- generation --------------------------------------------------------------

    def generate(self, request: MotionRequest, report):
        import torch
        from unimate.dataset.conditioning import create_sample_condition
        from unimate.inference import sample
        from unimate.inference.generate import generate_samples
        from unimate.utils.motion_utils import recover_unimate_joint_pos_from_ric

        torch.manual_seed(int(request.seed))
        np.random.seed(int(request.seed) % (2 ** 32))
        object_type = self._pick_object_type()
        report("Encoding the prompt...", 12)
        caption = sample._encode_prompt(self.encoder, request.prompt)

        cfg_scale = float(request.guidance or self.spec.capabilities["guidance"]["default"])
        sample_model = sample._wrap_for_cfg(self.model, cfg_scale)
        report("Generating motion...", 20)
        with torch.no_grad():
            _, cond = create_sample_condition(
                config=self.config, data=self.dataset,
                test_case_captions=[(object_type, request.prompt, caption)],
            )
            cond = {k: v.to(self.device) if torch.is_tensor(v) else v for k, v in cond.items()}
            data = self.config.dataset
            shape = (1, data.max_joints, data.feature_len, data.max_motion_length)
            samples = generate_samples(
                model=sample_model, cond=cond, motion_shape=shape,
                diff_model=self.config.training.diff_model,
                diffusion=self.diffusion, gen_diffusion=self.sampler,
                device=self.device, cfg_scale=cfg_scale,
            )

        joints = int(cond["n_joints"][0].item())
        motion = samples[0][:joints].cpu().permute(2, 0, 1).numpy()  # (T, J, D)
        mean = cond["mean"][0][:joints][None].cpu().numpy()
        std = cond["std"][0][:joints][None].cpu().numpy()
        positions = recover_unimate_joint_pos_from_ric(motion * std + mean)

        fps = float(self.spec.options.get("fps") or 30)
        frames = max(2, min(len(positions), int(round(request.duration * fps))))
        # Raw Mixamo bone names; the "clean" names are spaced anatomical words.
        names = self.dataset.motion_dataset.cond_dict[object_type]["joint_names"]
        return unimate_motion(positions[:frames], names, fps)

    def unload(self) -> None:
        self.model = self.config = self.dataset = self.encoder = None
        self.diffusion = self.sampler = self.device = None
        empty_torch_cache()
