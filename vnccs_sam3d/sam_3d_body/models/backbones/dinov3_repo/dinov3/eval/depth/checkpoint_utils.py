# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging
import os

import torch
from torch.optim.optimizer import Optimizer

logger = logging.getLogger("dinov3")


def unwrap_ddp_state_dict(model_state_dict):
    is_ddp = all([k.startswith("module.") for k in model_state_dict.keys()])
    if is_ddp:
        model_state_dict = {k.split("module.", 1)[-1]: v for (k, v) in model_state_dict.items()}
    return model_state_dict


def load_checkpoint(checkpoint_path):
    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    state_dicts = {}
    iteration = None
    if "iteration" in checkpoint.keys():
        iteration = checkpoint["iteration"]
    state_dicts["model"] = unwrap_ddp_state_dict(checkpoint["model"])
    if "optimizer" in checkpoint.keys():
        state_dicts["optimizer"] = checkpoint["optimizer"]
    return state_dicts, iteration


def find_latest_checkpoint(path):
    if not os.path.exists(path):
        return None
    list_checkpoints = sorted([filepath for filepath in os.listdir(path) if filepath.endswith("pth")])
    if os.path.exists(os.path.join(path, "model_final.pth")):
        return os.path.join(path, "model_final.pth")
    elif len(list_checkpoints) >= 1:
        model_latest_iteration_path = list_checkpoints[-1]
        return os.path.join(path, model_latest_iteration_path)
    else:
        logger.info("Could not find checkpoint to resume from, starting from scratch")


def save_checkpoint(path: str, iteration: int, model: torch.nn.Module, optimizer: Optimizer):
    chkpt = {
        "model": unwrap_ddp_state_dict(model.state_dict()),
        "optimizer": optimizer.state_dict(),
        "iteration": iteration,
    }
    torch.save(chkpt, os.path.join(path, f"model_{iteration:08d}.pth"))
