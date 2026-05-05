# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging
from contextlib import suppress
from functools import partial

import torch
import torch.nn as nn
from torch.distributed._composable.fsdp import MixedPrecisionPolicy, fully_shard
from torch.distributed.device_mesh import DeviceMesh
from torch.distributed.fsdp import register_fsdp_forward_method
from torch.distributed.fsdp._fully_shard._fsdp_state import FSDPState
from torch.utils.checkpoint import create_selective_checkpoint_contexts

logger = logging.getLogger("dinov3")


def map_modules_and_blocks(models: list[nn.Module], callable) -> None:
    for m in models:
        for block_id, block in enumerate(m.blocks):
            m.blocks[block_id] = callable(block, is_backbone_block=True)


def ac_compile_parallelize_and_init(
    clip_model: nn.Module,
    world_mesh: DeviceMesh,
    do_compile: bool,
    use_activation_checkpointing: bool,
    use_full_activation_checkpointing: bool,
    use_cuda_graphs: bool,
    param_dtype_str: str = "bf16",
    reduce_dtype_str: str = "fp32",
) -> None:
    """
    Order of the wrappers:
    1/ Activation checkpointing on blocks
    2/ Compile blocks
    3/ FSDP blocks + global model
    """
    logger.info("DISTRIBUTED FSDP -- preparing model for distributed training")

    # 1/ AC on blocks
    from torch.distributed.algorithms._checkpoint.checkpoint_wrapper import (
        checkpoint_wrapper,
    )

    trained_models = []
    inference_only_models = []
    for model in [clip_model.visual_model, clip_model.text_model]:
        if not model.freeze_backbone:
            trained_models.append(model.backbone)
        else:
            inference_only_models.append(model.backbone)
        trained_models.append(model.head)

    for model in trained_models:
        if use_activation_checkpointing:
            if use_full_activation_checkpointing:
                _checkpointing_wrapper = checkpoint_wrapper
                logger.info(
                    "using selective checkpointing on backbone with full checkpointing policy"
                )
            else:
                _save_list = [
                    # mm
                    torch.ops.aten.mm.default,
                    torch.ops.aten._scaled_mm.default,
                    # attentions
                    torch.ops.aten._scaled_dot_product_efficient_attention.default,
                    torch.ops.aten._scaled_dot_product_flash_attention.default,
                    torch.ops._c10d_functional.reduce_scatter_tensor.default,
                ]
                with suppress(
                    AttributeError
                ):  # ignore exception if op is missing (old xFormers)
                    _save_list.append(torch.ops.xformers_flash3.flash_fwd.default)
                _checkpointing_wrapper = partial(
                    checkpoint_wrapper,
                    context_fn=partial(
                        create_selective_checkpoint_contexts, _save_list
                    ),
                    preserve_rng_state=True,
                )
                logger.info(
                    "using selective checkpointing on backbone with selective policy"
                )
            for i, b in enumerate(model.blocks):
                if not isinstance(b, nn.Identity):
                    model.blocks[i] = _checkpointing_wrapper(b)

    # 2/ Compile blocks
    def compile_block(block: nn.Module) -> nn.Module:
        if do_compile:
            if use_cuda_graphs:
                block.compile(
                    fullgraph=True, dynamic=False, options={"triton.cudagraphs": True}
                )
            else:
                block.compile()
        return block

    def compile_backbone(backbone: nn.Module) -> nn.Module:
        for block_id, block in enumerate(backbone.blocks):
            backbone.blocks[block_id] = compile_block(block)

    def compile_head(head: nn.Module) -> nn.Module:
        for block_id in range(head.num_blocks):
            head.blocks[block_id] = compile_block(head.blocks[block_id])
        if do_compile and isinstance(head.linear_projection, nn.Linear):
            head.linear_projection.compile()

    compile_backbone(clip_model.visual_model.backbone)
    compile_backbone(clip_model.text_model.backbone)
    compile_head(clip_model.visual_model.head)
    compile_head(clip_model.text_model.head)
    DTYPE_MAP = {
        "fp16": torch.float16,
        "bf16": torch.bfloat16,
        "fp32": torch.float32,
    }
    mp_policy = MixedPrecisionPolicy(
        param_dtype=DTYPE_MAP[param_dtype_str],
        reduce_dtype=DTYPE_MAP[reduce_dtype_str],
    )
    fsdp_config = {"mesh": world_mesh["dp"], "mp_policy": mp_policy}

    for block in clip_model.visual_model.backbone.blocks:
        fully_shard(block, **fsdp_config, reshard_after_forward=True)
    for i in range(clip_model.visual_model.head.num_blocks):
        fully_shard(
            clip_model.visual_model.head.blocks[i],
            **fsdp_config,
            reshard_after_forward=True,
        )
    fully_shard(
        clip_model.visual_model.head.linear_projection,
        **fsdp_config,
        reshard_after_forward=True,
    )
    fully_shard(
        clip_model.visual_model.backbone, **fsdp_config, reshard_after_forward=True
    )
    fully_shard(clip_model.visual_model.head, **fsdp_config, reshard_after_forward=True)
    register_fsdp_forward_method(
        clip_model.visual_model.backbone, "get_intermediate_layers"
    )
    for block in clip_model.text_model.backbone.blocks:
        fully_shard(block, **fsdp_config, reshard_after_forward=True)
    for i in range(clip_model.text_model.head.num_blocks):
        fully_shard(
            clip_model.text_model.head.blocks[i],
            **fsdp_config,
            reshard_after_forward=True,
        )
    fully_shard(
        clip_model.text_model.head.linear_projection,
        **fsdp_config,
        reshard_after_forward=True,
    )
    fully_shard(
        clip_model.text_model.backbone, **fsdp_config, reshard_after_forward=True
    )
    fully_shard(clip_model.text_model.head, **fsdp_config, reshard_after_forward=True)

    clip_model.to_empty(device="cuda")
    clip_model.init_weights()

    for model in inference_only_models:
        fsdp_state: FSDPState = model._get_fsdp_state()
        if not fsdp_state._fsdp_param_group:
            continue
        mi = fsdp_state._fsdp_param_group.post_forward_mesh_info
        fsdp_state._lazy_init()
        fsdp_state._fsdp_param_group.post_forward_mesh_info = mi
