# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Factory helpers for building predefined skeleton variants."""

from pathlib import Path

from ..assets import SKELETONS_ROOT

from .definitions import (
    G1Skeleton34,
    SMPLXSkeleton22,
    SOMASkeleton30,
    SOMASkeleton77,
)


def build_skeleton(nbjoints: int, assets_folder: str | Path = SKELETONS_ROOT):
    """Instantiate a known skeleton class from its joint count.

    Supported joint counts: 30 (SOMA compact), 34 (G1), 77 (SOMA full), 22 (SMPLX).

    Args:
        nbjoints: Number of joints expected in the skeleton representation.
        assets_folder: Base skeleton-assets directory containing per-skeleton subfolders.

    Returns:
        A configured `SkeletonBase` subclass instance.

    Raises:
        ValueError: If `nbjoints` does not match a registered skeleton.
    """
    assets_folder = Path(assets_folder)
    if nbjoints == 34:
        return G1Skeleton34(assets_folder / "g1skel34")
    elif nbjoints == 22:
        return SMPLXSkeleton22(assets_folder / "smplx22")
    elif nbjoints == 30:
        return SOMASkeleton30(assets_folder / "somaskel30")
    elif nbjoints == 77:
        return SOMASkeleton77(assets_folder / "somaskel77")
    else:
        raise ValueError("This skeleton is not recognized.")
