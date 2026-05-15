# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging
import os
from typing import Any, Callable

import torch
import torch.distributed as dist
from omegaconf import OmegaConf
from torch.nn.parallel import DistributedDataParallel as DDP
from torch.optim.optimizer import Optimizer
from torch.optim.lr_scheduler import LRScheduler

import dinov3.distributed as distributed
from dinov3.eval.depth.data import build_dataloader
from dinov3.eval.depth.config import (
    DepthConfig,
    ResultConfig,
    make_depth_eval_transforms_from_config,
    make_depth_train_transforms_from_config,
)

from dinov3.eval.depth.checkpoint_utils import find_latest_checkpoint, load_checkpoint, save_checkpoint
from dinov3.eval.depth.datasets.datasets_utils import _EvalCropType, make_valid_mask
from dinov3.eval.depth.loss import MultiLoss
from dinov3.eval.depth.models import Depther, make_depther_from_config
from dinov3.eval.depth.metrics import DEPTH_METRICS
from dinov3.eval.depth.schedulers import build_scheduler
from dinov3.eval.depth.eval import evaluate_depther_with_dataloader

from dinov3.eval.depth.utils import setup_model_ddp
from dinov3.logging import MetricLogger, SmoothedValue
from dinov3.utils import fix_random_seeds

logger = logging.getLogger("dinov3")


class IterBasedTrainer:
    def __init__(
        self,
        config: DepthConfig,
        depther: Depther,
        train_dataloader: Any,
        val_dataloader: Any,
        criterion: Callable,
        metrics: list[str],
        optimizer: Optimizer,
        scheduler: LRScheduler,
    ):
        self._train_dataset_epoch = 0  # a counter for how many times all images in the dataset were seen
        self.rank = distributed.get_rank()

        self.depther = depther
        self.train_dataloader = train_dataloader
        self.val_dataloader = val_dataloader
        self.train_dataloader.sampler.set_epoch(self._train_dataset_epoch)
        torch.backends.cudnn.benchmark = True
        self.optimizer = optimizer
        self.scheduler = scheduler
        self.criterion = criterion

        self.global_step = 0
        self.total_iter = config.scheduler.total_iter
        self._halt_trainer = False

        # filter out metrics that won't be tracked
        self.metrics = [metric for metric in DEPTH_METRICS if metric.name in metrics]
        self.config = config

    def train_on_batch(self, batch):
        assert not self._halt_trainer

        device = self.rank
        batch_img, depth_gt = batch
        batch_img = batch_img.to(device)
        depth_gt = depth_gt.to(device)

        valid_mask = make_valid_mask(
            depth_gt,
            eval_crop=_EvalCropType(self.config.transforms.train.eval_mask),
            ignored_value=self.config.eval.ignored_value,
        ).bool()
        # mask out pixels outside of valid region
        depth_gt[~valid_mask] = self.config.eval.ignored_value

        self.optimizer.zero_grad(set_to_none=True)

        # c) forward pass
        pred = self.depther(batch_img)
        # d) resize -if necessary- prediction to match size of gt

        if depth_gt.shape != pred.shape:
            pred = torch.nn.functional.interpolate(
                input=pred,
                size=depth_gt.shape[2:],
                mode="bilinear",
                align_corners=False,
            )
        loss = self.criterion(pred, depth_gt, valid_mask)

        # e) optimization
        loss.backward()
        torch.nn.utils.clip_grad_norm_(
            [p for p in self.depther.parameters() if p.requires_grad],
            self.config.optimizer.gradient_clip,
        )
        self.optimizer.step()
        self.scheduler.step()

        self.global_step += 1
        if self.global_step >= self.total_iter:
            self._halt_trainer = False

        # update epoch for dataset
        if self.global_step % len(self.train_dataloader):
            self._train_dataset_epoch += 1
            self.train_dataloader.sampler.set_epoch(self._train_dataset_epoch)

        return loss

    def validate(self):
        """
        Runs evaluation on the validation set

        Returns True if the selected target metric is better than the previous best one
        """
        depther = self.depther
        # unwrap DDP
        if isinstance(depther, DDP):
            depther = depther.module

        self.depther.eval()
        new_metric_values_dict, _, _ = evaluate_depther_with_dataloader(
            dataloader=self.val_dataloader,
            depther=self.depther,
            device=self.rank,
            metrics=self.metrics,
            eval_range=(self.config.eval.min_depth, self.config.eval.max_depth),
            result_config=ResultConfig(save_results=False),
            save_dir=self.config.output_dir,
            ignored_value=self.config.eval.ignored_value,
            eval_mask_type=self.config.transforms.eval.eval_mask,
            align_least_squares=self.config.eval.align_least_squares,
            use_tta=False,
        )

        # put model back to train mode after validation
        self.depther.decoder.train()


def run_epochs(config: DepthConfig, backbone: torch.nn.Module, autocast_dtype: torch.dtype):
    n_gpus = distributed.get_world_size()

    # 1- define decoder(s) and optimizer
    optim_param_groups = []
    depther = make_depther_from_config(
        backbone,
        config.decoder_head,
        autocast_dtype=autocast_dtype,
    )
    depther.train()
    if torch.cuda.is_available():
        depther = depther.cuda()
    optim_param_groups.append(
        {
            "params": depther.decoder.parameters(),
            "lr": config.optimizer.lr,
            "betas": (config.optimizer.beta1, config.optimizer.beta2),
            "weight_decay": config.optimizer.weight_decay,
        }
    )
    depther.decoder = setup_model_ddp(depther.decoder, device=distributed.get_rank())
    optimizer = torch.optim.AdamW(optim_param_groups)

    # 2- define scheduler
    scheduler = build_scheduler(
        config.scheduler.type,
        optimizer=optimizer,
        lr=config.optimizer.lr,
        total_iter=config.scheduler.total_iter,
        constructor_kwargs=config.scheduler.constructor_kwargs,
    )

    # 3- define transforms and dataloaders
    train_transforms = make_depth_train_transforms_from_config(config)
    val_transforms = make_depth_eval_transforms_from_config(config, split="val")
    train_dataloader = build_dataloader(
        transforms=train_transforms,
        dataset_str=getattr(config.datasets, "train") + f":root={config.datasets.root}",
        device=torch.cuda.current_device(),
        split="train",
        batch_size=config.bs,
        n_gpus=n_gpus,
        num_workers=n_gpus,
        use_init_fn=True,
    )

    val_dataloader = build_dataloader(
        transforms=val_transforms,
        dataset_str=getattr(config.datasets, "val") + f":root={config.datasets.root}",
        device=torch.cuda.current_device(),
        split="val",
        batch_size=1,
        n_gpus=n_gpus,
        num_workers=n_gpus,
    )

    # 4- define criterion
    assert config.losses is not None, "No loss defined for training"
    criterion = MultiLoss(dict_losses=config.losses)

    trainer = IterBasedTrainer(
        config,
        depther=depther,
        train_dataloader=train_dataloader,
        val_dataloader=val_dataloader,
        criterion=criterion,
        metrics=config.metrics,
        optimizer=optimizer,
        scheduler=scheduler,
    )

    if config.load_from is None:
        config.load_from = find_latest_checkpoint(config.output_dir)  # returns "" if the path does not exist

    if config.load_from is not None:
        logger.info(f"RESUMING CHECKPOINT from {config.load_from}")
        chkpt, iteration = load_checkpoint(config.load_from)
        depther.decoder.load_state_dict(chkpt["model"])
        optimizer.load_state_dict(chkpt["optimizer"])
        trainer.global_step = iteration or float("inf")  # type: ignore

    metric_logger = MetricLogger(delimiter="  ")
    metric_logger.add_meter("loss", SmoothedValue(window_size=4, fmt="{value:.3f}"))
    logger.info(f"Built trainer with start: {trainer.global_step} | total_iter {trainer.total_iter}")

    for batch in metric_logger.log_every(
        trainer.train_dataloader,
        50,
        header="Train: ",
        start_iteration=trainer.global_step,
        n_iterations=trainer.total_iter,
    ):
        if trainer.global_step >= trainer.total_iter:
            break

        loss = trainer.train_on_batch(batch)
        metric_logger.update(loss=loss)

        if trainer.global_step % config.eval.eval_interval == 0:
            dist.barrier()
            trainer.validate()
            if distributed.is_main_process():
                save_checkpoint(
                    config.output_dir,
                    iteration=trainer.global_step,
                    model=trainer.depther.decoder,
                    optimizer=trainer.optimizer,
                )
            metric_logger.synchronize_between_processes()

    # one last validation only if the number of total iterations is NOT divisible by eval interval:
    if trainer.total_iter % config.eval.eval_interval:
        trainer.validate()
        metric_logger.synchronize_between_processes()

    logger.info("done!")
    if distributed.is_main_process():
        save_checkpoint(
            config.output_dir,
            iteration=trainer.global_step,
            model=trainer.depther.decoder,
            optimizer=trainer.optimizer,
        )

    # load selected model checkpoint and return the model
    dist.barrier()
    depther.eval()
    return depther


def train_model_with_backbone(config: DepthConfig, backbone: torch.nn.Module, autocast_dtype: torch.dtype):
    fix_random_seeds(config.seed + distributed.get_rank())

    depth_file_path = os.path.join(config.output_dir, "depth_config.yaml")
    OmegaConf.save(config=config, f=depth_file_path)
    logger.info(f"Config:\n{OmegaConf.to_yaml(config)}")
    trained_model = run_epochs(config=config, backbone=backbone, autocast_dtype=autocast_dtype)
    return trained_model
