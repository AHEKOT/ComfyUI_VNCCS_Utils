# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

from enum import Enum
from typing import Callable

import numpy as np
import torch
import torchvision.transforms as T
from torchvision.transforms import v2
from torchvision import tv_tensors


import torchvision.transforms.functional as TF
from PIL import Image

from dinov3.data.transforms import IMAGENET_DEFAULT_MEAN, IMAGENET_DEFAULT_STD


class _FixedCropType(Enum):
    NYU = "NYU"
    FULL = "FULL"


class Aug:
    def __call__(self, x):
        raise NotImplementedError

    def inverse(self, x):
        raise NotImplementedError("This function has no inverse!")


class ColorAug(torch.nn.Module):
    """Color augmentation used in depth estimation

    Args:
        prob (float, optional): The color augmentation probability. Default: None.
        gamma_range(tuple[float, float], optional): Gamma range for augmentation. Default: (0.9, 1.1).
        brightness_range(tuple[float, float], optional): Brightness range for augmentation. Default: (0.9, 1.1).
        color_range(tuple[float, float], optional): Color range for augmentation. Default: (0.9, 1.1).
    """

    def __init__(self, prob=None, gamma_range=(0.9, 1.1), brightness_range=(0.9, 1.1), color_range=(0.9, 1.1)):
        super().__init__()
        self.prob = prob
        self.gamma_range = gamma_range
        self.brightness_range = brightness_range
        self.color_range = color_range
        if prob is not None:
            assert prob >= 0 and prob <= 1

    def __call__(self, img):
        """Call function to apply color augmentation.

        Args:
            img: Data to transform.

        Returns:
            img: Randomly colored data.
        """
        aug = True if np.random.rand() < self.prob else False
        if aug:
            image = img.permute((1, 2, 0)) * 255  # 256, 256, 3

            # gamma augmentation
            gamma = np.random.uniform(min(*self.gamma_range), max(*self.gamma_range))
            image_aug = image**gamma

            # brightness augmentation
            brightness = np.random.uniform(min(*self.brightness_range), max(*self.brightness_range))
            image_aug = image_aug * brightness

            # color augmentation
            colors = np.random.uniform(min(*self.color_range), max(*self.color_range), size=3)
            white = np.ones((image.shape[0], image.shape[1]), dtype=np.float32)
            color_image = np.stack([white * colors[i] for i in range(3)], axis=2)
            image_aug *= color_image
            image_aug = np.clip(image_aug, 0, 255)
            image_aug = image_aug / 255

            return image_aug.permute((2, 0, 1))
        return img


class ColorAugV2(torch.nn.Module):
    """Color augmentation used in depth estimation

    Args:
        prob (float, optional): The color augmentation probability. Default: None.
        gamma_range(tuple[float, float], optional): Gamma range for augmentation. Default: (0.9, 1.1).
        brightness_range(tuple[float, float], optional): Brightness range for augmentation. Default: (0.9, 1.1).
        color_range(tuple[float, float], optional): Color range for augmentation. Default: (0.9, 1.1).
    """

    def __init__(self, prob=None, gamma_range=(0.9, 1.1), brightness_range=(0.9, 1.1), color_range=(0.9, 1.1)):
        super().__init__()
        self.prob = prob
        self.img_transform = ColorAug(
            prob=prob, gamma_range=gamma_range, brightness_range=brightness_range, color_range=color_range
        )

    def __call__(self, img, label):
        return self.img_transform(img), label

    def __repr__(self):
        repr = "ColorAug("
        repr += f"\n\tgamma_range={self.img_transform.gamma_range},"
        repr += f"\n\tbrightness_range={self.img_transform.brightness_range},"
        repr += f"\n\tcolor_range={self.img_transform.color_range},"
        repr += f"\n\tprob={self.prob},"
        repr += ")"
        return repr


class LeftRightFlipAug(Aug):
    """
    Test time augmentation for depth estimation
    from https://github.com/open-mmlab/mmcv/blob/main/mmcv/transforms/processing.py#L721

    this is just returning two versions of the same image, and the according labels
    """

    def __init__(
        self,
        flip: bool = False,
    ):
        self._flip = flip

    def __call__(self, img, label=None):
        """Call function to apply test time augment transforms on results.

        Args:
            img: Data to transform.

        Returns:
            list: A list of augmented data.
        """

        do_flips = [False, True] if self._flip else [False]
        results_images = []
        results_labels = []

        for do_flip in do_flips:
            image_aug = TF.hflip(img) if do_flip else img
            results_images.append(image_aug)
            label_aug = TF.hflip(label) if do_flip else label
            results_labels.append(label_aug)

        return results_images, results_labels

    def inverse(self, stacked_left_right_pair: torch.Tensor) -> torch.Tensor:
        if not self._flip:
            return stacked_left_right_pair

        pre_aug_batch_size = stacked_left_right_pair.shape[0] // 2
        assert pre_aug_batch_size * 2 == stacked_left_right_pair.shape[0]
        return (
            stacked_left_right_pair[:pre_aug_batch_size] + TF.hflip(stacked_left_right_pair[pre_aug_batch_size:])
        ) / 2


class NormalizeDepth(torch.nn.Module):
    def __init__(self, normalization_factor):
        super().__init__()
        self.factor = normalization_factor
        assert self.factor > 1e-6, f"Normalization factor should be > 1e-6, got {self.factor}"

    def forward(self, img, label):
        assert label is not None
        label = Depth(label / self.factor)  # have to rewrap otherwise it becomes a torch.Tensor
        return img, label

    def __repr__(self):
        repr = f"NormalizeDepth(normalization_factor={self.factor})"
        return repr


class NYUCrop:
    def __init__(self, crop_box: tuple[int, int, int, int] = (43, 45, 608, 472)):
        """NYU standard krop when training monocular depth estimation on NYU dataset.

        Args:
            crop_box: (x1, y1, x2, y2) of cropped region.
        """
        self._orig_width = 640
        self._orig_height = 480
        self._x1, self._y1, self._x2, self._y2 = crop_box

    def __call__(self, img):
        """Call function to apply NYUCrop on images."""
        orig_h, orig_w = 480, 640
        w, h = img.size if isinstance(img, Image.Image) else img.shape[-2:][::-1]
        y1_new = int((self._y1 / orig_h) * h)
        y2_new = int((self._y2 / orig_h) * h)
        x1_new = int((self._x1 / orig_w) * w)
        x2_new = int((self._x2 / orig_w) * w)
        if isinstance(img, Image.Image):
            output_img = img.crop((x1_new, y1_new, x2_new, y2_new))
        elif isinstance(img, (torch.Tensor, np.ndarray)):
            output_img = img[..., y1_new:y2_new, x1_new:x2_new]
        else:
            raise NotImplementedError(f"got unsupported input type {type(img)}")
        return output_img


class ResizeV2:
    """
    Resize both image and label using different interpolation modes.
    """

    def __init__(
        self,
        size,
        image_interpolation: T.InterpolationMode = T.InterpolationMode.BILINEAR,
        label_interpolation: T.InterpolationMode = T.InterpolationMode.NEAREST,
        resize_label: bool = False,
    ):
        self.size = size
        self.image_interpolation = image_interpolation
        self.label_interpolation = label_interpolation
        self.resize_label = resize_label

    def __call__(self, img, label):
        img = T.Resize(size=self.size, interpolation=self.image_interpolation)(img)
        if self.resize_label:
            label = T.Resize(size=self.size, interpolation=self.label_interpolation)(label)
        return img, label

    def __repr__(self):
        repr = f"Resize(img_size={self.size},label="
        repr += "None)" if not self.resize_label else f"{self.size})"
        return repr


class FixedCrop(torch.nn.Module):
    def __init__(self, crop_type: _FixedCropType | str):
        super().__init__()
        if isinstance(crop_type, str):
            crop_type = _FixedCropType(crop_type)
        self.crop: Callable
        if crop_type == _FixedCropType.NYU:
            self.crop = NYUCrop()
        elif crop_type == _FixedCropType.FULL:
            self.crop = lambda x: x
        self.crop_type = crop_type

    def forward(self, img, label):
        img = self.crop(img)
        if label is not None:
            label = self.crop(label)
        return img, label

    def __repr__(self):
        repr = f"FixedCrop({self.crop_type})"
        return repr


class MaybeApply(torch.nn.Module):
    def __init__(self, transform, threshold: float = 0.5):
        super().__init__()
        self._transform = transform
        self._threshold = threshold

    def forward(self, img, label):
        x = np.random.rand()
        if x < self._threshold:
            return self._transform(img, label)
        return img, label


class Depth(tv_tensors.Mask):
    pass


class ToRGBDTensorPair(torch.nn.Module):
    """Read segmentation mask from arrays or PIL images"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def forward(self, img, label):
        img = T.ToTensor()(img)
        if isinstance(label, Image.Image):
            label = Depth(label, dtype=torch.uint16)
        return img, label


# Add custom parameters to Resize and Rotate transforms for Depth (use Nearest interpolation)
# https://docs.pytorch.org/vision/master/auto_examples/transforms/plot_custom_tv_tensors.html


@v2.functional.register_kernel(functional="resize", tv_tensor_cls=Depth)
def depth_resize(my_dp, size):
    out = TF.resize(my_dp, size=size, interpolation=T.InterpolationMode.NEAREST, antialias=True)
    return tv_tensors.wrap(out, like=my_dp)


@v2.functional.register_kernel(functional="rotate", tv_tensor_cls=Depth)
def depth_rotate(my_dp, angle, *args, **kwargs):
    out = TF.rotate(my_dp, angle=angle, interpolation=T.InterpolationMode.NEAREST)
    return tv_tensors.wrap(out, like=my_dp)


def make_depth_train_transforms(
    *,
    normalization_constant: float = 1.0,
    rotation_angle: float = 2.5,
    interpolation=T.InterpolationMode.BILINEAR,
    img_size: int | tuple[int, int] | None = None,
    random_crop_size: tuple[int, int] | None = (352, 704),
    fixed_crop: str = "FULL",
    mean: tuple[float, float, float] = IMAGENET_DEFAULT_MEAN,
    std: tuple[float, float, float] = IMAGENET_DEFAULT_STD,
    brightness_range: tuple[float, float] = (0.9, 1.1),
):
    # Fixed geometric transforms
    transforms_list: list[Callable] = []
    transforms_list.append(FixedCrop(_FixedCropType(fixed_crop)))
    if img_size is not None:
        transforms_list.append(
            ResizeV2(
                img_size,
                image_interpolation=interpolation,
                label_interpolation=T.InterpolationMode.NEAREST,
                resize_label=True,
            )
        )

    # To (TV)tensor
    transforms_list.append(ToRGBDTensorPair())
    transforms_list.append(NormalizeDepth(normalization_constant))

    # Random geometric augmentations
    transforms_list.append(
        MaybeApply(
            v2.Compose(
                [
                    v2.RandomRotation(degrees=rotation_angle, interpolation=interpolation),
                ]
            ),
            threshold=0.5,
        )
    )
    transforms_list.append(v2.RandomHorizontalFlip())
    transforms_list.append(v2.RandomCrop(random_crop_size))

    # Random color augmentations
    transforms_list.append(ColorAugV2(prob=0.5, brightness_range=brightness_range))

    # Normalize image
    transforms_list.append(v2.Normalize(mean=mean, std=std))

    return v2.Compose(transforms_list)


def make_depth_eval_transforms(
    *,
    normalization_constant: float = 1.0,
    img_size: int | tuple[int, int] | None = None,
    image_interpolation: T.InterpolationMode = T.InterpolationMode.BILINEAR,
    mean: tuple[float, float, float] = IMAGENET_DEFAULT_MEAN,
    std: tuple[float, float, float] = IMAGENET_DEFAULT_STD,
    fixed_crop: str = "FULL",
    tta: bool = False,
):
    transforms_list: list[Callable] = []
    # Apply the fixed evaluation crop
    transforms_list.append(FixedCrop(fixed_crop))

    # Convert image and depth to tensors
    transforms_list.append(ToRGBDTensorPair())
    if img_size:
        # don't resize the label for evaluation
        transforms_list.append(ResizeV2(size=img_size, image_interpolation=image_interpolation, resize_label=False))

    # Normalize input image and depth
    transforms_list.append(v2.Normalize(mean=mean, std=std))
    transforms_list.append(NormalizeDepth(normalization_constant))
    transforms_list.append(LeftRightFlipAug(flip=tta))
    return v2.Compose(transforms_list)
