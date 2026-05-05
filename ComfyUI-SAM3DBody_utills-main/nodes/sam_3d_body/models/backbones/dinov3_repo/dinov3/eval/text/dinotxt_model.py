# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import math
from dataclasses import dataclass
from typing import Optional, Tuple

import torch
import torch.nn.functional as F
from torch import nn

from dinov3.eval.text.text_tower import build_text_model
from dinov3.eval.text.vision_tower import build_vision_model


@dataclass
class DINOTxtConfig:
    embed_dim: int
    vision_backbone_config: str | None = None
    text_backbone_config: str | None = None
    vision_backbone_pretrained_weights: str | None = None
    text_backbone_pretrained_weights: str | None = None
    vision_model_freeze_backbone: bool = True
    vision_model_train_img_size: int = 224
    vision_model_use_class_token: bool = True
    vision_model_use_patch_tokens: bool = False
    vision_model_num_head_blocks: int = 0
    vision_model_head_blocks_drop_path: float = 0.3
    vision_model_use_linear_projection: bool = False
    vision_model_patch_tokens_pooler_type: str = "mean"
    vision_model_patch_token_layer: int = 1  # which layer to take patch tokens from
    # 1 - last layer, 2 - second last layer, etc.
    text_model_freeze_backbone: bool = False
    text_model_num_head_blocks: int = 0
    text_model_head_blocks_is_causal: bool = False
    text_model_head_blocks_drop_prob: float = 0.0
    text_model_tokens_pooler_type: str = "first"
    text_model_use_linear_projection: bool = False
    text_vocab_path_or_url: Optional[str] = None
    init_logit_scale: float = math.log(1 / 0.07)
    init_logit_bias: Optional[float] = None
    freeze_logit_scale: bool = False


class DINOTxt(nn.Module):
    def __init__(
        self,
        model_config: DINOTxtConfig,
        vision_backbone: Optional[nn.Module] = None,
        text_backbone: Optional[nn.Module] = None,
        device=None,
    ):
        super().__init__()
        self.model_config = model_config
        self.visual_model = build_vision_model(
            model_config.embed_dim,
            model_config.vision_backbone_config,
            model_config.vision_model_freeze_backbone,
            model_config.vision_model_num_head_blocks,
            model_config.vision_model_head_blocks_drop_path,
            model_config.vision_model_use_class_token,
            model_config.vision_model_use_patch_tokens,
            model_config.vision_model_patch_token_layer,
            model_config.vision_model_patch_tokens_pooler_type,
            model_config.vision_model_use_linear_projection,
            backbone=vision_backbone,
        )
        self.text_model = build_text_model(
            model_config.embed_dim,
            model_config.text_backbone_config,
            model_config.text_model_freeze_backbone,
            model_config.text_model_num_head_blocks,
            model_config.text_model_head_blocks_is_causal,
            model_config.text_model_head_blocks_drop_prob,
            model_config.text_model_tokens_pooler_type,
            model_config.text_model_use_linear_projection,
            backbone=text_backbone,
        )
        self.logit_scale = nn.Parameter(torch.empty(1, device=device))
        if model_config.freeze_logit_scale:
            self.logit_scale.requires_grad = False

    def init_weights(self):
        torch.nn.init.constant(self.logit_scale, self.model_config.init_logit_scale)
        self.visual_model.init_weights()
        self.text_model.init_weights()

    def encode_image_with_patch_tokens(
        self,
        image: torch.Tensor,
        normalize: bool = False,
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        features, patch_tokens, backbone_patch_tokens = self.visual_model(image)
        return (
            F.normalize(features, dim=-1) if normalize else features,
            patch_tokens,
            backbone_patch_tokens,
        )

    def encode_image(
        self,
        image: torch.Tensor,
        normalize: bool = False,
    ) -> torch.Tensor:
        features, _, _ = self.visual_model(image)
        return F.normalize(features, dim=-1) if normalize else features

    def encode_text(self, text: torch.Tensor, normalize: bool = False) -> torch.Tensor:
        features = self.text_model(text)
        return F.normalize(features, dim=-1) if normalize else features

    def get_logits(
        self, image: torch.Tensor, text: torch.Tensor
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        text_features = self.encode_text(text, normalize=True)
        image_features = self.encode_image(image, normalize=True)
        image_logits = self.logit_scale.exp() * image_features @ text_features.T
        text_logits = image_logits.T
        return image_logits, text_logits

    def forward(
        self,
        image: torch.Tensor,
        text: torch.Tensor,
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        text_features = self.encode_text(text, normalize=True)
        image_features, patch_tokens, backbone_patch_tokens = (
            self.encode_image_with_patch_tokens(image, normalize=True)
        )
        return (
            image_features,
            text_features,
            self.logit_scale.exp(),
            patch_tokens,
            backbone_patch_tokens,
        )
