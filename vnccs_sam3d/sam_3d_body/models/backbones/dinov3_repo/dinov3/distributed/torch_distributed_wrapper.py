# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging
from datetime import timedelta
from enum import Enum
from typing import Sequence

import torch
import torch.distributed as dist

logger = logging.getLogger("dinov3")

_DEFAULT_PROCESS_GROUP = None
_PROCESS_SUBGROUP = None
_BUILTIN_PRINT = None


def is_distributed_enabled() -> bool:
    """
    Returns:
        True if distributed training is enabled.
    """
    return dist.is_available() and dist.is_initialized()


def get_rank(group=None) -> int:
    """
    Returns:
        The rank of the current process within the specified process group.
    """
    if not is_distributed_enabled():
        return 0
    return dist.get_rank(group=group)


def get_world_size(group=None) -> int:
    """
    Returns:
        The number of processes in the specified process group.
    """
    if not is_distributed_enabled():
        return 1
    return dist.get_world_size(group=group)


def is_main_process(group=None) -> bool:
    """
    Returns:
        True if the current process is the main one in the specified process group.
    """
    return get_rank(group) == 0


def save_in_main_process(*args, **kwargs) -> None:
    """Utility function to save only from the main process."""
    group = kwargs.pop("group", None)
    if not is_main_process(group):
        return
    torch.save(*args, **kwargs)


def _restrict_print_to_main_process() -> None:
    """This function disables printing when not in the main process."""
    import builtins as __builtin__

    global _BUILTIN_PRINT
    _BUILTIN_PRINT = __builtin__.print

    def print(*args, **kwargs):
        force = kwargs.pop("force", False)
        if is_main_process() or force:
            _BUILTIN_PRINT(*args, **kwargs)

    __builtin__.print = print


class JobType(Enum):
    TORCHELASTIC = "TorchElastic"
    SLURM = "Slurm"
    MANUAL = "manual"


class TorchDistributedEnvironment:
    """
    Safe single-process description used by the bundled inference runtime.

    Environment-driven distributed launch and process-based cluster discovery
    are intentionally excluded from this vendored inference package.
    """

    def __init__(self):
        self.job_id = None
        self.job_type = JobType.MANUAL
        self.master_addr = "127.0.0.1"
        self.master_port = 0
        self.rank = 0
        self.world_size = 1
        self.local_rank = 0
        self.local_world_size = 1

    def export(
        self,
        *,
        overwrite: bool,
        nccl_async_error_handling: bool = False,
    ) -> "TorchDistributedEnvironment":
        del overwrite, nccl_async_error_handling
        return self

    @property
    def is_main_process(self) -> bool:
        return self.rank == 0

    def __str__(self):
        return (
            f"{self.job_type.value} job "
            + (f"({self.job_id}) " if self.job_id else "")
            + f"using {self.master_addr}:{self.master_port} "  # noqa: E231
            f"(rank={self.rank}, world size={self.world_size})"
        )

    def __repr__(self):
        return (
            f"{self.__class__.__name__}("
            f"master_addr={self.master_addr},"  # noqa: E231
            f"master_port={self.master_port},"  # noqa: E231
            f"rank={self.rank},"  # noqa: E231
            f"world_size={self.world_size},"  # noqa: E231
            f"local_rank={self.local_rank},"  # noqa: E231
            f"local_world_size={self.local_world_size}"
            ")"
        )


def enable_distributed(
    *,
    set_cuda_current_device: bool = True,
    overwrite: bool = False,
    nccl_async_error_handling: bool = False,
    restrict_print_to_main_process: bool = True,
    timeout: timedelta | None = None,
):
    """Enable distributed mode.

    Args:
        set_cuda_current_device: If True, call torch.cuda.set_device() to set the
            current PyTorch CUDA device to the one matching the local rank.
        overwrite: If True, overwrites already set variables. Else fails.
        nccl_async_error_handling: Enables NCCL asynchronous error handling. As a
            side effect, this enables timing out PyTorch distributed operations
            after a default 30 minutes delay).
        restrict_print_to_main_process: If True, the print function of non-main processes
            (ie rank>0) is disabled. Use print(..., force=True) to print anyway.
            If False, nothing is changed and all processes can print as usual.
        timeout: Timeout for operations executed against the process group.
            Default value is 10 minutes for NCCL and 30 minutes for other backends.
    """
    del (
        set_cuda_current_device,
        overwrite,
        nccl_async_error_handling,
        restrict_print_to_main_process,
        timeout,
    )
    raise RuntimeError("Distributed launch is disabled in the bundled inference runtime")


def get_default_process_group():
    return _DEFAULT_PROCESS_GROUP


def disable_distributed() -> None:
    global _BUILTIN_PRINT
    if _BUILTIN_PRINT is not None:
        import builtins as __builtin__

        __builtin__.print = _BUILTIN_PRINT

    global _PROCESS_SUBGROUP
    # checking here because get_process_subgroup can return _DEFAULT_PROCESS_GROUP
    if _PROCESS_SUBGROUP is not None:
        torch.distributed.destroy_process_group(_PROCESS_SUBGROUP)
        _PROCESS_SUBGROUP = None

    global _DEFAULT_PROCESS_GROUP
    if _DEFAULT_PROCESS_GROUP is not None:  # not initialized
        torch.distributed.destroy_process_group(_DEFAULT_PROCESS_GROUP)
        _DEFAULT_PROCESS_GROUP = None


def new_subgroups(all_subgroup_ranks: Sequence[Sequence[int]]):
    """Create new process subgroups according to the provided specification.

    Args:
       all_subgroup_ranks: a sequence of rank sequences (first rank, ..., last rank),
           one for each process subgroup. Example: ((0, 1), (2, 3), (4, 5, 6, 7)).

    Note:
       This is similar to the (non-documented) new_subgroups_by_enumeration().
       This should be called once (and not sequentially) to create all subgroups.
    """
    all_ranks = tuple(rank for subgroup_ranks in all_subgroup_ranks for rank in subgroup_ranks)
    rank = get_rank()
    assert len(all_ranks) == len(set(all_ranks))
    assert rank in all_ranks

    global _PROCESS_SUBGROUP
    assert _PROCESS_SUBGROUP is None

    for subgroup_ranks in all_subgroup_ranks:
        subgroup = torch.distributed.new_group(subgroup_ranks)
        if rank in subgroup_ranks:
            _PROCESS_SUBGROUP = subgroup


def get_process_subgroup():
    """
    Returns:
        The process subgroup of this rank (or None).
    """
    return _PROCESS_SUBGROUP or _DEFAULT_PROCESS_GROUP


def get_subgroup_rank() -> int:
    """
    Returns:
        The rank of the current process within its process subgroup.
    """
    return get_rank(group=get_process_subgroup())


def get_subgroup_size() -> int:
    """
    Returns:
        The number of processes in the process subgroup
    """
    return get_world_size(group=get_process_subgroup())


def is_subgroup_main_process() -> bool:
    """
    Returns:
        True if the current process is the main one within its process subgroup.
    """
    return get_rank(group=get_process_subgroup()) == 0
