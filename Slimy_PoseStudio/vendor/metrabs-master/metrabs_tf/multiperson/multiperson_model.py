import numpy as np
import tensorflow as tf
from posepile.joint_info import JointInfo
from simplepyutils import FLAGS

from metrabs_tf import tfu, tfu3d
from metrabs_tf.multiperson import plausibility_check as plausib, warping

# Dummy value which will mean that the intrinsic_matrix are unknown
UNKNOWN_INTRINSIC_MATRIX = ((-1, -1, -1), (-1, -1, -1), (-1, -1, -1))
DEFAULT_EXTRINSIC_MATRIX = ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1))
DEFAULT_DISTORTION = (0, 0, 0, 0, 0)
DEFAULT_WORLD_UP = (0, -1, 0)


class Pose3dEstimator(tf.Module):
    def __init__(self, crop_model, detector, skeleton_infos, joint_transform_matrix):
        super().__init__()

        # Note that only the Trackable resource attributes such as Variables and Models will be
        # retained when saving to SavedModel
        self.crop_model = crop_model
        self.joint_names = self.crop_model.joint_names
        self.joint_edges = self.crop_model.joint_edges
        joint_names = [b.decode('utf8') for b in self.joint_names.numpy()]
        self.joint_info = JointInfo(joint_names, self.joint_edges.numpy())
        self.detector = detector
        self.joint_transform_matrix = joint_transform_matrix

        self.per_skeleton_indices = {
            k: tf.Variable(v['indices'], dtype=tf.int32, trainable=False)
            for k, v in skeleton_infos.items()}
        self.per_skeleton_joint_names = {
            k: tf.Variable(v['names'], dtype=tf.string, trainable=False)
            for k, v in skeleton_infos.items()}
        self.per_skeleton_joint_edges = {
            k: tf.Variable(v['edges'], dtype=tf.int32, trainable=False)
            for k, v in skeleton_infos.items()}
        self.skeleton_joint_indices_table = tfu.make_tf_hash_table(
            {k: v['indices'] for k, v in skeleton_infos.items()})

    @tf.function(input_signature=[
        tf.TensorSpec(shape=(None, None, None, 3), dtype=tf.uint8, name='images'),
        tf.TensorSpec(shape=(None, 3, 3), dtype=tf.float32, name='intrinsic_matrix'),
        tf.TensorSpec(shape=(None, None), dtype=tf.float32, name='distortion_coeffs'),
        tf.TensorSpec(shape=(None, 4, 4), dtype=tf.float32, name='extrinsic_matrix'),
        tf.TensorSpec(shape=(3,), dtype=tf.float32, name='world_up_vector'),
        tf.TensorSpec(shape=(), dtype=tf.float32, name='default_fov_degrees'),
        tf.TensorSpec(shape=(), dtype=tf.int32, name='internal_batch_size'),
        tf.TensorSpec(shape=(), dtype=tf.int32, name='antialias_factor'),
        tf.TensorSpec(shape=(), dtype=tf.int32, name='num_aug'),
        tf.TensorSpec(shape=(), dtype=tf.bool, name='average_aug'),
        tf.TensorSpec(shape=(), dtype=tf.string, name='skeleton'),
        tf.TensorSpec(shape=(), dtype=tf.float32, name='detector_threshold'),
        tf.TensorSpec(shape=(), dtype=tf.float32, name='detector_nms_iou_threshold'),
        tf.TensorSpec(shape=(), dtype=tf.int32, name='max_detections'),
        tf.TensorSpec(shape=(), dtype=tf.bool, name='detector_flip_aug'),
        tf.TensorSpec(shape=(), dtype=tf.bool, name='suppress_implausible_poses'),
    ])
    def detect_poses_batched(
            self, images, intrinsic_matrix=(UNKNOWN_INTRINSIC_MATRIX,),
            distortion_coeffs=(DEFAULT_DISTORTION,), extrinsic_matrix=(DEFAULT_EXTRINSIC_MATRIX,),
            world_up_vector=DEFAULT_WORLD_UP, default_fov_degrees=55, internal_batch_size=64,
            antialias_factor=1, num_aug=5, average_aug=True, skeleton='', detector_threshold=0.3,
            detector_nms_iou_threshold=0.7, max_detections=-1, detector_flip_aug=False,
            suppress_implausible_poses=True):
        boxes = self._get_boxes(
            images, detector_flip_aug, detector_nms_iou_threshold, detector_threshold,
            max_detections)
        return self._estimate_poses_batched(
            images, boxes, intrinsic_matrix, distortion_coeffs, extrinsic_matrix, world_up_vector,
            default_fov_degrees, internal_batch_size, antialias_factor, num_aug, average_aug,
            skeleton, suppress_implausible_poses)

    @tf.function(input_signature=[
        tf.TensorSpec(shape=(None, None, None, 3), dtype=tf.uint8, name='images'),
        tf.RaggedTensorSpec(shape=(None, None, 4), ragged_rank=1, dtype=tf.float32),  # boxes
        tf.TensorSpec(shape=(None, 3, 3), dtype=tf.float32, name='intrinsic_matrix'),
        tf.TensorSpec(shape=(None, None), dtype=tf.float32, name='distortion_coeffs'),
        tf.TensorSpec(shape=(None, 4, 4), dtype=tf.float32, name='extrinsic_matrix'),
        tf.TensorSpec(shape=(3,), dtype=tf.float32, name='world_up_vector'),
        tf.TensorSpec(shape=(), dtype=tf.float32, name='default_fov_degrees'),
        tf.TensorSpec(shape=(), dtype=tf.int32, name='internal_batch_size'),
        tf.TensorSpec(shape=(), dtype=tf.int32, name='antialias_factor'),
        tf.TensorSpec(shape=(), dtype=tf.int32, name='num_aug'),
        tf.TensorSpec(shape=(), dtype=tf.bool, name='average_aug'),
        tf.TensorSpec(shape=(), dtype=tf.string, name='skeleton'),
    ])
    def estimate_poses_batched(
            self, images, boxes, intrinsic_matrix=(UNKNOWN_INTRINSIC_MATRIX,),
            distortion_coeffs=(DEFAULT_DISTORTION,),
            extrinsic_matrix=(DEFAULT_EXTRINSIC_MATRIX,), world_up_vector=DEFAULT_WORLD_UP,
            default_fov_degrees=55, internal_batch_size=64, antialias_factor=1, num_aug=5,
            average_aug=True, skeleton=''):
        boxes = tf.concat([boxes, tf.ones_like(boxes[..., :1])], axis=-1)
        pred = self._estimate_poses_batched(
            images, boxes, intrinsic_matrix, distortion_coeffs, extrinsic_matrix, world_up_vector,
            default_fov_degrees, internal_batch_size, antialias_factor, num_aug, average_aug,
            skeleton, suppress_implausible_poses=False)
        del pred['boxes']
        return pred

    def _estimate_poses_batched(
            self, images, boxes, intrinsic_matrix, distortion_coeffs, extrinsic_matrix,
            world_up_vector, default_fov_degrees, internal_batch_size, antialias_factor, num_aug,
            average_aug, skeleton, suppress_implausible_poses):
        # Special case when zero boxes are provided or found
        # (i.e., all images without person detections)
        # This must be explicitly handled, else the shapes don't work out automatically
        # for the TensorArray in _predict_in_batches.
        if tf.size(boxes) == 0:
            return self._predict_empty(images, num_aug, average_aug, skeleton)

        n_images = tf.shape(images)[0]
        # If one intrinsic matrix is given, repeat it for all images
        if tf.shape(intrinsic_matrix)[0] == 1:
            # If intrinsic_matrix is not given, fill it in based on field of view
            if tf.reduce_all(intrinsic_matrix == -1):
                intrinsic_matrix = tfu3d.intrinsic_matrix_from_field_of_view(
                    default_fov_degrees, tf.shape(images)[1:3])
            intrinsic_matrix = tf.repeat(intrinsic_matrix, n_images, axis=0)

        # If one distortion coeff/extrinsic matrix is given, repeat it for all images
        if tf.shape(distortion_coeffs)[0] == 1:
            distortion_coeffs = tf.repeat(distortion_coeffs, n_images, axis=0)
        if tf.shape(extrinsic_matrix)[0] == 1:
            extrinsic_matrix = tf.repeat(extrinsic_matrix, n_images, axis=0)

        # Now repeat these camera params for each box
        n_box_per_image = boxes.row_lengths()
        intrinsic_matrix = tf.repeat(intrinsic_matrix, n_box_per_image, axis=0)
        distortion_coeffs = tf.repeat(distortion_coeffs, n_box_per_image, axis=0)

        # Up-vector in camera-space
        camspace_up = tf.einsum('c,bCc->bC', world_up_vector, extrinsic_matrix[..., :3, :3])
        camspace_up = tf.repeat(camspace_up, n_box_per_image, axis=0)

        # Set up the test-time augmentation parameters
        aug_gammas = tf.cast(tfu.linspace(0.6, 1.0, num_aug), tf.float32)

        if FLAGS.rot_aug_360_half:
            num_aug_normal = num_aug // 2
            aug_angle_range_normal = np.float32(np.deg2rad(FLAGS.rot_aug))
            aug_angles_normal = tfu.linspace(
                -aug_angle_range_normal, aug_angle_range_normal, num_aug_normal)

            num_aug_360 = num_aug - num_aug_normal
            aug_angle_range_360 = (
                    tf.cast(np.pi, tf.float32) * (1 - 1 / tf.cast(num_aug_360, tf.float32)))
            aug_angles_360 = tfu.linspace(-aug_angle_range_360, aug_angle_range_360, num_aug_360)

            aug_angles = tf.sort(tf.concat([aug_angles_normal, aug_angles_360], axis=0))
        elif FLAGS.rot_aug_360:
            aug_angle_range_360 = (
                    tf.cast(np.pi, tf.float32) * (1 - 1 / tf.cast(num_aug, tf.float32)))
            aug_angles = tfu.linspace(-aug_angle_range_360, aug_angle_range_360, num_aug)
        else:
            aug_angle_range = np.float32(np.deg2rad(FLAGS.rot_aug))
            aug_angles = tfu.linspace(-aug_angle_range, aug_angle_range, num_aug)

        aug_scales = tf.concat([
            tfu.linspace(0.8, 1.0, num_aug // 2, endpoint=False),
            tfu.linspace(1.0, 1.1, num_aug - num_aug // 2)], axis=0)
        aug_should_flip = (tf.range(num_aug) - num_aug // 2) % 2 != 0
        aug_flipmat = tf.constant([[-1, 0, 0], [0, 1, 0], [0, 0, 1]], np.float32)
        aug_maybe_flipmat = tf.where(
            aug_should_flip[:, np.newaxis, np.newaxis], aug_flipmat, tf.eye(3))
        aug_rotmat = tfu3d.rotation_mat(-aug_angles, rot_axis='z')
        aug_rotflipmat = aug_maybe_flipmat @ aug_rotmat

        # CROP
        # crops_flat, poses3d_flat = self._predict_in_batches(
        poses3d_flat = self._predict_in_batches(
            images, intrinsic_matrix, distortion_coeffs, camspace_up, boxes, internal_batch_size,
            aug_should_flip, aug_rotflipmat, aug_gammas, aug_scales, antialias_factor)

        if self.joint_transform_matrix is not None:
            poses3d_flat = tf.einsum(
                'bank,nN->baNk', poses3d_flat, self.joint_transform_matrix)

        # Project the 3D poses to get the 2D poses
        poses2d_flat_normalized = tfu3d.to_homogeneous(
            warping.distort_points(tfu3d.project(poses3d_flat), distortion_coeffs))
        poses2d_flat = tf.einsum(
            'bank,bjk->banj', poses2d_flat_normalized, intrinsic_matrix[:, :2, :])
        if self.joint_transform_matrix is None:
            n_joints = self.joint_info.n_joints
        else:
            n_joints = self.joint_transform_matrix.shape[1]
        poses2d_flat = tf.ensure_shape(poses2d_flat, [None, None, n_joints, 2])

        # Arrange the results back into ragged tensors
        poses3d = tf.RaggedTensor.from_row_lengths(poses3d_flat, n_box_per_image)
        poses2d = tf.RaggedTensor.from_row_lengths(poses2d_flat, n_box_per_image)
        # CROP
        # crops = tf.RaggedTensor.from_row_lengths(crops_flat, n_box_per_image)

        if suppress_implausible_poses:
            # Filter the resulting poses for individual plausibility to reduce false positives
            selected_indices = self._filter_poses(boxes, poses3d, poses2d)
            boxes, poses3d, poses2d = [
                tf.gather(x, selected_indices, batch_dims=1)
                for x in [boxes, poses3d, poses2d]]
            # CROP
            # crops = tf.gather(crops, selected_indices, batch_dims=1)

        # Convert to world coordinates
        extrinsic_matrix = tf.repeat(tf.linalg.inv(extrinsic_matrix), poses3d.row_lengths(), axis=0)
        poses3d_flat = tf.einsum(
            'bank,bjk->banj', tfu3d.to_homogeneous(poses3d.flat_values), extrinsic_matrix[:, :3, :])
        poses3d = tf.RaggedTensor.from_row_lengths(poses3d_flat, poses3d.row_lengths())

        poses3d = self._get_skeleton(poses3d, skeleton)
        poses2d = self._get_skeleton(poses2d, skeleton)

        if average_aug:
            poses3d = tf.reduce_mean(poses3d, axis=-3)
            poses2d = tf.reduce_mean(poses2d, axis=-3)

        result = dict(boxes=boxes, poses3d=poses3d, poses2d=poses2d)
        # CROP
        # result['crops'] = crops
        return result

    def _get_boxes(
            self, images, detector_flip_aug, detector_nms_iou_threshold, detector_threshold,
            max_detections):
        if self.detector is None:
            n_images = tf.shape(images)[0]
            boxes = tf.RaggedTensor.from_row_lengths(
                tf.zeros(shape=(0, 5)), tf.zeros(n_images, tf.int64))
        else:
            boxes = self.detector.predict_multi_image(
                images, detector_threshold, detector_nms_iou_threshold, detector_flip_aug,
                detector_flip_aug and FLAGS.detector_flip_vertical_too)
            if max_detections > -1 and not tf.size(boxes) == 0:
                topk_indices = tfu.topk_indices_ragged(boxes[..., 4], max_detections)
                boxes = tf.gather(boxes, topk_indices, axis=1, batch_dims=1)
        return boxes

    def _predict_in_batches(
            self, images, intrinsic_matrix, distortion_coeffs, camspace_up, boxes,
            internal_batch_size, aug_should_flip, aug_rotflipmat, aug_gammas, aug_scales,
            antialias_factor):

        num_aug = tf.shape(aug_gammas)[0]
        boxes_per_batch = internal_batch_size // num_aug
        boxes_flat = boxes.flat_values
        image_id_per_box = boxes.value_rowids()

        # Gamma decoding for correct image rescaling later on
        images = (tf.cast(images, tf.float32) / np.float32(255)) ** 2.2

        if boxes_per_batch == 0:
            # Run all as a single batch
            return self._predict_single_batch(
                images, intrinsic_matrix, distortion_coeffs, camspace_up, boxes_flat,
                image_id_per_box, aug_rotflipmat, aug_should_flip, aug_scales, aug_gammas,
                antialias_factor)
        else:
            # Chunk the image crops into batches and predict them one by one
            n_total_boxes = tf.shape(boxes_flat)[0]
            n_batches = tf.cast(tf.math.ceil(n_total_boxes / boxes_per_batch), tf.int32)
            poses3d_batches = tf.TensorArray(
                tf.float32, size=n_batches, element_shape=(None, None, self.joint_info.n_joints, 3),
                infer_shape=False)
            # CROP
            # crop_batches = tf.TensorArray(
            #    tf.float32, size=n_batches,
            #    element_shape=(None, None, None, None, 3),
            #    infer_shape=False)

            for i in tf.range(n_batches):
                # tf.autograph.experimental.set_loop_options(parallel_iterations=1)
                batch_slice = slice(i * boxes_per_batch, (i + 1) * boxes_per_batch)
                # CROP
                # crops, poses3d = self._predict_single_batch(
                poses3d = self._predict_single_batch(
                    images, intrinsic_matrix[batch_slice], distortion_coeffs[batch_slice],
                    camspace_up[batch_slice], boxes_flat[batch_slice],
                    image_id_per_box[batch_slice], aug_rotflipmat, aug_should_flip, aug_scales,
                    aug_gammas, antialias_factor)
                poses3d_batches = poses3d_batches.write(i, poses3d)

                # CROP
                # crop_batches = crop_batches.write(i, crops)

            # CROP
            # return crop_batches.concat(), poses3d_batches.concat()
            return poses3d_batches.concat()

    def _predict_single_batch(
            self, images, intrinsic_matrix, distortion_coeffs, camspace_up, boxes, image_ids,
            aug_rotflipmat, aug_should_flip, aug_scales, aug_gammas, antialias_factor):
        # Get crops and info about the transformation used to create them
        # Each has shape [num_aug, n_boxes, ...]
        crops, new_intrinsic_matrix, R = self._get_crops(
            images, intrinsic_matrix, distortion_coeffs, camspace_up, boxes, image_ids,
            aug_rotflipmat, aug_scales, aug_gammas, antialias_factor)

        # Flatten each and predict the pose with the crop model
        new_intrinsic_matrix_flat = tf.reshape(new_intrinsic_matrix, (-1, 3, 3))
        res = self.crop_model.input_resolution
        crops_flat = tf.reshape(crops, (-1, res, res, 3))
        poses_flat = self.crop_model.predict_multi(
            tf.cast(crops_flat, tf.float16),
            new_intrinsic_matrix_flat)

        # Unflatten the result
        num_aug = tf.shape(aug_should_flip)[0]
        poses = tf.reshape(poses_flat, [num_aug, -1, self.joint_info.n_joints, 3])

        # Reorder the joints for mirrored predictions (e.g., swap left and right wrist)
        left_right_swapped_poses = tf.gather(poses, self.joint_info.mirror_mapping, axis=-2)
        poses = tf.where(
            tf.reshape(aug_should_flip, [-1, 1, 1, 1]), left_right_swapped_poses, poses)

        # Transform the predictions back into the original camera space
        # We need to multiply by the inverse of R, but since we are using row vectors in `poses`
        # the inverse and transpose cancel out, leaving just R.
        poses_orig_camspace = poses @ R

        # Transpose to [n_boxes, num_aug, ...]
        # CROP
        # return (
        #    tf.transpose(crops, [1, 0, 2, 3, 4]), tf.transpose(poses_orig_camspace, [1, 0, 2, 3]))
        return tf.transpose(poses_orig_camspace, [1, 0, 2, 3])

    def _get_crops(
            self, images, intrinsic_matrix, distortion_coeffs, camspace_up, boxes, image_ids,
            aug_rotflipmat, aug_scales, aug_gammas, antialias_factor):
        R_noaug, box_scales = self._get_new_rotation_and_scale(
            intrinsic_matrix, distortion_coeffs, camspace_up, boxes)

        # How much we need to scale overall, taking scale augmentation into account
        # From here on, we introduce the dimension of augmentations
        crop_scales = aug_scales[:, tf.newaxis] * box_scales[tf.newaxis, :]
        # Build the new intrinsic matrix
        num_box = tf.shape(boxes)[0]
        num_aug = tf.shape(aug_gammas)[0]
        res = self.crop_model.input_resolution
        new_intrinsic_matrix = tf.concat([
            tf.concat([
                # Top-left of original intrinsic matrix gets scaled
                intrinsic_matrix[tf.newaxis, :, :2, :2] * crop_scales[:, :, tf.newaxis, tf.newaxis],
                # Principal point is the middle of the new image size
                tf.fill((num_aug, num_box, 2, 1), tf.cast(res, tf.float32) / 2)], axis=3),
            tf.concat([
                # [0, 0, 1] as the last row of the intrinsic matrix:
                tf.zeros((num_aug, num_box, 1, 2), tf.float32),
                tf.ones((num_aug, num_box, 1, 1), tf.float32)], axis=3)], axis=2)
        R = aug_rotflipmat[:, tf.newaxis] @ R_noaug
        new_invprojmat = tf.linalg.inv(new_intrinsic_matrix @ R)

        # If we perform antialiasing through output scaling, we render a larger image first and then
        # shrink it. So we scale the homography first.
        if antialias_factor > 1:
            scaling_mat = warping.corner_aligned_scale_mat(
                1 / tf.cast(antialias_factor, tf.float32))
            new_invprojmat = new_invprojmat @ scaling_mat

        crops = warping.warp_images_with_pyramid(
            images,
            intrinsic_matrix=tf.tile(intrinsic_matrix, [num_aug, 1, 1]),
            new_invprojmat=tf.reshape(new_invprojmat, [-1, 3, 3]),
            distortion_coeffs=tf.tile(distortion_coeffs, [num_aug, 1]),
            crop_scales=tf.reshape(crop_scales, [-1]) * tf.cast(antialias_factor, tf.float32),
            output_shape=(res * antialias_factor, res * antialias_factor),
            image_ids=tf.tile(image_ids, [num_aug]))

        # Downscale the result if we do antialiasing through output scaling
        if antialias_factor == 2:
            crops = tf.nn.avg_pool2d(crops, 2, 2, padding='VALID')
        elif antialias_factor == 4:
            crops = tf.nn.avg_pool2d(crops, 4, 4, padding='VALID')
        elif antialias_factor > 4:
            crops = tf.image.resize(crops, (res, res), tf.image.ResizeMethod.AREA)
        crops = tf.reshape(crops, [num_aug, num_box, res, res, 3])
        # The division by 2.2 cancels the original gamma decoding from earlier
        crops **= tf.reshape(aug_gammas / 2.2, [-1, 1, 1, 1, 1])
        return crops, new_intrinsic_matrix, R

    def _get_new_rotation_and_scale(self, intrinsic_matrix, distortion_coeffs, camspace_up, boxes):
        # Transform five points on each box: the center and the four side midpoints
        x, y, w, h = tf.unstack(boxes[:, :4], axis=1)
        boxpoints_homog = tfu3d.to_homogeneous(tf.reshape(tf.stack([
            x + w / 2, y + h / 2,
            x + w / 2, y,
            x + w, y + h / 2,
            x + w / 2, y + h,
            x, y + h / 2], axis=1), (-1, 5, 2)))
        boxpoints_camspace = tf.einsum(
            'bpc,bCc->bpC', boxpoints_homog, tf.linalg.inv(intrinsic_matrix))
        boxpoints_camspace = tfu3d.to_homogeneous(
            warping.undistort_points(boxpoints_camspace[:, :, :2], distortion_coeffs))

        # Create a rotation matrix that will put the box center to the principal point
        # and apply the augmentation rotation and flip, to get the new coordinate frame
        box_center_camspace = boxpoints_camspace[:, 0]
        R_noaug = tfu3d.get_new_rotation_matrix(
            forward_vector=box_center_camspace, up_vector=camspace_up)

        # Transform the side midpoints of the box to the new coordinate frame
        sidepoints_camspace = boxpoints_camspace[:, 1:5]
        sidepoints_new = tfu3d.project(tf.einsum(
            'bpc,bCc->bpC', sidepoints_camspace, intrinsic_matrix @ R_noaug))

        # Measure the size of the reprojected boxes
        vertical_size = tf.linalg.norm(sidepoints_new[:, 0] - sidepoints_new[:, 2], axis=-1)
        horiz_size = tf.linalg.norm(sidepoints_new[:, 1] - sidepoints_new[:, 3], axis=-1)
        box_size_new = tf.maximum(vertical_size, horiz_size)

        # How much we need to scale (zoom) to have the boxes fill out the final crop
        box_scales = tf.cast(self.crop_model.input_resolution, tf.float32) / box_size_new
        return R_noaug, box_scales

    def _predict_empty(self, image, num_aug, average_aug, skeleton):
        if average_aug:
            poses3d = tf.zeros(shape=(0, self.joint_info.n_joints, 3))
            poses2d = tf.zeros(shape=(0, self.joint_info.n_joints, 2))
        else:
            poses3d = tf.zeros(shape=(0, num_aug, self.joint_info.n_joints, 3))
            poses2d = tf.zeros(shape=(0, num_aug, self.joint_info.n_joints, 2))

        poses3d = self._get_skeleton(poses3d, skeleton)
        poses2d = self._get_skeleton(poses2d, skeleton)

        n_images = tf.shape(image)[0]
        poses3d = tf.RaggedTensor.from_row_lengths(poses3d, tf.zeros(n_images, tf.int64))
        poses2d = tf.RaggedTensor.from_row_lengths(poses2d, tf.zeros(n_images, tf.int64))
        boxes = tf.zeros(shape=(0, 5))
        boxes = tf.RaggedTensor.from_row_lengths(boxes, tf.zeros(n_images, tf.int64))
        result = dict(boxes=boxes, poses3d=poses3d, poses2d=poses2d)
        # CROP
        # res = self.crop_model.input_resolution
        # crops = tf.zeros(shape=(0, num_aug, res, res, 3))
        # crops = tf.RaggedTensor.from_row_lengths(crops, tf.zeros(n_images, tf.int64))
        # result['crops'] = crops
        return result

    def _filter_poses(self, boxes, poses3d, poses2d):
        poses3d_mean = tf.reduce_mean(poses3d, axis=-3)
        poses2d_mean = tf.reduce_mean(poses2d, axis=-3)

        plausible_mask_flat = tf.logical_and(
            tf.logical_and(
                plausib.is_pose_plausible(poses3d_mean.flat_values, self.joint_info),
                plausib.are_augmentation_results_consistent(poses3d.flat_values)),
            plausib.is_pose_consistent_with_box(poses2d_mean.flat_values, boxes.flat_values))

        plausible_mask = tf.RaggedTensor.from_row_lengths(
            plausible_mask_flat, boxes.row_lengths())

        # Apply pose similarity-based non-maximum suppression to reduce duplicates
        nms_indices = tf.map_fn(
            fn=lambda args: plausib.pose_non_max_suppression(*args),
            elems=(poses3d_mean, boxes[..., 4], plausible_mask),
            fn_output_signature=tf.RaggedTensorSpec(shape=(None,), dtype=tf.int32))
        return nms_indices

    def _get_skeleton(self, poses, skeleton):
        indices = tfu.lookup_tf_hash_table(self.skeleton_joint_indices_table, skeleton)
        return tf.gather(poses, indices, axis=-2)

    @tf.function(input_signature=[
        tf.TensorSpec(shape=(None, None, 3), dtype=tf.uint8, name='image'),
        tf.TensorSpec(shape=(3, 3), dtype=tf.float32, name='intrinsic_matrix'),
        tf.TensorSpec(shape=(None,), dtype=tf.float32, name='distortion_coeffs'),
        tf.TensorSpec(shape=(4, 4), dtype=tf.float32, name='extrinsic_matrix'),
        tf.TensorSpec(shape=(3,), dtype=tf.float32, name='world_up_vector'),
        tf.TensorSpec(shape=(), dtype=tf.float32, name='default_fov_degrees'),
        tf.TensorSpec(shape=(), dtype=tf.int32, name='internal_batch_size'),
        tf.TensorSpec(shape=(), dtype=tf.int32, name='antialias_factor'),
        tf.TensorSpec(shape=(), dtype=tf.int32, name='num_aug'),
        tf.TensorSpec(shape=(), dtype=tf.bool, name='average_aug'),
        tf.TensorSpec(shape=(), dtype=tf.string, name='skeleton'),
        tf.TensorSpec(shape=(), dtype=tf.float32, name='detector_threshold'),
        tf.TensorSpec(shape=(), dtype=tf.float32, name='detector_nms_iou_threshold'),
        tf.TensorSpec(shape=(), dtype=tf.int32, name='max_detections'),
        tf.TensorSpec(shape=(), dtype=tf.bool, name='detector_flip_aug'),
        tf.TensorSpec(shape=(), dtype=tf.bool, name='suppress_implausible_poses'),
    ])
    def detect_poses(
            self, image, intrinsic_matrix=UNKNOWN_INTRINSIC_MATRIX,
            distortion_coeffs=DEFAULT_DISTORTION, extrinsic_matrix=DEFAULT_EXTRINSIC_MATRIX,
            world_up_vector=DEFAULT_WORLD_UP, default_fov_degrees=55, internal_batch_size=64,
            antialias_factor=1, num_aug=5, average_aug=True, skeleton='', detector_threshold=0.3,
            detector_nms_iou_threshold=0.7, max_detections=-1, detector_flip_aug=False,
            suppress_implausible_poses=True):
        images = image[tf.newaxis]
        intrinsic_matrix = intrinsic_matrix[tf.newaxis]
        distortion_coeffs = distortion_coeffs[tf.newaxis]
        extrinsic_matrix = extrinsic_matrix[tf.newaxis]
        result = self.detect_poses_batched(
            images, intrinsic_matrix, distortion_coeffs, extrinsic_matrix, world_up_vector,
            default_fov_degrees, internal_batch_size, antialias_factor, num_aug, average_aug,
            skeleton, detector_threshold, detector_nms_iou_threshold, max_detections,
            detector_flip_aug, suppress_implausible_poses)
        return tf.nest.map_structure(lambda x: tf.squeeze(x, 0), result)

    @tf.function(input_signature=[
        tf.TensorSpec(shape=(None, None, 3), dtype=tf.uint8, name='image'),
        tf.TensorSpec(shape=(None, 4), dtype=tf.float32, name='boxes'),
        tf.TensorSpec(shape=(3, 3), dtype=tf.float32, name='intrinsic_matrix'),
        tf.TensorSpec(shape=(None,), dtype=tf.float32, name='distortion_coeffs'),
        tf.TensorSpec(shape=(4, 4), dtype=tf.float32, name='extrinsic_matrix'),
        tf.TensorSpec(shape=(3,), dtype=tf.float32, name='world_up_vector'),
        tf.TensorSpec(shape=(), dtype=tf.float32, name='default_fov_degrees'),
        tf.TensorSpec(shape=(), dtype=tf.int32, name='internal_batch_size'),
        tf.TensorSpec(shape=(), dtype=tf.int32, name='antialias_factor'),
        tf.TensorSpec(shape=(), dtype=tf.int32, name='num_aug'),
        tf.TensorSpec(shape=(), dtype=tf.bool, name='average_aug'),
        tf.TensorSpec(shape=(), dtype=tf.string, name='skeleton'),
    ])
    def estimate_poses(
            self, image, boxes, intrinsic_matrix=UNKNOWN_INTRINSIC_MATRIX,
            distortion_coeffs=DEFAULT_DISTORTION, extrinsic_matrix=DEFAULT_EXTRINSIC_MATRIX,
            world_up_vector=DEFAULT_WORLD_UP, default_fov_degrees=55, internal_batch_size=64,
            antialias_factor=1, num_aug=5, average_aug=True, skeleton=''):
        images = image[tf.newaxis]
        boxes = tf.RaggedTensor.from_tensor(boxes[tf.newaxis])
        intrinsic_matrix = intrinsic_matrix[tf.newaxis]
        distortion_coeffs = distortion_coeffs[tf.newaxis]
        extrinsic_matrix = extrinsic_matrix[tf.newaxis]
        result = self.estimate_poses_batched(
            images, boxes, intrinsic_matrix, distortion_coeffs, extrinsic_matrix, world_up_vector,
            default_fov_degrees, internal_batch_size, antialias_factor, num_aug, average_aug,
            skeleton)
        return tf.nest.map_structure(lambda x: tf.squeeze(x, 0), result)
