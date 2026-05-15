# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import math

import numpy as np
import torch
import torch.nn.functional as F
from torchvision.transforms import v2

from ..util.misc import NestedTensor


class WindowsWrapper(torch.nn.Module):
    """
    This wrapper will take an input (NestedTensor) at size (h, w) and split it
    in `N = n_windows_h * n_windows_w` equally sized windows (the bottom and right windows might
    be a little bit smaller), with sizes that are multiples of the patch size (as the input should be).

    Then, the input will be resized at the size of the top left window (h / n_windows_h, w / n_windows_w).
    This resized input, plus the N windows, will be passed through the backbone.
    Then, the features of the resized input will be resized to the original input size, while the
    features of the windows will be concatenated side by side to reconstruct a feature map also
    corresponding to the original image's size.

    Finally, both the features from the windows and from the resized images are stacked.
    Compared to the output of the backbone of size [B, C, H, W], the output here is [B, 2 * C, H, W]
    """

    def __init__(self, backbone, n_windows_w, n_windows_h, patch_size):
        # Assuming image size is divisible by patch_size
        super().__init__()
        self._backbone = backbone
        self._n_windows_w = n_windows_w
        self._n_windows_h = n_windows_h
        self._patch_size = patch_size
        self.strides = backbone.strides
        self.num_channels = [el * 2 for el in backbone.num_channels]  # resized + windows

    def forward(self, tensor_list: NestedTensor):
        tensors = tensor_list.tensors
        original_h, original_w = tensors.shape[2], tensors.shape[3]
        # Get height and width of the windows, such that it is a multiple of the patch size
        window_h = math.ceil((original_h // self._n_windows_h) / self._patch_size) * self._patch_size
        window_w = math.ceil((original_w // self._n_windows_w) / self._patch_size) * self._patch_size
        all_h = [window_h] * (self._n_windows_h - 1) + [original_h - window_h * (self._n_windows_h - 1)]
        all_w = [window_w] * (self._n_windows_w - 1) + [original_w - window_w * (self._n_windows_w - 1)]
        all_h_cumsum = [0] + list(np.cumsum(all_h))
        all_w_cumsum = [0] + list(np.cumsum(all_w))
        window_patch_features = [[0 for _ in range(self._n_windows_w)] for _ in range(self._n_windows_h)]

        for ih in range(self._n_windows_h):
            for iw in range(self._n_windows_w):
                window_tensor = v2.functional.crop(
                    tensors, top=all_h_cumsum[ih], left=all_w_cumsum[iw], height=all_h[ih], width=all_w[iw]
                )
                window_mask = v2.functional.crop(
                    tensor_list.mask, top=all_h_cumsum[ih], left=all_w_cumsum[iw], height=all_h[ih], width=all_w[iw]
                )
                window_patch_features[ih][iw] = self._backbone(NestedTensor(tensors=window_tensor, mask=window_mask))[0]

        window_tensors = torch.cat(
            [
                torch.cat([el.tensors for el in window_patch_features[ih]], dim=-1)  # type: ignore
                for ih in range(len(window_patch_features))
            ],
            dim=-2,
        )
        # Also compute the global features in a "preferential" setting, of lower resolution
        resized_global_tensor = v2.functional.resize(tensors, size=(window_h, window_w))
        global_features = self._backbone(
            NestedTensor(tensors=resized_global_tensor, mask=tensor_list.mask)
        )  # mask is not used

        concat_tensors = torch.cat(
            [v2.functional.resize(global_features[0].tensors, size=window_tensors.shape[-2:]), window_tensors], dim=1
        )
        global_mask = F.interpolate(tensor_list.mask[None].float(), size=concat_tensors.shape[-2:]).to(torch.bool)[0]
        out = [NestedTensor(tensors=concat_tensors, mask=global_mask)]
        return out
