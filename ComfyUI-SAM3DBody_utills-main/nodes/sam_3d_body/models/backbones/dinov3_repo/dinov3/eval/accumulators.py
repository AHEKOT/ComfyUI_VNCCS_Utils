# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging
from collections import defaultdict
from typing import Dict, List, Optional

import torch
from torch import Tensor

from dinov3.distributed import gather_all_tensors  # Gathers tensors of different sizes

logger = logging.getLogger("dinov3")


def _cat_and_gather_tensor_list(tensor_list: List[Tensor]) -> Tensor:
    local_cat = torch.cat(tensor_list)
    return torch.cat(gather_all_tensors(local_cat))


class Accumulator:
    def __init__(self) -> None:
        pass

    def update(self, preds: Tensor, target: Tensor, index: Tensor) -> None:
        raise NotImplementedError

    def accumulate(self) -> Optional[Dict[str, Tensor]]:
        raise NotImplementedError


class NoOpAccumulator(Accumulator):
    def __init__(self) -> None:
        pass

    def update(self, preds: Tensor, target: Tensor, index: Tensor) -> None:
        pass

    def accumulate(self) -> None:
        return None


class ResultsAccumulator(Accumulator):
    """
    Accumulate predictions and targets across processes
    """

    def __init__(self) -> None:
        self._local_values: Dict[str, List[Tensor]] = defaultdict(list)
        self._gathered_values: Dict[str, Tensor] = {}
        self._gathered = False

    def update(self, preds: Tensor, target: Tensor, index: Tensor) -> None:
        assert len(preds) == len(target) == len(index)
        assert not self._gathered, "Tensors have already been gathered in this helper"
        self._local_values["preds"].append(preds)
        self._local_values["target"].append(target)
        self._local_values["index"].append(index)
        self._gathered = False

    def _gather_tensors(self):
        for k, tensor_list in self._local_values.items():
            self._gathered_values[k] = _cat_and_gather_tensor_list(tensor_list)
        self._gathered = True

    def accumulate(self) -> Dict[str, Tensor]:
        if not self._gathered:
            self._gather_tensors()
        preds, target, index = [self._gathered_values[k] for k in ["preds", "target", "index"]]
        assert len(preds) == len(target) == len(index) and index.min() == 0
        preds_ordered = torch.zeros((index.max() + 1, *preds.shape[1:]), dtype=preds.dtype, device=preds.device)
        preds_ordered[index] = preds
        target_ordered = torch.zeros((index.max() + 1, *target.shape[1:]), dtype=target.dtype, device=target.device)
        target_ordered[index] = target
        return {"preds": preds_ordered, "target": target_ordered}
