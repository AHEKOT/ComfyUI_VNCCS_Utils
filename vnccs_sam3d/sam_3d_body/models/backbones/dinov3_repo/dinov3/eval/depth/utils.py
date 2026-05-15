# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging
import numpy as np

import torch
from torch.nn.parallel import DistributedDataParallel as DDP

logger = logging.getLogger("dinov3")


def align_depth_least_square(
    gt_arr: np.ndarray | torch.Tensor,
    pred_arr: np.ndarray | torch.Tensor,
    valid_mask_arr: np.ndarray | torch.Tensor,
    max_resolution=None,
):
    """
    Adapted from Marigold
    https://github.com/prs-eth/Marigold/blob/62413d56099d36573b2de1eb8c429839734b7782/src/util/alignment.py#L8
    """
    ori_shape = pred_arr.shape  # input shape
    dtype = pred_arr.dtype
    if isinstance(pred_arr, torch.Tensor):
        assert isinstance(gt_arr, torch.Tensor) and isinstance(valid_mask_arr, torch.Tensor)
        pred_arr = pred_arr.to(torch.float32)  # unsupported other types
        device = gt_arr.device
        gt_arr = gt_arr.detach().cpu().numpy()
        pred_arr = pred_arr.detach().cpu().numpy()
        valid_mask_arr = valid_mask_arr.detach().cpu().numpy()

    gt = gt_arr.squeeze()  # [H, W]
    pred = pred_arr.squeeze()
    valid_mask = valid_mask_arr.squeeze()

    # Downsample
    if max_resolution is not None:
        scale_factor = np.min(max_resolution / np.array(ori_shape[-2:]))
        if scale_factor < 1:
            downscaler = torch.nn.Upsample(scale_factor=scale_factor, mode="nearest")
            gt = downscaler(torch.as_tensor(gt).unsqueeze(0)).numpy()
            pred = downscaler(torch.as_tensor(pred).unsqueeze(0)).numpy()
            valid_mask = downscaler(torch.as_tensor(valid_mask).unsqueeze(0).float()).bool().numpy()

    assert gt.shape == pred.shape == valid_mask.shape, f"{gt.shape}, {pred.shape}, {valid_mask.shape}"

    gt_masked = gt[valid_mask].reshape((-1, 1))
    pred_masked = pred[valid_mask].reshape((-1, 1))

    # numpy solver
    _ones = np.ones_like(pred_masked)
    A = np.concatenate([pred_masked, _ones], axis=-1)
    try:
        X = np.linalg.lstsq(A, gt_masked, rcond=None)[0]
        scale, shift = X
    except np.linalg.LinAlgError:
        scale = 1
        shift = 0
        logger.info(f"Found wrong depth: \n Pred m:{pred_arr.min()} M:{pred_arr.max()} mean: {pred_arr.mean()}")
        logger.info(f"Gt m:{gt_arr.min()} M:{gt_arr.max()} mean: {gt_arr.mean()}")

    aligned_pred = pred_arr * scale + shift

    # restore dimensions
    aligned_pred = aligned_pred.reshape(ori_shape)
    if isinstance(aligned_pred, np.ndarray):
        aligned_pred = torch.as_tensor(aligned_pred, dtype=dtype, device=device)
    return aligned_pred, scale, shift


def setup_model_ddp(model: torch.nn.Module, device: torch.device | int):
    model = DDP(model.to(device), device_ids=[device])
    logger.info(f"Model moved to rank {device}")
    return model
