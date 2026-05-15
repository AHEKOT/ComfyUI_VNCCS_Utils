# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging
from pathlib import Path
from typing import Any, Dict, List

import dinov3.distributed as distributed
import torch
from dinov3.checkpointer import load_checkpoint, register_dont_save_hooks
from dinov3.data import (
    make_classification_eval_transform,
    make_classification_train_transform,
)
from torch.distributed import DeviceMesh
from torch.distributed._composable.replicate import replicate
from torch.distributed.device_mesh import init_device_mesh

from dinov3.eval.text.tokenizer import get_tokenizer

from dinov3.eval.text.ac_comp_parallelize import ac_compile_parallelize_and_init
from dinov3.eval.text.dinotxt_model import DINOTxt, DINOTxtConfig

logger = logging.getLogger("dinov3")


# This allows us to load OSS DINOv2 models from pretrained weights using DINOv3 ViT
def rename_register_token(
    chkpt: Dict[str, Any], n_register_tokens: int, embed_dim: int
) -> Dict[str, Any]:
    if "register_tokens" in chkpt:
        chkpt["storage_tokens"] = chkpt["register_tokens"]
        del chkpt["register_tokens"]
    else:
        chkpt["storage_tokens"] = torch.zeros(1, n_register_tokens, embed_dim)
    return chkpt


def load_backbone_checkpoint(
    model: torch.nn.Module,
    checkpoint_path: str,
    world_mesh: DeviceMesh,
    skip_load_prefixes: List[str] = [],
):
    if not Path(checkpoint_path).is_dir():  # PyTorch standard checkpoint
        logger.info(f"Loading pretrained weights from {checkpoint_path}")
        state_dict = torch.load(checkpoint_path, map_location="cpu")
        if "register_tokens" in state_dict:
            state_dict["storage_tokens"] = state_dict["register_tokens"]
            del state_dict["register_tokens"]
        if "teacher" in state_dict:
            state_dict = state_dict["teacher"]
        state_dict = {k.replace("module.", ""): v for k, v in state_dict.items()}
        state_dict = {k.replace("backbone.", ""): v for k, v in state_dict.items()}
        state_dict = {
            k: (
                torch.distributed.tensor.distribute_tensor(
                    v, world_mesh, src_data_rank=None
                )
                if not k.startswith("rope_embed.periods") and "qkv.bias_mask" not in k
                else v
            )
            for k, v in state_dict.items()
        }
        model.load_state_dict(
            {
                k: v
                for k, v in state_dict.items()
                if not any(k.startswith(prefix) for prefix in skip_load_prefixes)
            }
        )
    else:  # DCP checkpoint
        load_checkpoint(checkpoint_path, model)


def compile_parallelize_and_init(
    model: torch.nn.Module,
    model_config: DINOTxtConfig,
    world_mesh: DeviceMesh,
    use_fsdp: bool,
    do_compile: bool,
    use_ac: bool,
    use_full_ac: bool,
    use_cuda_graphs: bool,
    param_dtype_str: str = "bf16",
    reduce_dtype_str: str = "fp32",
) -> None:
    if not use_fsdp:
        logger.info("Wrap in DDP, compile and initialize the model")
        if do_compile:
            torch._dynamo.config.optimize_ddp = "ddp_optimizer"
        replicate(model, device_mesh=world_mesh, bucket_cap_mb=100)
        if do_compile:
            model.compile()
        model = model.to_empty(device="cuda")
        model.init_weights()
    else:
        logger.info("Wrap in FSDP, compile and initialize the model")
        ac_compile_parallelize_and_init(
            model,
            world_mesh,
            do_compile,
            use_ac,
            use_full_ac,
            use_cuda_graphs,
            param_dtype_str,
            reduce_dtype_str,
        )
    if model.visual_model.freeze_backbone:
        vision_backbone_pretrained_weights = (
            model_config.vision_backbone_pretrained_weights
        )
        logger.info(
            f"Loading visual backbone pretrained-weights from: {vision_backbone_pretrained_weights}"
        )
        load_backbone_checkpoint(
            model.visual_model.backbone,
            vision_backbone_pretrained_weights,
            world_mesh,
            ["dino_loss", "ibot_patch_loss", "dino_head", "ibot_head"],
        )
        model.visual_model.backbone = model.visual_model.backbone.eval()
        for param in model.visual_model.backbone.parameters():
            param.requires_grad = False
        logger.info("Froze visual backbone!")
        register_dont_save_hooks(
            model,
            dont_save=[
                k
                for k, _ in model.state_dict().items()
                if k.startswith("visual_model.backbone")
            ],
        )
    if model.text_model.freeze_backbone:
        text_backbone_pretrained_weights = model_config.text_backbone_pretrained_weights
        logger.info(
            f"Loading text backbone pretrained-weights from: {text_backbone_pretrained_weights}"
        )
        load_backbone_checkpoint(
            model.text_model.backbone, text_backbone_pretrained_weights, world_mesh
        )
        logger.info("Assigned pretrained-weights to text backbone..")
        logger.info("Freezing text backbone")
        model.text_model.backbone = model.text_model.backbone.eval()
        for param in model.text_model.backbone.parameters():
            param.requires_grad = False
        logger.info("Froze text backbone!")
        register_dont_save_hooks(
            model,
            dont_save=[
                k
                for k, _ in model.state_dict().items()
                if k.startswith("text_model.backbone")
            ],
        )


def build_model_and_tokenizer(
    model_config: DINOTxtConfig,
    use_fsdp: bool = True,
    do_compile: bool = False,
    use_ac: bool = True,
    use_full_ac: bool = False,
    use_cuda_graphs: bool = False,
    param_dtype_str: str = "bf16",
    reduce_dtype_str: str = "fp32",
):
    with torch.device("meta"):
        model = DINOTxt(model_config=model_config, device="meta")
    world_mesh = init_device_mesh(
        "cuda",
        mesh_shape=(distributed.get_world_size(),),
        mesh_dim_names=("dp",),
    )
    compile_parallelize_and_init(
        model,
        model_config,
        world_mesh,
        use_fsdp,
        do_compile,
        use_ac,
        use_full_ac,
        use_cuda_graphs,
        param_dtype_str,
        reduce_dtype_str,
    )
    tokenizer = get_tokenizer(model_config.text_vocab_path_or_url)
    return (
        model,
        make_classification_train_transform(
            crop_size=model_config.vision_model_train_img_size
        ),
        tokenizer,
    )


def build_model_for_eval(
    model_config: DINOTxtConfig,
    pretrained_weights: str,
    use_fsdp: bool = True,
    do_compile: bool = True,
    param_dtype_str: str = "bf16",
    reduce_dtype_str: str = "fp32",
):
    with torch.device("meta"):
        model = DINOTxt(model_config=model_config)
    world_mesh = init_device_mesh(
        "cuda",
        mesh_shape=(distributed.get_world_size(),),
        mesh_dim_names=("dp",),
    )
    compile_parallelize_and_init(
        model,
        model_config,
        world_mesh,
        use_fsdp,
        do_compile,
        False,
        False,
        False,
        param_dtype_str,
        reduce_dtype_str,
    )
    load_checkpoint(pretrained_weights, model=model)
    model.eval()
    tokenizer = get_tokenizer(model_config.text_vocab_path_or_url)
    crop_size = model_config.vision_model_train_img_size
    resize_size = int(256 * crop_size / 224)
    return (
        model,
        make_classification_eval_transform(
            resize_size=resize_size, crop_size=crop_size
        ),
        tokenizer,
    )
