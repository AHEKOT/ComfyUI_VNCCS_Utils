# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

# isort: skip_file
from .torch_distributed_wrapper import (
    disable_distributed as disable,
    enable_distributed as enable,
    get_default_process_group,
    get_process_subgroup,
    get_rank,
    get_subgroup_rank,
    get_subgroup_size,
    get_world_size,
    is_distributed_enabled as is_enabled,
    is_main_process,
    is_subgroup_main_process,
    new_subgroups,
    save_in_main_process,
    TorchDistributedEnvironment,
)

from .torch_distributed_primitives import gather_all_tensors, reduce_dict
