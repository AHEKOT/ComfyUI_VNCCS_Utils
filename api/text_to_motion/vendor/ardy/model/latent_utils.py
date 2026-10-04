# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Shared utility functions for latent motion models.

These functions were originally in latent_ardy_train.py and are used by auto_latent training and
test-time code.
"""

import logging
from functools import cached_property

import torch

log = logging.getLogger(__name__)


class HybridMotionConverter:
    """Converts between explicit motion and the hybrid (root + latent token) rep.

    Bundles the ``denoiser``, ``autoencoder`` and ``motion_rep`` that every conversion needs so call
    sites don't have to thread them through manually. Derived attributes (``num_frames_per_token``,
    ``motion_rep``) are resolved lazily and raise a clear error if the required object is missing,
    instead of half-initializing.
    """

    def __init__(self, *, denoiser=None, autoencoder=None, motion_rep=None, gen_horizon_len=None):
        if denoiser is None and autoencoder is None:
            raise ValueError("HybridMotionConverter needs a denoiser and/or an autoencoder")
        self.denoiser = denoiser
        self.autoencoder = autoencoder
        self._motion_rep = motion_rep
        self.gen_horizon_len = gen_horizon_len

    @classmethod
    def from_model(cls, ardy_model):
        """Build from an object exposing ``denoiser``/``autoencoder``/``motion_rep``."""
        return cls(
            denoiser=ardy_model.denoiser,
            autoencoder=ardy_model.autoencoder,
            motion_rep=ardy_model.motion_rep,
            gen_horizon_len=getattr(ardy_model, "gen_horizon_len", None),
        )

    @cached_property
    def motion_rep(self):
        rep = self._motion_rep
        if rep is None and self.denoiser is not None:
            rep = self.denoiser.motion_rep
        if rep is None and self.autoencoder is not None:
            rep = self.autoencoder.motion_rep
        if rep is None:
            raise ValueError("No motion_rep available on denoiser or autoencoder")
        return rep

    @cached_property
    def num_frames_per_token(self):
        if self.autoencoder is not None:
            return self.autoencoder.num_frames_per_token
        return self.denoiser.num_frames_per_token

    def get_num_frames_from_hybrid(self, hybrid_motion):
        num_tokens = hybrid_motion.shape[1]
        num_frames = self.num_frames_per_token * num_tokens
        return num_frames

    def get_root_and_latent_body_motion_from_hybrid(self, hybrid_motion):
        num_frames = self.get_num_frames_from_hybrid(hybrid_motion)
        bs = hybrid_motion.shape[0]

        root_motion = hybrid_motion[
            :, :, : self.denoiser.nframe_root_dim
        ]  # (B, num_frames // num_frames_per_token, dim_root * num_frames_per_token)
        root_motion = root_motion.reshape(bs, num_frames, self.motion_rep.motion_root_dim)  # (B, num_frames, dim_root)
        latent_body_motion = hybrid_motion[:, :, self.denoiser.nframe_root_dim :]  # (B, num_tokens, dim_latent_body)
        return root_motion, latent_body_motion

    def get_explicit_motion_from_hybrid(
        self,
        hybrid_motion,
        motion_pad_mask,
        motion_len,
        motion_mask=None,
    ):
        # Separate the root and the latents
        global_root_motion, latent_body_motion = self.get_root_and_latent_body_motion_from_hybrid(hybrid_motion)
        # Compute the local root as a condition
        local_root_motion = self.motion_rep.global_root_to_local_root(
            global_root_motion, normalized=True, lengths=motion_len
        )

        # Detokenize the tokens
        output = self.autoencoder.detokenize(
            latent_body_motion,
            external_cond=local_root_motion,
            motion_pad_mask=motion_pad_mask,
        )
        decoded_body_motion = output["body"]
        # Construct back the motion features
        motion = self.motion_rep.concat_root_body(global_root_motion, decoded_body_motion)
        return motion

    def get_explicit_motion_from_hybrid_autoregressive(
        self,
        hybrid_motion,
        motion_pad_mask,
        motion_len,
        motion_mask=None,
        crop_history_length=None,
    ):
        if self.gen_horizon_len is None:
            raise ValueError("gen_horizon_len is required for autoregressive decoding (see from_model)")
        gen_horizon_len = self.gen_horizon_len
        num_frames_per_token = self.num_frames_per_token
        num_generation_tokens = gen_horizon_len // num_frames_per_token
        token_len = hybrid_motion.shape[1]
        results = []
        for token_idx in range(0, token_len, num_generation_tokens):
            generation_token_end = min(token_idx + num_generation_tokens, token_len)
            generation_token_start = token_idx
            history_token_start = (
                max(0, token_idx - crop_history_length // num_frames_per_token)
                if crop_history_length is not None
                else 0
            )
            generation_frame_start = generation_token_start * num_frames_per_token
            generation_frame_end = generation_token_end * num_frames_per_token
            history_frame_start = history_token_start * num_frames_per_token
            explicit_motion = self.get_explicit_motion_from_hybrid(
                hybrid_motion[:, history_token_start:generation_token_end],
                motion_pad_mask[:, history_frame_start:generation_frame_end],
                motion_pad_mask[:, history_frame_start:generation_frame_end].sum(dim=-1),
                motion_mask=motion_mask[:, history_frame_start:generation_frame_end]
                if motion_mask is not None
                else None,
            )
            results.append(
                explicit_motion[
                    :,
                    generation_frame_start - history_frame_start : generation_frame_end - history_frame_start,
                ]
            )
        motion = torch.cat(results, dim=1)
        return motion

    def get_hybrid_motion_from_root_and_latent_body_motion(
        self,
        root_motion,
        latent_body_motion,
    ):
        bs = root_motion.shape[0]
        nframe_root_dim = self.denoiser.nframe_root_dim
        num_tokens = latent_body_motion.shape[1]
        hybrid_motion = torch.cat(
            [root_motion.reshape(bs, num_tokens, nframe_root_dim), latent_body_motion],
            dim=-1,
        )
        return hybrid_motion

    def get_hybrid_motion_from_explicit(
        self,
        motion,
        motion_len,
        motion_pad_mask,
    ):
        token_embedding = self.autoencoder.tokenize(motion, motion_pad_mask=motion_pad_mask)  # (B, T, D)

        # ensure masked tokens are set to 0
        bs, num_frames = motion_pad_mask.shape
        num_frames_per_token = self.num_frames_per_token

        motion_token_mask = motion_pad_mask.reshape(bs, num_frames // num_frames_per_token, num_frames_per_token).all(
            dim=-1
        )  # (B, num_frames // num_frames_per_token)
        token_embedding = token_embedding * motion_token_mask[:, :, None]

        root = self.motion_rep.extract_root(motion)
        root_reshape = root.reshape(
            bs,
            num_frames // num_frames_per_token,
            self.motion_rep.motion_root_dim * num_frames_per_token,
        )  # (B, num_frames // num_frames_per_token, dim_root * num_frames_per_token)
        hybrid_motion = torch.cat(
            [root_reshape, token_embedding], dim=-1
        )  # (B, num_frames // num_frames_per_token, dim_hybrid)
        hybrid_motion_pad_mask = motion_pad_mask.reshape(
            bs, num_frames // num_frames_per_token, num_frames_per_token
        ).all(dim=-1)  # (B, num_frames // num_frames_per_token)

        return hybrid_motion, hybrid_motion_pad_mask

    def convert_frame_mask_to_token_mask(
        self,
        history_mask,
        generation_mask,
        future_mask,
        motion_mask=None,
    ):
        num_frames_per_token = self.num_frames_per_token
        bs, num_frames = history_mask.shape[0], history_mask.shape[1]
        history_token_mask = history_mask.reshape(bs, num_frames // num_frames_per_token, num_frames_per_token).all(
            dim=-1
        )  # (B, num_frames // num_frames_per_token)
        generation_token_mask = generation_mask.reshape(
            bs, num_frames // num_frames_per_token, num_frames_per_token
        ).all(dim=-1)  # (B, num_frames // num_frames_per_token)
        future_token_mask = torch.zeros_like(history_token_mask)
        if motion_mask is not None:
            future_token_mask = future_mask.reshape(bs, num_frames // num_frames_per_token, num_frames_per_token).all(
                dim=-1
            )  # (B, num_frames // num_frames_per_token)
            has_observation = motion_mask.any(dim=-1)  # if any feature is observed, the token is valid
            has_observation = has_observation.reshape(
                bs, num_frames // num_frames_per_token, num_frames_per_token
            ).any(
                dim=-1
            )  # (B, num_frames // num_frames_per_token), future constraints are sparse, any frame with constraints make the token valid
            future_token_mask = future_token_mask & has_observation

        return history_token_mask, generation_token_mask, future_token_mask
