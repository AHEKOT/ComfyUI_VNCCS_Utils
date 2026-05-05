# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import os
from enum import Enum
from typing import Any, Callable, List, Optional, Tuple, Union

from PIL import Image

from .decoders import Decoder, DenseTargetDecoder, ImageDataDecoder
from .extended import ExtendedVisionDataset


class _Split(Enum):
    TRAIN = "train"
    VAL = "val"

    @property
    def dirname(self) -> str:
        return {
            _Split.TRAIN: "training",
            _Split.VAL: "validation",
        }[self]


def _file_to_segmentation_path(file_name: str, segm_base_path: str) -> str:
    file_name_noext = os.path.splitext(file_name)[0]
    return os.path.join(segm_base_path, file_name_noext + ".png")


def _load_segmentation(root: str, split_file_names: List[str]):
    segm_base_path = "annotations"
    segmentation_paths = [_file_to_segmentation_path(file_name, segm_base_path) for file_name in split_file_names]
    return segmentation_paths


def _load_file_paths(root: str, split: _Split) -> Tuple[List[str], List[str]]:
    with open(os.path.join(root, f"ADE20K_object150_{split.value}.txt")) as f:
        split_file_names = sorted(f.read().strip().split("\n"))

    all_segmentation_paths = _load_segmentation(root, split_file_names)
    file_names = [os.path.join("images", el) for el in split_file_names]
    return file_names, all_segmentation_paths


class ADE20K(ExtendedVisionDataset):
    Split = Union[_Split]
    Labels = Union[Image.Image]

    def __init__(
        self,
        split: "ADE20K.Split",
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

        self.image_paths, self.target_paths = _load_file_paths(root, split)

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
