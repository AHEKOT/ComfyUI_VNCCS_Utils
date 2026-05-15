# Copyright (c) Meta Platforms, Inc. and affiliates.
import os
import torch

from .models.meta_arch import SAM3DBody
from .utils.config import get_config
from .utils.checkpoint import load_state_dict


def load_sam_3d_body(checkpoint_path: str = "", device: str = "cuda", mhr_path: str = ""):

    # Check the current directory, and if not present check the parent dir.
    model_cfg = os.path.join(os.path.dirname(checkpoint_path), "model_config.yaml")
    tried_paths = [model_cfg]

    if not os.path.exists(model_cfg):
        # Looks at parent dir
        model_cfg = os.path.join(
            os.path.dirname(os.path.dirname(checkpoint_path)), "model_config.yaml"
        )
        tried_paths.append(model_cfg)

    if not os.path.exists(model_cfg):
        # Use bundled default config
        bundled_config = os.path.join(
            os.path.dirname(__file__), "configs", "model_config.yaml"
        )
        tried_paths.append(bundled_config)
        if os.path.exists(bundled_config):
            model_cfg = bundled_config
        else:
            raise FileNotFoundError(
                f"Could not find model_config.yaml in any of these locations:\n" +
                "\n".join(f"  - {p}" for p in tried_paths) +
                f"\n\nFor local model loading, please ensure model_config.yaml is in the same directory as your checkpoint."
            )

    model_cfg = get_config(model_cfg)

    # Disable face for inference
    model_cfg.defrost()
    model_cfg.MODEL.MHR_HEAD.MHR_MODEL_PATH = mhr_path
    model_cfg.freeze()

    # Initialze the model
    model = SAM3DBody(model_cfg)

    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    if "state_dict" in checkpoint:
        state_dict = checkpoint["state_dict"]
    else:
        state_dict = checkpoint
    load_state_dict(model, state_dict, strict=False)

    model = model.to(device)
    model.eval()
    return model, model_cfg, mhr_path


