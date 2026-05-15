# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

from typing import Callable, Optional, Tuple

import torch
import torch.nn.functional as F
from torch import nn
from torchvision.transforms import functional as Fv


def make_inference(
    x: torch.Tensor,
    segmentation_model: nn.Module,
    inference_mode: str = "whole",
    decoder_head_type: str = "linear",
    rescale_to=(512, 512),
    n_output_channels: int = 256,
    crop_size: Optional[Tuple[int]] = None,
    stride: Optional[Tuple[int]] = None,
    apply_horizontal_flip: bool = False,
    num_max_forward: int = 1,
    output_activation: Callable | None = None,
):
    """Make inference on a given image, and reverts horizontal flip TTA if applicable.
    If `inference_mode` = whole, one single prediction is made for the image.
    If `inference_mode` = slide, the image is cropped into multiple slices and the latter are
    used to make prediction following a sliding window method.

    Args:
        x (tensor): input image to make inference on.
        dense_predictor (nn.Module): model to use for evaluating on dense tasks.
            requires a `predict` method.
        inference_mode (str, optional): Do inference on the whole image (mode="whole"), or by
            adopting a sliding window approach to aggregate the results on
            smaller patches of the input image (mode="slide"). Defaults to "whole".
        rescale_to (tuple, optional): Resizing the output of the model prediction to the
            shape of the ground truth. Defaults to (512, 512).
        n_output_channels (int): number of output classes
        crop_size (tuple, optional): [h_crop, w_crop]
        stride (tuple, optional): [h_stride, w_stride]
        apply_horizontal_flip (bool): Determines if horizontal flip TTA was applied for
            the prediction. Defaults to False.
        output_activation (callable): Output activation to use on top of the predictions.
            - softmax is used when each pixel belongs to a single class (multiclass),
            - sigmoid is used when pixel can belong to multiple classes (multilabel). Defaults to None (identity).
    Returns:
        Tensor: The segmentation results created from the input image.
    """
    assert inference_mode in ["whole", "slide"]
    if inference_mode == "slide":
        # crop size and stride are needed for sliding inference
        assert crop_size is not None
        assert stride is not None
        pred = F.interpolate(
            slide_inference(
                x,
                segmentation_model,
                decoder_head_type,
                n_output_channels=n_output_channels,
                crop_size=crop_size,
                stride=stride,
                num_max_forward=num_max_forward,
            ),
            size=rescale_to,
            mode="bilinear",
            align_corners=False,
        )
    else:
        pred = segmentation_model.predict(
            F.interpolate(
                x,
                size=(512, 512),
                mode="bilinear",
                align_corners=False,
            ),
            rescale_to=rescale_to,
        )
        if decoder_head_type == "m2f":
            mask_pred, mask_cls = pred["pred_masks"], pred["pred_logits"]
            mask_cls = F.softmax(mask_cls, dim=-1)[..., :-1]
            mask_pred = mask_pred.sigmoid()
            pred = torch.einsum("bqc,bqhw->bchw", mask_cls.to(torch.float), mask_pred.to(torch.float))
    if apply_horizontal_flip:
        pred = Fv.hflip(pred)
    if output_activation:
        pred = output_activation(pred)
    return pred


def slide_inference(
    inputs: torch.Tensor,
    segmentation_model: nn.Module,
    decoder_head_type: str = "linear",
    n_output_channels: int = 256,
    crop_size: Tuple = (512, 512),
    stride: Tuple = (341, 341),
    num_max_forward: int = 1,
):
    """Inference by sliding-window with overlap.
    If h_crop > h_img or w_crop > w_img, the small patch will be used to
    decode without padding.
    Args:
        inputs (tensor): the tensor should have a shape NxCxHxW,
            which contains all images in the batch.
        segmentation_model (nn.Module): model to use for evaluating on dense tasks.
        n_output_channels (int): number of output channels
        crop_size (tuple): (h_crop, w_crop)
        stride (tuple): (h_stride, w_stride)
    Returns:
        Tensor: The output results from model of each input image.
    """
    h_stride, w_stride = stride
    h_crop, w_crop = crop_size
    batch_size, C, h_img, w_img = inputs.shape
    if h_crop > h_img and w_crop > w_img:  # Meaning we are doing < 1.0 TTA
        h_crop, w_crop = min(h_img, w_img), min(h_img, w_img)
    assert batch_size == 1  # As of now, the code assumes that a single image is passed at a time at inference time
    h_grids = max(h_img - h_crop + h_stride - 1, 0) // h_stride + 1
    w_grids = max(w_img - w_crop + w_stride - 1, 0) // w_stride + 1
    preds = inputs.new_zeros((1, n_output_channels, h_img, w_img)).cpu()
    count_mat = inputs.new_zeros((1, 1, h_img, w_img)).to(torch.int8).cpu()
    for h_idx in range(h_grids):
        for w_idx in range(w_grids):
            y1 = h_idx * h_stride
            x1 = w_idx * w_stride
            y2 = min(y1 + h_crop, h_img)
            x2 = min(x1 + w_crop, w_img)
            y1 = max(y2 - h_crop, 0)
            x1 = max(x2 - w_crop, 0)
            crop_img = inputs[:, :, y1:y2, x1:x2]
            crop_pred = segmentation_model.predict(crop_img, rescale_to=crop_img.shape[2:])
            if decoder_head_type == "m2f":
                mask_pred, mask_cls = crop_pred["pred_masks"], crop_pred["pred_logits"]
                mask_cls = F.softmax(mask_cls, dim=-1)[..., :-1]
                mask_pred = mask_pred.sigmoid()
                crop_pred = torch.einsum("bqc,bqhw->bchw", mask_cls.to(torch.bfloat16), mask_pred.to(torch.bfloat16))
                del mask_cls, mask_pred
            preds += F.pad(crop_pred, (int(x1), int(preds.shape[-1] - x2), int(y1), int(preds.shape[-2] - y2))).cpu()
            count_mat[:, :, y1:y2, x1:x2] += 1
            del crop_img, crop_pred
    # Optional buffer to ensure each gpu does the same number of operations for sharded models
    for _ in range(h_grids * w_grids, num_max_forward):
        dummy_input = inputs.new_zeros((1, C, h_crop, w_crop))
        _ = segmentation_model.predict(dummy_input, rescale_to=dummy_input.shape[2:])
    assert (count_mat == 0).sum() == 0
    return preds / count_mat
