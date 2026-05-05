import numpy as np
import torch
import torchvision.transforms.functional
from posepile.joint_info import JointInfo

from metrabs_pytorch import ptu, ptu3d
from metrabs_pytorch.multiperson import person_detector, warping

# Dummy value which will mean that the intrinsic_matrix are unknown
UNKNOWN_INTRINSIC_MATRIX = ((-1, -1, -1), (-1, -1, -1), (-1, -1, -1))
DEFAULT_EXTRINSIC_MATRIX = ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1))
DEFAULT_DISTORTION = (0, 0, 0, 0, 0)
DEFAULT_WORLD_UP = (0, -1, 0)


class Pose3dEstimator(torch.nn.Module):
    def __init__(self, crop_model, skeleton_infos, joint_transform_matrix):
        super().__init__()

        # Note that only the Trackable resource attributes such as Variables and Models will be
        # retained when saving to SavedModel
        self.crop_model = crop_model
        self.joint_names = self.crop_model.joint_names
        self.joint_edges = self.crop_model.joint_edges
        self.joint_info = JointInfo(self.joint_names, self.joint_edges)
        self.detector = person_detector.PersonDetector()
        self.joint_transform_matrix = torch.tensor(joint_transform_matrix, dtype=torch.float32)

        self.per_skeleton_indices = {
            k: torch.tensor(v['indices'], dtype=torch.int32)
            for k, v in skeleton_infos.items()}
        self.per_skeleton_joint_names = {
            k: v['names'] for k, v in skeleton_infos.items()}
        self.per_skeleton_joint_edges = {
            k: torch.tensor(v['edges'], dtype=torch.int32)
            for k, v in skeleton_infos.items()}
        self.skeleton_joint_indices_table = {k: v['indices'] for k, v in skeleton_infos.items()}

    def detect_poses_batched(
            self, images, intrinsic_matrix=np.array([UNKNOWN_INTRINSIC_MATRIX]),
            distortion_coeffs=np.array([DEFAULT_DISTORTION]),
            extrinsic_matrix=np.array([DEFAULT_EXTRINSIC_MATRIX]),
            world_up_vector=DEFAULT_WORLD_UP, default_fov_degrees=55, internal_batch_size=64,
            antialias_factor=1, num_aug=5, average_aug=True, skeleton='', detector_threshold=0.3,
            detector_nms_iou_threshold=0.7, max_detections=None, detector_flip_aug=False,
            suppress_implausible_poses=True):

        intrinsic_matrix = torch.as_tensor(intrinsic_matrix, dtype=torch.float32)
        distortion_coeffs = torch.as_tensor(distortion_coeffs, dtype=torch.float32)
        extrinsic_matrix = torch.as_tensor(extrinsic_matrix, dtype=torch.float32)
        world_up_vector = torch.as_tensor(world_up_vector, dtype=torch.float32)

        boxes = self.detector(
            images=images, threshold=detector_threshold,
            nms_iou_threshold=detector_nms_iou_threshold, max_detections=max_detections)

        return self._estimate_poses_batched(
            images, boxes, intrinsic_matrix, distortion_coeffs, extrinsic_matrix, world_up_vector,
            default_fov_degrees, internal_batch_size, antialias_factor, num_aug, average_aug,
            skeleton, suppress_implausible_poses)

    def estimate_poses_batched(
            self, images, boxes, intrinsic_matrix=(UNKNOWN_INTRINSIC_MATRIX,),
            distortion_coeffs=(DEFAULT_DISTORTION,),
            extrinsic_matrix=(DEFAULT_EXTRINSIC_MATRIX,), world_up_vector=DEFAULT_WORLD_UP,
            default_fov_degrees=55, internal_batch_size=64, antialias_factor=1, num_aug=5,
            average_aug=True, skeleton=''):
        boxes = torch.cat([boxes, torch.ones_like(boxes[..., :1])], dim=-1)
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

        # TODO: once PyTorch's nested tensors support operations like `mean`,
        #  use them instead of lists.
        n_images = len(images)
        # If one intrinsic matrix is given, repeat it for all images
        if len(intrinsic_matrix) == 1:
            # If intrinsic_matrix is not given, fill it in based on field of view
            if torch.all(intrinsic_matrix == -1):
                intrinsic_matrix = ptu3d.intrinsic_matrix_from_field_of_view(
                    default_fov_degrees, images.shape[2:4])
            intrinsic_matrix = torch.repeat_interleave(intrinsic_matrix, n_images, dim=0)

        # If one distortion coeff/extrinsic matrix is given, repeat it for all images
        if len(distortion_coeffs) == 1:
            distortion_coeffs = torch.repeat_interleave(distortion_coeffs, n_images, dim=0)
        if len(extrinsic_matrix) == 1:
            extrinsic_matrix = torch.repeat_interleave(extrinsic_matrix, n_images, dim=0)

        # Move all camera params to the same device as the input images
        _dev = images.device
        intrinsic_matrix  = intrinsic_matrix.to(_dev)
        distortion_coeffs = distortion_coeffs.to(_dev)
        extrinsic_matrix  = extrinsic_matrix.to(_dev)
        world_up_vector   = world_up_vector.to(_dev)

        # Now repeat these camera params for each box
        n_box_per_image = torch.tensor([len(b) for b in boxes], device=intrinsic_matrix.device)
        intrinsic_matrix = torch.repeat_interleave(intrinsic_matrix, n_box_per_image, dim=0)
        distortion_coeffs = torch.repeat_interleave(distortion_coeffs, n_box_per_image, dim=0)

        # Up-vector in camera-space
        camspace_up = torch.einsum('c,bCc->bC', world_up_vector, extrinsic_matrix[..., :3, :3])
        camspace_up = torch.repeat_interleave(camspace_up, n_box_per_image, dim=0)

        # Set up the test-time augmentation parameters
        aug_gammas = ptu.linspace(np.float32(0.6), np.float32(1.0), num_aug)

        # if FLAGS.rot_aug_360_half:
        #     num_aug_normal = num_aug // 2
        #     aug_angle_range_normal = np.float32(np.deg2rad(FLAGS.rot_aug))
        #     aug_angles_normal = ptu.linspace(
        #         -aug_angle_range_normal, aug_angle_range_normal, num_aug_normal)
        #
        #     num_aug_360 = num_aug - num_aug_normal
        #     aug_angle_range_360 = torch.pi * (1 - 1 / num_aug_360)
        #     aug_angles_360 = ptu.linspace(-aug_angle_range_360, aug_angle_range_360, num_aug_360)
        #
        #     aug_angles = torch.sort(torch.cat([aug_angles_normal, aug_angles_360], dim=0))
        # elif FLAGS.rot_aug_360:
        #     aug_angle_range_360 = torch.pi * (1 - 1 / num_aug)
        #     aug_angles = ptu.linspace(-aug_angle_range_360, aug_angle_range_360, num_aug)
        # else:
        rot_aug = 25
        aug_angle_range = np.float32(np.deg2rad(rot_aug))
        aug_angles = ptu.linspace(-aug_angle_range, aug_angle_range, num_aug)

        aug_scales = torch.cat([
            ptu.linspace(0.8, 1.0, num_aug // 2, endpoint=False),
            torch.linspace(1.0, 1.1, num_aug - num_aug // 2)], dim=0)
        aug_should_flip = (torch.arange(0, num_aug) - num_aug // 2) % 2 != 0
        aug_flipmat = torch.tensor([[-1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=torch.float32)
        aug_maybe_flipmat = torch.where(
            aug_should_flip[:, np.newaxis, np.newaxis], aug_flipmat, torch.eye(3))
        aug_rotmat = ptu3d.rotation_mat(-aug_angles, rot_axis='z')
        aug_rotflipmat = aug_maybe_flipmat @ aug_rotmat

        # crops_flat, poses3d_flat = self._predict_in_batches(
        poses3d_flat = self._predict_in_batches(
            images, intrinsic_matrix, distortion_coeffs, camspace_up, boxes, internal_batch_size,
            aug_should_flip, aug_rotflipmat, aug_gammas, aug_scales, antialias_factor)
        if self.joint_transform_matrix is not None:
            poses3d_flat = torch.einsum(
                'bank,nN->baNk', poses3d_flat, self.joint_transform_matrix)

        # Project the 3D poses to get the 2D poses
        poses2d_flat_normalized = ptu3d.to_homogeneous(
            warping.distort_points(ptu3d.project(poses3d_flat), distortion_coeffs))
        poses2d_flat = torch.einsum(
            'bank,bjk->banj', poses2d_flat_normalized, intrinsic_matrix[:, :2, :])

        # Arrange the results back into ragged tensors
        poses3d = torch.split(poses3d_flat, n_box_per_image)
        poses2d = torch.split(poses2d_flat, n_box_per_image)
        # crops = torch.split(crops_flat, n_box_per_image)

        # if suppress_implausible_poses:
        #     # Filter the resulting poses for individual plausibility to reduce false positives
        #     selected_indices = self._filter_poses(boxes, poses3d, poses2d)
        #     boxes, poses3d, poses2d = [
        #         [x[selected_indices] for x in xs]
        #         for xs in [boxes, poses3d, poses2d]]
        #     # crops = [crop[selected_indices] for crop in crops]

        # Convert to world coordinates
        extrinsic_matrix = torch.repeat_interleave(
            torch.linalg.inv(extrinsic_matrix), torch.tensor([len(p) for p in poses3d]), dim=0)
        poses3d_flat = torch.einsum(
            'bank,bjk->banj', ptu3d.to_homogeneous(torch.cat(poses3d)), extrinsic_matrix[:, :3, :])
        poses3d = torch.split(poses3d_flat, [len(p) for p in poses3d])

        poses3d = self._get_skeleton(poses3d, skeleton)
        poses2d = self._get_skeleton(poses2d, skeleton)

        if average_aug:
            poses3d = [torch.mean(p, dim=-3) for p in poses3d]
            poses2d = [torch.mean(p, dim=-3) for p in poses2d]

        result = dict(boxes=boxes, poses3d=poses3d, poses2d=poses2d)
        # result['crops'] = crops
        return result

    def _predict_in_batches(
            self, images, intrinsic_matrix, distortion_coeffs, camspace_up, boxes,
            internal_batch_size, aug_should_flip, aug_rotflipmat, aug_gammas, aug_scales,
            antialias_factor):

        num_aug = len(aug_gammas)
        boxes_per_batch = internal_batch_size // num_aug
        # boxes may be a stacked tensor [n_images, n_boxes, 5] (estimate_poses path)
        # or a list of per-image tensors (detect_poses path). Normalise to flat 2-D.
        boxes_flat = (boxes.flatten(0, 1) if isinstance(boxes, torch.Tensor)
                      else torch.cat(boxes, dim=0))
        image_id_per_box = torch.repeat_interleave(
            torch.arange(len(boxes)), torch.tensor([len(b) for b in boxes]))

        # aug tensors are created on CPU; move them to wherever intrinsic_matrix lives
        _dev = intrinsic_matrix.device
        aug_should_flip  = aug_should_flip.to(_dev)
        aug_rotflipmat   = aug_rotflipmat.to(_dev)
        aug_gammas       = aug_gammas.to(_dev)
        aug_scales       = aug_scales.to(_dev)
        image_id_per_box = image_id_per_box.to(_dev)

        # Gamma decoding for correct image rescaling later on
        images = (images.float() / 255) ** 2.2

        if boxes_per_batch == 0:
            # Run all as a single batch
            return self._predict_single_batch(
                images, intrinsic_matrix, distortion_coeffs, camspace_up, boxes_flat,
                image_id_per_box, aug_rotflipmat, aug_should_flip, aug_scales, aug_gammas,
                antialias_factor)
        else:
            # Chunk the image crops into batches and predict them one by one
            n_total_boxes = len(boxes_flat)
            n_batches = int(np.ceil(n_total_boxes / boxes_per_batch))
            poses3d_batches = []
            # CROP
            # crop_batches = []
            for i in range(n_batches):
                batch_slice = slice(i * boxes_per_batch, (i + 1) * boxes_per_batch)
                # CROP
                # crops, poses3d = self._predict_single_batch(
                poses3d = self._predict_single_batch(
                    images, intrinsic_matrix[batch_slice], distortion_coeffs[batch_slice],
                    camspace_up[batch_slice], boxes_flat[batch_slice],
                    image_id_per_box[batch_slice], aug_rotflipmat, aug_should_flip, aug_scales,
                    aug_gammas, antialias_factor)
                poses3d_batches.append(poses3d)
                # CROP
                # crop_batches.append(crops)
            # CROP
            # return torch.cat(crop_batches, dim=0), torch.cat(poses3d_batches, dim=0)
            return torch.cat(poses3d_batches, dim=0)

    def _predict_single_batch(
            self, images, intrinsic_matrix, distortion_coeffs, camspace_up, boxes, image_ids,
            aug_rotflipmat, aug_should_flip, aug_scales, aug_gammas, antialias_factor):
        # Get crops and info about the transformation used to create them
        # Each has shape [num_aug, n_boxes, ...]
        crops, new_intrinsic_matrix, R = self._get_crops(
            images, intrinsic_matrix, distortion_coeffs, camspace_up, boxes, image_ids,
            aug_rotflipmat, aug_scales, aug_gammas, antialias_factor)

        # Flatten each and predict the pose with the crop model
        new_intrinsic_matrix_flat = torch.reshape(new_intrinsic_matrix, (-1, 3, 3))
        res = self.crop_model.input_resolution

        crops_flat = torch.reshape(crops, (-1, 3, res, res))
        with torch.autocast(dtype=torch.float16, device_type='cuda'):
            poses_flat = self.crop_model((crops_flat, new_intrinsic_matrix_flat))

        # Unflatten the result
        num_aug = aug_should_flip.shape[0]
        poses = torch.reshape(poses_flat, [num_aug, -1, self.joint_info.n_joints, 3])

        # Reorder the joints for mirrored predictions (e.g., swap left and right wrist)
        left_right_swapped_poses = poses[..., self.joint_info.mirror_mapping, :]
        poses = torch.where(
            torch.reshape(aug_should_flip, [-1, 1, 1, 1]), left_right_swapped_poses, poses)

        # Transform the predictions back into the original camera space
        # We need to multiply by the inverse of R, but since we are using row vectors in `poses`
        # the inverse and transpose cancel out, leaving just R.
        poses_orig_camspace = poses @ R

        # Transpose to [n_boxes, num_aug, ...]
        return poses_orig_camspace.transpose(0, 1)
        # CROP
        # crops = torch.reshape(crops_flat, [num_aug, -1, 3, res, res])
        # return crops.transpose(0, 1), poses_orig_camspace.transpose(0, 1)

    def _get_crops(
            self, images, intrinsic_matrix, distortion_coeffs, camspace_up, boxes, image_ids,
            aug_rotflipmat, aug_scales, aug_gammas, antialias_factor):
        R_noaug, box_scales = self._get_new_rotation_and_scale(
            intrinsic_matrix, distortion_coeffs, camspace_up, boxes)

        # How much we need to scale overall, taking scale augmentation into account
        # From here on, we introduce the dimension of augmentations
        crop_scales = aug_scales[:, np.newaxis] * box_scales[np.newaxis, :]
        # Build the new intrinsic matrix
        num_box = boxes.shape[0]
        num_aug = aug_gammas.shape[0]
        res = self.crop_model.input_resolution
        _dev = intrinsic_matrix.device
        new_intrinsic_matrix = torch.cat([
            torch.cat([
                # Top-left of original intrinsic matrix gets scaled
                intrinsic_matrix[np.newaxis, :, :2, :2] * crop_scales[:, :, np.newaxis, np.newaxis],
                # Principal point is the middle of the new image size
                torch.full((num_aug, num_box, 2, 1), res / 2, dtype=torch.float32, device=_dev)], dim=3),
            torch.cat([
                # [0, 0, 1] as the last row of the intrinsic matrix:
                torch.zeros((num_aug, num_box, 1, 2), dtype=torch.float32, device=_dev),
                torch.ones((num_aug, num_box, 1, 1), dtype=torch.float32, device=_dev)], dim=3)], dim=2)
        R = aug_rotflipmat[:, np.newaxis] @ R_noaug
        new_invprojmat = torch.linalg.inv(new_intrinsic_matrix @ R)

        # If we perform antialiasing through output scaling, we render a larger image first and then
        # shrink it. So we scale the homography first.
        if antialias_factor > 1:
            scaling_mat = warping.corner_aligned_scale_mat(
                1 / antialias_factor)
            new_invprojmat = new_invprojmat @ scaling_mat.to(new_invprojmat.device)

        crops = warping.warp_images_with_pyramid(
            # crops = warping.warp_images(
            images,
            intrinsic_matrix=torch.tile(intrinsic_matrix, [num_aug, 1, 1]),
            new_invprojmats=torch.reshape(new_invprojmat, [-1, 3, 3]),
            distortion_coeffs=torch.tile(distortion_coeffs, [num_aug, 1]),
            crop_scales=torch.reshape(crop_scales, [-1]) * antialias_factor,
            output_shape=(res * antialias_factor, res * antialias_factor),
            image_ids=torch.tile(image_ids, [num_aug]))

        # Downscale the result if we do antialiasing through output scaling
        if antialias_factor == 2:
            crops = torch.nn.functional.avg_pool2d(crops, 2, 2)
        elif antialias_factor == 4:
            crops = torch.nn.functional.avg_pool2d(crops, 4, 4)
        elif antialias_factor > 4:
            crops = torchvision.transforms.functional.resize(
                crops, (res, res), torchvision.transforms.functional.InterpolationMode.BILINEAR,
                antialias=True)
        crops = torch.reshape(crops, [num_aug, num_box, 3, res, res])

        # The division by 2.2 cancels the original gamma decoding from earlier
        crops **= torch.reshape(aug_gammas / 2.2, [-1, 1, 1, 1, 1])
        return crops, new_intrinsic_matrix, R

    def _get_new_rotation_and_scale(self, intrinsic_matrix, distortion_coeffs, camspace_up, boxes):
        # Transform five points on each box: the center and the midpoints of the four sides
        x, y, w, h = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
        boxpoints_homog = ptu3d.to_homogeneous(torch.stack([
            torch.stack([x + w / 2, y + h / 2], dim=1),  # center
            torch.stack([x + w / 2, y], dim=1),
            torch.stack([x + w, y + h / 2], dim=1),
            torch.stack([x + w / 2, y + h], dim=1),
            torch.stack([x, y + h / 2], dim=1)], dim=1))

        boxpoints_camspace = torch.einsum(
            'bpc,bCc->bpC', boxpoints_homog, torch.linalg.inv(intrinsic_matrix))
        boxpoints_camspace = ptu3d.to_homogeneous(
            warping.undistort_points(boxpoints_camspace[:, :, :2], distortion_coeffs))
        # Create a rotation matrix that will put the box center to the principal point
        # and apply the augmentation rotation and flip, to get the new coordinate frame
        box_center_camspace = boxpoints_camspace[:, 0]
        R_noaug = ptu3d.lookat_matrix(forward_vector=box_center_camspace, up_vector=camspace_up)

        # Transform the side midpoints of the box to the new coordinate frame
        sidepoints_camspace = boxpoints_camspace[:, 1:5]
        sidepoints_new = ptu3d.project(torch.einsum(
            'bpc,bCc->bpC', sidepoints_camspace, intrinsic_matrix @ R_noaug))

        # Measure the size of the reprojected boxes
        # TODO consider using 'balanced' cropping
        vertical_size = torch.linalg.norm(sidepoints_new[:, 0] - sidepoints_new[:, 2], dim=-1)
        horiz_size = torch.linalg.norm(sidepoints_new[:, 1] - sidepoints_new[:, 3], dim=-1)
        box_size_new = torch.maximum(vertical_size, horiz_size)

        # How much we need to scale (zoom) to have the boxes fill out the final crop
        box_scales = torch.tensor(self.crop_model.input_resolution,
                                  dtype=box_size_new.dtype) / box_size_new
        return R_noaug, box_scales

    # def _filter_poses(self, boxes, poses3d, poses2d):
    #     poses3d_mean = torch.mean(poses3d, dim=-3)
    #     poses2d_mean = torch.mean(poses2d, dim=-3)
    #
    #     plausible_mask_flat = torch.logical_and(
    #         torch.logical_and(
    #             plausibility_check.is_pose_plausible(
    #                 poses3d_mean.flat_values, self.joint_info),
    #             plausibility_check.are_augmentation_results_consistent(
    #                 poses3d.flat_values)),
    #         plausibility_check.is_pose_consistent_with_box(
    #             poses2d_mean.flat_values, boxes.flat_values))
    #
    #     plausible_mask = tf.RaggedTensor.from_row_lengths(
    #         plausible_mask_flat, boxes.row_lengths())
    #
    #     # Apply pose similarity-based non-maximum suppression to reduce duplicates
    #     nms_indices = tf.map_fn(
    #         fn=lambda args: plausibility_check.pose_non_max_suppression(
    #             *args),
    #         elems=(poses3d_mean, boxes[..., 4], plausible_mask),
    #         fn_output_signature=tf.RaggedTensorSpec(shape=(None,), dtype=tf.int32))
    #     return nms_indices

    def _get_skeleton(self, poses, skeleton):
        return [p[..., self.skeleton_joint_indices_table[skeleton], :] for p in poses]

    def detect_poses(
            self, image, intrinsic_matrix=UNKNOWN_INTRINSIC_MATRIX,
            distortion_coeffs=DEFAULT_DISTORTION, extrinsic_matrix=DEFAULT_EXTRINSIC_MATRIX,
            world_up_vector=DEFAULT_WORLD_UP, default_fov_degrees=55, internal_batch_size=64,
            antialias_factor=1, num_aug=5, average_aug=True, skeleton='', detector_threshold=0.3,
            detector_nms_iou_threshold=0.7, max_detections=-1, detector_flip_aug=False,
            suppress_implausible_poses=True):

        intrinsic_matrix = torch.as_tensor(intrinsic_matrix, dtype=torch.float32)
        distortion_coeffs = torch.as_tensor(distortion_coeffs, dtype=torch.float32)
        extrinsic_matrix = torch.as_tensor(extrinsic_matrix, dtype=torch.float32)
        world_up_vector = torch.as_tensor(world_up_vector, dtype=torch.float32)

        images = image[np.newaxis]
        intrinsic_matrix = intrinsic_matrix[np.newaxis]
        distortion_coeffs = distortion_coeffs[np.newaxis]
        extrinsic_matrix = extrinsic_matrix[np.newaxis]

        result = self.detect_poses_batched(
            images, intrinsic_matrix, distortion_coeffs, extrinsic_matrix, world_up_vector,
            default_fov_degrees, internal_batch_size, antialias_factor, num_aug, average_aug,
            skeleton, detector_threshold, detector_nms_iou_threshold, max_detections,
            detector_flip_aug, suppress_implausible_poses)
        return {k: v[0] for k, v in result.items()}

    def estimate_poses(
            self, image, boxes, intrinsic_matrix=UNKNOWN_INTRINSIC_MATRIX,
            distortion_coeffs=DEFAULT_DISTORTION, extrinsic_matrix=DEFAULT_EXTRINSIC_MATRIX,
            world_up_vector=DEFAULT_WORLD_UP, default_fov_degrees=55, internal_batch_size=64,
            antialias_factor=1, num_aug=5, average_aug=True, skeleton=''):
        intrinsic_matrix = torch.as_tensor(intrinsic_matrix, dtype=torch.float32)
        distortion_coeffs = torch.as_tensor(distortion_coeffs, dtype=torch.float32)
        extrinsic_matrix = torch.as_tensor(extrinsic_matrix, dtype=torch.float32)
        world_up_vector = torch.as_tensor(world_up_vector, dtype=torch.float32)

        images = image[np.newaxis]
        boxes = boxes[np.newaxis]
        intrinsic_matrix = intrinsic_matrix[np.newaxis]
        distortion_coeffs = distortion_coeffs[np.newaxis]
        extrinsic_matrix = extrinsic_matrix[np.newaxis]

        result = self.estimate_poses_batched(
            images, boxes, intrinsic_matrix, distortion_coeffs, extrinsic_matrix, world_up_vector,
            default_fov_degrees, internal_batch_size, antialias_factor, num_aug, average_aug,
            skeleton)
        return {k: v[0] for k, v in result.items()}
