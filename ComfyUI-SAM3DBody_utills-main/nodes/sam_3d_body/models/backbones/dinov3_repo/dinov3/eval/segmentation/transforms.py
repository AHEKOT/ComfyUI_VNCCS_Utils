# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed in accordance with
# the terms of the DINOv3 License Agreement.

import numpy as np
from PIL import Image
from typing import Any, List, Optional, Sequence, Tuple, Union

import torch
import torch.nn.functional as F
from torchvision import transforms as T
from torchvision.transforms import functional as Fv
from torchvision.transforms import v2
from torchvision.tv_tensors import Mask

from dinov3.data.transforms import IMAGENET_DEFAULT_MEAN, IMAGENET_DEFAULT_STD, make_normalize_transform
from dinov3.eval.segmentation.metrics import preprocess_nonzero_labels


class PhotoMetricDistortion(torch.nn.Module):
    """Apply photometric distortion to image sequentially, every transformation
    is applied with a probability of 0.5.
    1. random brightness
    2. random contrast (mode 0)
    3. convert color from BGR to HSV
    4. random saturation
    5. random hue
    6. convert color from HSV to BGR
    7. random contrast (mode 1)
    Args:
        brightness_delta (int): delta of brightness.
        contrast_range (tuple): range of contrast.
        saturation_range (tuple): range of saturation.
        hue_delta (int): delta of hue.
    """

    def __init__(
        self,
        brightness_delta: int = 32,
        contrast_range: Sequence[float] = (0.5, 1.5),
        saturation_range: Sequence[float] = (0.5, 1.5),
        hue_range: Sequence[float] = (-0.5, 0.5),
    ):
        super().__init__()
        self.brightness_delta = brightness_delta
        self.contrast_lower, self.contrast_upper = contrast_range
        self.saturation_lower, self.saturation_upper = saturation_range
        self.hue_lower, self.hue_upper = hue_range

    def convert(self, img: np.ndarray, alpha: float = 1.0, beta: float = 0.0) -> np.ndarray:
        """Multiple with alpha and add beat with clip."""
        img = img.astype(np.float32) * alpha + beta
        img = np.clip(img, 0, 255)
        return img.astype(np.uint8)

    def brightness(self, img: np.ndarray) -> np.ndarray:
        if np.random.randint(2):
            return self.convert(img, beta=np.random.uniform(-self.brightness_delta, self.brightness_delta))
        return img

    def contrast(self, img: np.ndarray) -> np.ndarray:
        if np.random.randint(2):
            return self.convert(img, alpha=np.random.uniform(self.contrast_lower, self.contrast_upper))
        return img

    def saturation(self, img: np.ndarray) -> np.ndarray:
        if np.random.randint(2):
            saturation_factor = np.random.uniform(self.saturation_lower, self.saturation_upper)
            img_tensor = torch.tensor(img.astype(np.uint8)).permute((2, 0, 1))
            img_tensor = Fv.adjust_saturation(img_tensor, saturation_factor)
            img = img_tensor.permute((1, 2, 0)).numpy()
        return img

    def hue(self, img: np.ndarray) -> np.ndarray:
        if np.random.randint(2):
            hue_factor = np.random.uniform(self.hue_lower, self.hue_upper)
            img_tensor = torch.tensor(img.astype(np.uint8)).permute((2, 0, 1))
            img_tensor = Fv.adjust_hue(img_tensor, hue_factor)
            img = img_tensor.permute((1, 2, 0)).numpy()
        return img

    def forward(self, img, label) -> Tuple[torch.Tensor, Any]:
        """Transform function to perform photometric distortion on images."""
        # Operations need numpy arrays
        img = img.permute((1, 2, 0)).numpy()
        # random brightness
        img = self.brightness(img)
        # mode == 0 --> do random contrast first
        # mode == 1 --> do random contrast last
        mode = np.random.randint(2)
        if mode == 1:
            img = self.contrast(img)
        # random saturation
        img = self.saturation(img)
        # random hue
        img = self.hue(img)
        # random contrast
        if mode == 0:
            img = self.contrast(img)
        return torch.tensor(img.astype(np.float32)).permute((2, 0, 1)), label


class ReduceZeroLabel(torch.nn.Module):
    """Operation on the labels when class 0 is to be ignored."""

    def __init__(self, ignore_index=255):
        super().__init__()
        self.ignore_index = ignore_index

    def forward(self, img, label):
        label = preprocess_nonzero_labels(label, ignore_index=self.ignore_index)
        return img, label


class MaybeApplyImageLabel(torch.nn.Module):
    """Apply a given operation on both image and label
    given a probability threshold.
    Args:
        _transform (torchvision.transforms): type of transform to apply.
            Since this transform is applied on both image and label,
            it has to be deterministic (e.g. horizontal flip, non-random crop).
        _threshold (float): probability of applying the above transform."""

    def __init__(self, transform, threshold: float = 0.5):
        super().__init__()
        self._transform = transform
        self._threshold = threshold

    def __call__(self, img, label):
        x = np.random.rand()
        if x < self._threshold:
            return self._transform(img), self._transform(label)
        return img, label


class FixedSideResize:
    """Resize an image, given a fixed value for the small side.
    Args:
        small_size (int): small size to resize an image to.
            example: if small_size = 512, an image of size (300, 400) will be resized to (512, 683)
        image_interpolation (T.InterpolationMode): Interpolation mode when resizing a given image.
        label_interpolation (T.InterpolationMode): Interpolation mode when resizing a given label.
        random_img_size_ratio_range (tuple(min, max)): If used, for a given image, a random ratio
            between the range is used to multiply to `small_size` for resizing
        inference_mode (str): Dataset inference mode.
            If value is "whole", resize both image and label for a single prediction on the resized image.
            If value is "slide", resize image, do sliding inference on it, then scale it back to the
            original image size for final prediction - the label doesn't need to be resized.
    Returns:
        image, label (PIL.Image, tensor.Tensor): resized image and label
    """

    def __init__(
        self,
        small_size,
        image_interpolation,
        label_interpolation,
        random_img_size_ratio_range=None,
        inference_mode="whole",
        use_tta=False,
        tta_img_size_ratio_range=[1.0],
    ):
        self.small_size = small_size
        self.image_interpolation = image_interpolation
        self.label_interpolation = label_interpolation
        self.random_img_size_ratio_range = random_img_size_ratio_range
        self.inference_mode = inference_mode
        self.use_tta = use_tta
        self.tta_img_size_ratio_range = tta_img_size_ratio_range

    def _random_sample_ratio(self):
        min_ratio, max_ratio = self.random_img_size_ratio_range
        ratio = np.random.random_sample() * (max_ratio - min_ratio) + min_ratio
        return int(self.small_size * ratio)

    def _resize(self, img, label, small_size):
        init_width, init_height = img.size
        if init_height > init_width:
            new_width = small_size
            new_height = int(small_size * init_height / init_width + 0.5)
        else:
            new_height = small_size
            new_width = int(small_size * init_width / init_height + 0.5)

        img = T.Resize(size=(new_height, new_width), interpolation=self.image_interpolation)(img)
        if self.inference_mode == "whole":
            label = T.Resize(size=(new_height, new_width), interpolation=self.label_interpolation)(label)
        return img, label

    def __call__(self, img, label):
        if not self.use_tta:
            small_size = self.small_size
            if self.random_img_size_ratio_range:
                small_size = self._random_sample_ratio()
            return self._resize(img, label, small_size)

        tta_img_list = []  # Used only if TTA
        for tta_ratio in self.tta_img_size_ratio_range:
            tta_size = int(self.small_size * tta_ratio)
            if tta_ratio < 1:
                tta_size = int(np.ceil(tta_size / 32)) * 32
            tta_img, _ = self._resize(img, label, tta_size)
            tta_img_list.append(tta_img)
        return tta_img_list, label


class ResizeV2:
    """
    Resize both image and label using different interpolation modes.
    """

    def __init__(self, size, image_interpolation, label_interpolation):
        self.size = size
        self.image_interpolation = image_interpolation
        self.label_interpolation = label_interpolation

    def __call__(self, img, label):
        img = T.Resize(size=self.size, interpolation=self.image_interpolation)(img)
        label = T.Resize(size=self.size, interpolation=self.label_interpolation)(label)
        return img, label


class CustomResize(torch.nn.Module):
    def __init__(
        self,
        img_resize,
        image_interpolation,
        label_interpolation,
        random_img_size_ratio_range=None,
        inference_mode="whole",
        use_tta=False,
        tta_img_size_ratio_range=[1.0],
    ):
        super().__init__()
        if isinstance(img_resize, int):
            self.resize_function = FixedSideResize(
                small_size=img_resize,
                image_interpolation=image_interpolation,
                label_interpolation=label_interpolation,
                random_img_size_ratio_range=random_img_size_ratio_range,
                inference_mode=inference_mode,
                use_tta=use_tta,
                tta_img_size_ratio_range=tta_img_size_ratio_range,
            )
        else:
            self.resize_function = ResizeV2(
                size=img_resize,
                image_interpolation=image_interpolation,
                label_interpolation=label_interpolation,
            )

    def forward(self, img, label):
        return self.resize_function(img, label)


class RandomCropWithLabel(torch.nn.Module):
    """Randomly crop the image & segmentation label.
    Args:
        crop_size (tuple(h, w)): Expected size after cropping.
        cat_max_ratio (float): The maximum ratio that a single category could
            occupy in the cropped image. Default value is 0.75.
        ignore_index (int): Index to ignore when measuring the category ratio
            in a cropped image
    Returns:
        cropped_img (torch.Tensor), Optional[crop_bbox](tuple)
    """

    def __init__(self, crop_size, cat_max_ratio=0.75, ignore_index=255):
        super().__init__()
        assert crop_size[0] > 0 and crop_size[1] > 0
        self.crop_size = crop_size
        self.cat_max_ratio = cat_max_ratio
        self.ignore_index = ignore_index

    def get_crop_bbox(self, img):
        """Randomly get a crop bounding box."""
        margin_h = max(img.shape[-2] - self.crop_size[0], 0)
        margin_w = max(img.shape[-1] - self.crop_size[1], 0)
        offset_h = np.random.randint(0, margin_h + 1)
        offset_w = np.random.randint(0, margin_w + 1)
        crop_y1, crop_y2 = offset_h, offset_h + self.crop_size[0]
        crop_x1, crop_x2 = offset_w, offset_w + self.crop_size[1]

        return crop_y1, crop_y2, crop_x1, crop_x2

    def crop(self, img, crop_bbox):
        """Crop given a crop bounding box"""
        crop_y1, crop_y2, crop_x1, crop_x2 = crop_bbox
        img = img[:, crop_y1:crop_y2, crop_x1:crop_x2]
        return img

    def forward(self, img, label):
        """Find an adequate crop for a given image and crop it"""
        # Create a random crop_bbox
        new_crop_bbox = self.get_crop_bbox(img)
        if self.cat_max_ratio < 1.0:
            # Check that the ratio of label_counts / nb_pixels created
            # with the random crop_bbox is under `cat_max_ratio`
            # Repeat until 10 times to find a good crop_bbox
            for _ in range(10):
                seg_temp = self.crop(label, new_crop_bbox)
                labels, cnt = np.unique(seg_temp, return_counts=True)
                cnt = cnt[labels != self.ignore_index]
                if len(cnt) > 1 and np.max(cnt) / np.sum(cnt) < self.cat_max_ratio:
                    break
                new_crop_bbox = self.get_crop_bbox(img)

        return self.crop(img, new_crop_bbox), self.crop(label, new_crop_bbox)


class HorizontalFlipAug(torch.nn.Module):
    def forward(self, img_list, label):
        """Call function to apply test time augment transforms on results.

        Args:
            img (PIL image | torch.Tensor | List[PIL image]): Data to transform.

        Returns:
            list: A list of augmented data.
        """
        if isinstance(img_list, Image.Image):
            img_list = [img_list]
        augmented_img_list = [Fv.hflip(img) for img in img_list]
        img_list.extend(augmented_img_list)
        return img_list, label

    def inverse(self, stacked_left_right_pair):
        pre_aug_batch_size = len(stacked_left_right_pair) // 2
        assert pre_aug_batch_size * 2 == len(stacked_left_right_pair)
        orig_img_list = stacked_left_right_pair[:pre_aug_batch_size]
        orig_img_list.extend([Fv.hflip(img) for img in stacked_left_right_pair[pre_aug_batch_size:]])
        return orig_img_list


class PadTensor(torch.nn.Module):
    """Pad a given tensor to the desired shape"""

    def __init__(self, pad_shape=[512, 512], img_pad_value=0, label_pad_value=255):
        super().__init__()
        self.pad_shape = pad_shape
        self.img_pad_value = img_pad_value
        self.label_pad_value = label_pad_value

    def forward(self, img, label):
        h, w = img.shape[-2:]
        new_h, new_w = self.pad_shape[0] - h, self.pad_shape[1] - w
        img = F.pad(input=img, pad=(0, new_w, 0, new_h), mode="constant", value=self.img_pad_value)
        label = F.pad(input=label, pad=(0, new_w, 0, new_h), mode="constant", value=self.label_pad_value)
        return img, label


class NormalizeImage(torch.nn.Module):
    def __init__(self, mean, std):
        super().__init__()
        self.normalize_function = make_normalize_transform(mean=mean, std=std)

    def forward(self, img, label):
        return self.normalize_function(img.float()), label


class TransformImages(torch.nn.Module):
    """Given a list of operations, apply them on a tensor or a list of transforms.
    Transforms apply on images. Always return a list of tensors for coherent output format.
    Args:
        _transform (List[torchvision.transforms]): transforms to apply.
    """

    def __init__(self, transforms):
        super().__init__()
        self._transforms = transforms

    def forward(self, img, label):
        if isinstance(img, (torch.Tensor, Image.Image)):
            img = [img]
        for transform in self._transforms:
            # only apply transforms on the augmented images
            img = [transform(im, label)[0] for im in img]
        return img, label


class MaskToTensor(torch.nn.Module):
    """Read segmentation mask from arrays or PIL images"""

    def forward(self, img, label):
        if isinstance(label, np.ndarray):
            return img, Mask(label).permute(2, 0, 1)
        return img, Mask(label)


def make_segmentation_train_transforms(
    *,
    img_size: Optional[Union[List[int], int]] = None,
    image_interpolation: T.InterpolationMode = T.InterpolationMode.BILINEAR,
    label_interpolation: T.InterpolationMode = T.InterpolationMode.NEAREST,
    random_img_size_ratio_range: Optional[List[float]] = None,
    crop_size: Optional[Tuple[int]] = None,
    flip_prob: float = 0.0,
    reduce_zero_label: bool = False,
    mean: Sequence[float] = [mean * 255 for mean in IMAGENET_DEFAULT_MEAN],
    std: Sequence[float] = [std * 255 for std in IMAGENET_DEFAULT_STD],
):
    # Label conversion to tensor
    transforms_list = [MaskToTensor()]  # type: List[Any]
    # Resizing
    if img_size is not None:
        transforms_list.append(
            CustomResize(
                img_resize=img_size,
                image_interpolation=image_interpolation,
                label_interpolation=label_interpolation,
                inference_mode="whole",  # when training, always resize image + label
                random_img_size_ratio_range=random_img_size_ratio_range,
            )
        )
    # Conversion to torch.Tensor
    transforms_list.extend([v2.PILToTensor()])

    # Reducing zero labels
    if reduce_zero_label:
        transforms_list.append(ReduceZeroLabel())

    # Random crop
    if crop_size:
        transforms_list.append(RandomCropWithLabel(crop_size=crop_size))

    # Rest of the image and label-specific transforms
    transforms_list.extend(
        [
            MaybeApplyImageLabel(transform=Fv.hflip, threshold=flip_prob),
            PhotoMetricDistortion(),
            NormalizeImage(mean=mean, std=std),
        ]
    )

    # Pad if cropping was done previously
    if crop_size:
        transforms_list.append(PadTensor(pad_shape=crop_size, img_pad_value=0, label_pad_value=255))

    return v2.Compose(transforms_list)


def make_segmentation_eval_transforms(
    *,
    img_size: Optional[Union[List[int], int]] = None,
    inference_mode: str = "whole",
    image_interpolation: T.InterpolationMode = T.InterpolationMode.BILINEAR,
    label_interpolation: T.InterpolationMode = T.InterpolationMode.NEAREST,
    use_tta: bool = False,
    tta_ratios: Sequence[float] = [1.0],
    mean: Sequence[float] = [mean * 255 for mean in IMAGENET_DEFAULT_MEAN],
    std: Sequence[float] = [std * 255 for std in IMAGENET_DEFAULT_STD],
):
    # Label conversion to tensor
    transforms_list = [MaskToTensor()]  # type: List[Any]
    # Optional resizing
    if img_size is not None:
        transforms_list.append(
            CustomResize(
                img_resize=img_size,
                image_interpolation=image_interpolation,
                label_interpolation=label_interpolation,
                inference_mode=inference_mode,
                use_tta=use_tta,
                tta_img_size_ratio_range=tta_ratios,
            )
        )

    if use_tta:
        transforms_list.append(HorizontalFlipAug())
    # Always return a list of tensors for prediction at evaluation time
    transforms_list.append(TransformImages(transforms=[v2.PILToTensor(), NormalizeImage(mean=mean, std=std)]))

    return v2.Compose(transforms_list)
