# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import itertools
import math

import torch


class CenterPadding(torch.nn.Module):
    def __init__(self, multiple: int):
        super().__init__()
        self.multiple = multiple

    def _get_pad(self, size):
        new_size = math.ceil(size / self.multiple) * self.multiple
        pad_size = new_size - size
        pad_size_left = pad_size // 2
        pad_size_right = pad_size - pad_size_left
        return pad_size_left, pad_size_right

    # @torch.inference_mode()
    def forward(self, x):
        # expected shapes are ... x H x W, usually B x C x H x W
        pads = list(itertools.chain.from_iterable(self._get_pad(m) for m in x.shape[:-3:-1]))
        output = torch.nn.functional.pad(x, pads)
        return output

    def __extra_repr__(self) -> str:
        return f"multiple={self.multiple}"


class StretchToMultiple(torch.nn.Module):
    def __init__(self, multiple: int):
        super().__init__()
        self.multiple = multiple

    def forward(self, x):
        # expected shapes are ... x H x W, usually B x C x H x W
        *shape, C, H, W = x.shape
        new_H = math.ceil(H / self.multiple) * self.multiple
        new_W = math.ceil(W / self.multiple) * self.multiple
        if new_H != H or new_W != W:
            x = x.reshape(-1, C, H, W)
            x = torch.nn.functional.interpolate(x, size=(new_H, new_W), mode="bilinear")
            x = x.reshape(*shape, C, new_H, new_W)
        return x

    def __extra_repr__(self) -> str:
        return f"multiple={self.multiple}"
