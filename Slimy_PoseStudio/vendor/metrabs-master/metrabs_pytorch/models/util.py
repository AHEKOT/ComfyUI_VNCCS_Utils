import torch
from metrabs_pytorch.util import get_config
from metrabs_pytorch import ptu


def heatmap_to_image(coords, is_training):
    FLAGS = get_config()
    stride = FLAGS.stride_train if is_training else FLAGS.stride_test

    last_image_pixel = FLAGS.proc_side - 1
    last_receptive_center = last_image_pixel - (last_image_pixel % stride)
    coords_out = coords * last_receptive_center

    if FLAGS.centered_stride:
        coords_out = coords_out + stride // 2

    if FLAGS.legacy_centered_stride_bug:
        coords_out = coords_out + stride // 2

    return coords_out


def heatmap_to_25d(coords, is_training):
    FLAGS = get_config()
    coords2d = heatmap_to_image(coords[..., :2], is_training)
    return torch.cat([coords2d, coords[..., 2:] * FLAGS.box_size_mm], dim=-1)


def heatmap_to_metric(coords, is_training):
    FLAGS = get_config()
    coords2d = heatmap_to_image(
        coords[..., :2], is_training) * FLAGS.box_size_mm / FLAGS.proc_side
    return torch.cat([coords2d, coords[..., 2:] * FLAGS.box_size_mm], dim=-1)


def align_2d_skeletons(coords_pred, coords_true, joint_validity_mask):
    mean_pred, stdev_pred = ptu.mean_stdev_masked(
        coords_pred, joint_validity_mask, items_dim=1, dimensions_dim=2)
    mean_true, stdev_true = ptu.mean_stdev_masked(
        coords_true, joint_validity_mask, items_dim=1, dimensions_dim=2)
    return torch.nan_to_num(
        (coords_pred - mean_pred) / stdev_pred) * stdev_true + mean_true
