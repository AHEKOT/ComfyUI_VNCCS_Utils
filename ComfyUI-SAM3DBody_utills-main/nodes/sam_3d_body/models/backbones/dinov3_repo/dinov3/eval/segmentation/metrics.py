# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging
import numpy as np
import pandas as pd
import torch


pd.set_option("display.max_rows", 200)

logger = logging.getLogger("dinov3")


SEGMENTATION_METRICS = ["mIoU", "acc", "aAcc", "dice", "fscore", "precision", "recall"]


def calculate_segmentation_metrics(
    pre_eval_results,
    metrics=["mIoU"],
    beta=1,
):
    """Calculate the segmentation metrics after aggregating all the intermediate results.

    Args:
        pre_eval_results (list): Lists of (area_intersect, area_union, area_pred_label, and area_label).
            These are intermediate results to compute the final metrics such as iou, fscore, etc.
        metrics (list): Metrics to compute. Defaults to ["mIoU"].
        beta (int): Parameter for computing F-score. Defaults to 1 (for computing F1-score).

    Returns:
        Dictionary of final metrics.
    """
    pre_eval_results = tuple(zip(*pre_eval_results))
    assert len(pre_eval_results) == 4
    total_area_intersect = sum(pre_eval_results[0])
    total_area_union = sum(pre_eval_results[1])
    total_area_pred_label = sum(pre_eval_results[2])
    total_area_label = sum(pre_eval_results[3])
    metrics_dict = total_area_to_metrics(
        total_area_intersect,
        total_area_union,
        total_area_pred_label,
        total_area_label,
        metrics=metrics,
        beta=beta,
    )
    df = pd.DataFrame(
        {
            "Class Index": np.arange(len(metrics_dict["mIoU"])),
            "mIoU": 100 * metrics_dict["mIoU"].cpu().numpy(),
        }
    )
    logger.info(f"mIoU per class:\n{df.to_string(index=False)}")
    return {
        "mIoU": metrics_dict["mIoU"].nanmean(),
        "acc": metrics_dict["acc"].nanmean(),
        "aAcc": metrics_dict["aAcc"].nanmean(),
        "dice": metrics_dict["dice"].nanmean(),
        "fscore": metrics_dict["fscore"].nanmean(),
        "precision": metrics_dict["precision"].nanmean(),
        "recall": metrics_dict["recall"].nanmean(),
    }


def preprocess_nonzero_labels(label, ignore_index=255):
    label_new = label.clone()
    label_new[label_new == ignore_index] += 1
    label_new -= 1
    label_new[label_new == -1] = ignore_index
    return label_new


def calculate_intersect_and_union(pred_label, label, num_classes, ignore_index=255, reduce_zero_label=False):
    """Calculate intersection and Union.
    Args:
        pred_label (torch.Tensor): Prediction segmentation map
        label (torch.Tensor): Ground truth segmentation map
        num_classes (int): Number of categories.
        ignore_index (int): Index that will be ignored in evaluation.
        reduce_zero_label (bool): Indicates whether or not label 0 is to be ignored.
    """
    pred_label = pred_label.float()  # Enables float tensor operations
    if reduce_zero_label:
        label = preprocess_nonzero_labels(label, ignore_index=ignore_index)

    mask = label != ignore_index
    pred_label = pred_label[mask]
    label = label[mask]
    intersect = pred_label[pred_label == label]
    area_intersect = torch.histc(intersect.float(), bins=(num_classes), min=0, max=num_classes - 1)
    area_pred_label = torch.histc(pred_label.float(), bins=(num_classes), min=0, max=num_classes - 1)
    area_label = torch.histc(label.float(), bins=(num_classes), min=0, max=num_classes - 1)
    area_union = area_pred_label + area_label - area_intersect

    return torch.stack([area_intersect, area_union, area_pred_label, area_label])


def total_area_to_metrics(
    total_area_intersect,
    total_area_union,
    total_area_pred_label,
    total_area_label,
    metrics=["mIoU"],
    beta=1,
):
    """Calculate evaluation metrics
    Args:
        total_area_intersect (torch.Tensor): The intersection of prediction and
            ground truth histogram on all classes.
        total_area_union (torch.Tensor): The union of prediction and ground truth
            histogram on all classes.
        total_area_pred_label (torch.Tensor): The prediction histogram on all
            classes.
        total_area_label (torch.Tensor): The ground truth histogram on all classes.
        metrics (list[str] | str): Metrics to be evaluated,
            can be 'mIoU', 'mDice', or 'mFscore'.
        beta (int): Parameter for computing F-score. Defaults to 1 (for computing F1-score).
    Returns:
        float: Overall accuracy on all images.
        ndarray: Per category accuracy, shape (num_classes, ).
        ndarray: Per category evaluation metrics, shape (num_classes, ).
    """

    def f_score(precision, recall, beta=1):
        score = (1 + beta**2) * (precision * recall) / ((beta**2 * precision) + recall)
        return score

    if isinstance(metrics, str):
        metrics = [metrics]
    allowed_metrics = ["mIoU", "dice", "fscore"]
    if not set(metrics).issubset(set(allowed_metrics)):
        raise KeyError(f"metrics {metrics} is not supported")

    all_acc = total_area_intersect.sum() / total_area_label.sum()
    ret_metrics = dict({"aAcc": all_acc})
    for metric in metrics:
        if metric == "mIoU":
            ret_metrics["mIoU"] = total_area_intersect / total_area_union
            ret_metrics["acc"] = total_area_intersect / total_area_label
        elif metric == "dice":
            ret_metrics["dice"] = 2 * total_area_intersect / (total_area_pred_label + total_area_label)
            ret_metrics["acc"] = total_area_intersect / total_area_label
        elif metric == "fscore":
            precision = total_area_intersect / total_area_pred_label
            recall = total_area_intersect / total_area_label
            f_value = torch.tensor([f_score(x[0], x[1], beta) for x in zip(precision, recall)])
            ret_metrics["fscore"] = f_value
            ret_metrics["precision"] = precision
            ret_metrics["recall"] = recall
    return ret_metrics
