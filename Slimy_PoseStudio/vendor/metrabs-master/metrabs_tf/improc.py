import functools
import itertools

import PIL.Image
import cv2
import imageio
import numba
import numpy as np
import rlemasklib
import simplepyutils as spu
from simplepyutils.argparse import logger

from metrabs_tf import util


def resize_by_factor(im, factor, interp=None):
    """Returns a copy of `im` resized by `factor`, using bilinear interp for up and area interp
    for downscaling.
    """
    new_size = rounded_int_tuple([im.shape[1] * factor, im.shape[0] * factor])
    if interp is None:
        interp = cv2.INTER_LINEAR if factor > 1.0 else cv2.INTER_AREA
    return cv2.resize(im, new_size, fx=factor, fy=factor, interpolation=interp)


@functools.lru_cache()
def get_structuring_element(shape, ksize, anchor=None):
    if not isinstance(ksize, tuple):
        ksize = (ksize, ksize)
    return cv2.getStructuringElement(shape, ksize, anchor)


def rounded_int_tuple(p):
    return tuple(np.round(p).astype(int))


def image_extents(filepath):
    """Returns the image (width, height) as a numpy array, without loading the pixel data."""

    with PIL.Image.open(filepath) as im:
        return np.asarray(im.size)


def video_extents(filepath):
    """Returns the video (width, height) as a numpy array, without loading the pixel data."""

    with imageio.get_reader(filepath, 'ffmpeg') as reader:
        return np.asarray(reader.get_meta_data()['source_size'])


def video_fps(filepath):
    with imageio.get_reader(filepath) as reader:
        return reader.get_meta_data()['fps']


def rectangle(im, pt1, pt2, color, thickness):
    cv2.rectangle(im, rounded_int_tuple(pt1), rounded_int_tuple(pt2), color, thickness)


def line(im, p1, p2, *args, **kwargs):
    if np.asarray(p1).shape[-1] != 2 or np.asarray(p2).shape[-1] != 2:
        raise Exception('Wrong dimensionality of point in line drawing')

    try:
        cv2.line(im, rounded_int_tuple(p1), rounded_int_tuple(p2), *args, **kwargs)
    except OverflowError:
        logger.warning('Overflow in rounded_int_tuple!')


def draw_box(im, box, color=(255, 0, 0), thickness=5):
    box = np.array(box)
    rectangle(im, box[:2], box[:2] + box[2:4], color, thickness)


def circle(im, center, radius, *args, **kwargs):
    cv2.circle(im, rounded_int_tuple(center), np.round(radius).astype(int), *args, **kwargs)


def draw_stick_figure(
        im, coords, joint_info, thickness=3, brightness_increase=0, color=None, joint_dots=True,
        inplace=False):
    factor = 255 if np.issubdtype(im.dtype, np.floating) else 1
    if factor != 255 or not inplace:
        result_image = (im * factor).astype(np.uint8).copy()
        result_image = np.clip(
            result_image.astype(np.float32) + brightness_increase, 0, 255).astype(np.uint8)
    else:
        result_image = im

    if color is None:
        colors = util.cycle_over_colors()
    else:
        colors = itertools.repeat(color)

    for color, (i_joint1, i_joint2) in zip(colors, joint_info.stick_figure_edges):
        relevant_coords = coords[[i_joint1, i_joint2]]
        if not np.isnan(relevant_coords).any() and not np.isclose(0, relevant_coords).any():
            line(
                result_image, coords[i_joint1], coords[i_joint2], color=color, thickness=thickness,
                lineType=cv2.LINE_AA)

    if joint_dots:
        for i_joint, joint_name in enumerate(joint_info.names):
            if not np.isnan(coords[i_joint]).any():
                circle(
                    result_image, coords[i_joint], thickness * 1.2, color=(255, 0, 0),
                    thickness=cv2.FILLED)

    return result_image


def normalize01(im, dst=None):
    if dst is None:
        result = np.empty_like(im, dtype=np.float32)
    else:
        result = dst
    result[:] = im.astype(np.float32) / np.float32(255)
    np.clip(result, np.float32(0), np.float32(1), out=result)
    return result


@numba.jit(nopython=True)
def blend_image_numba(im1, im2, im2_weight):
    return im1 * (1 - im2_weight) + im2 * im2_weight


use_libjpeg_turbo = True
if use_libjpeg_turbo:
    import jpeg4py


    def _imread(path, dst=None):
        lower = path.lower()
        if not (lower.endswith('.jpg') or lower.endswith('.jpeg')):
            return cv2.imread(path)[..., ::-1]
        try:
            return jpeg4py.JPEG(path).decode(dst)
        except jpeg4py.JPEGRuntimeError:
            logger.error(f'Could not load image at {path}, JPEG error.')
            raise
else:
    def _imread(path, dst=None):
        assert dst is None
        return imageio.v3.imread(path)


def imread(path, dst=None):
    if isinstance(path, bytes):
        path = path.decode('utf8')
    elif isinstance(path, np.str_):
        path = str(path)

    path = util.ensure_absolute_path(path)
    return _imread(path, dst)[..., :3]


@numba.jit(nopython=True)
def paste_over(im_src, im_dst, alpha, center, inplace=False):
    """Pastes `im_src` onto `im_dst` at a specified position, with alpha blending.

    The resulting image has the same shape as `im_dst` but contains `im_src`
    (perhaps only partially, if it's put near the border).
    Locations outside the bounds of `im_dst` are handled as expected
    (only a part or none of `im_src` becomes visible).

    Args:
        im_src: The image to be pasted onto `im_dst`. Its size can be arbitrary.
        im_dst: The target image.
        alpha: A float (0.0-1.0) image of the same size as `im_src` controlling the alpha blending
            at each pixel. Large values mean more visibility for `im_src`.
        center: coordinates in `im_dst` where the center of `im_src` should be placed.

    Returns:
        An image of the same shape as `im_dst`, with `im_src` pasted onto it.
    """

    width_height_src = np.array([im_src.shape[1], im_src.shape[0]], dtype=np.int32)
    width_height_dst = np.array([im_dst.shape[1], im_dst.shape[0]], dtype=np.int32)

    center_float = center.astype(np.float32)
    np.round(center_float, 0, center_float)
    center_int = center_float.astype(np.int32)
    ideal_start_dst = center_int - width_height_src // np.int32(2)
    ideal_end_dst = ideal_start_dst + width_height_src

    zeros = np.zeros_like(ideal_start_dst)
    start_dst = np.minimum(np.maximum(ideal_start_dst, zeros), width_height_dst)
    end_dst = np.minimum(np.maximum(ideal_end_dst, zeros), width_height_dst)

    if inplace:
        result = im_dst
    else:
        result = im_dst.copy()

    region_dst = result[start_dst[1]:end_dst[1], start_dst[0]:end_dst[0]]

    start_src = start_dst - ideal_start_dst
    end_src = width_height_src + (end_dst - ideal_end_dst)

    alpha_expanded = np.expand_dims(alpha, -1)
    alpha_expanded = alpha_expanded[start_src[1]:end_src[1], start_src[0]:end_src[0]]

    region_src = im_src[start_src[1]:end_src[1], start_src[0]:end_src[0]]

    result[start_dst[1]:end_dst[1], start_dst[0]:end_dst[0]] = (
        (alpha_expanded * region_src + (1 - alpha_expanded) * region_dst)).astype(np.uint8)
    return result


def adjust_gamma(image, gamma, inplace=False):
    if inplace:
        cv2.LUT(image, get_gamma_lookup_table(gamma), dst=image)
        return image

    return cv2.LUT(image, get_gamma_lookup_table(gamma))


@functools.lru_cache()
def get_gamma_lookup_table(gamma):
    return (np.linspace(0, 1, 256) ** gamma * 255).astype(np.uint8)


def blend_image(im1, im2, im2_weight):
    if im2_weight.ndim == im1.ndim - 1:
        im2_weight = im2_weight[..., np.newaxis]

    return blend_image_numba(
        im1.astype(np.float32),
        im2.astype(np.float32),
        im2_weight.astype(np.float32)).astype(im1.dtype)


@numba.jit(nopython=True)
def blend_image_numba(im1, im2, im2_weight):
    return im1 * (1 - im2_weight) + im2 * im2_weight


def is_image_readable(path):
    try:
        imread(path)
        return True
    except Exception:
        return False


def white_balance(img, a=None, b=None):
    result = cv2.cvtColor(img, cv2.COLOR_RGB2LAB)
    avg_a = a if a is not None else np.mean(result[..., 1])
    avg_b = b if b is not None else np.mean(result[..., 2])
    result[..., 1] = result[..., 1] - ((avg_a - 128) * (result[..., 0] / 255.0) * 1.1)
    result[..., 2] = result[..., 2] - ((avg_b - 128) * (result[..., 0] / 255.0) * 1.1)
    result = cv2.cvtColor(result, cv2.COLOR_LAB2RGB)
    return result


def largest_connected_component(mask):
    mask = mask.astype(np.uint8)
    n_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, 4, cv2.CV_32S)
    areas = stats[1:, -1]
    if len(areas) < 1:
        return mask, np.array([0, 0, 0, 0])

    largest_area_label = 1 + np.argsort(areas)[-1]
    obj_mask = np.uint8(labels == largest_area_label)
    obj_box = stats[largest_area_label, :4]

    return obj_mask, np.array(obj_box)


def transform_video(inp_path, out_path, process_frame_fn, **kwargs):
    spu.ensure_parent_dir_exists(out_path)
    with imageio.get_reader(inp_path) as reader:
        fps = reader.get_meta_data()['fps']
        n_frames = num_frames_of_video(inp_path)
        with imageio.get_writer(out_path, fps=fps, codec='h264', **kwargs) as writer:
            for frame in spu.progressbar(reader, total=n_frames):
                writer.append_data(process_frame_fn(frame))


def num_frames_of_video(path):
    with imageio.get_reader(path) as vid:
        return vid.get_meta_data()['nframes']


def mask_iou(mask1, mask2):
    union = np.count_nonzero(np.logical_or(mask1, mask2))
    if union == 0:
        return 0
    intersection = np.count_nonzero(np.logical_and(mask1, mask2))
    return intersection / union


def erode(mask, kernel_size, iterations=1):
    elem = get_structuring_element(cv2.MORPH_ELLIPSE, kernel_size)
    return cv2.morphologyEx(mask, cv2.MORPH_ERODE, elem, iterations=iterations)


def dilate(mask, kernel_size, iterations=1):
    elem = get_structuring_element(cv2.MORPH_ELLIPSE, kernel_size)
    return cv2.morphologyEx(mask, cv2.MORPH_DILATE, elem, iterations=iterations)


def masks_to_label_map(masks):
    h, w = masks.shape[1:3]
    final_mask = np.zeros([h, w], np.uint8)
    i_instance = 1
    for mask in masks:
        final_mask[mask > 0.5] = i_instance
        i_instance += 1
    return final_mask


def outline(mask, d1=1, d2=3):
    return dilate(mask, d2) - dilate(mask, d1)


def fill_polygon(img, pts, color):
    pts = pts.reshape((-1, 1, 2))
    pts = np.round(pts).astype(np.int32)
    cv2.fillPoly(img, [pts], color)


def resize_mask(mask_encoded, new_imshape):
    mask = rlemasklib.decode(mask_encoded) * 255
    mask = cv2.resize(mask, (new_imshape[1], new_imshape[0]))
    mask = (mask > 127).astype(np.uint8)
    return rlemasklib.encode(mask)


def get_inline(mask, d1=1, d2=3):
    if mask.dtype == np.bool:
        return get_inline(mask.astype(np.uint8), d1, d2).astype(np.bool)
    return erode(mask, d1) - erode(mask, d2)


def draw_mask(img, mask, mask_color, draw_outline=True):
    imcolor = img[mask > 0].astype(np.float64)
    img[mask > 0] = np.clip(mask_color * 0.3 + imcolor * 0.7, 0, 255).astype(np.uint8)

    if draw_outline:
        outline = get_inline(mask > 0, 1, 5)
        img[outline] = mask_color


def video_audio_mux(vidpath_audiosource, vidpath_imagesource, out_video_path):
    import ffmpeg
    video = ffmpeg.input(vidpath_imagesource).video
    audio = ffmpeg.input(vidpath_audiosource).audio
    ffmpeg.output(audio, video, out_video_path, vcodec='copy', acodec='copy').run()
