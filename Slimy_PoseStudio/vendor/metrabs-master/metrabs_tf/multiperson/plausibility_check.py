import posepile.datasets3d as ds3d
import simplepyutils as spu
import tensorflow as tf
from simplepyutils import FLAGS

from metrabs_tf import util3d


def is_pose_plausible(poses, joint_info):
    """Check poses for very basic plausibility, mainly to deal with false positive detections
    that don't yield a meaningful pose prediction.
    """
    mean_bones = (
        ds3d.get_dataset(FLAGS.bone_length_dataset).train_bones
        if FLAGS.bone_length_dataset
        else spu.load_pickle(FLAGS.bone_length_file))
    joint2bone_mat = util3d.get_joint2bone_mat(joint_info)
    bones = joint2bone_mat @ poses[..., :joint_info.n_joints, :]
    bone_lengths = tf.norm(bones, axis=-1)
    bone_length_relative = bone_lengths / mean_bones
    bone_length_diff = tf.abs(bone_lengths - mean_bones)

    relsmall = bone_length_relative < 0.1
    relbig = bone_length_relative > 3
    absdiffbig = bone_length_diff > 300
    is_implausible = tf.reduce_any(
        tf.logical_and(tf.logical_or(relbig, relsmall), absdiffbig), axis=-1)
    return tf.logical_not(is_implausible)


def pose_non_max_suppression(poses, scores, is_pose_valid):
    plausible_indices_single_frame = tf.squeeze(tf.where(is_pose_valid), 1)
    plausible_poses = tf.gather(poses, plausible_indices_single_frame)
    plausible_scores = tf.gather(scores, plausible_indices_single_frame)
    similarity_matrix = compute_pose_similarity(plausible_poses)
    nms_indices = tf.image.non_max_suppression_overlaps(
        overlaps=similarity_matrix, scores=plausible_scores,
        max_output_size=150, overlap_threshold=0.4)
    return tf.cast(tf.gather(plausible_indices_single_frame, nms_indices), tf.int32)


def are_augmentation_results_consistent(poses3d):
    """At least one fourth of the joints have a standard deviation under 200 mm"""
    n_joints = poses3d.shape[-2]
    stdevs = point_stdev(scale_align(poses3d), item_axis=1, coord_axis=-1)
    return tf.math.count_nonzero(stdevs < 200, axis=1) > (n_joints // 4)


def compute_pose_similarity(poses):
    # Pairwise scale align the poses before comparing them
    square_scales = tf.reduce_mean(tf.square(poses), axis=(-2, -1), keepdims=True)
    square_scales1 = tf.expand_dims(square_scales, 0)
    square_scales2 = tf.expand_dims(square_scales, 1)
    mean_square_scales = (square_scales1 + square_scales2) / 2
    scale_factor1 = tf.sqrt(mean_square_scales / square_scales1)
    scale_factor2 = tf.sqrt(mean_square_scales / square_scales2)

    poses1 = tf.expand_dims(poses, 0)
    poses2 = tf.expand_dims(poses, 1)

    dists = tf.linalg.norm(scale_factor1 * poses1 - scale_factor2 * poses2, axis=-1)
    best_dists = tf.math.top_k(dists, k=poses.shape[-2] // 4, sorted=False).values
    return tf.reduce_mean(tf.nn.relu(1 - best_dists / 300), axis=-1)


def is_pose_consistent_with_box(pose2d, box):
    """Check if pose prediction is consistent with the original box it was based on.
    Concretely, check if the intersection between the pose's bounding box and the detection has
    at least half the area of the detection box. This is like IoU but the denominator is the
    area of the detection box, so that truncated poses are handled correctly.
    """

    # Compute the bounding box around the 2D joints
    posebox_start = tf.reduce_min(pose2d, axis=-2)
    posebox_end = tf.reduce_max(pose2d, axis=-2)

    box_start = box[..., :2]
    box_end = box[..., :2] + box[..., 2:4]
    box_area = tf.reduce_prod(box[..., 2:4], axis=-1)

    intersection_start = tf.maximum(box_start, posebox_start)
    intersection_end = tf.minimum(box_end, posebox_end)
    intersection_area = tf.reduce_prod(tf.nn.relu(intersection_end - intersection_start), axis=-1)
    return intersection_area > 0.5 * box_area


def scale_align(poses):
    square_scales = tf.reduce_mean(tf.square(poses), axis=(-2, -1), keepdims=True)
    mean_square_scale = tf.reduce_mean(square_scales, axis=-3, keepdims=True)
    return poses * tf.sqrt(mean_square_scale / square_scales)


def point_stdev(poses, item_axis, coord_axis):
    coordwise_variance = tf.math.reduce_variance(poses, axis=item_axis, keepdims=True)
    average_stdev = tf.sqrt(tf.reduce_sum(coordwise_variance, axis=coord_axis, keepdims=True))
    return tf.squeeze(average_stdev, (item_axis, coord_axis))
