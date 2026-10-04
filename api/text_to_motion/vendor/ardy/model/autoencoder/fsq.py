# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch as t
from torch import nn
from ....fsq_quantizer import FSQ

from ..loading import load_checkpoint_state_dict
from ...motion_rep import MotionRepBase
from ...motion_rep.stats import Stats

from .transformer import (
    DoubleCondDecoderTransformer,
    EncoderTransformer,
)


def round_ste(z):
    """Round with straight through gradients."""
    zhat = z.round()
    return z + (zhat - z).detach()


class FSQVAETransformer(nn.Module):
    ALLOWED_FEATURE_MODE = ["pose", "body", "root"]

    def __init__(
        self,
        motion_rep: MotionRepBase,
        feature_mode: list,
        # fsq config
        num_fsq_levels: int = 5,
        fsq_level_list: int | list[int] = [16, 16, 16, 16, 16],
        # encoding config
        encode_with_normalization: bool = True,
        encode_with_quantization: bool = True,
        # network config
        latent_embedding_dim: int = 128,  # number of the output embedding dimension
        num_frames_per_token: int = 4,
        latent_dim: int = 512,
        ff_size: int = 1024,
        num_layers: int = 8,
        num_heads: int = 4,
        activation: str = "gelu",
        dropout: float = 0.1,
        pe_dropout: float = 0.1,
        norm_first: bool = False,
        causal_encoder: bool = False,
        causal_decoder: bool = False,
        ckpt_path: Optional[str] = None,
        **kwargs,
    ):
        super().__init__()
        self._motion_rep = motion_rep
        self._num_frames_per_token = num_frames_per_token
        self._latent_embedding_dim = num_fsq_levels

        self.encode_with_normalization = encode_with_normalization
        self.encode_with_quantization = encode_with_quantization

        assert len(feature_mode) == 4 and np.all([f in self.ALLOWED_FEATURE_MODE for f in feature_mode])
        (
            self.encoder_input_feature_mode,  # body
            self.decoder_output_feature_mode,  # pose
            self.decoder_target_cond_feature_mode,  # body
            self.decoder_external_cond_feature_mode,  # root
        ) = feature_mode

        # always use the local root
        dim_dict = {
            "pose": motion_rep.local_motion_rep_dim,  # local root + body
            "body": motion_rep.body_dim,
            "root": motion_rep.local_root_dim,
        }
        encoder_state_dim = dim_dict[self.encoder_input_feature_mode]
        decoder_state_dim = dim_dict[self.decoder_output_feature_mode]
        decoder_target_cond_dim = dim_dict[self.decoder_target_cond_feature_mode]
        decoder_external_cond_dim = dim_dict[self.decoder_external_cond_feature_mode]

        latent_embedding_dim = num_fsq_levels
        self.encoder = EncoderTransformer(
            encoder_state_dim,
            latent_embedding_dim,
            num_frames_per_token,
            latent_dim,
            num_heads,
            ff_size,
            dropout,
            activation,
            norm_first,
            num_layers,
            pe_dropout,
            causal_encoder,
        )
        self.decoder = DoubleCondDecoderTransformer(
            latent_embedding_dim,
            decoder_state_dim,
            num_frames_per_token,
            latent_dim,
            num_heads,
            ff_size,
            dropout,
            activation,
            norm_first,
            num_layers,
            pe_dropout,
            causal_decoder,
            target_cond_dim=decoder_target_cond_dim,
            external_cond_dim=decoder_external_cond_dim,
        )

        if isinstance(fsq_level_list, int):
            fsq_level_list = [fsq_level_list] * num_fsq_levels
        assert len(fsq_level_list) == num_fsq_levels, (
            f"fsq_level_list must have num_fsq_levels={num_fsq_levels} entries, got {len(fsq_level_list)}"
        )
        self.quantizer = FSQ(levels=fsq_level_list, return_indices=False)

        if ckpt_path:
            self.load_ckpt(ckpt_path)
        self.eval_and_freeze()

        # make forward by default used for detokenization
        self.forward = self.detokenize

    def eval_and_freeze(self):
        self.eval()
        # freeze the autoencoder
        for param in self.parameters():
            param.requires_grad = False

    def load_ckpt(self, ckpt_path: str) -> None:
        """Load checkpoint from path; state dict keys are stripped of 'denoiser.backbone.' prefix.

        Then load the stats.
        """
        # Load ckpt
        state_dict = load_checkpoint_state_dict(ckpt_path)
        state_dict = {
            key.removeprefix("pose_net."): val for key, val in state_dict.items() if key.startswith("pose_net")
        }
        self.load_state_dict(state_dict)

        ckpt_path = str(ckpt_path)
        autoencoder_stats_dir = Path(ckpt_path).parent / "stats"
        self.post_quantization_stats = Stats(folder=autoencoder_stats_dir / "post_quantization", load=True)
        self.pre_quantization_stats = Stats(folder=autoencoder_stats_dir / "pre_quantization", load=True)

    @property
    def motion_rep(self):
        return self._motion_rep

    @property
    def num_frames_per_token(self):
        return self._num_frames_per_token

    def extract_feature(
        self,
        x: t.Tensor,
        feature: str = "",
        lengths: Optional[torch.Tensor] = None,
    ):
        """@brief: extract the full pose / root or body from the full local features"""
        assert feature in self.ALLOWED_FEATURE_MODE

        if feature == "body":
            return self.motion_rep.extract_body(x)

        global_root = self.motion_rep.extract_root(x)
        local_root = self.motion_rep.global_root_to_local_root(global_root, normalized=True, lengths=lengths)

        if feature == "root":
            return local_root

        # pose
        assert feature == "pose"
        body = self.motion_rep.extract_body(x)
        local_features = torch.cat([local_root, body], dim=-1)
        return local_features

    def tokenize(
        self,
        x: t.Tensor,
        motion_pad_mask: t.BoolTensor,
    ):
        """@brief: get the embeddings of the input motion
        @param x: local poses [batch_size, numFrames, feat_dim]
        @param motion_pad_mask: [batch_size, numFrames], 1 means valid frames
        @return embeddings: [batch_size, num_tokens, feat_dim]
        """
        # create lengths
        x_in = self.extract_feature(x, self.encoder_input_feature_mode, lengths=motion_pad_mask.sum(1))
        x_encoder = self.encoder(x_in, motion_pad_mask)

        if self.encode_with_quantization:
            x_quantized, indices = self.quantizer(x_encoder)
            token_embeddings = x_quantized
        else:
            token_embeddings = x_encoder

        if self.encode_with_normalization:
            # mean = self.stats['mean_after_quantization'] if encode_with_quantization else self.stats['mean_before_quantization']
            # std = self.stats['std_after_quantization'] if encode_with_quantization else self.stats['std_before_quantization']
            # token_embeddings = (token_embeddings - mean) / std
            stats = self.post_quantization_stats if self.encode_with_quantization else self.pre_quantization_stats
            token_embeddings = stats.normalize(token_embeddings)

        return token_embeddings

    def detokenize(
        self,
        token_embeddings: t.Tensor,
        external_cond: t.Tensor = None,
        motion_pad_mask: t.BoolTensor = None,
    ):
        """@brief: get the original motion from the token embeddings
        @param token_embeddings: [batch_size, num_tokens, feat_dim]
        @param motion_pad_mask: [batch_size, numFrames], 1 means valid frames
        @return x: [batch_size, numFrames, feat_dim]
        """
        if self.encode_with_normalization:
            # mean = self.stats['mean_after_quantization'] if encode_with_quantization else self.stats['mean_before_quantization']
            # std = self.stats['std_after_quantization'] if encode_with_quantization else self.stats['std_before_quantization']
            # token_embeddings = token_embeddings * std + mean
            stats = self.post_quantization_stats if self.encode_with_quantization else self.pre_quantization_stats
            token_embeddings = stats.unnormalize(token_embeddings)

        if not self.encode_with_quantization:  # quantization not applied at encoding
            token_embeddings, indices = self.quantizer(token_embeddings)
        else:  # redo the rounding operation do ensure quantization, but we can not directly call quantizer since it include additional operation apart from rounding
            half_width = self.quantizer._levels // 2
            token_embeddings = round_ste(token_embeddings.clamp(-1, 1) * half_width) / half_width

        x_decoder = self.decoder(
            token_embeddings,
            external_cond=external_cond,
            motion_pad_mask=motion_pad_mask,
        )
        # produce a dict instead of the raw output
        output = {}
        if self.decoder_output_feature_mode == "pose":
            output["root"] = x_decoder[..., : self.motion_rep.local_root_dim]
            output["body"] = x_decoder[..., self.motion_rep.local_root_dim :]
        elif self.decoder_output_feature_mode == "body":
            output["body"] = x_decoder
        elif self.decoder_output_feature_mode == "root":
            output["root"] = x_decoder
        else:
            raise NotImplementedError
        return output

    def requantize(
        self,
        token_embeddings: t.Tensor,
    ):
        """@brief: requantize the token embeddings to the discrete values
        @param token_embeddings: [batch_size, num_tokens, feat_dim]
        @return requantized_token_embeddings: [batch_size, num_tokens, feat_dim]
        """
        assert self.encode_with_quantization, "Only support encode_with_quantization=True"

        if self.encode_with_normalization:  # unnormalize the token embeddings
            stats = self.post_quantization_stats
            token_embeddings = stats.unnormalize(token_embeddings)

        half_width = self.quantizer._levels // 2
        token_embeddings = round_ste(token_embeddings.clamp(-1, 1) * half_width) / half_width

        if self.encode_with_normalization:  # normalize the token embeddings
            stats = self.post_quantization_stats
            token_embeddings = stats.normalize(token_embeddings)

        return token_embeddings
