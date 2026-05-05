import cv2
import numpy as np


def augment_color(im, rng, out_dtype=None):
    if out_dtype is None:
        out_dtype = im.dtype

    if im.dtype == np.uint8:
        result = np.empty_like(im, dtype=np.float32)
        cv2.divide(im, (255, 255, 255, 255), dst=result, dtype=cv2.CV_32F)
        im = result

    augmentation_functions = [augment_brightness, augment_contrast, augment_hue, augment_saturation]
    rng.shuffle(augmentation_functions)

    colorspace = 'rgb'
    for fn in augmentation_functions:
        colorspace = fn(im, colorspace, rng)

    if colorspace != 'rgb':
        cv2.cvtColor(im, cv2.COLOR_HSV2RGB, dst=im)

    np.clip(im, 0, 1, out=im)

    if out_dtype == np.uint8:
        return (im * 255).astype(np.uint8)
    else:
        return im


def augment_brightness(im, in_colorspace, rng):
    if in_colorspace != 'rgb':
        cv2.cvtColor(im, cv2.COLOR_HSV2RGB, dst=im)

    im += rng.uniform(-0.125, 0.125)
    return 'rgb'


def augment_contrast(im, in_colorspace, rng):
    if in_colorspace != 'rgb':
        cv2.cvtColor(im, cv2.COLOR_HSV2RGB, dst=im)
    im -= 0.5
    im *= rng.uniform(0.5, 1.5)
    im += 0.5
    return 'rgb'


def augment_hue(im, in_colorspace, rng):
    if in_colorspace != 'hsv':
        np.clip(im, 0, 1, out=im)
        cv2.cvtColor(im, cv2.COLOR_RGB2HSV, dst=im)
    hue = im[:, :, 0]
    hue += rng.uniform(-72, 72)
    hue[hue < 0] += 360
    hue[hue > 360] -= 360
    return 'hsv'


def augment_saturation(im, in_colorspace, rng):
    if in_colorspace != 'hsv':
        np.clip(im, 0, 1, out=im)
        cv2.cvtColor(im, cv2.COLOR_RGB2HSV, dst=im)

    saturation = im[:, :, 1]
    saturation *= rng.uniform(0.5, 1.5)
    saturation[saturation > 1] = 1
    return 'hsv'
