# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import os
from typing import Callable

import matplotlib
import numpy as np
import torch
import torchvision.transforms as transforms
from PIL import Image

from dinov3.eval.depth.config import ResultConfig, ResultExtension

from dinov3.data.transforms import IMAGENET_DEFAULT_MEAN, IMAGENET_DEFAULT_STD


def alpha_blend(img_pil: Image.Image, mask_rgb: np.ndarray, alpha: float = 0.5) -> Image.Image:
    img_rgba = img_pil.convert("RGBA")
    mask_alpha = np.full_like(mask_rgb, np.round(255 * alpha))[..., 0:1]
    mask_rgba = Image.fromarray(np.concatenate([mask_rgb, mask_alpha], axis=-1).astype(np.uint8))
    overlay = Image.alpha_composite(img_rgba, mask_rgba)
    return overlay.convert("RGB")


def normalized_tensor_to_pil(
    tensor: torch.Tensor,
    mean=IMAGENET_DEFAULT_MEAN,
    std=IMAGENET_DEFAULT_STD,
) -> Image.Image:
    """
    Transforms a normalized image tensor back into PIL image.
    """
    assert tensor.ndim == 3 and tensor.shape[0] == 3, f"input should be 3xHxW, got {tensor.shape}"
    std = torch.tensor(std, device=tensor.device)[:, None, None]
    mean = torch.tensor(mean, device=tensor.device)[:, None, None]
    unnormalized_tensor = torch.clamp(tensor * std + mean, 0.0, 1.0)
    return transforms.functional.to_pil_image(unnormalized_tensor)


def depth_tensor_to_colorized_pil(depth_tensor: torch.Tensor, cmap="plasma", vmin=None, vmax=None):
    # derived from https://github.com/zhyever/Monocular-Depth-Estimation-Toolbox/blob/main/depth/utils/color_depth.py
    value = depth_tensor.detach().cpu().reshape(depth_tensor.shape[-2:]).numpy()
    # normalize
    vmin = value.min() if vmin is None else vmin
    vmax = value.max() if vmax is None else vmax
    if vmin != vmax:
        value = (value - vmin) / (vmax - vmin)  # vmin..vmax
    else:
        # Avoid 0-division
        value = value * 0.0
    cmapper = matplotlib.cm.get_cmap(cmap)
    value = cmapper(value, bytes=True)  # ((1)xhxwx4)
    value = value[:, :, :3]  # bgr -> rgb
    rgb_value = value  # [..., ::-1]
    return Image.fromarray(rgb_value)


def save_raw_predictions(
    img: torch.Tensor,  # [1, 3, H, W]
    pred: torch.Tensor,  # [1, C, H, W]
    gt: torch.Tensor,  # [1, C, H, W]
    save_dir: str,
    save_index: int,
) -> None:
    torch.save(
        {
            "image": transforms.functional.to_tensor(normalized_tensor_to_pil(img[0])).cpu(),
            "pred": pred.detach().cpu(),
            "target": gt.cpu(),
        },
        os.path.join(save_dir, f"results_{int(save_index)}.pth"),
    )


def get_prediction_images(
    img: torch.Tensor,  # [1, 3, H, W]
    pred: torch.Tensor,  # [1, C, H, W]
    gt: torch.Tensor,  # [1, C, H, W]
    pred_tensor_to_pil: Callable[[torch.Tensor], Image.Image],
    alpha: float = 1.0,
) -> tuple[Image.Image, Image.Image, Image.Image]:
    img_pil = normalized_tensor_to_pil(img[0])
    assert pred.shape[0] == gt.shape[0] == 1
    pred_pil = pred_tensor_to_pil(pred[0].cpu())
    gt_pil = pred_tensor_to_pil(gt[0].cpu())
    if img_pil.size != gt_pil.size:
        img_pil = img_pil.resize(gt_pil.size)

    if alpha < 1.0:
        pred_pil = alpha_blend(img_pil, np.array(pred_pil), alpha)
        gt_pil = alpha_blend(img_pil, np.array(gt_pil), alpha)
    return img_pil, pred_pil, gt_pil


def resize_results(
    img_pil: Image.Image,
    pred_pil: Image.Image,
    gt_pil: Image.Image,
    resolution: int,
) -> tuple[Image.Image, Image.Image, Image.Image]:
    img_pil = transforms.functional.resize(
        img_pil,
        resolution,
        interpolation=transforms.InterpolationMode.BILINEAR,
    )
    pred_pil, gt_pil = [
        transforms.functional.resize(
            x,
            resolution,
            interpolation=transforms.InterpolationMode.NEAREST,
        )
        for x in [pred_pil, gt_pil]
    ]
    return img_pil, pred_pil, gt_pil


def save_predictions(
    img: torch.Tensor,  # [1, 3, H, W]
    pred: torch.Tensor,  # [1, C, H, W]
    gt: torch.Tensor,  # [1, C, H, W]
    result_config: ResultConfig,
    save_dir: str,
    save_index: int,
    pred_tensor_to_pil_fn: Callable,
) -> None:
    vis_save_dir = os.path.join(save_dir, "visualizations")
    os.makedirs(vis_save_dir, exist_ok=True)
    if result_config.extension == ResultExtension.PTH:
        save_raw_predictions(
            img=img,
            pred=pred,
            gt=gt,
            save_dir=vis_save_dir,
            save_index=save_index,
        )
        return

    img_pil, pred_pil, gt_pil = get_prediction_images(
        img=img,
        pred=pred,
        gt=gt,
        pred_tensor_to_pil=pred_tensor_to_pil_fn,
        alpha=result_config.overlay_alpha,
    )

    if result_config.save_resolution:
        img_pil, pred_pil, gt_pil = resize_results(img_pil, pred_pil, gt_pil, result_config.save_resolution)

    ext = result_config.extension.value
    if result_config.save_separate_files:
        img_pil.save(os.path.join(vis_save_dir, f"image_{int(save_index)}.{ext}"))
        pred_pil.save(os.path.join(vis_save_dir, f"pred_{int(save_index)}.{ext}"))
        gt_pil.save(os.path.join(vis_save_dir, f"gt_{int(save_index)}.{ext}"))

    band = np.concatenate([np.array(segm) for segm in [pred_pil, gt_pil]], axis=1)  # horizontal band
    band = Image.fromarray(band)
    band.save(os.path.join(vis_save_dir, f"results_{int(save_index)}.{ext}"))
