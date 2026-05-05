# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

from dataclasses import dataclass

from .models.position_encoding import PositionEncoding


@dataclass(kw_only=True)
class DetectionHeadConfig:
    num_classes: int = 91  # 91 classes in COCO
    # Deformable DETR tricks
    with_box_refine: bool = True
    two_stage: bool = True
    # DINO DETR tricks
    mixed_selection: bool = True
    look_forward_twice: bool = True  # was default False
    # Hybrid Matching tricks
    k_one2many: int = 6  # was 5
    lambda_one2many: float = 1.0
    num_queries_one2one: int = 300  # number of query slots for one_to_one matching
    num_queries_one2many: int = 1500  # was 0, number of query slots for one_to_many matching
    """
    Absolute coordinates & box regression reparameterization.
    If true, we use absolute coordindates & reparameterization for bounding boxes.
    """
    reparam: bool = True
    topk: int = 100

    # * Backbone
    # type of positional embedding to use on top of the image features
    position_embedding: PositionEncoding = PositionEncoding.SINE
    num_feature_levels: int = 1  # number of feature levels

    # * Transformer
    dec_layers: int = 6  # number of decoding layers in the transformer
    dim_feedforward: int = 2048  # intermediate size of the feedforward layers in the transformer blocks
    hidden_dim: int = 256  # size of the embeddings (dimension of the transformer)
    dropout: float = 0.0  # dropout applied in the transformer, was 0.1
    nheads: int = 8  # number of attention heads inside the transformer's attentions
    norm_type: str = "pre_norm"

    # Loss
    aux_loss: bool = True  # auxiliary decoding losses (loss at each layer)

    # * dev: proposals
    proposal_feature_levels: int = 4  # was 1
    proposal_min_size: int = 50
    # * dev decoder: global decoder
    decoder_type: str = "global_rpe_decomp"  # was deform
    decoder_use_checkpoint: bool = False
    decoder_rpe_hidden_dim: int = 512
    decoder_rpe_type: str = "linear"

    # Custom
    add_transformer_encoder: bool = True
    num_encoder_layers: int = 6
    layers_to_use: list[int] | None = None
    blocks_to_train: list[int] | None = None
    n_windows_sqrt: int = 0
    proposal_in_stride: int | None = None
    proposal_tgt_strides: list[int] | None = None
    backbone_use_layernorm: bool = False  # whether to use layernorm on each layer of the backbone's features
