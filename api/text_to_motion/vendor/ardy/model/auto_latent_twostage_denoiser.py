# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import contextlib
from typing import Optional

import torch
from einops import rearrange
from torch import nn

from .latent_utils import HybridMotionConverter

from .backbone import TransformerEncoderBlock
from .loading import load_checkpoint_state_dict


def sparsify_token_seq(token_seq, token_mask, token_index):
    """Sparsify the token sequence to only include the tokens at positions that contain at least one
    valid token in the batch.

    The token index will then not be continuous.
    Args:
        token_seq (torch.Tensor): [B, num_tokens, dim_token] token sequence
        token_mask (torch.Tensor): [B, num_tokens] boolean token mask
        token_index (torch.Tensor): [B, num_tokens] integer token index
    Returns:
        token_seq (torch.Tensor): [B, num_valid_tokens, dim_token] token sequence
        token_mask (torch.Tensor): [B, num_valid_tokens] boolean token mask
        token_index (torch.Tensor): [B, num_valid_tokens] integer token index
        index_mask (torch.Tensor): [num_tokens,] boolean mask, if any token at this index is valid in the batch
    """
    index_mask = token_mask.any(dim=0)  # [num_tokens,], if any token at this index is valid in the batch
    # slice the token sequence, token_mask and token index to only include the valid tokens
    token_seq = token_seq[:, index_mask]
    token_mask = token_mask[:, index_mask]
    token_index = token_index[:, index_mask]
    return token_seq, token_mask, token_index, index_mask


class AutoLatentTwostageDenoiser(nn.Module):
    """Two-stage denoiser: first predicts global root features, then body features conditioned on
    local root."""

    def __init__(
        self,
        motion_rep,
        motion_mask_mode,
        num_frames_per_token,
        nframe_root_dim,
        latent_embedding_dim,
        # other params
        ckpt_path: Optional[str] = None,
        sparsify_token_seq: bool = False,
        trt_compatible: bool = True,
        **kwargs,
    ):
        """Build root and body transformer blocks; optionally load checkpoint from ckpt_path."""
        assert not (sparsify_token_seq and trt_compatible), "Should choose between sparsification or trt compatibility."

        super().__init__()
        self.motion_rep = motion_rep
        self.motion_mask_mode = motion_mask_mode

        self.num_frames_per_token = num_frames_per_token
        self.nframe_root_dim = nframe_root_dim

        self.latent_embedding_dim = latent_embedding_dim
        self.latent_dim = kwargs["latent_dim"]
        self.positional_encoding_mode = kwargs["positional_encoding_mode"]
        self.llm_shape = kwargs["llm_shape"]

        self.sparsify_token_seq = sparsify_token_seq

        print(f"sparsify_token_seq: {self.sparsify_token_seq}")

        local_root_dim = motion_rep.local_root_dim
        self.nframe_local_root_dim = local_root_dim * self.num_frames_per_token
        global_root_hybrid_token_dim = self.nframe_root_dim + self.latent_embedding_dim

        local_root_hybrid_token_dim = (
            self.nframe_local_root_dim + self.latent_embedding_dim
        )  # body stage always takes in local root info for motion (but still the global mask)

        if motion_mask_mode == "concat":
            # stage 1: root pred only
            self.global_root_hybrid_proj = nn.Linear(global_root_hybrid_token_dim, self.latent_dim)
            global_root_hybrid_constraints_dim = (
                global_root_hybrid_token_dim
                + (motion_rep.motion_rep_dim + motion_rep.body_dim) * self.num_frames_per_token
            )
            self.global_root_hybrid_constraints_proj = nn.Linear(
                global_root_hybrid_constraints_dim, self.latent_dim
            )  # generation tokens with constraints infilling and concat
            # stage 2: body pred only
            self.local_root_hybrid_proj = nn.Linear(local_root_hybrid_token_dim, self.latent_dim)
            local_root_hybrid_constraints_dim = (
                local_root_hybrid_token_dim
                + (motion_rep.motion_rep_dim + motion_rep.body_dim) * self.num_frames_per_token
            )  # body stage always takes in local root info for motion (but still the global mask)
            self.local_root_hybrid_constraints_proj = nn.Linear(
                local_root_hybrid_constraints_dim, self.latent_dim
            )  # generation tokens with constraints infilling and concat
            # explicit future constraints projection for both stages
            self.future_constraints_proj = nn.Linear(
                motion_rep.motion_rep_dim * 2 * self.num_frames_per_token,
                self.latent_dim,
            )
        else:
            assert motion_mask_mode is None
            self.global_root_hybrid_proj = nn.Linear(global_root_hybrid_token_dim, self.latent_dim)
            self.local_root_hybrid_proj = nn.Linear(local_root_hybrid_token_dim, self.latent_dim)

        root_output_dim = self.nframe_root_dim
        self.root_model = TransformerEncoderBlock(
            add_input_proj=False,
            input_dim=-1,  # for compatibility
            output_dim=root_output_dim,
            skeleton=self.motion_rep.skeleton,
            **kwargs,
        )

        body_output_dim = self.latent_embedding_dim
        self.body_model = TransformerEncoderBlock(
            add_input_proj=False,
            input_dim=-1,  # for compatibility
            output_dim=body_output_dim,
            skeleton=self.motion_rep.skeleton,
            **kwargs,
        )

        self.trt_compatible = trt_compatible
        self.hybrid = HybridMotionConverter(denoiser=self)

        if ckpt_path:
            self.load_ckpt(ckpt_path)

    def load_ckpt(self, ckpt_path: str) -> None:
        """Load checkpoint from path; state dict keys are stripped of 'denoiser.backbone.'
        prefix."""
        state_dict = load_checkpoint_state_dict(ckpt_path)
        state_dict = {
            key.replace("denoiser.", ""): val for key, val in state_dict.items() if key.startswith("denoiser")
        }
        state_dict = {key.replace("backbone.", ""): val for key, val in state_dict.items()}
        self.load_state_dict(state_dict)

    def forward(
        self,
        x: torch.Tensor,
        history_len: torch.Tensor,
        generation_len: torch.Tensor,
        future_len: torch.Tensor,
        history_mask: torch.Tensor,
        generation_mask: torch.Tensor,
        future_mask: torch.Tensor,
        history_token_mask: torch.Tensor,
        generation_token_mask: torch.Tensor,
        future_token_mask: torch.Tensor,
        text_feat: torch.Tensor,
        text_feat_pad_mask: torch.Tensor,
        timesteps: torch.Tensor,
        first_heading_angle: Optional[torch.Tensor] = None,
        motion_mask: Optional[torch.Tensor] = None,
        observed_motion: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        """
        Args:
            x (torch.Tensor): [B, num_tokens, dim_token] current noisy hybrid motion
            history_len (torch.Tensor): [B,] history length
            generation_len (torch.Tensor): [B,] generation length
            future_len (torch.Tensor): [B,] future length. history_len + generation_len + future length == motion_len, but not necessarily equal to num_frames which are padded to the same length
            history_mask (torch.Tensor): [B, num_frames] attention mask, positions with True are allowed to attend, False are not
            generation_mask (torch.Tensor): [B, num_frames] attention mask, positions with True are allowed to attend, False are not
            future_mask (torch.Tensor): [B, num_frames] attention mask, positions with True are allowed to attend, False are not
            history_token_mask (torch.Tensor): [B, num_tokens] attention mask, positions with True are allowed to attend, False are not
            generation_token_mask (torch.Tensor): [B, num_tokens] attention mask, positions with True are allowed to attend, False are not
            future_token_mask (torch.Tensor): [B, num_tokens] attention mask, positions with True are allowed to attend, False are not
            text_feat (torch.Tensor): [B, max_text_len, llm_dim] embedded text prompts
            text_feat_pad_mask (torch.Tensor): [B, max_text_len] attention mask, positions with True are allowed to attend, False are not
            timesteps (torch.Tensor): [B,] current denoising step
            motion_mask (torch.Tensor): [B, num_frames, dim_motion] attention mask, positions with True are allowed to attend, False are not
            observed_motion (torch.Tensor): [B, num_frames, dim_motion] observed motion

        Returns:
            torch.Tensor: same size as input x
        """
        bs, num_tokens, dim_token = x.shape
        num_frames = num_tokens * self.num_frames_per_token
        global_root_motion, latent_body_motion = self.hybrid.get_root_and_latent_body_motion_from_hybrid(x)
        token_index = torch.arange(num_tokens, device=x.device)[None, :].repeat(bs, 1)  # [B, num_tokens]
        if self.positional_encoding_mode == "learned_prefix_zero_at_first_generation":
            origin_index = history_len // self.num_frames_per_token
            token_index = token_index - origin_index[:, None]

        if self.motion_mask_mode is not None:
            if motion_mask is None or observed_motion is None:
                motion_shape = (bs, num_frames, self.motion_rep.motion_rep_dim)
                motion_mask = torch.zeros(motion_shape, device=x.device)
                observed_motion = torch.zeros(motion_shape, device=x.device)

            if self.motion_mask_mode == "concat":
                observed_root_motion = self.motion_rep.extract_root(observed_motion)
                observed_body_motion = self.motion_rep.extract_body(observed_motion)
                root_motion_mask = self.motion_rep.extract_root(motion_mask)
                # infill root constraints from observed motion and motion mask. the root motion mask will always be false for the history tokens, so the history root motion will not be changed.
                global_root_motion = (
                    global_root_motion * (1 - root_motion_mask) + observed_root_motion * root_motion_mask
                )

                x_infilled_extended = torch.cat(
                    [
                        latent_body_motion,
                        global_root_motion.reshape((bs, num_tokens, self.nframe_root_dim)),
                        observed_body_motion.reshape(bs, num_tokens, -1),
                        motion_mask.reshape(bs, num_tokens, -1),
                    ],
                    dim=-1,
                )

                if self.trt_compatible:
                    # Dense masking instead of fancy indexing (TRT-compatible)
                    generation_token_proj = (
                        self.global_root_hybrid_constraints_proj(x_infilled_extended)
                        * generation_token_mask[:, :, None]
                    )
                    history_token_proj = self.global_root_hybrid_proj(x) * history_token_mask[:, :, None]
                    future_token_proj = (
                        self.future_constraints_proj(x_infilled_extended[:, :, self.latent_embedding_dim :])
                        * future_token_mask[:, :, None]
                    )
                    root_stage_input = generation_token_proj + history_token_proj + future_token_proj
                    root_stage_pad_mask = history_token_mask | generation_token_mask | future_token_mask
                else:
                    generation_token_extended = x_infilled_extended[
                        generation_token_mask
                    ]  # [num_generation_tokens, D], float32
                    generation_token_proj = self.global_root_hybrid_constraints_proj(
                        generation_token_extended
                    )  # [num_generation_tokens, latent_dim for transformer], float16, note the dtype can change
                    history_token = x[history_token_mask]  # [num_history_tokens, D]
                    history_token_proj = self.global_root_hybrid_proj(history_token)
                    future_constraints_input = x_infilled_extended[future_token_mask]
                    future_constraints_input = future_constraints_input[
                        :, self.latent_embedding_dim :
                    ]  # [num_future_tokens, D], extract the part after the latent body embedding
                    future_token_proj = self.future_constraints_proj(future_constraints_input)
                    dtype = generation_token_proj.dtype
                    device = generation_token_proj.device
                    root_stage_input = torch.zeros(
                        bs, num_tokens, self.latent_dim, dtype=dtype, device=device
                    )  # [B, num_tokens, latent_dim for transformer]
                    root_stage_input[generation_token_mask] = generation_token_proj
                    root_stage_input[history_token_mask] = history_token_proj
                    root_stage_input[future_token_mask] = future_token_proj
                    root_stage_pad_mask = history_token_mask | generation_token_mask | future_token_mask
            else:
                raise NotImplementedError(f"This motion mask mode ({self.motion_mask_mode}) is not supported.")
        else:
            root_stage_input = self.global_root_hybrid_proj(x)
            root_stage_pad_mask = history_token_mask | generation_token_mask
        root_stage_token_index = token_index
        if self.sparsify_token_seq:
            (
                root_stage_input,
                root_stage_pad_mask,
                root_stage_token_index,
                root_stage_index_mask,
            ) = sparsify_token_seq(root_stage_input, root_stage_pad_mask, root_stage_token_index)

        # Stage 1: predict root motion in global
        global_root_motion_pred = self.root_model(
            root_stage_input,
            root_stage_pad_mask,
            text_feat,
            text_feat_pad_mask,
            timesteps,
            first_heading_angle,
            root_stage_token_index,
        )  # [B, num_tokens, num_frames_per_token * 5]
        if self.sparsify_token_seq:  # convert back to dense tensor
            dense_tensor = torch.zeros(
                bs,
                num_tokens,
                self.nframe_root_dim,
                dtype=global_root_motion_pred.dtype,
                device=global_root_motion_pred.device,
            )
            dense_tensor[:, root_stage_index_mask, :] = global_root_motion_pred
            global_root_motion_pred = dense_tensor
        global_root_motion_pred = rearrange(
            global_root_motion_pred,
            "b t (f d) -> b (t f) d",
            f=self.num_frames_per_token,
        )
        global_root_motion_pred = (
            global_root_motion_pred * generation_mask[:, :, None] + global_root_motion * history_mask[:, :, None]
        )
        lengths = history_len + generation_len

        # Convert root pred to local rep
        # At test-time want to allow gradient through for guidance
        convert_ctx = torch.no_grad() if self.training else contextlib.nullcontext()
        with convert_ctx:
            local_root_motion = self.motion_rep.global_root_to_local_root(
                global_root_motion_pred,
                normalized=True,
                lengths=lengths,
            )
        if self.training:
            local_root_motion = local_root_motion.detach()

        # concatenate the predicted local root with the body motion
        local_root_motion = rearrange(
            local_root_motion,
            "b (t f) d -> b t (f d)",
            f=self.num_frames_per_token,
        )
        x_new = torch.cat([local_root_motion, latent_body_motion], dim=-1)

        if self.motion_mask_mode == "concat":
            x_new_extended = torch.cat(
                [
                    x_new,
                    observed_body_motion.reshape(bs, num_tokens, -1),
                    motion_mask.reshape(bs, num_tokens, -1),
                ],
                dim=-1,
            )
            if self.trt_compatible:
                generation_token_proj = (
                    self.local_root_hybrid_constraints_proj(x_new_extended) * generation_token_mask[:, :, None]
                )
                history_token_proj = self.local_root_hybrid_proj(x_new) * history_token_mask[:, :, None]
                body_stage_input = generation_token_proj + history_token_proj + future_token_proj
                body_stage_pad_mask = history_token_mask | generation_token_mask | future_token_mask
            else:
                generation_token_extended = x_new_extended[generation_token_mask]  # [num_generation_tokens, D]
                generation_token_proj = self.local_root_hybrid_constraints_proj(  # noqa
                    generation_token_extended
                )
                history_token = x_new[history_token_mask]  # [num_history_tokens, D]
                history_token_proj = self.local_root_hybrid_proj(history_token)
                # reuse the future_token_proj from body stage, because the future constraints are explicit and sparse, we can not convert to local root
                dtype = generation_token_proj.dtype
                device = generation_token_proj.device
                body_stage_input = torch.zeros(
                    bs, num_tokens, self.latent_dim, dtype=dtype, device=device
                )  # [B, num_tokens, latent_dim for transformer]
                body_stage_input[generation_token_mask] = generation_token_proj
                body_stage_input[history_token_mask] = history_token_proj
                body_stage_input[future_token_mask] = future_token_proj
                body_stage_pad_mask = history_token_mask | generation_token_mask | future_token_mask
        else:
            assert self.motion_mask_mode is None
            body_stage_input = self.local_root_hybrid_proj(x_new)
            body_stage_pad_mask = history_token_mask | generation_token_mask
        body_stage_token_index = token_index
        if self.sparsify_token_seq:
            (
                body_stage_input,
                body_stage_pad_mask,
                body_stage_token_index,
                body_stage_index_mask,
            ) = sparsify_token_seq(body_stage_input, body_stage_pad_mask, body_stage_token_index)

        # Stage 2: predict local body motion based on local root
        latent_body_motion_pred = self.body_model(
            body_stage_input,
            body_stage_pad_mask,
            text_feat,
            text_feat_pad_mask,
            timesteps,
            first_heading_angle,
            body_stage_token_index,
        )
        if self.sparsify_token_seq:  # convert back to dense tensor
            dense_tensor = torch.zeros(
                bs,
                num_tokens,
                self.latent_embedding_dim,
                dtype=latent_body_motion_pred.dtype,
                device=latent_body_motion_pred.device,
            )
            dense_tensor[:, body_stage_index_mask, :] = latent_body_motion_pred
            latent_body_motion_pred = dense_tensor
        latent_body_motion_pred = (
            latent_body_motion_pred * generation_token_mask[:, :, None]
            + latent_body_motion * history_token_mask[:, :, None]
        )  # fuse history and generation tokens

        # concatenate the predicted local body with the predicted root
        output = torch.cat(
            [
                global_root_motion_pred.reshape(bs, num_tokens, self.nframe_root_dim),
                latent_body_motion_pred,
            ],
            dim=-1,
        )
        return output
