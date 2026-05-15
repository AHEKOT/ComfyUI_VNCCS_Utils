# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import gc
import logging
from functools import partial
import math
import os
import sys
from pathlib import Path
from typing import Callable

import dinov3.distributed as distributed
import torch
from dinov3.checkpointer import (
    find_latest_checkpoint,
    keep_last_n_checkpoints,
    load_checkpoint,
    save_checkpoint,
)
from dinov3.configs import setup_job
from dinov3.data import SamplerType, make_data_loader, make_dataset
from dinov3.eval.text.build_dinotxt import build_model_and_tokenizer
from dinov3.eval.text.clip_loss import memory_efficient_clip_loss
from dinov3.eval.text.dinotxt_model import DINOTxt, DINOTxtConfig
from dinov3.eval.text.gram_loss import gram_loss_fn
from dinov3.logging import MetricLogger, setup_logging
from dinov3.train.cosine_lr_scheduler import linear_warmup_cosine_decay
from omegaconf import OmegaConf
from torch import optim

logger = logging.getLogger("dinov3")


def unwrap_model(model):
    return getattr(model, "module", model)


def test(
    model: DINOTxt,
    iteration: str,
    output_dir: str,
):
    eval_dir = Path(output_dir) / "eval" / str(iteration)
    if distributed.is_subgroup_main_process():
        eval_dir.mkdir(parents=True, exist_ok=True)

    ckpt_dir = eval_dir / str("sharded_model_checkpoint")
    save_checkpoint(ckpt_dir, iteration=iteration, model=model)


def apply_learning_rate(optimizer, lr: float):
    for param_group in optimizer.param_groups:
        param_group["lr"] = lr


def exclude(n: str, p: torch.Tensor) -> bool:
    return p.ndim < 2 or "bn" in n or "ln" in n or "bias" in n or "logit_scale" in n


def include(n: str, p: torch.Tensor) -> bool:
    return not exclude(n, p)


def train(
    train_dataset,
    model: DINOTxt,
    tokenizer: Callable,
    max_iteration: int,
    warmup_length: int,
    checkpointing_period: int,
    output_dir: str,
    dtype_str: str,
    sampler_type: SamplerType,
    lr_scheduler_type: str,
    lr: float,
    weight_decay: float,
    batch_size: int = 256,
    beta1: float = 0.9,
    beta2: float = 0.99,
    eps: float = 1e-8,
    num_workers: int = 10,
    eval_freq: int = 1000,
    gc_freq: int = 100,
    use_gram_loss: bool = False,
    patch_sampling_rate_for_gram_loss: float = 0.5,
    normalize_patch_tokens_for_gram_loss: bool = False,
    gram_loss_weight: float = 1.0,
    max_checkpoints_to_keep: int = None,
    resume: bool = False,
    seed: int = 11,
):
    named_parameters = list(model.named_parameters())
    gain_or_bias_params = [
        p for n, p in named_parameters if exclude(n, p) and p.requires_grad
    ]
    gain_or_bias_params_names = [
        n for n, p in named_parameters if exclude(n, p) and p.requires_grad
    ]
    rest_params = [p for n, p in named_parameters if include(n, p) and p.requires_grad]
    rest_params_names = [
        n for n, p in named_parameters if include(n, p) and p.requires_grad
    ]
    logger.info(f"Gain or bias params: {gain_or_bias_params_names}")
    logger.info(f"Rest params: {rest_params_names}")
    logger.info(
        f"Learning rate: {lr}, batch_size_per_gpu: {batch_size}, weight_decay: {weight_decay}"
    )
    optimizer = optim.AdamW(
        [
            {"params": gain_or_bias_params, "weight_decay": 0.0},
            {"params": rest_params, "weight_decay": weight_decay},
        ],
        lr=lr,
        betas=(beta1, beta2),
        eps=eps,
    )
    learning_rates = linear_warmup_cosine_decay(
        0, lr, 0, warmup_iterations=warmup_length, total_iterations=max_iteration
    )
    logger.info(
        f"Init lr scheduler: {lr_scheduler_type}, warmup length: {warmup_length}, base_lr: {lr}, max iter: {max_iteration}"
    )

    if (
        resume
        and (ckpt_dir := find_latest_checkpoint(os.path.join(output_dir, "ckpt")))
        is not None
    ):
        iteration = load_checkpoint(ckpt_dir, model=model, optimizer=optimizer)
        start_iteration = iteration + 1
        del iteration, ckpt_dir
    else:
        logger.info("Initializing from scratch")
        start_iteration = 0

    def collate_fn(batch):
        images, captions = list(zip(*batch))[:2]
        return torch.stack(images), tokenizer.tokenize(captions)

    train_data_loader = make_data_loader(
        dataset=train_dataset,
        batch_size=batch_size,
        num_workers=num_workers,
        shuffle=False,
        seed=seed,
        sampler_type=sampler_type,
        sampler_advance=start_iteration,
        drop_last=True,
        persistent_workers=True,
        collate_fn=collate_fn,
    )
    rank = distributed.get_rank()
    world_size = distributed.get_world_size()
    logger.info(
        f"Init loss function: rank: {distributed.get_rank()}, world size: {world_size}"
    )
    clip_loss = partial(memory_efficient_clip_loss, group=torch.distributed.group.WORLD)
    cur_iteration = start_iteration
    logger.info(f"Starting training from iteration {start_iteration}...")
    header = "Training"
    metric_logger = MetricLogger(delimiter="  ")
    gc.disable()
    device_id = rank % torch.cuda.device_count()

    for batch in metric_logger.log_every(
        train_data_loader,
        10,
        header,
        max_iteration,
        start_iteration,
    ):
        images, text_tokens = batch
        images = images.to(device=device_id, non_blocking=True)
        text_tokens = text_tokens.to(device=device_id, non_blocking=True)
        (
            image_embeddings,
            text_embeddings,
            logit_scale,
            patch_tokens,
            backbone_patch_tokens,
        ) = model(images, text_tokens)
        contrastive_loss = clip_loss(image_embeddings, text_embeddings, logit_scale)
        total_loss = contrastive_loss
        if use_gram_loss:
            gram_loss = gram_loss_fn(
                patch_tokens,
                backbone_patch_tokens,
                patch_sampling_rate_for_gram_loss,
                normalize_patch_tokens_for_gram_loss,
            )
            total_loss = contrastive_loss + gram_loss_weight * gram_loss

        if total_loss.isnan():
            msg = f"Loss is NaN at iteration {cur_iteration}, aborting..."
            logger.error(msg)
            raise RuntimeError(msg)
        apply_learning_rate(optimizer=optimizer, lr=learning_rates[cur_iteration])
        optimizer.zero_grad()
        total_loss.backward()
        optimizer.step()

        # This clamping trick is from OpenCLIP reposistory which MetaCLIP follows. Orginally used in CLIP training.
        # NOTE: we clamp to 4.6052 = ln(100), as in the original paper.
        with torch.no_grad():
            unwrap_model(model).logit_scale.clamp_(0, math.log(100))
        metric_logger.update(contrastive_loss=contrastive_loss.item())
        if use_gram_loss:
            metric_logger.update(gram_loss=gram_loss.item())
        metric_logger.update(lr=optimizer.param_groups[0]["lr"])
        metric_logger.update(logit_scale=logit_scale.item())
        is_last_iteration = (cur_iteration + 1) == max_iteration
        is_ckpt_iteration = (
            (cur_iteration + 1) % checkpointing_period == 0
        ) or is_last_iteration
        if is_ckpt_iteration:
            ckpt_dir = Path(output_dir, "ckpt").expanduser()
            save_checkpoint(
                ckpt_dir / str(cur_iteration),
                iteration=cur_iteration,
                model=model,
                optimizer=optimizer,
            )
            if distributed.is_main_process():
                keep_last_n_checkpoints(ckpt_dir, max_checkpoints_to_keep)
        if eval_freq > 0 and (cur_iteration + 1) % eval_freq == 0:
            test(
                model,
                iteration=f"training_{cur_iteration}",
                batch_size=batch_size,
                num_workers=num_workers,
                output_dir=output_dir,
                dtype_str=dtype_str,
            )
            torch.cuda.synchronize()
        if (cur_iteration + 1) % gc_freq == 0:
            logger.info("Garbage collection...")
            gc.collect()
        cur_iteration += 1


def write_config(
    model_config: DINOTxtConfig, output_dir, name="clip_model_config.yaml"
):
    logger.info(OmegaConf.to_yaml(model_config))
    saved_cfg_path = os.path.join(output_dir, name)
    with open(saved_cfg_path, "w") as f:
        OmegaConf.save(config=model_config, f=f)
    return saved_cfg_path


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    args_dict = OmegaConf.to_container(OmegaConf.from_cli(argv))
    logger.info(args_dict)
    config = OmegaConf.load(args_dict["trainer_config_file"])
    logger.info(config)
    if "output_dir" in args_dict:
        config.output_dir = args_dict["--output-dir"]
    setup_job(output_dir=config.output_dir, seed=config.seed)
    setup_logging(output=os.path.join(config.output_dir, "nan_logs"), name="nan_logger")
    logger.info("Trainer config:")
    logger.info(config)
    model_config = DINOTxtConfig(
        embed_dim=config.embed_dim,
        text_backbone_config=config.text_backbone_config,
        vision_backbone_config=config.vision_backbone_config,
        text_backbone_pretrained_weights=config.text_backbone_pretrained_weights,
        vision_backbone_pretrained_weights=config.vision_backbone_pretrained_weights,
        vision_model_train_img_size=config.vision_model_train_img_size,
        vision_model_use_class_token=config.vision_model_use_class_token,
        vision_model_use_patch_tokens=config.vision_model_use_patch_tokens,
        vision_model_num_head_blocks=config.vision_model_num_head_blocks,
        vision_model_head_blocks_drop_path=config.vision_model_head_blocks_drop_path,
        vision_model_use_linear_projection=config.vision_model_use_linear_projection,
        vision_model_patch_tokens_pooler_type=config.vision_model_patch_tokens_pooler_type,
        vision_model_patch_token_layer=config.vision_model_patch_token_layer,
        text_model_freeze_backbone=config.text_model_freeze_backbone,
        text_model_num_head_blocks=config.text_model_num_head_blocks,
        text_model_head_blocks_is_causal=config.text_model_head_blocks_is_causal,
        text_model_head_blocks_drop_prob=config.text_model_head_blocks_drop_prob,
        text_model_tokens_pooler_type=config.text_model_tokens_pooler_type,
        text_model_use_linear_projection=config.text_model_use_linear_projection,
        text_vocab_path_or_url=config.text_vocab_path_or_url,
        init_logit_scale=config.init_logit_scale,
        freeze_logit_scale=config.freeze_logit_scale,
        init_logit_bias=config.init_logit_bias,
    )
    write_config(model_config=model_config, output_dir=config.output_dir)
    model, transform, tokenizer = build_model_and_tokenizer(
        model_config,
        use_fsdp=config.use_fsdp,
        do_compile=config.do_compile,
        use_ac=config.use_ac,
        use_cuda_graphs=config.use_cuda_graphs,
    )

    train_dataset = make_dataset(
        dataset_str=config.train_dataset_str,
        transform=transform,
    )
    sampler_type = (
        SamplerType.SHARDED_INFINITE
        if config.dataset_use_cache
        else SamplerType.INFINITE
    )
    train(
        train_dataset=train_dataset,
        model=model,
        tokenizer=tokenizer,
        max_iteration=config.max_iteration,
        warmup_length=config.warmup_length,
        checkpointing_period=config.checkpointing_period,
        output_dir=config.output_dir,
        dtype_str=config.dtype_str,
        lr_scheduler_type=config.lr_scheduler_type,
        lr=config.lr,
        weight_decay=config.weight_decay,
        batch_size=config.batch_size,
        beta1=config.beta1,
        beta2=config.beta2,
        eps=config.eps,
        sampler_type=sampler_type,
        eval_freq=config.eval_freq,
        gc_freq=config.gc_freq,
        max_checkpoints_to_keep=config.max_checkpoints_to_keep,
        use_gram_loss=config.vision_model_use_gram_loss,
        patch_sampling_rate_for_gram_loss=config.vision_model_patch_sampling_rate_for_gram_loss,
        normalize_patch_tokens_for_gram_loss=config.vision_model_normalize_patch_tokens_for_gram_loss,
        gram_loss_weight=config.vision_model_gram_loss_weight,
        resume=not config.no_resume,
    )


if __name__ == "__main__":
    main()
