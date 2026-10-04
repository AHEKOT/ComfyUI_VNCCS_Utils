# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import inspect
import json
import math
import random
from collections.abc import Mapping, Sequence
from functools import wraps
from math import prod
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, ParamSpec, TypeVar, Union

import numpy as np
import torch


def validate(validator, save_args: bool = False, super_init: bool = False):
    """Create a decorator function for validating user inputs.

    Args:
        validator: the function to validate (pydantic dataclass)
        save (bool): save all the attributes to the obj [args[0]]
        super_init (bool): init parent with no arguments (usefull for using save on a nn.Module)

    Returns:
        decorator: the decorator function
    """

    def decorator(func):
        @wraps(func)
        def validated_func(*args, **kwargs):
            conf = validator(**kwargs)

            if save_args:
                assert len(args) != 0
                obj = args[0]

                if super_init:
                    # init the parent module
                    super(type(obj), obj).__init__()

                for key, val in conf.__dict__.items():
                    setattr(obj, key, val)
            return func(*args, conf)

        return validated_func

    return decorator


# Type alias for clarity
Tensor = Any

P = ParamSpec("P")
R = TypeVar("R")


def ensure_batched(**spec: int) -> Callable[[Callable[P, R]], Callable[P, R]]:
    """Decorator to flatten complex batch dimensions.

    Fixes included:
    1. Handles 1D tensors (tail_ndim=0) correctly without slicing errors.
    2. Skips .reshape() if the input is already purely flat (Optimization).
    """
    if not spec:
        raise ValueError("At least one argument spec must be provided.")

    canonical_name, canonical_ndim = next(iter(spec.items()))

    def decorator(fn: Callable[P, R]) -> Callable[P, R]:
        sig = inspect.signature(fn)

        @wraps(fn)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            bound = sig.bind(*args, **kwargs)
            bound.apply_defaults()

            # --- 1. CANONICAL ARGUMENT ---
            if canonical_name not in bound.arguments:
                raise TypeError(f"Missing canonical argument '{canonical_name}'.")

            x0 = bound.arguments[canonical_name]
            if x0 is None:
                raise ValueError(f"Canonical '{canonical_name}' cannot be None.")

            # Calculate split between Batch dims and Feature dims
            expected_tail_dims = canonical_ndim - 1  # e.g. 3 - 1 = 2 (Sequence, Feat)

            # Validation
            if x0.ndim < expected_tail_dims:
                raise ValueError(f"'{canonical_name}' ndim={x0.ndim} < expected {expected_tail_dims} tail dims.")

            # --- LOGIC FIX 1: Handle 0 tail dims correctly ---
            if expected_tail_dims == 0:
                orig_batch_shape = x0.shape
                tail_shape = ()
            else:
                orig_batch_shape = x0.shape[:-expected_tail_dims]
                tail_shape = x0.shape[-expected_tail_dims:]

            # Calculate flattened batch size
            # If orig_batch_shape is () (scalar input), size is 1.
            B_flat = prod(orig_batch_shape) if orig_batch_shape else 1

            # Determine if we added a fake batch dim (unbatched input)
            is_unbatched_input = len(orig_batch_shape) == 0

            # --- LOGIC FIX 2: Skip reshape if already flat (Optimization) ---
            # If batch shape is already 1D (e.g. [2]), we don't need to reshape [2, 140, 5] -> [2, 140, 5]
            is_already_flat = len(orig_batch_shape) == 1

            if is_unbatched_input:
                # (H, W) -> (1, H, W)
                x0_batched = x0.reshape(1, *tail_shape)
            elif is_already_flat:
                # (B, H, W) -> Keep as is
                x0_batched = x0
            else:
                # (B1, B2, H, W) -> (B1*B2, H, W)
                x0_batched = x0.reshape(B_flat, *tail_shape)

            bound.arguments[canonical_name] = x0_batched

            # --- 2. OTHER ARGUMENTS ---
            for name, target_ndim in list(spec.items())[1:]:
                val = bound.arguments.get(name, None)
                if val is None:
                    continue

                arg_tail_dims = target_ndim - 1  # e.g. for lengths=1, tail=0

                # Validate
                if val.ndim < arg_tail_dims:
                    raise ValueError(f"'{name}' ndim={val.ndim} too small.")

                # --- Get Batch Shape (With 0-tail fix) ---
                if arg_tail_dims == 0:
                    val_batch_shape = val.shape
                    val_tail_shape = ()
                else:
                    val_batch_shape = val.shape[:-arg_tail_dims]
                    val_tail_shape = val.shape[-arg_tail_dims:]

                # --- Check Mismatch ---
                # Unbatched inputs must match unbatched canonical
                if len(val_batch_shape) == 0:
                    if not is_unbatched_input:
                        raise ValueError(f"'{name}' is unbatched but canonical is batched.")
                    val_batched = val.reshape(1, *val_tail_shape)
                else:
                    # Batched inputs must match canonical batch shape EXACTLY
                    if val_batch_shape != orig_batch_shape:
                        raise ValueError(
                            f"Batch dimensions mismatch! '{canonical_name}' has {orig_batch_shape}, "
                            f"but '{name}' has {val_batch_shape}."
                        )

                    # Optimization: Don't reshape if already flat
                    if is_already_flat:
                        val_batched = val
                    else:
                        val_batched = val.reshape(B_flat, *val_tail_shape)

                bound.arguments[name] = val_batched

            # --- 3. EXECUTION ---
            out = fn(**bound.arguments)

            # --- 4. RESTORE ---
            def restore(obj):
                if isinstance(obj, Mapping):
                    return {k: restore(v) for k, v in obj.items()}
                if isinstance(obj, (list, tuple)):
                    return type(obj)(restore(x) for x in obj)

                if hasattr(obj, "shape"):
                    if obj.ndim == 0:
                        return obj

                    # Verify batch dimension exists and wasn't reduced
                    if obj.shape[0] != B_flat:
                        return obj

                    # If input was simple (B, ...), return simple (B, ...)
                    if is_already_flat:
                        return obj

                    rest = obj.shape[1:]

                    if is_unbatched_input:
                        return obj.reshape(*rest)

                    return obj.reshape(*orig_batch_shape, *rest)
                return obj

            return restore(out)

        return wrapper

    return decorator


def to_numpy(obj):
    if isinstance(obj, Mapping):
        return {k: to_numpy(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return type(obj)(to_numpy(x) for x in obj)
    if isinstance(obj, torch.Tensor):
        return obj.cpu().numpy()
    return obj


def to_torch(obj, device=None, dtype=None):
    if isinstance(obj, Mapping):
        return {k: to_torch(v, device, dtype) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return type(obj)(to_torch(x, device, dtype) for x in obj)
    if isinstance(obj, np.ndarray):
        obj = torch.from_numpy(obj)
    if isinstance(obj, torch.Tensor):
        if dtype is not None:
            obj = obj.to(dtype=dtype)
        if device is None:
            return obj
        return obj.to(device)
    return obj


def seed_everything(seed: int, deterministic: bool = False) -> None:
    """Seed all random number generators."""
    random.seed(seed)  # for Python random module.
    np.random.seed(seed)  # for NumPy.
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    if deterministic:
        torch.backends.cudnn.deterministic = True  # for deterministic behavior.
        torch.backends.cudnn.benchmark = False  # if you want to make the behavior deterministic.


def load_json(path: Union[str, Path]) -> Any:
    """Load a JSON file and return its contents.

    Args:
        path (str | Path): Path to the JSON file.

    Returns:
        Any: Parsed JSON content (dict, list, etc.).

    Raises:
        FileNotFoundError: If the file does not exist.
        ValueError: If the file is not valid JSON.
    """
    path = Path(path)

    if not path.exists():
        raise FileNotFoundError(f"JSON file not found: {path}")

    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON in file {path}: {e}") from e


def save_json(path: Union[str, Path], data: Any) -> None:
    """Save data to a JSON file.

    Args:
        path (str | Path): Path to the JSON file.
        data (Any): Data to save (must be JSON serializable).

    Raises:
        ValueError: If the data is not JSON serializable.
    """
    path = Path(path)

    # Create parent directories if they don't exist
    path.parent.mkdir(parents=True, exist_ok=True)

    try:
        with path.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except (TypeError, ValueError) as e:
        raise ValueError(f"Data is not JSON serializable: {e}") from e
