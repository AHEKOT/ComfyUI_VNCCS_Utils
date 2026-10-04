# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Feature normalization statistics (mean/std) for motion representations."""

import logging
import os
from typing import Optional

import numpy as np
import torch

log = logging.getLogger(__name__)


class Stats(torch.nn.Module):
    """Utility module for feature normalization statistics.

    Normalization follows:
    ``(data - mean) / sqrt(std**2 + eps)``
    """

    def __init__(
        self,
        folder: Optional[str] = None,
        load: bool = True,
        eps=1e-05,
    ):
        super().__init__()
        self.folder = folder
        self.eps = eps
        if folder is not None and load:
            self.load()

    def sliced(self, indices):
        """Return a new ``Stats`` object containing selected feature indices."""
        new_stats = Stats(folder=self.folder, load=False, eps=self.eps)
        new_stats.register_from_tensors(
            self.mean[..., indices].clone(),
            self.std[..., indices].clone(),
        )
        return new_stats

    def load(self):
        """Load ``mean.npy`` and ``std.npy`` from ``self.folder``."""
        mean_path = os.path.join(self.folder, "mean.npy")
        std_path = os.path.join(self.folder, "std.npy")
        if not os.path.exists(mean_path) or not os.path.exists(std_path):
            raise FileNotFoundError(
                f"Missing stats files in '{self.folder}'. Expected:\n"
                f"  - {mean_path}\n"
                f"  - {std_path}\n\n"
                "Make sure the checkpoint/stats have been downloaded and are mounted into the container.\n"
                "If you're using Docker Compose, run it from the repo root so `./:/workspace` mounts the correct directory."
            )

        mean = torch.from_numpy(np.load(mean_path))
        std = torch.from_numpy(np.load(std_path))
        self.register_from_tensors(mean, std)

    def register_from_tensors(self, mean: torch.Tensor, std: torch.Tensor):
        """Register mean/std tensors as non-persistent buffers."""
        self.register_buffer("mean", mean, persistent=False)
        self.register_buffer("std", std, persistent=False)

    def normalize(self, data: torch.Tensor) -> torch.Tensor:
        """Normalize data using the stored statistics."""
        mean = self.mean.to(device=data.device, dtype=data.dtype)
        std = self.std.to(device=data.device, dtype=data.dtype)
        # adjust std with eps
        return (data - mean) / torch.sqrt(std**2 + self.eps)

    def unnormalize(self, data: torch.Tensor) -> torch.Tensor:
        """Undo normalization using the stored statistics."""
        mean = self.mean.to(device=data.device, dtype=data.dtype)
        std = self.std.to(device=data.device, dtype=data.dtype)
        # adjust std with eps
        return data * torch.sqrt(std**2 + self.eps) + mean

    def is_loaded(self):
        """Return whether statistics are currently available."""
        return hasattr(self, "mean")

    def get_dim(self):
        """Return feature dimensionality."""
        return self.mean.shape[0]

    def save(
        self,
        folder: Optional[str] = None,
        mean: Optional[torch.Tensor] = None,
        std: Optional[torch.Tensor] = None,
    ):
        """Save statistics to ``folder`` as ``mean.npy`` and ``std.npy``."""
        if folder is None:
            folder = self.folder
            if folder is None:
                raise ValueError("No folder to save stats")

        if mean is None and std is None:
            try:
                mean = self.mean.cpu().numpy()
                std = self.std.cpu().numpy()
            except AttributeError:
                raise ValueError("Stats were not loaded")

        # don't override stats folder
        os.makedirs(folder, exist_ok=False)

        np.save(os.path.join(folder, "mean.npy"), mean)
        np.save(os.path.join(folder, "std.npy"), std)

    def __eq__(self, other):
        return (self.mean.cpu() == other.mean.cpu()).all() and (self.std.cpu() == other.std.cpu()).all()

    # should define a hash value for pytorch, as we defined __eq__
    def __hash__(self):
        # Convert mean and std to bytes for a consistent hash value
        mean_hash = hash(self.mean.detach().cpu().numpy().tobytes())
        std_hash = hash(self.std.detach().cpu().numpy().tobytes())
        return hash((mean_hash, std_hash))

    def __repr__(self):
        return f'Stats(folder="{self.folder}")'
