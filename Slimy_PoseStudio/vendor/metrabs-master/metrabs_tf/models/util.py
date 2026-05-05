import posepile.datasets3d as ds3d
import tensorflow as tf
from simplepyutils import FLAGS

from metrabs_tf import tfu


def heatmap_to_image(coords, is_training):
    stride = FLAGS.stride_train if is_training else FLAGS.stride_test

    last_image_pixel = FLAGS.proc_side - 1
    last_receptive_center = last_image_pixel - (last_image_pixel % stride)
    coords_out = coords * last_receptive_center

    if FLAGS.centered_stride:
        coords_out = coords_out + stride // 2

    return coords_out


def heatmap_to_25d(coords, is_training):
    coords2d = heatmap_to_image(coords[..., :2], is_training)
    return tf.concat([coords2d, coords[..., 2:] * FLAGS.box_size_mm], axis=-1)


def heatmap_to_metric(coords, is_training):
    coords2d = heatmap_to_image(
        coords[..., :2], is_training) * FLAGS.box_size_mm / FLAGS.proc_side
    return tf.concat([coords2d, coords[..., 2:] * FLAGS.box_size_mm], axis=-1)


def align_2d_skeletons(coords_pred, coords_true, joint_validity_mask):
    mean_pred, stdev_pred = tfu.mean_stdev_masked(
        coords_pred, joint_validity_mask, items_axis=1, dimensions_axis=2)
    mean_true, stdev_true = tfu.mean_stdev_masked(
        coords_true, joint_validity_mask, items_axis=1, dimensions_axis=2)
    return tf.math.divide_no_nan(
        coords_pred - mean_pred, stdev_pred) * stdev_true + mean_true


def select_skeleton(coords_src, joint_info_src, skeleton_type_dst):
    if skeleton_type_dst == '':
        return coords_src

    def get_index(name):
        if name + '_' + skeleton_type_dst in joint_info_src.names:
            return joint_info_src.names.index(name + '_h36m')
        else:
            return joint_info_src.names.index(name)

    joint_info_dst = ds3d.get_joint_info(skeleton_type_dst)
    selected_indices = [get_index(name) for name in joint_info_dst.names]
    return tf.gather(coords_src, selected_indices, axis=-2)
