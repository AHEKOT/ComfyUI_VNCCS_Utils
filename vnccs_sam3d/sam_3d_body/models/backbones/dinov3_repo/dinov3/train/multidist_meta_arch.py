# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging

import torch
from torch import Tensor

from .ssl_meta_arch import SSLMetaArch

logger = logging.getLogger("dinov3")


class MultiDistillationMetaArch(SSLMetaArch):
    """
    Multidistillation version of SSLMetaArchCompilableGram:
    - baked-in scales for DINO, KOLEO, and IBOT losses
    - always global and local crops
    - always separate heads for DINO and IBOT
    - always sinkhorn-knopp centering for DINO and IBOT
    - always per-GPU computation of KOLEO loss (non-distributed)
    - DINO, IBOT, and KOLEO are always computed even if their weight is 0.0
    """

    def forward_backward(
        self, data, *, teacher_temp, iteration: int = 0, **ignored_kwargs
    ) -> tuple[Tensor, dict[str, float | Tensor]]:
        del ignored_kwargs
        metrics_dict = {}

        # Shapes
        n_global_crops = 2
        n_local_crops = self.n_local_crops  # self.cfg.crops.local_crops_number
        B_teacher = B = data["collated_local_crops"].shape[0] // n_local_crops
        assert data["collated_global_crops"].shape[0] == n_global_crops * B
        metrics_dict["batch_size"] = B

        global_crops = data["collated_global_crops"].cuda(non_blocking=True)
        local_crops = data["collated_local_crops"].cuda(non_blocking=True)
        masks = data["collated_masks"].cuda(non_blocking=True)
        mask_indices_list = data["mask_indices_list"].cuda(non_blocking=True)
        masks_weight = data["masks_weight"].cuda(non_blocking=True)
        n_masked_patches_tensor = data["n_masked_patches"].cuda(non_blocking=True)
        global_batch_size = data["global_batch_size"]

        # Multidistillation codepath:

        # Downsample teacher crops to match student resolution
        downsampling_factor = getattr(self, "crops.teacher_to_student_resolution_scale", 1.0)
        if downsampling_factor != 1.0:
            global_crops = torch.nn.functional.interpolate(
                global_crops,
                scale_factor=1.0 / downsampling_factor,
                mode="bilinear",
                antialias=True,
            )
        global_crops_subgroup = self.broadcast_to_subgroups(
            global_crops.view(n_global_crops, -1, *global_crops.shape[1:]),
            1,
            global_batch_size=global_batch_size,
        ).view(-1, *global_crops.shape[1:])
        local_crops_subgroup = self.broadcast_to_subgroups(
            local_crops.view(n_local_crops, -1, *local_crops.shape[1:]),
            1,
            global_batch_size=global_batch_size,
        ).view(-1, *local_crops.shape[1:])
        B = local_crops_subgroup.shape[0] // n_local_crops

        # Teacher output (will trigger an all-gather to unshard)
        teacher_global = self.get_teacher_output(
            global_crops.unflatten(0, (n_global_crops, B_teacher)),
            teacher_temp=teacher_temp,
            n_masked_patches_tensor=n_masked_patches_tensor,
            mask_indices_list=mask_indices_list,
            upperbound=data["upperbound"],
            global_batch_size=global_batch_size,
        )

        # Student output (will trigger an all-gather to unshard)
        student_global, student_local = self.get_student_output(
            global_crops=global_crops_subgroup.unflatten(0, (n_global_crops, B)),
            local_crops=local_crops_subgroup.unflatten(0, (n_local_crops, B)),
            upperbound=data["upperbound"],
            masks=masks,
            mask_indices_list=mask_indices_list,
        )
        # End of multidistillation codepath

        # Compute losses and backprop
        loss_accumulator, loss_dict = self.compute_losses(
            teacher_global=teacher_global,
            student_global=student_global,
            student_local=student_local,
            masks=masks,
            mask_indices_list=mask_indices_list,
            masks_weight=masks_weight,
            gram_global=None,
            iteration=iteration,
        )

        self.backprop_loss(loss_accumulator)

        # Return total weighted loss and a dict of metrics to log
        return loss_accumulator, metrics_dict | loss_dict

    @torch.no_grad()
    def get_teacher_output(
        self,
        images,
        *,
        upperbound,
        mask_indices_list,
        teacher_temp,
        n_masked_patches_tensor,
        global_batch_size,
    ):
        n_crops, B_teacher, rgb, H, W = images.shape

        backbone_out = self.teacher.backbone(images.flatten(0, 1), is_training=True)
        cls = backbone_out["x_norm_clstoken"]  # [n_crops * B, D]
        reg = backbone_out["x_storage_tokens"]  # [n_crops * B, R, D]
        ibot_patch = backbone_out["x_norm_patchtokens"]  # [n_crops * B, P, D]

        R, D = reg.shape[-2:]

        # Multidistillation codepath:
        # IBOT head only on patches that are masked for the student
        n_tokens = ibot_patch.shape[1]
        masked_patch_after_head = self.teacher.ibot_head(ibot_patch.flatten(0, 1), no_last_layer=True)
        masked_patch_after_head = masked_patch_after_head.view(n_crops, -1, *masked_patch_after_head.shape[1:])
        masked_patch_after_head = self.broadcast_to_subgroups(
            masked_patch_after_head,
            over_dim=1,
            global_batch_size=global_batch_size * n_tokens,
        )
        buffer = torch.index_select(masked_patch_after_head.flatten(0, 1), dim=0, index=mask_indices_list)
        masked_patch_after_head = self.teacher.ibot_head(buffer, only_last_layer=True)

        # DINO head on CLS tokens
        cls_after_head = self.teacher.dino_head(cls, no_last_layer=True)  # [n_crops * B, K]
        cls_after_head = cls_after_head.view(n_crops, -1, *cls_after_head.shape[1:])
        cls_after_head = self.broadcast_to_subgroups(cls_after_head, over_dim=1, global_batch_size=global_batch_size)
        B = cls_after_head.shape[1]
        cls_after_head = cls_after_head.flatten(0, 1)
        cls_after_head = self.teacher.dino_head(cls_after_head, only_last_layer=True)  # [n_crops * B, K]
        # End of multidistillation codepath

        # Center with sinkhorn-knopp
        cls_centered = self.dino_loss.sinkhorn_knopp_teacher(
            cls_after_head, teacher_temp=teacher_temp
        )  # [n_crops * B, K]
        cls_centered = cls_centered.unflatten(0, (n_crops, B))  # [n_crops, B, K]
        masked_patch_centered = self.ibot_patch_loss.sinkhorn_knopp_teacher(
            masked_patch_after_head,
            teacher_temp=teacher_temp,
            n_masked_patches_tensor=n_masked_patches_tensor,
        )  # [n_masked_patches, K]

        return {
            "cls_after_head": cls_after_head.unflatten(0, [n_crops, B]),  # [n_crops, B, K]
            "cls_centered": cls_centered,  # [n_crops, B, K]
            "masked_patch_centered": masked_patch_centered,  # [n_masked_patches, K]
        }
