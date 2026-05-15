# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

from typing import Any, Dict, List, Optional

import torch
import torch.distributed as dist
from torch.nn import functional as F

from .torch_distributed_wrapper import get_default_process_group, get_world_size


def reduce_dict(input_dict: Dict[Any, torch.Tensor], average: bool = True) -> Dict[Any, torch.Tensor]:
    """
    Reduce the values in the dictionary from all processes so that all processes
    have the averaged results. Returns a dictionary with the same fields as
    the input dictionary, after reduction.

    Args:
        input_dict (dict): all the values will be reduced
        average (bool): whether to do average or sum
    """
    world_size = get_world_size()
    if world_size <= 1:
        return input_dict
    with torch.no_grad():
        names = []
        values = []
        # Sort the keys so that they are consistent across processes
        for k in sorted(input_dict.keys()):
            names.append(k)
            values.append(input_dict[k])
        stacked_values = torch.stack(values, dim=0)
        dist.all_reduce(stacked_values)
        if average:
            stacked_values /= world_size
        reduced_dict = {k: v for k, v in zip(names, stacked_values)}
    return reduced_dict


def _simple_gather_all_tensors(result: torch.Tensor, group: Any, world_size: int) -> List[torch.Tensor]:
    gathered_result = [torch.zeros_like(result) for _ in range(world_size)]
    dist.all_gather(gathered_result, result, group)
    return gathered_result


def gather_all_tensors(result: torch.Tensor, group: Optional[Any] = None) -> List[torch.Tensor]:
    """
    Copied from https://github.com/Lightning-AI/torchmetrics/blob/master/src/torchmetrics/utilities/distributed.py
    Gather all tensors from several ddp processes onto a list that is broadcasted to all processes.

    Works on tensors that have the same number of dimensions, but where each dimension may differ. In this case
    tensors are padded, gathered and then trimmed to secure equal workload for all processes.

    Args:
        result: the value to sync
        group: the process group to gather results from. Defaults to all processes (world)

    Return:
        list with size equal to the process group where element i corresponds to result tensor from process i
    """
    if group is None:
        group = get_default_process_group()

    # convert tensors to contiguous format
    result = result.contiguous()

    world_size = get_world_size()
    dist.barrier(group=group)

    # if the tensor is scalar, things are easy
    if result.ndim == 0:
        return _simple_gather_all_tensors(result, group, world_size)

    # 1. Gather sizes of all tensors
    local_size = torch.tensor(result.shape, device=result.device)
    local_sizes = [torch.zeros_like(local_size) for _ in range(world_size)]
    dist.all_gather(local_sizes, local_size, group=group)
    max_size = torch.stack(local_sizes).max(dim=0).values
    all_sizes_equal = all(all(ls == max_size) for ls in local_sizes)

    # 2. If shapes are all the same, then do a simple gather:
    if all_sizes_equal:
        return _simple_gather_all_tensors(result, group, world_size)

    # 3. If not, we need to pad each local tensor to maximum size, gather and then truncate
    pad_dims = []
    pad_by = (max_size - local_size).detach().cpu()
    for val in reversed(pad_by):
        pad_dims.append(0)
        pad_dims.append(val.item())
    result_padded = F.pad(result, pad_dims)
    gathered_result = [torch.zeros_like(result_padded) for _ in range(world_size)]
    dist.all_gather(gathered_result, result_padded, group)
    for idx, item_size in enumerate(local_sizes):
        slice_param = [slice(dim_size) for dim_size in item_size]
        gathered_result[idx] = gathered_result[idx][slice_param]
    return gathered_result
