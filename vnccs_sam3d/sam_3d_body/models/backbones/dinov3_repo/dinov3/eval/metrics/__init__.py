# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

from .classification import (
    AveragingMethod,
    ClassificationMetricType,
    MacroAveragedMeanReciprocalRank,
    MeanAveragePrecisionVOC2007,
    accuracy,
    build_classification_metric,
    build_topk_accuracy_metric,
)
