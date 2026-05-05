import warnings

import numpy as np
# noinspection PyUnresolvedReferences
from mpl_toolkits.mplot3d import Axes3D

import procrustes
from simplepyutils import logger


def rigid_align(coords_pred, coords_true, *, joint_validity_mask=None, scale_align=False,
                reflection_align=False):
    """Returns the predicted coordinates after rigid alignment to the ground truth."""

    if joint_validity_mask is None:
        joint_validity_mask = np.ones_like(coords_pred[..., 0], dtype=np.bool)

    valid_coords_pred = coords_pred[joint_validity_mask]
    valid_coords_true = coords_true[joint_validity_mask]
    try:
        d, Z, tform = procrustes.procrustes(
            valid_coords_true, valid_coords_pred, scaling=scale_align,
            reflection='best' if reflection_align else False)
    except np.linalg.LinAlgError:
        logger.error('Cannot do Procrustes alignment, returning original prediction.')
        return coords_pred

    T = tform['rotation']
    b = tform['scale']
    c = tform['translation']
    return b * coords_pred @ T + c


def rigid_align_many(
        coords_pred, coords_true, *, joint_validity_mask=None, scale_align=False,
        reflection_align=False):
    if joint_validity_mask is None:
        joint_validity_mask = np.ones_like(coords_pred[..., 0], dtype=np.bool)

    return np.stack([
        rigid_align(p, t, joint_validity_mask=jv, scale_align=scale_align,
                    reflection_align=reflection_align)
        for p, t, jv in zip(coords_pred, coords_true, joint_validity_mask)])


class AdaptivePoseSampler:
    def __init__(self, thresh, check_validity=False, assume_nan_unchanged=False):
        self.prev_pose = None
        self.thresh = thresh
        self.check_validity = check_validity
        self.assume_nan_unchanged = assume_nan_unchanged

    def should_skip(self, pose):
        pose = np.array(pose)
        if self.prev_pose is None:
            self.prev_pose = pose.copy()
            return not np.any(are_joints_valid(pose))

        if self.check_validity:
            valid_now = are_joints_valid(pose)
            valid_prev = are_joints_valid(self.prev_pose)
            any_newly_valid = np.any(np.logical_and(np.logical_not(valid_prev), valid_now))
            if any_newly_valid:
                self.update(pose)
                return False
        else:
            valid_now = slice(None)

        change = np.linalg.norm(pose[valid_now] - self.prev_pose[valid_now], axis=-1)
        #  print(change)

        if self.assume_nan_unchanged:
            some_changed = np.any(change >= self.thresh)
        else:
            some_changed = not np.all(change < self.thresh)
        if some_changed:
            self.update(pose)
            return False
        return True

    def update(self, pose):
        if self.assume_nan_unchanged:
            isnan = np.isnan(pose)
            self.prev_pose[~isnan] = pose[~isnan]
        else:
            self.prev_pose[:] = pose


class AdaptivePoseSampler2:
    def __init__(self, thresh, check_validity=False, assume_nan_unchanged=False, buffer_size=1):
        self.prev_poses = RingBufferArray(buffer_size, copy_last_if_nan=assume_nan_unchanged)
        self.thresh = thresh
        self.check_validity = check_validity
        self.assume_nan_unchanged = assume_nan_unchanged

    def should_skip(self, pose):
        pose = np.array(pose)
        if self.prev_poses.array is None:
            self.prev_poses.add(pose)
            return not np.any(are_joints_valid(pose))

        if self.check_validity:
            valid_now = are_joints_valid(pose)
            valid_prev = are_joints_valid(self.prev_poses.last_item())
            any_newly_valid = np.any(np.logical_and(np.logical_not(valid_prev), valid_now))
            if any_newly_valid:
                self.prev_poses.add(pose)
                return False
        else:
            valid_now = slice(None)

        change = np.linalg.norm(pose[valid_now] - self.prev_poses.array[:, valid_now], axis=-1)

        if self.assume_nan_unchanged:
            if change.size == 0:
                some_changed = False
            else:
                with np.errstate(invalid='ignore'):
                    with warnings.catch_warnings():
                        warnings.filterwarnings('ignore', 'All-NaN slice encountered')
                        minmax_change = np.nanmin(np.nanmax(change, axis=1), axis=0)
                some_changed = minmax_change >= self.thresh
        else:
            some_changed = not np.any(np.all(change < self.thresh, axis=1), axis=0)

        if some_changed:
            self.prev_poses.add(pose)
            return False
        return True


class RingBufferArray:
    def __init__(self, buffer_size, copy_last_if_nan=False):
        self.buffer_size = buffer_size
        self.array = None
        self.i_buf = 0
        self.copy_last_if_nan = copy_last_if_nan

    def add(self, item):
        if self.array is None:
            self.array = np.full(
                shape=[self.buffer_size, *item.shape], fill_value=np.nan, dtype=np.float32)

        if self.copy_last_if_nan:
            self.array[self.i_buf] = self.last_item()
            isnan = np.isnan(item)
            self.array[self.i_buf][~isnan] = item[~isnan]
        else:
            self.array[self.i_buf] = item

        self.i_buf = (self.i_buf + 1) % self.buffer_size

    def last_item(self):
        i = (self.i_buf - 1) % self.buffer_size
        return self.array[i]


def scale_align(poses):
    mean_scale = np.sqrt(np.mean(np.square(poses), axis=(-3, -2, -1), keepdims=True))
    scales = np.sqrt(np.mean(np.square(poses), axis=(-2, -1), keepdims=True))
    return poses / scales * mean_scale


def relu(x):
    return np.maximum(0, x)


def auc(x, t1, t2):
    return relu(np.float32(1) - relu(x - t1) / (t2 - t1))


def are_joints_valid(coords):
    return np.logical_not(np.any(np.isnan(coords), axis=-1))


def unit_vector(vectors, axis=-1):
    norm = np.linalg.norm(vectors, axis=axis, keepdims=True)
    return vectors / norm


def get_joint2bone_mat(joint_info):
    n_bones = len(joint_info.stick_figure_edges)
    joints2bones = np.zeros([n_bones, joint_info.n_joints], np.float32)
    for i_bone, (i_joint1, i_joint2) in enumerate(joint_info.stick_figure_edges):
        joints2bones[i_bone, i_joint1] = 1
        joints2bones[i_bone, i_joint2] = -1
    return joints2bones
