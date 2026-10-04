# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Checkpoint loading (vendored, reduced).

VNCCS: the Hydra / OmegaConf instantiation and environment-variable helpers of the
original module are replaced by api/text_to_motion/vendor/config_loader.py, and
non-safetensors checkpoints load with ``weights_only=True`` (no arbitrary pickles).
"""

from pathlib import Path
from typing import Union

import torch
from safetensors.torch import load_file as load_safetensors


def load_checkpoint_state_dict(ckpt_path: Union[str, Path]) -> dict:
    """Load a state dict from a checkpoint file.

    If the checkpoint is a dict with a 'state_dict' key (e.g. PyTorch Lightning),
    that is returned; otherwise the whole checkpoint is treated as the state dict.
    """
    ckpt_path = str(ckpt_path)

    if ckpt_path.endswith(".safetensors"):
        state_dict = load_safetensors(ckpt_path)
    else:
        checkpoint = torch.load(ckpt_path, map_location="cpu", weights_only=True)
        if isinstance(checkpoint, dict) and "state_dict" in checkpoint:
            state_dict = checkpoint["state_dict"]
        elif isinstance(checkpoint, dict):
            state_dict = checkpoint
        else:
            raise ValueError(f"Unsupported checkpoint format: {ckpt_path}")
    return {key: val.detach().cpu() for key, val in state_dict.items()}


__all__ = ["load_checkpoint_state_dict"]
