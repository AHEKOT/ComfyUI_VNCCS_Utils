# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import contextlib
import os
import sys
from pathlib import Path


@contextlib.contextmanager
def _load_modules_from_dir(dir_: str):
    sys.path.insert(0, dir_)
    yield
    sys.path.pop(0)


def load_custom_callable(module_path: str | Path, callable_name: str):
    del module_path, callable_name
    raise RuntimeError("Loading executable Python modules from configuration is disabled")


@contextlib.contextmanager
def change_working_dir_and_pythonpath(new_dir):
    old_dir = Path.cwd()
    new_dir = Path(new_dir).expanduser().resolve().as_posix()
    old_pythonpath = sys.path.copy()
    sys.path.insert(0, new_dir)
    os.chdir(new_dir)
    try:
        yield
    finally:
        os.chdir(old_dir)
        sys.path = old_pythonpath
