# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging
from enum import Enum

from dinov3.eval.depth.models.embed import CenterPadding, StretchToMultiple
from torch import Tensor, nn

logger = logging.getLogger("dinov3")


class BackboneLayersSet(Enum):
    # Set of intermediate layers to take from the backbone
    LAST = "LAST"  # extracting only the last layer
    FOUR_LAST = "FOUR_LAST"  # extracting the last 4 layers
    FOUR_EVEN_INTERVALS = "FOUR_EVEN_INTERVALS"  # extracting outputs every 1/4 of the total number of blocks


def _get_backbone_out_indices(
    model: nn.Module,
    backbone_out_layers: list[int] | tuple[int, ...] | BackboneLayersSet = BackboneLayersSet.FOUR_EVEN_INTERVALS,
):
    """
    Get indices for output layers of the ViT backbone. For now there are 3 options available:
    BackboneLayersSet.LAST : only extract the last layer, used in segmentation tasks with a bn head.
    BackboneLayersSet.FOUR_LAST : extract the last 4 layers, used in segmentation (multiscale setting)
    BackboneLayersSet.FOUR_EVEN_INTERVALS : extract outputs every 1/4 of the total number of blocks
    Reference outputs in 'FOUR_EVEN_INTERVALS' mode :
    ViT/S (12 blocks): [2, 5, 8, 11]
    ViT/B (12 blocks): [2, 5, 8, 11]
    ViT/L (24 blocks): [5, 11, 17, 23] (correct), [4, 11, 17, 23] (incorrect)
    ViT/g (40 blocks): [9, 19, 29, 39]
    """
    n_blocks = getattr(model, "n_blocks", 1)
    out_indices: list[int]
    if isinstance(backbone_out_layers, (tuple, list)):
        out_indices = list(backbone_out_layers)
    elif backbone_out_layers == BackboneLayersSet.LAST:
        out_indices = [n_blocks - 1]
    elif backbone_out_layers == BackboneLayersSet.FOUR_LAST:
        out_indices = [i for i in range(n_blocks - 4, n_blocks)]
    elif backbone_out_layers == BackboneLayersSet.FOUR_EVEN_INTERVALS:
        # XXX: Force (incorrect) out indices for backward-compatibility (ViT/L only)
        if n_blocks == 24:
            out_indices = [4, 11, 17, 23]
        else:
            out_indices = [i * (n_blocks // 4) - 1 for i in range(1, 5)]
    assert all([out_index < n_blocks for out_index in out_indices])
    return out_indices


class PatchSizeAdaptationStrategy(Enum):
    CENTER_PADDING = "center_padding"
    STRETCH = "stretch"
    NO_ADAPTATION = "never"


class DinoVisionTransformerWrapper(nn.Module):
    """Vision Transformer."""

    def __init__(
        self,
        backbone_model: nn.Module,
        backbone_out_layers: str | tuple[int, ...] | BackboneLayersSet,
        use_backbone_norm: bool = False,
        adapt_to_patch_size: PatchSizeAdaptationStrategy = PatchSizeAdaptationStrategy.CENTER_PADDING,
    ):
        super().__init__()

        self.final_norm = use_backbone_norm
        self.backbone = backbone_model
        if isinstance(backbone_out_layers, str):
            backbone_out_layers = BackboneLayersSet(backbone_out_layers)
        self.backbone_out_indices = _get_backbone_out_indices(self.backbone, backbone_out_layers=backbone_out_layers)

        # If the backbone does not define embed_dims, use [embed_dim] * n_blocks
        try:
            embed_dims: list[int] = getattr(self.backbone, "embed_dims")
        except AttributeError:
            embed_dim: int = getattr(self.backbone, "embed_dim")
            n_blocks: int = getattr(self.backbone, "n_blocks")
            logger.warning(f"Backbone does not define embed_dims, using {[embed_dim] * n_blocks} instead")
            embed_dims = [embed_dim] * n_blocks
        self.embed_dims = [embed_dims[idx] for idx in self.backbone_out_indices]

        # How to adapt input images to the patch size of the model?
        try:
            input_pad_size = getattr(self.backbone, "input_pad_size")
        except AttributeError:
            patch_size = getattr(self.backbone, "patch_size")
            logger.warning(f"Backbone does not define input_pad_size, using {patch_size=} instead")
            input_pad_size = patch_size
        self.patch_size_adapter: nn.Module = nn.Identity()
        if adapt_to_patch_size is PatchSizeAdaptationStrategy.CENTER_PADDING:
            self.patch_size_adapter = CenterPadding(input_pad_size)
        elif adapt_to_patch_size is PatchSizeAdaptationStrategy.STRETCH:
            self.patch_size_adapter = StretchToMultiple(input_pad_size)

        # Freeze backbone
        self.backbone.requires_grad_(False)

    def forward(
        self,
        x: Tensor,  # [B, rgb, H, W]
    ) -> list[tuple[Tensor, Tensor]]:
        x = self.patch_size_adapter(x)
        outputs = self.backbone.get_intermediate_layers(  # type: ignore
            x,
            n=self.backbone_out_indices,
            reshape=True,
            return_class_token=True,
            norm=self.final_norm,
        )  # List of (patch feats [B, C, h, w], class token [B, C])
        return outputs
