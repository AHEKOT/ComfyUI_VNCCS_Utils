# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Two-stage transformer denoiser: root stage then body stage for motion diffusion."""

import contextlib
from typing import Optional

import torch
from torch import nn

from .backbone import TransformerEncoderBlock
from .loading import load_checkpoint_state_dict


class TwostageDenoiser(nn.Module):
    """Two-stage denoiser: first predicts global root features, then body features conditioned on local root."""

    def __init__(
        self,
        motion_rep,
        motion_mask_mode,
        ckpt_path: Optional[str] = None,
        **kwargs,
    ):
        """Build root and body transformer blocks; optionally load checkpoint from ckpt_path."""
        super().__init__()
        self.motion_rep = motion_rep
        self.motion_mask_mode = motion_mask_mode

        # it should be a dual motion_rep
        # and be global by default
        # global motion_rep as inpnut
        input_dim = motion_rep.motion_rep_dim
        will_concatenate = motion_mask_mode == "concat"

        # stage 1: root only
        root_input_dim = input_dim * 2 if will_concatenate else input_dim
        root_output_dim = motion_rep.global_root_dim

        self.root_model = TransformerEncoderBlock(
            input_dim=root_input_dim,
            output_dim=root_output_dim,
            skeleton=self.motion_rep.skeleton,
            **kwargs,
        )

        # replace the global root by the local root
        local_motion_rep_dim = input_dim - motion_rep.global_root_dim + motion_rep.local_root_dim

        # stage 2: local body
        body_input_dim = local_motion_rep_dim + (
            input_dim if will_concatenate else 0
        )  # body stage always takes in local root info for motion (but still the global mask)

        body_output_dim = input_dim - motion_rep.global_root_dim
        self.body_model = TransformerEncoderBlock(
            input_dim=body_input_dim,
            output_dim=body_output_dim,
            skeleton=self.motion_rep.skeleton,
            **kwargs,
        )

        if ckpt_path:
            self.load_ckpt(ckpt_path)

    def load_ckpt(self, ckpt_path: str) -> None:
        """Load checkpoint from path; state dict keys are stripped of 'denoiser.backbone.'
        prefix."""
        state_dict = load_checkpoint_state_dict(ckpt_path)
        state_dict = {key.replace("denoiser.backbone.", ""): val for key, val in state_dict.items()}
        self.load_state_dict(state_dict)

    def forward(
        self,
        x: torch.Tensor,
        x_pad_mask: torch.Tensor,
        text_feat: torch.Tensor,
        text_feat_pad_mask: torch.Tensor,
        timesteps: torch.Tensor,
        first_heading_angle: Optional[torch.Tensor] = None,
        motion_mask: Optional[torch.Tensor] = None,
        observed_motion: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        """
        Args:
            x (torch.Tensor): [B, T, dim_motion] current noisy motion
            x_pad_mask (torch.Tensor): [B, T] attention mask, positions with True are allowed to attend, False are not
            text_feat (torch.Tensor): [B, max_text_len, llm_dim] embedded text prompts
            text_feat_pad_mask (torch.Tensor): [B, max_text_len] attention mask, positions with True are allowed to attend, False are not
            timesteps (torch.Tensor): [B,] current denoising step
            motion_mask
            observed_motion

        Returns:
            torch.Tensor: same size as input x
        """

        if self.motion_mask_mode == "concat":
            if motion_mask is None or observed_motion is None:
                motion_mask = torch.zeros_like(x)
                observed_motion = torch.zeros_like(x)
            x = x * (1 - motion_mask) + observed_motion * motion_mask
            x_extended = torch.cat([x, motion_mask], axis=-1)
        else:
            x_extended = x

        # Stage 1: predict root motion in global
        root_motion_pred = self.root_model(
            x_extended,
            x_pad_mask,
            text_feat,
            text_feat_pad_mask,
            timesteps,
            first_heading_angle,
        )  # [B, T, 5]

        # Maybe pass this as argument instead of recomputing it
        lengths = x_pad_mask.sum(-1)

        # Convert root pred to local rep
        # At test-time want to allow gradient through for guidance
        convert_ctx = torch.no_grad() if self.training else contextlib.nullcontext()
        with convert_ctx:
            root_motion_local = self.motion_rep.global_root_to_local_root(
                root_motion_pred,
                normalized=True,
                lengths=lengths,
            )
        if self.training:
            root_motion_local = root_motion_local.detach()

        # concatenate the predicted local root with the body motion
        body_x = x[..., self.motion_rep.body_slice]
        x_new = torch.cat([root_motion_local, body_x], axis=-1)

        if self.motion_mask_mode == "concat":
            x_new_extended = torch.cat([x_new, motion_mask], axis=-1)
        else:
            x_new_extended = x_new

        # Stage 2: predict local body motion based on local root
        predicted_body = self.body_model(
            x_new_extended,
            x_pad_mask,
            text_feat,
            text_feat_pad_mask,
            timesteps,
            first_heading_angle,
        )

        # concatenate the predicted local body with the predicted root
        output = torch.cat([root_motion_pred, predicted_body], axis=-1)
        return output
