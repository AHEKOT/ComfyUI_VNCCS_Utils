import torch
from metrabs_pytorch import ptu3d
import numpy as np


def warp_images_with_pyramid(
        images, intrinsic_matrix, new_invprojmats, distortion_coeffs, crop_scales, output_shape,
        image_ids, n_pyramid_levels=3):
    # Create a very simple pyramid with lower resolution images for simple antialiasing.
    image_levels = [images]
    for _ in range(1, n_pyramid_levels):
        # We use simple averaging (box filter) to create the pyramid, for efficiency
        image_levels.append(torch.nn.functional.avg_pool2d(image_levels[-1], 2, 2))

    intrinsic_matrix_levels = [
        corner_aligned_scale_mat(1 / 2 ** i_level).to(intrinsic_matrix.device) @ intrinsic_matrix
        for i_level in range(n_pyramid_levels)]

    # Decide which pyramid level is most appropriate for each crop
    i_pyramid_levels = torch.floor(-torch.log2(crop_scales))
    i_pyramid_levels = torch.clip(i_pyramid_levels, 0, n_pyramid_levels - 1).int()

    return torch.stack([
        warp_single_image(
            image_levels[i_pyramid_levels[i]][image_ids[i]],
            intrinsic_matrix_levels[i_pyramid_levels[i]][i], new_invprojmats[i],
            distortion_coeffs[i], output_shape)
        for i in range(len(image_ids))])


def warp_images(
        images, intrinsic_matrix, new_invprojmats, distortion_coeffs, crop_scales, output_shape,
        image_ids):
    return torch.stack([
        warp_single_image(
            images[image_ids[i]], intrinsic_matrix[i], new_invprojmats[i], distortion_coeffs[i],
            output_shape)
        for i in range(len(image_ids))])


def warp_single_image(image, intrinsic_matrix, new_invprojmat, distortion_coeffs, output_shape):
    _dev = new_invprojmat.device
    new_coords = torch.stack(torch.meshgrid(
        torch.arange(output_shape[1], device=_dev),
        torch.arange(output_shape[0], device=_dev), indexing='xy'), dim=-1).float()
    new_coords_homog = ptu3d.to_homogeneous(new_coords)
    old_coords_homog = torch.einsum('hwc,Cc->hwC', new_coords_homog, new_invprojmat)
    old_coords_homog = ptu3d.to_homogeneous(
        distort_points(ptu3d.project(old_coords_homog), distortion_coeffs))
    old_coords = torch.einsum('hwc,Cc->hwC', old_coords_homog, intrinsic_matrix)[..., :2]
    size = torch.tensor([image.shape[2], image.shape[1]], dtype=old_coords.dtype, device=_dev)
    old_coords_normalized = (old_coords / (size - 1)) * 2 - 1
    return torch.nn.functional.grid_sample(
        image.unsqueeze(0), old_coords_normalized.unsqueeze(0),
        align_corners=True, mode='bilinear', padding_mode='zeros').squeeze(0)


def distort_points(undist_points2d, distortion_coeffs):
    if torch.all(distortion_coeffs == 0):
        return undist_points2d
    else:
        a, b, c = distortion_formula_parts(undist_points2d, distortion_coeffs)
        return undist_points2d * (a + b) + c


def undistort_points(dist_points2d, distortion_coeffs):
    if torch.all(distortion_coeffs == 0):
        return dist_points2d

    undist_points2d = dist_points2d
    for _ in range(5):
        a, b, c = distortion_formula_parts(undist_points2d, distortion_coeffs)
        undist_points2d = (dist_points2d - c - undist_points2d * b) / a
    return undist_points2d


def distortion_formula_parts_simple(undist_points2d, distortion_coeffs):
    distortion_coeffs_broadcast_shape = (
            ([-1] if distortion_coeffs.ndim > 1 else []) +
            [1] * (undist_points2d.ndim - distortion_coeffs.ndim) + [5])
    distortion_coeffs = torch.reshape(distortion_coeffs, distortion_coeffs_broadcast_shape)

    r2 = torch.sum(torch.square(undist_points2d), dim=-1, keepdim=True)
    a = ((distortion_coeffs[..., 4:5] * r2 + distortion_coeffs[..., 1:2]) * r2 +
         distortion_coeffs[..., 0:1]) * r2 + 1
    b = 2 * torch.sum(undist_points2d * distortion_coeffs[..., 3:1:-1], dim=-1, keepdim=True)
    c = r2 * distortion_coeffs[..., 3:1:-1]
    return a, b, c


def distortion_formula_parts(undist_points2d, distortion_coeffs):
    # (k1, k2, p1, p2, k3, k4, k5, k6, s1, s2, s3, s4)
    # Pad the distortion coefficients with zeros, to have 12 elements.
    d = pad_axis_to_size(distortion_coeffs, 12, -1)
    broadcast_shape = (
            ([-1] if d.ndim > 1 else []) +
            [1] * (undist_points2d.ndim - d.ndim) + [12])
    d = torch.reshape(d, broadcast_shape)

    r2 = torch.sum(torch.square(undist_points2d), dim=-1, keepdim=True)
    a = ((((d[..., 4:5] * r2 + d[..., 1:2]) * r2 + d[..., 0:1]) * r2 + 1) /
         (((d[..., 7:8] * r2 + d[..., 6:7]) * r2 + d[..., 5:6]) * r2 + 1))

    p2_1 = torch.flip(d[..., 2:4], dims=[-1])
    b = 2 * torch.sum(undist_points2d * p2_1, dim=-1, keepdim=True)
    c = (d[..., 9:12:2] * r2 + p2_1 + d[..., 8:11:2]) * r2

    return a, b, c


def pad_axis_to_size(x, size, axis):
    paddings = [(0, 0)] * x.ndim
    paddings[axis] = (0, size - x.shape[axis])
    return torch.nn.functional.pad(x, tuple([p for ps in paddings[::-1] for p in ps]))


#
# def corner_aligned_scale_mat(factor):
#     factor = torch.tensor(factor, dtype=torch.float32)
#     _0 = torch.tensor(0, dtype=torch.float32)
#     _1 = torch.tensor(1, dtype=torch.float32)
#     _2 = torch.tensor(2, dtype=torch.float32)
#     shift = (factor - _1) / _2
#     return torch.stack(
#         [torch.stack([factor, _0, shift], dim=0),
#          torch.stack([_0, factor, shift], dim=0),
#          torch.stack([_0, _0, _1], dim=0)], dim=0)

def corner_aligned_scale_mat(factor):
    shift = (factor - 1) / 2
    return torch.from_numpy(np.array(
        [[factor, 0, shift],
         [0, factor, shift],
         [0, 0, 1]], dtype=np.float32))
