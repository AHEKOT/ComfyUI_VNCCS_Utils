# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

from .config import (
    DinoV3SetupArgs,
    apply_scaling_rules_to_cfg,
    exit_job,
    get_cfg_from_args,
    get_default_config,
    setup_config,
    setup_job,
    setup_multidistillation,
    write_config,
)
