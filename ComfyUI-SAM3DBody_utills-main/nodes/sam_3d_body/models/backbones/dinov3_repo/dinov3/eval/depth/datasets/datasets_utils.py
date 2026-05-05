# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

from enum import Enum

import torch


class _EvalCropType(Enum):
    NYU_EIGEN = "NYU_EIGEN"
    FULL = "FULL"


def make_valid_mask(input, eval_crop: _EvalCropType = _EvalCropType.FULL, ignored_value: float = 0.0):
    """Following Adabins, Do grag_crop or eigen_crop for testing

    Args:
        input: input tensor in BxCxHxW format
        eval_crop (_EvalCropType): evaluation crop used for evaluation
        ignored_value (float): value from input to be ignored during evaluation
    """
    B, _, h, w = input.shape
    eval_mask = torch.zeros(input.shape, device=input.device)
    if eval_crop == _EvalCropType.NYU_EIGEN:
        y1, y2, x1, x2 = 45, 471, 41, 601
        orig_h, orig_w = 480, 640
        y1_new = int((y1 / orig_h) * h)
        y2_new = int((y2 / orig_h) * h)
        x1_new = int((x1 / orig_w) * w)
        x2_new = int((x2 / orig_w) * w)
        eval_mask[:, :, y1_new:y2_new, x1_new:x2_new] = 1
    else:
        eval_mask.fill_(1)

    # make mask from ignored values
    ignored_value_mask = torch.ones((B, 1, h, w), device=eval_mask.device)
    ignored_value_mask[(input == ignored_value).all(dim=1, keepdims=True)] = 0

    eval_mask = eval_mask * ignored_value_mask
    return eval_mask.bool()
