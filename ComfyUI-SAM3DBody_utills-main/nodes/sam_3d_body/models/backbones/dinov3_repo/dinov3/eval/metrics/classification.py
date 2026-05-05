# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging
from enum import Enum
from typing import Any, Dict, Optional

import numpy as np
import torch
from torch import Tensor
from torchmetrics import Metric, MetricCollection
from torchmetrics.classification import (
    MulticlassAccuracy,
    MulticlassAUROC,
    MulticlassF1Score,
    MulticlassRecall,
    MultilabelAveragePrecision,
    MultilabelF1Score,
    MultilabelPrecisionRecallCurve,
)
from torchmetrics.utilities.data import dim_zero_cat, select_topk

from .imagenet_c import ImageNet_C_Metric

logger = logging.getLogger("dinov3")


class ClassificationMetricType(Enum):
    AUROC = "auroc"
    MEAN_ACCURACY = "mean_accuracy"
    MEAN_RECALL = "mean_recall"
    MEAN_PER_CLASS_ACCURACY = "mean_per_class_accuracy"
    MEAN_PER_CLASS_RECALL = "mean_per_class_recall"
    PER_CLASS_ACCURACY = "per_class_accuracy"
    MEAN_AVERAGE_PRECISION_VOC_2007 = "map_voc2007"
    ANY_MATCH_ACCURACY = "any_match_accuracy"
    GROUPBY_ANY_MATCH_ACCURACY_1 = "groupby_any_match_accuracy_1"
    GROUPBY_ANY_MATCH_ACCURACY_5 = "groupby_any_match_accuracy_5"
    MEAN_MULTICLASS_F1 = "mean_multiclass_f1"
    MEAN_PER_CLASS_MULTICLASS_F1 = "mean_per_class_multiclass_f1"
    MEAN_MULTILABEL_F1 = "mean_multilabel_f1"
    MEAN_PER_CLASS_MULTILABEL_F1 = "mean_per_class_multilabel_f1"
    IMAGENET_C_METRIC = "imagenet_c_metric"
    MACRO_AVERAGED_MEAN_RECIPROCAL_RANK = "macro_averaged_mean_reciprocal_rank"
    MACRO_MULTILABEL_AVERAGE_PRECISION = "macro_multilabel_average_precision"

    @property
    def averaging_method(self):
        return getattr(AveragingMethod, self.name, None)

    @property
    def is_topk_accuracy_metric(self):
        return self.value in ("mean_accuracy", "mean_per_class_accuracy", "per_class_accuracy")

    @property
    def is_topk_recall_metric(self):
        return self.value in ("mean_recall", "mean_per_class_recall")

    @property
    def is_multilabel(self):
        return self.value in (
            "map_voc2007",
            "any_match_accuracy",
            "groupby_any_match_accuracy_1",
            "groupby_any_match_accuracy_5",
            "mean_multilabel_f1",
            "mean_per_class_multilabel_f1",
        )

    def __str__(self):
        return self.value


class AveragingMethod(Enum):
    MEAN_ACCURACY = "micro"
    MEAN_RECALL = "micro"
    MEAN_PER_CLASS_ACCURACY = "macro"
    MEAN_PER_CLASS_RECALL = "macro"
    PER_CLASS_ACCURACY = "none"
    MEAN_MULTICLASS_F1 = "micro"
    MEAN_PER_CLASS_MULTICLASS_F1 = "macro"
    MEAN_MULTILABEL_F1 = "micro"
    MEAN_PER_CLASS_MULTILABEL_F1 = "macro"

    def __str__(self):
        return self.value


def _make_default_ks(num_classes: int):
    return (1, 5) if num_classes >= 5 else (1,)


def build_classification_metric(
    metric_type: ClassificationMetricType, *, num_classes: int, ks: Optional[tuple] = None, dataset=None
):
    if metric_type.is_topk_accuracy_metric:
        ks = ks or _make_default_ks(num_classes)
        return build_topk_accuracy_metric(average_type=metric_type.averaging_method, num_classes=num_classes, ks=ks)
    elif metric_type.is_topk_recall_metric:
        ks = ks or _make_default_ks(num_classes)
        return build_topk_recall_metric(average_type=metric_type.averaging_method, num_classes=num_classes, ks=ks)
    elif metric_type == ClassificationMetricType.MEAN_AVERAGE_PRECISION_VOC_2007:
        assert ks is None
        map_voc2007 = MeanAveragePrecisionVOC2007(num_labels=int(num_classes))
        return MetricCollection({"top-1": map_voc2007})
    elif metric_type == ClassificationMetricType.ANY_MATCH_ACCURACY:
        ks = ks or _make_default_ks(num_classes)
        return build_topk_any_match_accuracy_metric(num_classes=num_classes, ks=ks)
    elif metric_type == ClassificationMetricType.GROUPBY_ANY_MATCH_ACCURACY_1:
        return GroupByAnyMatchAccuracy(top_k=1, num_classes=int(num_classes), dataset=dataset)
    elif metric_type == ClassificationMetricType.GROUPBY_ANY_MATCH_ACCURACY_5:
        return GroupByAnyMatchAccuracy(top_k=5, num_classes=int(num_classes), dataset=dataset)
    elif metric_type == ClassificationMetricType.IMAGENET_C_METRIC:
        return ImageNet_C_Metric()
    elif metric_type == ClassificationMetricType.AUROC:
        return MetricCollection({"top-1": MulticlassAUROC(num_classes=int(num_classes))})
    elif metric_type == ClassificationMetricType.MACRO_MULTILABEL_AVERAGE_PRECISION:
        return MetricCollection({"top-1": MultilabelAveragePrecision(num_labels=int(num_classes), average="macro")})

    elif metric_type in (
        ClassificationMetricType.MEAN_MULTICLASS_F1,
        ClassificationMetricType.MEAN_PER_CLASS_MULTICLASS_F1,
    ):
        return MetricCollection(
            {"top-1": MulticlassF1Score(num_classes=int(num_classes), average=metric_type.averaging_method.value)}
        )
    elif metric_type in (
        ClassificationMetricType.MEAN_MULTILABEL_F1,
        ClassificationMetricType.MEAN_PER_CLASS_MULTILABEL_F1,
    ):
        return MetricCollection(
            {"top-1": MultilabelF1Score(num_labels=int(num_classes), average=metric_type.averaging_method.value)}
        )
    elif metric_type == ClassificationMetricType.MACRO_AVERAGED_MEAN_RECIPROCAL_RANK:
        return MetricCollection({"top-1": MacroAveragedMeanReciprocalRank(num_classes=int(num_classes))})
    raise ValueError(f"Unknown metric type {metric_type}")


def build_topk_accuracy_metric(average_type: AveragingMethod, num_classes: int, ks: tuple = (1, 5)):
    metrics: Dict[str, Metric] = {
        f"top-{k}": MulticlassAccuracy(top_k=k, num_classes=int(num_classes), average=average_type.value) for k in ks
    }
    return MetricCollection(metrics)


def build_topk_recall_metric(average_type: AveragingMethod, num_classes: int, ks: tuple = (1, 5)):
    metrics: Dict[str, Metric] = {
        f"top-{k}": MulticlassRecall(top_k=k, num_classes=int(num_classes), average=average_type.value) for k in ks
    }
    return MetricCollection(metrics)


def build_topk_any_match_accuracy_metric(num_classes: int, ks: tuple = (1, 5)):
    metrics: Dict[str, Metric] = {f"top-{k}": AnyMatchAccuracy(top_k=k, num_classes=int(num_classes)) for k in ks}
    return MetricCollection(metrics)


class MeanAveragePrecisionVOC2007(MultilabelPrecisionRecallCurve):
    """
    VOC2007 11-points mAP Evaluation defined on page 11 of
    The PASCAL Visual Object Classes (VOC) Challenge (Everingham et al., 2010)
    """

    def __init__(self, *args, recall_level_count: int = 11, **kwargs):
        super().__init__(*args, **kwargs)
        self.recall_thresholds = torch.linspace(0, 1, recall_level_count)

    def compute(self):
        precision, recall, _ = super().compute()
        interpolated_precisions = torch.stack(
            [torch.max(precision[i][recall[i] >= r]) for r in self.recall_thresholds for i in range(len(precision))]
        )
        return torch.mean(interpolated_precisions)


class AnyMatchAccuracy(Metric):
    """
    This computes an accuracy where an element is considered correctly
    predicted if one of the predictions is in a list of targets
    """

    is_differentiable: bool = False
    higher_is_better: Optional[bool] = None
    full_state_update: bool = False

    def __init__(
        self,
        num_classes: int,
        top_k: int = 1,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.num_classes = num_classes
        self.top_k = top_k
        self.add_state("tp", [], dist_reduce_fx="cat")

    def update(self, preds: Tensor, target: Tensor) -> None:  # type: ignore
        # preds [B, D]
        # target [B, A]
        # preds_oh [B, D] with 0 and 1
        # select top K highest probabilities, use one hot representation
        preds_oh = select_topk(preds, self.top_k)
        # target_oh [B, D + 1] with 0 and 1
        target_oh = torch.zeros((preds_oh.shape[0], preds_oh.shape[1] + 1), device=target.device, dtype=torch.int32)
        target = target.long()
        # for undefined targets (-1) use a fake value `num_classes`
        target[target == -1] = self.num_classes
        # fill targets, use one hot representation
        target_oh.scatter_(1, target, 1)
        # target_oh [B, D] (remove the fake target at index `num_classes`)
        target_oh = target_oh[:, :-1]
        # tp [B] with 0 and 1
        tp = (preds_oh * target_oh == 1).sum(dim=1)
        # at least one match between prediction and target
        tp.clip_(max=1)
        # ignore instances where no targets are defined
        mask = target_oh.sum(dim=1) > 0
        tp = tp[mask]
        self.tp.append(tp)  # type: ignore

    def compute(self) -> Tensor:
        tp = dim_zero_cat(self.tp)  # type: ignore
        return tp.float().mean()


class GroupByAnyMatchAccuracy(AnyMatchAccuracy):
    def __init__(
        self,
        dataset,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        assert hasattr(dataset, "get_groupby_labels"), "The dataset should have a `get_groupby_labels` method"
        self._groupby_labels: Dict[str, np.ndarray] = dataset.get_groupby_labels()
        assert hasattr(dataset, "get_mapped_targets"), "The dataset should have a `get_mapped_targets` method"
        self._mapped_targets: torch.Tensor = torch.from_numpy(dataset.get_mapped_targets())
        self.add_state("indices", [], dist_reduce_fx="cat")

    def update(self, preds: Tensor, target: Tensor) -> None:
        self.indices.append(target)  # target are indices in this case
        super().update(preds, self._mapped_targets[target.tolist()].to(preds.device))

    def groupby_metric(self, variable: np.ndarray, indices: np.ndarray, tp: torch.Tensor) -> Dict[Any, Tensor]:
        groubpy_dict = {}
        for v in set(variable):
            index = np.where(variable[indices] == v)[0]
            groubpy_dict[v] = tp[index].mean()
        return groubpy_dict

    def compute(self) -> Tensor:
        tp = dim_zero_cat(self.tp).float()  # type: ignore
        indices = dim_zero_cat(self.indices).cpu().numpy()  # type: ignore
        global_score = tp.mean()
        results_dict = {"top-1": global_score}
        for label_name, label_value in self._groupby_labels.items():
            groupby_results = self.groupby_metric(label_value, indices, tp)
            printable_results = {k: f"{100. * v.item():.4g}" for k, v in groupby_results.items()}
            logger.info(f"Scores by {label_name} {printable_results}\n")
            results_dict = {**results_dict, **groupby_results}
        return results_dict


class MacroAveragedMeanReciprocalRank(Metric):
    """
    This computes the macro average mean reciprocal rank metric.
    Rank is defined as the position at which the target label is found when
    we sort the prediction scores from most probable label to least probable
    The reciprocal of the rank (1 / rank) which lies in [0, 1] gives a measure on how well the model does.
    the higher the rank the better the model. The reciprocal rank of each sample is aggregated by the target
    label and we sum those aggregates groupby the target labels. This quantity is divided by the number of
    samples per label which gives as per label or macro reciprocal rank performance. This per label metric is
    avergaed across all the labels to get the macro averaged mean reciprocal rank metric. This metric is
    useful when we have label imbalance and we want to give equal importance to rare labels as well as frequent labels.
    """

    is_differentiable: bool = False
    higher_is_better: Optional[bool] = None
    full_state_update: bool = False

    def __init__(
        self,
        num_classes: int,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.num_classes = num_classes
        self.add_state("per_class_mrr", default=torch.zeros(self.num_classes, dtype=torch.float), dist_reduce_fx="sum")
        self.add_state(
            "per_class_num_samples", default=torch.zeros(self.num_classes, dtype=torch.float), dist_reduce_fx="sum"
        )

    def update(self, preds: Tensor, target: torch.LongTensor) -> None:  # type: ignore
        # preds: FloatTensor [B, num_classes]
        # target: LongTensor [B] target labels
        # ranks: []
        rank_scores = 1 / (preds >= preds.gather(1, target[:, None].expand_as(preds))).sum(dim=1)

        unique_targets = target.unique().tolist()
        target_remap = {key: val for val, key in enumerate(unique_targets)}
        target_inv_remap = {val: key for val, key in enumerate(unique_targets)}
        remaped_targets = torch.LongTensor(list(map(target_remap.get, target.tolist()))).to(target.device)
        unique_remaped_targets, remaped_target_count = remaped_targets.unique(sorted=True, return_counts=True)
        sum_rank_scores = torch.zeros_like(unique_remaped_targets, dtype=torch.float).scatter_add_(
            0, remaped_targets, rank_scores
        )
        unique_targets = torch.LongTensor(list(map(target_inv_remap.get, unique_remaped_targets.tolist()))).to(
            target.device
        )
        self.per_class_mrr.index_add_(0, unique_targets, sum_rank_scores)
        self.per_class_num_samples.index_add_(0, unique_targets, remaped_target_count.float())

    def compute(self) -> Tensor:
        return (self.per_class_mrr / (self.per_class_num_samples + 1e-6)).mean()


def accuracy(output, target, topk=(1,)):
    """Computes the accuracy over the k top predictions for the specified values of k"""
    maxk = max(topk)
    batch_size = target.size(0)
    _, pred = output.topk(maxk, 1, True, True)
    pred = pred.t()
    correct = pred.eq(target.reshape(1, -1).expand_as(pred))
    return [correct[:k].reshape(-1).float().sum(0) * 100.0 / batch_size for k in topk]
