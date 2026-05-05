import einops
import numpy as np
import torch
from metrabs_pytorch.util import get_config

from metrabs_pytorch import ptu


def reconstruct_absolute(
        coords2d, coords3d_rel, intrinsics, mix_3d_inside_fov=None, weak_perspective=None):
    FLAGS = get_config()
    inv_intrinsics = torch.linalg.inv(intrinsics.to(coords2d.dtype))
    coords2d_normalized = (to_homogeneous(coords2d) @ inv_intrinsics.transpose(1, 2))[..., :2]
    if weak_perspective is None:
        weak_perspective = FLAGS.weak_perspective

    reconstruct_ref_fn = (
        reconstruct_ref_weakpersp if weak_perspective else reconstruct_ref_fullpersp)
    is_predicted_to_be_in_fov = is_within_fov(coords2d)

    ref = reconstruct_ref_fn(coords2d_normalized, coords3d_rel, is_predicted_to_be_in_fov)
    coords_abs_3d_based = coords3d_rel + ref[:, np.newaxis]
    reference_depth = ref[:, 2]
    relative_depths = coords3d_rel[..., 2]

    coords_abs_2d_based = back_project(coords2d_normalized, relative_depths, reference_depth)

    if mix_3d_inside_fov is not None:
        coords_abs_2d_based = (
                mix_3d_inside_fov * coords_abs_3d_based +
                (1 - mix_3d_inside_fov) * coords_abs_2d_based)
    return torch.where(
        is_predicted_to_be_in_fov[..., np.newaxis], coords_abs_2d_based, coords_abs_3d_based)


def reconstruct_ref_weakpersp(normalized_2d, coords3d_rel, validity_mask):
    mean3d, stdev3d = ptu.mean_stdev_masked(
        coords3d_rel[..., :2], validity_mask, items_dim=1, dimensions_dim=2)

    mean2d, stdev2d = ptu.mean_stdev_masked(
        normalized_2d[..., :2], validity_mask, items_dim=1, dimensions_dim=2)

    stdev2d = torch.maximum(stdev2d, torch.tensor(1e-5))
    stdev3d = torch.maximum(stdev3d, torch.tensor(1e-5))

    old_mean = ptu.reduce_mean_masked(coords3d_rel, validity_mask, dim=1, keepdim=True)
    new_mean_z = torch.nan_to_num(stdev3d / stdev2d)
    new_mean = to_homogeneous(mean2d) * new_mean_z
    return torch.squeeze(new_mean - old_mean, 1)


def to_homogeneous(x):
    return torch.cat([x, torch.ones_like(x[..., :1])], dim=-1)


def reconstruct_ref_fullpersp(normalized_2d, coords3d_rel, validity_mask):
    """Reconstructs the reference point location.

    Args:
      normalized_2d: normalized image coordinates of the joints
         (without intrinsics applied), shape [batch_size, n_points, 2]
      coords3d_rel: 3D camera coordinate offsets relative to the unknown reference
         point which we want to reconstruct, shape [batch_size, n_points, 3]
      validity_mask: boolean mask of shape [batch_size, n_points] containing True
         where the point is reliable and should be used in the reconstruction

    Returns:
      The 3D reference point in camera coordinates, shape [batch_size, 3]
    """

    def rms_normalize(x):
        scale = x.square().mean().sqrt()
        normalized = x / scale
        return scale, normalized

    n_batch = normalized_2d.shape[0]
    n_points = normalized_2d.shape[1]
    eyes2 = torch.eye(
        2, device=normalized_2d.device, dtype=normalized_2d.dtype).unsqueeze(0).repeat(
        n_batch, n_points, 1)

    scale2d, reshaped2d = rms_normalize(normalized_2d.reshape(-1, n_points * 2, 1))
    A = torch.cat([eyes2, -reshaped2d], dim=2)
    eyes3 = torch.eye(
        3, device=normalized_2d.device, dtype=normalized_2d.dtype).unsqueeze(0).repeat(
        n_batch, 1, 1)
    A_regul = torch.cat([A, eyes3], dim=1)

    rel_backproj = normalized_2d * coords3d_rel[:, :, 2:] - coords3d_rel[:, :, :2]
    scale_rel_backproj, b = rms_normalize(rel_backproj.reshape(-1, n_points * 2, 1))
    b_zeros = torch.zeros(size=[n_batch, 3, 1], dtype=torch.float32, device=b.device)
    b_regul = torch.cat([b, b_zeros], dim=1)

    weights = validity_mask.float() + np.float32(1e-4)
    weights = einops.repeat(weights, 'b j -> b (j c) 1', c=2)
    full = torch.full(
        size=[n_batch, 3, 1], fill_value=np.sqrt(1e-2), dtype=torch.float32, device=weights.device)
    weights_regul = torch.cat([weights, full], dim=1)

    ref, residuals, rank, singular_values = torch.linalg.lstsq(
        A_regul * weights_regul, b_regul * weights_regul)

    ref = torch.cat(
        [ref[:, :2] * scale_rel_backproj, ref[:, 2:] * (scale_rel_backproj / scale2d)], dim=1)
    return torch.squeeze(ref, dim=-1)


def back_project(camcoords2d, delta_z, z_offset):
    return (to_homogeneous(camcoords2d) *
            torch.unsqueeze(delta_z + torch.unsqueeze(z_offset, -1), -1))


def is_within_fov(imcoords, border_factor=0.75):
    FLAGS = get_config()
    stride_train = FLAGS.stride_train
    offset = -stride_train / 2 if not FLAGS.centered_stride else 0

    lower = stride_train * border_factor + offset
    upper = FLAGS.proc_side - stride_train * border_factor + offset
    proj_in_fov = torch.all(torch.logical_and(imcoords >= lower, imcoords <= upper), dim=-1)
    return proj_in_fov


def project_pose(coords3d, intrinsic_matrix):
    projected = coords3d / torch.maximum(np.float32(1), coords3d[..., 2:])
    return torch.einsum('bnk,bjk->bnj', projected, intrinsic_matrix[..., :2, :])


def lookat_matrix(forward_vector, up_vector):
    # Z will point forwards, towards the box center
    new_z = forward_vector / torch.linalg.norm(forward_vector, dim=-1, keepdim=True)
    # Get the X (right direction) as the cross of forward and up.
    new_x = torch.linalg.cross(new_z, up_vector)
    # Get alternative X by rotating the new Z around the old Y by 90 degrees
    # in case lookdir happens to align with the up vector and the above cross product is zero.
    new_x_alt = torch.stack([new_z[:, 2], torch.zeros_like(new_z[:, 2]), -new_z[:, 0]], dim=1)
    new_x = torch.where(torch.linalg.norm(new_x, dim=-1, keepdim=True) == 0, new_x_alt, new_x)
    new_x = new_x / torch.linalg.norm(new_x, dim=-1, keepdim=True)
    # Complete the right-handed coordinate system to get Y
    new_y = torch.linalg.cross(new_z, new_x)
    # Stack the axis vectors to get the rotation matrix
    return torch.stack([new_x, new_y, new_z], dim=1)


def project(points):
    return points[..., :2] / points[..., 2:3]


def intrinsic_matrix_from_field_of_view(fov_degrees, imshape):
    imshape = torch.tensor(imshape, dtype=torch.float32)
    fov_radians = fov_degrees * torch.tensor(np.pi / 180, dtype=torch.float32)
    larger_side = torch.max(imshape)
    focal_length = larger_side / (torch.tan(fov_radians / 2) * 2)
    _0 = torch.tensor(0, dtype=torch.float32)
    _1 = torch.tensor(1, dtype=torch.float32)

    # print(torch.stack([focal_length, _0, imshape[1] / 2], dim=-1))
    return torch.stack(
        [torch.stack([focal_length, _0, imshape[1] / 2], dim=-1),
         torch.stack([_0, focal_length, imshape[0] / 2], dim=-1),
         torch.stack([_0, _0, _1], dim=-1)], dim=-2).unsqueeze(0)


def rotation_mat(angle, rot_axis):
    sin = torch.sin(angle)
    cos = torch.cos(angle)
    _0 = torch.zeros_like(angle)
    _1 = torch.ones_like(angle)

    if rot_axis == 'x':
        return torch.stack([
            torch.stack([_1, _0, _0], dim=-1),
            torch.stack([_0, cos, sin], dim=-1),
            torch.stack([_0, -sin, cos], dim=-1)], dim=-2)
    elif rot_axis == 'y':
        return torch.stack([
            torch.stack([cos, _0, -sin], dim=-1),
            torch.stack([_0, _1, _0], dim=-1),
            torch.stack([sin, _0, cos], dim=-1)], dim=-2)
    else:
        return torch.stack([
            torch.stack([cos, -sin, _0], dim=-1),
            torch.stack([sin, cos, _0], dim=-1),
            torch.stack([_0, _0, _1], dim=-1)], dim=-2)
