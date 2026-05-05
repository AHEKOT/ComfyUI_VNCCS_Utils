# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging
from typing import Any, Iterable, Iterator, List, Tuple, TypeVar

import numpy as np

logger = logging.getLogger("dinov3")
Loader = Iterable[List[Any]]
T = TypeVar("T")


class CombinedDataLoader:
    """
    Combines data loaders using the provided sampling ratios
    """

    GLOBAL_HOMOGENEOUS = 0
    LOCAL_HOMOGENEOUS = 1

    def __init__(
        self,
        loaders_with_ratios: Iterable[Tuple[Loader, float]],
        batch_size: int,
        combining_mode: int = 1,
        seed: int = 65537,
        name: str = None,
        logging_period: int = 100,
    ):
        if combining_mode not in [self.GLOBAL_HOMOGENEOUS, self.LOCAL_HOMOGENEOUS]:
            raise ValueError(f"Unsupported value of combining_mode ({combining_mode})")
        loaders, ratios = zip(*loaders_with_ratios)
        assert np.all([loader.batch_size == batch_size for loader in loaders]), (
            f"All individual loaders must have the same batch size to the combined data loader for combining_mode={combining_mode}"
        )
        self.loaders = loaders
        self.ratios = ratios
        self.batch_size = batch_size
        self.combining_mode = combining_mode
        self.initial_seed = seed
        self.name = name if name is not None else ""
        self.logging_period = logging_period
        if combining_mode == self.GLOBAL_HOMOGENEOUS:
            logger.info(f"Initialize CDL {self.name} with seed={seed}")
            self.seed = seed
            self.rng = np.random.default_rng(seed=seed)
        else:
            logger.info(f"Initialize CDL {self.name} with random seed")
            self.seed = 0
            self.rng = np.random.default_rng()
        self.loader_count = np.zeros(len(self.loaders))

    def homogeneous_iterator(self) -> Iterator[List[Any]]:
        iteration = 0
        iters = [iter(loader) for loader in self.loaders]
        while True:
            iteration += 1
            try:
                idx = self.rng.choice(len(self.loaders), p=self.ratios)
                self.loader_count[idx] += 1
                if iteration % self.logging_period == 0:
                    logger.info(f"Empirical ratios: CDL {self.name} {self.loader_count / self.loader_count.sum()}")
                yield next(iters[idx])
            except StopIteration:
                break

    def heterogeneous_iterator(self) -> Iterator[List[Any]]:
        pass

    def __iter__(self) -> Iterator[List[Any]]:
        if self.combining_mode in [self.GLOBAL_HOMOGENEOUS, self.LOCAL_HOMOGENEOUS]:
            logger.info(f"Using homogeneous iterator for CDL {self.name}")
            return self.homogeneous_iterator()
        else:
            raise ValueError(f"Unsupported value of combining_mode ({self.combining_mode})")
