# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging
from typing import Any, Dict, Optional

import numpy as np
import torch
from torch import Tensor
from torchmetrics import Metric

logger = logging.getLogger("dinov3")


# corruption type (str) -> level (int) -> score (float)
Scores = Dict[str, Dict[int, float]]
# corruption type (str) -> score (float)
AverageScores = Dict[str, float]


ALEXNET_INVERSE_SCORES: Scores = {
    "GAUSSIAN_NOISE": {
        1: 0.69528,
        2: 0.82542,
        3: 0.93554,
        4: 0.98138,
        5: 0.99452,
    },
    "SHOT_NOISE": {
        1: 0.71224,
        2: 0.85108,
        3: 0.93574,
        4: 0.98182,
        5: 0.99146,
    },
    "IMPULSE_NOISE": {
        1: 0.78374,
        2: 0.89808,
        3: 0.9487,
        4: 0.9872,
        5: 0.99548,
    },
    "DEFOCUS_BLUR": {
        1: 0.656239999999999,
        2: 0.73202,
        3: 0.85036,
        4: 0.91364,
        5: 0.94714,
    },
    "GLASS_BLUR": {
        1: 0.64308,
        2: 0.75054,
        3: 0.88806,
        4: 0.91622,
        5: 0.93344,
    },
    "MOTION_BLUR": {
        1: 0.5843,
        2: 0.70048,
        3: 0.82108,
        4: 0.8975,
        5: 0.92638,
    },
    "ZOOM_BLUR": {
        1: 0.70008,
        2: 0.769919999999999,
        3: 0.80784,
        4: 0.84198,
        5: 0.87198,
    },
    "SNOW": {
        1: 0.71726,
        2: 0.88392,
        3: 0.86468,
        4: 0.9187,
        5: 0.94952,
    },
    "FROST": {
        1: 0.6139,
        2: 0.797339999999999,
        3: 0.8879,
        4: 0.89942,
        5: 0.9343,
    },
    "FOG": {
        1: 0.67474,
        2: 0.7605,
        3: 0.84378,
        4: 0.8726,
        5: 0.945,
    },
    "BRIGHTNESS": {
        1: 0.4514,
        2: 0.48502,
        3: 0.54048,
        4: 0.62166,
        5: 0.724399999999999,
    },
    "CONTRAST": {
        1: 0.64548,
        2: 0.7615,
        3: 0.88874,
        4: 0.9776,
        5: 0.9927,
    },
    "ELASTIC_TRANSFORM": {
        1: 0.52596,
        2: 0.70116,
        3: 0.55686,
        4: 0.64076,
        5: 0.80554,
    },
    "PIXELATE": {
        1: 0.52218,
        2: 0.5462,
        3: 0.737279999999999,
        4: 0.87092,
        5: 0.91262,
    },
    "JPEG_COMPRESSION": {
        1: 0.510019999999999,
        2: 0.54718,
        3: 0.57294,
        4: 0.654579999999999,
        5: 0.74778,
    },
    "SPECKLE_NOISE": {
        1: 0.66192,
        2: 0.7444,
        3: 0.90246,
        4: 0.94548,
        5: 0.97268,
    },
    "GAUSSIAN_BLUR": {
        1: 0.54732,
        2: 0.70444,
        3: 0.82574,
        4: 0.89864,
        5: 0.9594,
    },
    "SPATTER": {
        1: 0.47196,
        2: 0.621939999999999,
        3: 0.75052,
        4: 0.84132,
        5: 0.90182,
    },
    "SATURATE": {
        1: 0.59342,
        2: 0.65514,
        3: 0.51174,
        4: 0.70834,
        5: 0.8226,
    },
}

N_LEVELS = 5
CORRUPTION_LEVEL_TO_ID = {
    (k, level): i * N_LEVELS + level - 1
    for i, k in enumerate(sorted(ALEXNET_INVERSE_SCORES.keys()))
    for level in range(1, 1 + N_LEVELS)
}
ID_TO_CORRUPTION_LEVEL = {i: k for k, i in CORRUPTION_LEVEL_TO_ID.items()}


def compute_relative_average_scores(scores: Scores, inv_scores_ref: Scores = ALEXNET_INVERSE_SCORES) -> AverageScores:
    rel_scores = {}
    for corruption_type in inv_scores_ref.keys():
        if corruption_type not in scores:
            logger.info(f"No results for split {corruption_type}")
            continue
        inv_scores_for_type = []
        inv_scores_ref_for_type = []
        for level in range(1, 1 + N_LEVELS):
            if level not in scores[corruption_type]:
                continue
            # append inverse score (confusion error)
            inv_scores_for_type.append(1.0 - scores[corruption_type][level])
            inv_scores_ref_for_type.append(inv_scores_ref[corruption_type][level])
        rel_scores[corruption_type] = np.mean(inv_scores_for_type) / np.mean(inv_scores_ref_for_type)

    mce_score = np.mean([v for _, v in rel_scores.items()])
    return mce_score


class ImageNet_C_Metric(Metric):

    is_differentiable: bool = False
    higher_is_better: Optional[bool] = False
    full_state_update: bool = False

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)

        self.add_state("tp", torch.zeros(len(CORRUPTION_LEVEL_TO_ID)), dist_reduce_fx="sum")
        self.add_state("total", torch.zeros(len(CORRUPTION_LEVEL_TO_ID)), dist_reduce_fx="sum")

    def update(self, preds: Tensor, target: Tensor) -> None:
        from large_vision_dataset.datasets.image_net_c import CORRUPTION_TYPES

        target_labels, corruption_types, levels = target.unbind(1)
        tps = torch.argmax(preds, dim=1) == target_labels.to(preds.device)
        index = torch.tensor(
            [
                CORRUPTION_LEVEL_TO_ID[(CORRUPTION_TYPES[ct].upper(), level.item())]
                for ct, level in zip(corruption_types, levels)
            ],
            device=preds.device,
        )
        self.total += torch.bincount(index, minlength=len(CORRUPTION_LEVEL_TO_ID))
        self.tp += torch.bincount(index, weights=tps, minlength=len(CORRUPTION_LEVEL_TO_ID))

    def compute(self) -> Tensor:
        flattened_scores = (self.tp / self.total).float().cpu().numpy()
        scores: Scores = {}
        for i, score in enumerate(flattened_scores):
            corruption_type, level = ID_TO_CORRUPTION_LEVEL[i]
            if corruption_type not in scores:
                scores[corruption_type] = {}
            scores[corruption_type][level] = score

        mce_score = compute_relative_average_scores(scores)
        return {"top-1": torch.tensor(mce_score, device=self.tp.device)}
