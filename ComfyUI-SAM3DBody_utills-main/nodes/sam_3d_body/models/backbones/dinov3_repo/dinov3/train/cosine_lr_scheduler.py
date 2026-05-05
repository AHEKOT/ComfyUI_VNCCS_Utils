# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging

import numpy as np

logger = logging.getLogger("dinov3")


class CosineScheduler(object):
    def __init__(
        self,
        base_value,
        final_value,
        total_iters,
        warmup_iters=0,
        start_warmup_value=0,
        freeze_iters=0,
        trunc_extra=0.0,
    ):
        super().__init__()
        self.final_value = np.float64(final_value)
        self.total_iters = total_iters

        freeze_schedule = np.zeros((freeze_iters))

        warmup_schedule = np.linspace(start_warmup_value, base_value, warmup_iters)

        if trunc_extra == 0.0:
            iters = np.arange(total_iters - warmup_iters - freeze_iters)
            schedule = final_value + 0.5 * (base_value - final_value) * (1 + np.cos(np.pi * iters / len(iters)))
        else:
            cosine_steps = total_iters - warmup_iters - freeze_iters
            iters = np.linspace(0, np.pi, int((1 + trunc_extra) * cosine_steps))[:cosine_steps]
            schedule = np.cos(iters)
            schedule = (schedule + 1) / 2
            schedule = (schedule - schedule[-1]) / (1 - schedule[-1])
            schedule = schedule * (base_value - final_value) + final_value

        self.schedule = np.concatenate((freeze_schedule, warmup_schedule, schedule), dtype=np.float64)

        assert len(self.schedule) == self.total_iters

    def __getitem__(self, it):
        if it >= self.total_iters:
            return self.final_value
        else:
            return self.schedule[it]


def linear_warmup_cosine_decay(
    start: float,
    peak: float,
    end: float,
    warmup_iterations: int,
    total_iterations: int,
    cosine_iterations: int | None = None,
) -> np.ndarray:
    """
    Create a learning rate schedule with linear warmup, a cosine, and an optional constant part in the end.

    Args:
        start (float): Initial learning rate.
        peak (float): Learning rate after linear warmup.
        end (float): Final learning rate after cosine.
        warmup_iterations (int): Number of iterations for linear warmup.
        total_iterations (int): Total number of iterations for the schedule.
        cosine_iterations (int | None): Number of iterations for cosine.
            If None, cosine part will be over remaining iterations after warmup.
    Returns:
        np.ndarray: Learning rate schedule as a numpy array.
    """
    linear = np.linspace(start, peak, warmup_iterations, endpoint=False)
    if cosine_iterations is None:
        cosine_iterations = total_iterations - warmup_iterations
    cosine = np.cos(np.linspace(0, np.pi, cosine_iterations))
    cosine = (cosine + 1) / 2
    cosine = (peak - end) * cosine + end
    remaining_iterations = total_iterations - cosine_iterations - warmup_iterations
    assert remaining_iterations >= 0
    constant = np.full((remaining_iterations,), fill_value=end)
    return np.concatenate([linear, cosine, constant])
