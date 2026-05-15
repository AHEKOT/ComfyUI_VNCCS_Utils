# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

from typing import Any, Optional, Tuple

from torch.utils.data import Dataset


def extend_samples_with_index(dataset_class):
    class DatasetWithIndex(dataset_class):
        def __init__(self, **kwargs) -> None:
            root = dataset_class.get_root()
            super().__init__(root=root, **kwargs)

        def __getitem__(self, index: int):
            image, target = super().__getitem__(index)
            return image, target, index

    return DatasetWithIndex


class DatasetWithEnumeratedTargets(Dataset):
    """
    If pad_dataset is set, pads based on torch's DistributedSampler implementation, which
    with drop_last=False pads the last batch to be a multiple of the world size.
    https://github.com/pytorch/pytorch/blob/main/torch/utils/data/distributed.py#L91
    """

    def __init__(self, dataset: Dataset, pad_dataset: bool = False, num_replicas: Optional[int] = None):
        self._dataset = dataset
        self._size = len(self._dataset)
        self._padded_size = self._size
        self._pad_dataset = pad_dataset
        if self._pad_dataset:
            assert num_replicas is not None, "num_replicas should be set if pad_dataset is True"
            self._padded_size = num_replicas * ((len(dataset) + num_replicas - 1) // num_replicas)

    def get_image_relpath(self, index: int) -> str:
        assert self._pad_dataset or index < self._size
        return self._dataset.get_image_relpath(index % self._size)

    def get_image_data(self, index: int) -> bytes:
        assert self._pad_dataset or index < self._size
        return self._dataset.get_image_data(index % self._size)

    def get_target(self, index: int) -> Tuple[Any, int]:
        target = self._dataset.get_target(index % self._size)
        if index >= self._size:
            assert self._pad_dataset
            return (-1, target)
        return (index, target)

    def get_sample_decoder(self, index: int) -> Any:
        assert self._pad_dataset or index < self._size
        return self._dataset.get_sample_decoder(index % self._size)

    def __getitem__(self, index: int) -> Tuple[Any, Tuple[Any, int]]:
        image, target = self._dataset[index % self._size]
        if index >= self._size:
            assert self._pad_dataset
            return image, (-1, target)
        target = index if target is None else target
        return image, (index, target)

    def __len__(self) -> int:
        return self._padded_size
