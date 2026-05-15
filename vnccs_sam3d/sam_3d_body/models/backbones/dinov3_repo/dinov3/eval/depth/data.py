# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import logging
import random
from functools import partial
from typing import Any

import numpy as np
import torch

from dinov3.data import make_dataset, make_data_loader, DatasetWithEnumeratedTargets, SamplerType
import dinov3.distributed as distributed


logger = logging.getLogger("dinov3")


def worker_init_fn(worker_id, num_workers, rank, seed):
    """Worker init func for dataloader.
    The seed of each worker equals to num_worker * rank + worker_id + user_seed
    Args:
        worker_id (int): Worker id.
        num_workers (int): Number of workers.
        rank (int): The rank of current process.
        seed (int): The random seed to use.
    """
    worker_seed = num_workers * rank + worker_id + seed
    np.random.seed(worker_seed)
    random.seed(worker_seed)
    torch.manual_seed(worker_seed)


def build_dataloader(
    transforms: Any,
    dataset_str: str,
    device: int,
    split: str = "train",
    batch_size: int = 1,
    n_gpus: int = 1,
    num_workers: int = 2,
    seed: int = 0,
    use_init_fn=False,
):
    """
    Build a dataloader from lavida descriptor strings.
    One can specify either a list of descriptors or a single one.
    When a list is used, the resulting dataset is
    a concatenation of all the listed datasets.

    transforms: transforms for the dataset
    dataset_str (str): a dataset descriptor, e.g. 'NYU:split=TRAIN'
    device (int): id for the GPU rank
    split (str): dataset split (choice: ['train', 'val', 'test'])
    batch_size (int): batch size
    n_gpus (int): number of ranks to use for distributed sampler
    num_workers (int): number of workers for the dataloader
    seed (int): random seed
    use_init_fn (bool): if True, initializes workers with worker_init_fn
    """
    assert split in ["train", "val", "test"]
    is_train = split == "train"
    ds = make_dataset(dataset_str=dataset_str, transforms=transforms)
    logger.info(f"Dataset {split}:\n{ds}")

    if not is_train:
        assert batch_size == 1, "Evaluation should only be done at batch size 1!"
        ds = DatasetWithEnumeratedTargets(ds, pad_dataset=True, num_replicas=n_gpus)

    if use_init_fn and is_train:
        init_fn = partial(worker_init_fn, num_workers=num_workers, rank=device, seed=seed + device)
    else:
        init_fn = None
    dataloader = make_data_loader(
        dataset=ds,
        batch_size=batch_size,
        sampler_type=SamplerType.DISTRIBUTED if distributed.is_enabled() else None,
        drop_last=is_train,
        shuffle=is_train,
        persistent_workers=(not is_train),
        worker_init_fn=init_fn,
        seed=seed,
        num_workers=num_workers,
    )

    if is_train:
        return InfiniteDataloader(dataloader)

    return dataloader


class InfiniteDataloader:
    def __init__(self, dataloader: torch.utils.data.DataLoader):
        self.dataloader = dataloader
        self.data_iterator = iter(dataloader)
        self.sampler = dataloader.sampler
        if not hasattr(self.sampler, "epoch"):
            self.sampler.epoch = 0  # type: ignore

    def __iter__(self):
        return self

    def __len__(self) -> int:
        return len(self.dataloader)

    def __next__(self):
        try:
            data = next(self.data_iterator)
        except StopIteration:
            self.sampler.epoch += 1
            self.data_iterator = iter(self.dataloader)
            data = next(self.data_iterator)
        return data
