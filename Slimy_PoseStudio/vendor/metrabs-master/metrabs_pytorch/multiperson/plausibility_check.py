import posepile.datasets3d as ds3d
import posepile.joint_info
import simplepyutils as spu
import torch
from simplepyutils import FLAGS


def is_pose_plausible(poses, joint_info):
    """Check poses for very basic plausibility, mainly to deal with false positive detections
    that don't yield a meaningful pose prediction.
    """
    mean_bones = (
        ds3d.get_dataset(FLAGS.bone_length_dataset).train_bones
        if FLAGS.bone_length_dataset
        else spu.load_pickle(FLAGS.bone_length_file))
    joint2bone_mat = posepile.joint_info.get_joint2bone_mat(joint_info)
    bones = joint2bone_mat @ poses[..., :joint_info.n_joints, :]
    bone_lengths = torch.norm(bones, dim=-1)
    bone_length_relative = bone_lengths / mean_bones
    bone_length_diff = torch.abs(bone_lengths - mean_bones)

    relsmall = bone_length_relative < 0.1
    relbig = bone_length_relative > 3
    absdiffbig = bone_length_diff > 300
    is_implausible = torch.any(
        torch.logical_and(torch.logical_or(relbig, relsmall), absdiffbig), dim=-1)
    return torch.logical_not(is_implausible)


def non_max_suppression_overlaps(overlaps, scores, overlap_threshold):
    n_items = len(overlaps)

    if n_items == 0:
        pass
    order = torch.argsort(scores, stable=True, dim=0, descending=True)
    is_suppressed = torch.zeros(size=[n_items], dtype=torch.bool)

    for _i in range(n_items):
        i = order[_i]
        if is_suppressed[i]:
            continue

        for _j in range(_i + 1, n_items):
            j = order[_j]
            if is_suppressed[j]:
                continue

            if overlaps[i, j] > overlap_threshold:
                is_suppressed[j] = True

    return torch.squeeze(torch.argwhere(torch.logical_not(is_suppressed)), 1)


def pose_non_max_suppression(poses, scores, is_pose_valid):
    plausible_indices_single_frame = torch.squeeze(torch.argwhere(is_pose_valid), 1)
    plausible_poses = poses[plausible_indices_single_frame]
    plausible_scores = scores[plausible_indices_single_frame]
    similarity_matrix = compute_pose_similarity(plausible_poses)
    nms_indices = non_max_suppression_overlaps(
        overlaps=similarity_matrix, scores=plausible_scores,
        overlap_threshold=0.4)
    return plausible_indices_single_frame[nms_indices]


def are_augmentation_results_consistent(poses3d):
    """At least one fourth of the joints have a standard deviation under 200 mm"""
    n_joints = poses3d.shape[-2]
    stdevs = point_stdev(scale_align(poses3d), item_dim=1, coord_dim=-1)
    return torch.count_nonzero(stdevs < 200, dim=1) > (n_joints // 4)


def compute_pose_similarity(poses):
    # Pairwise scale align the poses before comparing them
    square_scales = torch.mean(torch.square(poses), dim=(-2, -1), keepdim=True)
    square_scales1 = torch.unsqueeze(square_scales, 0)
    square_scales2 = torch.unsqueeze(square_scales, 1)
    mean_square_scales = (square_scales1 + square_scales2) / 2
    scale_factor1 = torch.sqrt(mean_square_scales / square_scales1)
    scale_factor2 = torch.sqrt(mean_square_scales / square_scales2)

    poses1 = torch.unsqueeze(poses, 0)
    poses2 = torch.unsqueeze(poses, 1)

    dists = torch.linalg.norm(scale_factor1 * poses1 - scale_factor2 * poses2, dim=-1)
    best_dists = torch.topk(dists, k=poses.shape[-2] // 4, sorted=False).values
    return torch.mean(torch.relu(1 - best_dists / 300), dim=-1)


def is_pose_consistent_with_box(pose2d, box):
    """Check if pose prediction is consistent with the original box it was based on.
    Concretely, check if the intersection between the pose's bounding box and the detection has
    at least half the area of the detection box. This is like IoU but the denominator is the
    area of the detection box, so that truncated poses are handled correctly.
    """

    # Compute the bounding box around the 2D joints
    posebox_start = torch.min(pose2d, dim=-2)
    posebox_end = torch.max(pose2d, dim=-2)

    box_start = box[..., :2]
    box_end = box[..., :2] + box[..., 2:4]
    box_area = torch.prod(box[..., 2:4], dim=-1)

    intersection_start = torch.maximum(box_start, posebox_start)
    intersection_end = torch.minimum(box_end, posebox_end)
    intersection_area = torch.prod(torch.relu(intersection_end - intersection_start), dim=-1)
    return intersection_area > 0.5 * box_area


def scale_align(poses):
    square_scales = torch.mean(torch.square(poses), dim=(-2, -1), keepdim=True)
    mean_square_scale = torch.mean(square_scales, dim=-3, keepdim=True)
    return poses * torch.sqrt(mean_square_scale / square_scales)


def point_stdev(poses, item_dim, coord_dim):
    coordwise_variance = torch.var(poses, dim=item_dim, keepdim=True)
    average_stdev = torch.sqrt(torch.sum(coordwise_variance, dim=coord_dim, keepdim=True))
    return torch.squeeze(average_stdev, (item_dim, coord_dim))
