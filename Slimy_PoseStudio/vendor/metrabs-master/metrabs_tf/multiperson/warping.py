import numpy as np
import tensorflow as tf
import tensorflow_addons as tfa

from metrabs_tf import tfu3d


def warp_images_with_pyramid(
        images, intrinsic_matrix, new_invprojmat, distortion_coeffs, crop_scales, output_shape,
        image_ids, n_pyramid_levels=3):
    # Create a very simple pyramid with lower resolution images for simple antialiasing.
    image_levels = [images]
    for _ in range(1, n_pyramid_levels):
        # We use simple averaging (box filter) to create the pyramid, for efficiency
        image_levels.append(tf.nn.avg_pool2d(image_levels[-1], 2, 2, padding='VALID'))

    intrinsic_matrix_levels = [
        corner_aligned_scale_mat(1 / 2 ** i_level) @ intrinsic_matrix
        for i_level in range(n_pyramid_levels)]

    # Decide which pyramid level is most appropriate for each crop
    i_pyramid_levels = tf.math.floor(-tf.math.log(crop_scales) / np.log(2))
    i_pyramid_levels = tf.cast(
        tf.clip_by_value(i_pyramid_levels, 0, n_pyramid_levels - 1), tf.int32)

    n_crops = tf.cast(tf.shape(new_invprojmat)[0], tf.int32)
    result_crops = tf.TensorArray(
        images.dtype, size=n_crops, element_shape=(None, None, 3), infer_shape=False)
    for i_crop in tf.range(n_crops):
        tf.autograph.experimental.set_loop_options(parallel_iterations=1000)

        i_pyramid_level = i_pyramid_levels[i_crop]
        # Ugly, but we must unroll this because we can't index a Python list with a Tensor...
        if i_pyramid_level == 0:
            image_level = image_levels[0]
            intrinsic_matrix_level = intrinsic_matrix_levels[0]
        elif i_pyramid_level == 1:
            image_level = image_levels[1]
            intrinsic_matrix_level = intrinsic_matrix_levels[1]
        else:
            image_level = image_levels[2]
            intrinsic_matrix_level = intrinsic_matrix_levels[2]

        # Perform the transformation on using the selected pyramid level
        crop = warp_single_image(
            image_level[image_ids[i_crop]], intrinsic_matrix_level[i_crop], new_invprojmat[i_crop],
            distortion_coeffs[i_crop], output_shape)
        result_crops = result_crops.write(i_crop, crop)
    return result_crops.stack()


def warp_images(
        images, intrinsic_matrix, new_invprojmat, distortion_coeffs, crop_scales, output_shape,
        image_ids):
    n_crops = tf.cast(tf.shape(new_invprojmat)[0], tf.int32)
    result_crops = tf.TensorArray(
        images.dtype, size=n_crops, element_shape=(None, None, 3), infer_shape=False)
    for i_crop in tf.range(n_crops):
        tf.autograph.experimental.set_loop_options(parallel_iterations=1000)
        crop = warp_single_image(
            images[image_ids[i_crop]], intrinsic_matrix[i_crop], new_invprojmat[i_crop],
            distortion_coeffs[i_crop], output_shape)
        result_crops = result_crops.write(i_crop, crop)
    return result_crops.stack()


def warp_single_image(image, intrinsic_matrix, new_invprojmat, distortion_coeffs, output_shape):
    if tf.reduce_all(distortion_coeffs == 0):
        # No lens distortion, simply apply a homography
        H = intrinsic_matrix @ new_invprojmat
        H = tf.reshape(H, [9])[:8] / H[2, 2]
        return tfa.image.transform(image, H, output_shape=output_shape, interpolation='bilinear')
    else:
        # With lens distortion, we must transform each pixel and interpolate
        new_coords = tf.cast(tf.stack(tf.meshgrid(
            tf.range(output_shape[1]), tf.range(output_shape[0])), axis=-1), tf.float32)
        new_coords_homog = tfu3d.to_homogeneous(new_coords)
        old_coords_homog = tf.einsum('hwc,Cc->hwC', new_coords_homog, new_invprojmat)
        old_coords_homog = tfu3d.to_homogeneous(
            distort_points(tfu3d.project(old_coords_homog), distortion_coeffs))
        old_coords = tf.einsum('hwc,Cc->hwC', old_coords_homog, intrinsic_matrix)[..., :2]
        # The underlying crop model was trained with border mode constant
        # however tfa.image.interpolate_bilinear uses border mode replicate
        # in other words, it will repeat the image border pixel when indexed outside the image
        # but we want zeros in that case.
        # We emulate border mode constant by zero padding the image with one pixel of black border.
        # We also need to shift the lookup indices by one pixel to adjustfor the extra padding
        image_padded = tf.pad(image, [(1, 1), (1, 1), (0, 0)])
        interpolated = tfa.image.interpolate_bilinear(
            image_padded[tf.newaxis], tf.reshape(old_coords + 1, [1, -1, 2])[:, :, ::-1])
        return tf.reshape(interpolated, [output_shape[0], output_shape[1], 3])


def distort_points(undist_points2d, distortion_coeffs):
    if tf.reduce_all(distortion_coeffs == 0):
        return undist_points2d
    else:
        a, b, c = distortion_formula_parts(undist_points2d, distortion_coeffs)
        return undist_points2d * (a + b) + c


def undistort_points(dist_points2d, distortion_coeffs):
    if tf.reduce_all(distortion_coeffs == 0):
        return dist_points2d

    undist_points2d = dist_points2d
    for _ in range(5):
        a, b, c = distortion_formula_parts(undist_points2d, distortion_coeffs)
        undist_points2d = (dist_points2d - c - undist_points2d * b) / a
    return undist_points2d


def distortion_formula_parts_simple(undist_points2d, distortion_coeffs):
    distortion_coeffs_broadcast_shape = (
            ([-1] if distortion_coeffs.shape.rank > 1 else []) +
            [1] * (undist_points2d.shape.rank - distortion_coeffs.shape.rank) + [5])
    distortion_coeffs = tf.reshape(distortion_coeffs, distortion_coeffs_broadcast_shape)

    r2 = tf.reduce_sum(tf.square(undist_points2d), axis=-1, keepdims=True)
    a = ((distortion_coeffs[..., 4:5] * r2 + distortion_coeffs[..., 1:2]) * r2 +
         distortion_coeffs[..., 0:1]) * r2 + 1
    b = 2 * tf.reduce_sum(undist_points2d * distortion_coeffs[..., 3:1:-1], axis=-1, keepdims=True)
    c = r2 * distortion_coeffs[..., 3:1:-1]
    return a, b, c


def distortion_formula_parts(undist_points2d, distortion_coeffs):
    # (k1, k2, p1, p2, k3, k4, k5, k6, s1, s2, s3, s4)
    # Pad the distortion coefficients with zeros, to have 12 elements.
    d = pad_axis_to_size(distortion_coeffs, 12, -1)
    broadcast_shape = (
            ([-1] if d.shape.rank > 1 else []) +
            [1] * (undist_points2d.shape.rank - d.shape.rank) + [12])
    d = tf.reshape(d, broadcast_shape)

    r2 = tf.reduce_sum(tf.square(undist_points2d), axis=-1, keepdims=True)
    a = ((((d[..., 4:5] * r2 + d[..., 1:2]) * r2 + d[..., 0:1]) * r2 + 1) /
         (((d[..., 7:8] * r2 + d[..., 6:7]) * r2 + d[..., 5:6]) * r2 + 1))
    b = 2 * tf.reduce_sum(undist_points2d * d[..., 3:1:-1], axis=-1, keepdims=True)
    c = (d[..., 9:12:2] * r2 + d[..., 3:1:-1] + d[..., 8:11:2]) * r2

    # Scheimpflug extension from opencv not implemented but would involve something like:
    # rx = rotation_mat_xaxis(d[..., 12])
    # ry = rotation_mat_yaxis(d[..., 13])
    # rxy = ry @ rx
    # projz = tf.stack([
    #     tf.stack([rxy[2, 2], 0, -rxy[0, 2]], axis=-1),
    #     tf.stack([0, rxy[2, 2], -rxy[1, 2]], axis=-1),
    #     tf.stack([0, 0, 1], axis=-1)], axis=-2)
    # tilt = projz @ rxy
    return a, b, c


def pad_axis_to_size(x, size, axis):
    paddings = [(0, 0)] * x.shape.rank
    paddings[axis] = (0, size - tf.shape(x)[axis])
    return tf.pad(x, paddings)


def corner_aligned_scale_mat(factor):
    shift = (factor - 1) / 2
    return tf.convert_to_tensor(
        [[factor, 0, shift],
         [0, factor, shift],
         [0, 0, 1]], tf.float32)
