# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import os
from enum import Enum
from typing import Any, Callable, Optional, Union

from PIL import Image

from .decoders import Decoder, DenseTargetDecoder, ImageDataDecoder
from .extended import ExtendedVisionDataset


class _Split(Enum):
    TRAIN = "train"
    VAL = "val"
    TEST = "test"

    @property
    def data_fname(self) -> str:
        _DATA_FNAMES = {
            _Split.TRAIN: "nyu_train.txt",
            _Split.VAL: "nyu_test.txt",
            _Split.TEST: "nyu_test.txt",
        }
        return _DATA_FNAMES[self]


class NYU(ExtendedVisionDataset):
    Split = Union[_Split]
    Labels = Union[Image.Image]

    def __init__(
        self,
        *,
        split: "NYU.Split",
        root: Optional[str] = None,
        transforms: Optional[Callable] = None,
        transform: Optional[Callable] = None,
        target_transform: Optional[Callable] = None,
        image_decoder: Decoder = ImageDataDecoder,
        target_decoder: Decoder = DenseTargetDecoder,
    ) -> None:
        super().__init__(
            root=root,
            transforms=transforms,
            transform=transform,
            target_transform=target_transform,
            image_decoder=image_decoder,
            target_decoder=target_decoder,
        )
        self.image_paths = []
        self.target_paths = []
        with open(os.path.join(root, split.data_fname)) as f:
            lines = f.readlines()
            lines = sorted(lines)
            for line in lines:
                image_relpath, depth_relpath, _ = line.split()
                image_relpath = image_relpath.strip("/")
                depth_relpath = depth_relpath.strip("/")
                self.image_paths.append(image_relpath)
                self.target_paths.append(depth_relpath)

    def get_image_data(self, index: int) -> bytes:
        image_relpath = self.image_paths[index]
        image_full_path = os.path.join(self.root, image_relpath)
        with open(image_full_path, mode="rb") as f:
            image_data = f.read()
        return image_data

    def get_target(self, index: int) -> Any:
        target_relpath = self.target_paths[index]
        target_full_path = os.path.join(self.root, target_relpath)
        with open(target_full_path, mode="rb") as f:
            target_data = f.read()
        return target_data

    def __len__(self) -> int:
        return len(self.image_paths)
