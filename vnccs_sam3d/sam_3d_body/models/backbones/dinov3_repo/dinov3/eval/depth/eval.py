# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging

from typing import Any
import torch
import torch.utils
import torch.utils.data

import dinov3.distributed as distributed
from dinov3.logging import MetricLogger


from dinov3.eval.depth.config import (
    DepthConfig,
    ResultConfig,
    make_depth_eval_transforms_from_config,
)
from dinov3.eval.depth.data import build_dataloader
from dinov3.eval.depth.datasets.datasets_utils import _EvalCropType, make_valid_mask
from dinov3.eval.depth.metrics import calculate_depth_metrics, _DepthMetric, DEPTH_METRICS
from dinov3.eval.depth.transforms import Aug, LeftRightFlipAug
from dinov3.eval.depth.utils import align_depth_least_square
from dinov3.eval.depth.visualization_utils import depth_tensor_to_colorized_pil, save_predictions


logger = logging.getLogger("dinov3")


def inverse_tta_hook(transforms: Aug):
    return lambda module, inputs, outputs: transforms.inverse(outputs)


def evaluate_depther_with_config(
    config: DepthConfig,
    depther: torch.nn.Module,
    device: Any,
    reduce_results: bool = True,
):
    # 1- define dataset
    transforms = make_depth_eval_transforms_from_config(config, split="test")
    dataloader = build_dataloader(
        dataset_str=config.datasets.test + f":root={config.datasets.root}",
        transforms=transforms,
        device=device,
        split="test",
        batch_size=1,
        n_gpus=distributed.get_world_size(),
    )
    metrics = [metric for metric in DEPTH_METRICS if metric.name in config.metrics]

    return evaluate_depther_with_dataloader(
        dataloader,
        depther,
        device=device,
        metrics=metrics,
        eval_range=(config.eval.min_depth, config.eval.max_depth),
        result_config=config.result_config,
        ignored_value=config.eval.ignored_value,
        eval_mask_type=config.transforms.eval.eval_mask,
        save_dir=config.output_dir,
        reduce_results=reduce_results,
        align_least_squares=config.eval.align_least_squares,
        use_tta=config.eval.use_tta,
    )


@torch.no_grad()
def evaluate_depther_with_dataloader(
    dataloader: torch.utils.data.DataLoader,
    depther: torch.nn.Module,
    device: Any,
    metrics: list[_DepthMetric],
    eval_range: tuple[float, float],
    result_config: ResultConfig,
    save_dir="",
    ignored_value: float = 0.0,
    eval_mask_type: str = "NYU_EIGEN",
    reduce_results: bool = True,
    align_least_squares: bool = False,
    use_tta: bool = False,
):
    """
    Evaluate a dense estimation model with a dataloader

    Inputs:
    - dataloader: a torch.utils.data.DataLoader
    - depther: depth estimator to evaluate
    - device: the (CUDA) device to evaluate on
    - metrics: metrics to report during evaluation
    - eval_range (float, float): depth evaluation range
    - result_config (ResultConfig): contains parameters for results saving
    - save_dir (str): saving directory for results (metrics and predictions)
    - ignored_value (float): value to ignore from the ground truth
    - eval_mask_type (str): evaluation mask. See _EvalCropType Enum for choices
    - reduce_results (bool): if True, results are averaged across all samples (default=True)
    - align_least_squares (bool): if True, aligns prediction in scale and shift with GT using least squares error minimization
    - use_tta (bool): if True, uses left-right flipping test time augmentation (default False).
    """

    metric_names = [metric.name for metric in metrics]
    all_metric_values_dict: dict[str, Any] = {metric: [] for metric in metric_names}
    all_metric_values_dict["indices"] = []
    final_metric_values_dict = {}

    n_gpus = distributed.get_world_size()

    # build a metric_logger for validation
    header = "Validation: "
    metric_logger = MetricLogger(delimiter="  ")
    all_losses: dict[str, list[float]] = {}
    if use_tta:
        hook = depther.register_forward_hook(inverse_tta_hook(LeftRightFlipAug(flip=True)))
    else:
        hook = None

    for batch_img, target in metric_logger.log_every(dataloader, 10, header=header):
        index, gt_map = target
        # batchify augmentations together
        assert batch_img[0].shape[0] == 1
        batch_img = torch.cat(batch_img, dim=0).to(device)
        gt_map = torch.cat(gt_map, dim=0).to(device)

        preds = depther(batch_img)
        # Skip padded indices AFTER prediction, so that each rank can process the
        # Same number of forwards, necessary for a sharded backbone
        if index < 0:
            continue

        # in case tta inflated the batch
        B, C, _, _ = preds.shape
        gt_map = gt_map[:B]

        # run post processing on ground truth and prediction
        gt_map = torch.where(
            torch.logical_or(gt_map >= eval_range[1], gt_map <= eval_range[0]),
            ignored_value,
            gt_map,
        )

        valid_mask = make_valid_mask(
            gt_map,
            eval_crop=_EvalCropType(eval_mask_type),
            ignored_value=ignored_value,
        )

        # resize -if necessary- prediction to match size of gt
        if gt_map.shape[-2:] != preds.shape[-2:]:
            preds = torch.nn.functional.interpolate(
                input=preds,
                size=gt_map.shape[2:],
                mode="bilinear",
                align_corners=False,
            )
        if align_least_squares:
            preds = torch.stack([align_depth_least_square(gt_map, p, valid_mask)[0] for p in preds])
            preds = preds.to(device)

        if result_config.save_results:
            assert preds.shape[0] == 1, "Cannot save results for more than one decoder"
            save_predictions(
                img=batch_img[: preds.shape[0]],
                pred=preds[0],
                gt=gt_map,
                save_index=index,
                result_config=result_config,
                save_dir=save_dir,
                pred_tensor_to_pil_fn=depth_tensor_to_colorized_pil,
            )

        preds = preds.clamp(min=eval_range[0], max=eval_range[1])

        batch_metric_values = calculate_depth_metrics(
            gt_map,
            preds,
            valid_mask,
            list_metrics=metrics,
        )  # NamedTuple with metrics as names
        for metric in metric_names:
            value = getattr(batch_metric_values, metric, None)
            if value is not None:
                all_metric_values_dict[metric].append(value)
        all_metric_values_dict["indices"].append(index)
    all_indices = torch.tensor(all_metric_values_dict["indices"], device=device)
    if n_gpus > 1:
        list_all_indices = distributed.gather_all_tensors(all_indices)
        all_indices = torch.cat(list_all_indices, dim=0).cpu().to(torch.int32)

    out_results_dict = {}

    all_metric_values = torch.tensor(
        [values_per_metric for values_per_metric in all_metric_values_dict.values()],
        device=device,
    )
    if n_gpus > 1:
        all_metric_values = torch.cat(distributed.gather_all_tensors(all_metric_values), dim=1)

    final_metric_values = all_metric_values.nanmean(1)
    final_metric_values_dict = dict(zip(metric_names, final_metric_values.cpu().numpy()))

    if reduce_results:
        out_results_dict = {k: float(v) for (k, v) in final_metric_values_dict.items()}
    else:
        out_results_dict = {
            metric_name: value for (metric_name, value) in zip(metric_names, all_metric_values.cpu().numpy().tolist())
        }
    logger.info(
        "Final scores: " + " ".join([f"{name}: {meter:.3f}" for name, meter in final_metric_values_dict.items()])
    )

    if hook is not None:
        hook.remove()

    return out_results_dict, all_losses, all_indices
