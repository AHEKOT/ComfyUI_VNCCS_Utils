"""Functions for loading learning examples from disk and numpy arrays into tensors.
Augmentations are also called from here.
"""
import re

import boxlib
import cameralib
import cv2
import numpy as np
import rlemasklib
from simplepyutils import FLAGS

import metrabs_tf.augmentation.appearance as appearance_aug
import metrabs_tf.augmentation.background as bgaug
from metrabs_tf import improc, tfu, util
from metrabs_tf.util import TRAIN


def load_and_transform3d(ex, joint_info, learning_phase, rng):
    ex = ex.load()
    world_coords = ex.get_world_coords()

    # Get the random number generators for the different augmentations to make it reproducibile
    appearance_rng = util.new_rng(rng)
    background_rng = util.new_rng(rng)
    geom_rng = util.new_rng(rng)
    partial_visi_rng = util.new_rng(rng)

    output_side = FLAGS.proc_side
    output_imshape = (output_side, output_side)

    if 'sailvos' in ex.image_path.lower():
        # This is needed in order not to lose precision in later operations.
        # Background: In the Sailvos dataset (GTA V), some world coordinates
        # are crazy large (several kilometers, i.e. millions of millimeters, which becomes
        # hard to process with the limited simultaneous dynamic range of float32).
        # They are stored in float64 but the processing is done in float32 here.
        world_coords -= ex.camera.t
        ex.camera.t[:] = 0

    box = ex.bbox

    # Partial visibility
    if 'h36m' in ex.image_path.lower() and (
            ('many' in FLAGS.dataset3d or
             'huge' in FLAGS.dataset3d or
             'annotations_28ds' in FLAGS.dataset3d)
            and FLAGS.dataset3d not in ['huge6', 'huge8', 'huge9']):
        partial_visi_prob = 0.5
    else:
        partial_visi_prob = FLAGS.partial_visibility_prob

    use_partial_visi_aug = (
            (learning_phase == TRAIN or FLAGS.test_aug) and
            partial_visi_rng.random() < partial_visi_prob)
    if use_partial_visi_aug:
        box = boxlib.random_partial_subbox(boxlib.expand_to_square(box), partial_visi_rng)

    # Geometric transformation and augmentation
    crop_side = np.max(box[2:])
    center_point = boxlib.center(box)
    if ((learning_phase == TRAIN and FLAGS.geom_aug) or
            (learning_phase != TRAIN and FLAGS.test_aug and FLAGS.geom_aug)):
        center_point += util.random_uniform_disc(geom_rng) * FLAGS.shift_aug / 100 * crop_side

    # The homographic reprojection of a rectangle (bounding box) will not be another rectangle
    # Hence, instead we transform the side midpoints of the short sides of the box and
    # determine an appropriate zoom factor by taking the projected distance of these two points
    # and scaling that to the desired output image side length.
    if box[2] < box[3]:
        # Tall box: take midpoints of top and bottom sides
        delta_y = np.array([0, box[3] / 2])
        sidepoints = center_point + np.stack([-delta_y, delta_y])
    else:
        # Wide box: take midpoints of left and right sides
        delta_x = np.array([box[2] / 2, 0])
        sidepoints = center_point + np.stack([-delta_x, delta_x])

    cam = ex.camera.copy()
    cam.turn_towards(target_image_point=center_point)
    cam.undistort()
    cam.square_pixels()
    cam_sidepoints = cameralib.reproject_image_points(sidepoints, ex.camera, cam)
    crop_side = np.linalg.norm(cam_sidepoints[0] - cam_sidepoints[1])
    cam.zoom(output_side / crop_side)
    cam.center_principal_point(output_imshape)

    if FLAGS.geom_aug and (learning_phase == TRAIN or FLAGS.test_aug):
        s1 = FLAGS.scale_aug_down / 100
        s2 = FLAGS.scale_aug_up / 100
        zoom = geom_rng.uniform(1 - s1, 1 + s2)
        cam.zoom(zoom)
        r = (np.pi if FLAGS.full_rot_aug_prob and geom_rng.random() < FLAGS.full_rot_aug_prob
             else np.deg2rad(FLAGS.rot_aug))
        cam.rotate(roll=geom_rng.uniform(-r, r))

    metric_world_coords = world_coords
    world_coords = ex.univ_coords if FLAGS.universal_skeleton else world_coords

    if FLAGS.geom_aug and learning_phase == TRAIN and geom_rng.random() < 0.5:
        cam.horizontal_flip()
        # Must reorder the joints due to left and right flip
        camcoords = cam.world_to_camera(world_coords)[joint_info.mirror_mapping]
        metric_world_coords = metric_world_coords[joint_info.mirror_mapping]
    else:
        camcoords = cam.world_to_camera(world_coords)

    imcoords = cam.world_to_image(metric_world_coords)

    # Load and reproject image
    if hasattr(ex, 'image') and ex.image is not None:
        origsize_im = ex.image
    else:
        origsize_im = improc.imread(ex.image_path)

    interp_str = (FLAGS.image_interpolation_train
                  if learning_phase == TRAIN else FLAGS.image_interpolation_test)
    antialias = (FLAGS.antialias_train if learning_phase == TRAIN else FLAGS.antialias_test)
    interp = getattr(cv2, 'INTER_' + interp_str.upper())
    im = cameralib.reproject_image(
        origsize_im, ex.camera, cam, output_imshape, antialias_factor=antialias, interp=interp)

    # Color adjustment
    if re.match('.*mupots/TS[1-5]/.+', ex.image_path):
        im = improc.adjust_gamma(im, 0.67, inplace=True)
    elif '3dhp' in ex.image_path and re.match('.+/(TS[1-4])/', ex.image_path):
        im = improc.adjust_gamma(im, 0.67, inplace=True)
        im = improc.white_balance(im, 110, 145)
    elif 'panoptic' in ex.image_path.lower():
        im = improc.white_balance(im, 120, 138)

    # Background augmentation
    if hasattr(ex, 'mask') and ex.mask is not None:
        has_realistic_background = any(
            x in ex.image_path.lower() for x in ['sailvos', 'agora', 'spec-syn', 'hspace'])
        bg_aug_prob = 0.2 if has_realistic_background else FLAGS.background_aug_prob
        if (FLAGS.background_aug_prob and
                (learning_phase == TRAIN or FLAGS.test_aug) and
                background_rng.random() < bg_aug_prob):
            fgmask = rlemasklib.decode(ex.mask)
            fgmask = cameralib.reproject_image(
                fgmask, ex.camera, cam, output_imshape, antialias_factor=antialias, interp=interp)
            im = bgaug.augment_background(im, fgmask, background_rng)

    # Occlusion and color augmentation
    im = appearance_aug.augment_appearance(
        im, learning_phase, FLAGS.occlude_aug_prob, appearance_rng)
    im = tfu.nhwc_to_std(im)
    im = improc.normalize01(im)

    with np.errstate(invalid='ignore'):
        is_joint_in_fov = ~np.any([
            np.any(imcoords < 0, axis=-1),
            np.any(imcoords >= FLAGS.proc_side, axis=-1)], axis=0)

    # Joints with NaN coordinates are invalid
    joint_validity_mask = ~np.any(np.isnan(camcoords), axis=-1)

    rot_to_orig_cam = ex.camera.R @ cam.R.T
    rot_to_world = cam.R.T

    return dict(
        image=im,
        intrinsics=np.float32(cam.intrinsic_matrix),
        image_path=ex.image_path,
        coords3d_true=np.nan_to_num(camcoords).astype(np.float32),
        coords2d_true=np.nan_to_num(imcoords).astype(np.float32),
        rot_to_orig_cam=rot_to_orig_cam.astype(np.float32),
        rot_to_world=rot_to_world.astype(np.float32),
        cam_loc=cam.t.astype(np.float32),
        joint_validity_mask=joint_validity_mask,
        is_joint_in_fov=np.float32(is_joint_in_fov))


def load_and_transform2d(ex, joint_info, learning_phase, rng):
    # Get the random number generators for the different augmentations to make it reproducibile
    appearance_rng = util.new_rng(rng)
    geom_rng = util.new_rng(rng)
    partial_visi_rng = util.new_rng(rng)
    background_rng = util.new_rng(rng)

    # Load the image
    im_from_file = improc.imread(ex.image_path)

    # image_path = util.ensure_absolute_path(ex.image_path)

    # Determine bounding box
    bbox = ex.bbox
    if learning_phase == TRAIN and partial_visi_rng.random() < FLAGS.partial_visibility_prob:
        bbox = boxlib.random_partial_subbox(boxlib.expand_to_square(bbox), partial_visi_rng)

    crop_side = np.max(bbox[2:])
    center_point = boxlib.center(bbox)

    if FLAGS.geom_aug:
        center_point += util.random_uniform_disc(geom_rng) * FLAGS.shift_aug / 100 * crop_side

    has_3d_camera = hasattr(ex, 'camera') and ex.camera is not None
    orig_cam = ex.camera if has_3d_camera else cameralib.Camera.from_fov(8, im_from_file.shape)
    cam = orig_cam.copy()

    if has_3d_camera:
        if bbox[2] < bbox[3]:
            # Tall box: take midpoints of top and bottom sides
            delta_y = np.array([0, bbox[3] / 2])
            sidepoints = center_point + np.stack([-delta_y, delta_y])
        else:
            # Wide box: take midpoints of left and right sides
            delta_x = np.array([bbox[2] / 2, 0])
            sidepoints = center_point + np.stack([-delta_x, delta_x])

        cam.turn_towards(target_image_point=center_point)
        cam.undistort()
        cam.square_pixels()
        cam_sidepoints = cameralib.reproject_image_points(sidepoints, ex.camera, cam)
        crop_side = np.linalg.norm(cam_sidepoints[0] - cam_sidepoints[1])

    cam.zoom(FLAGS.proc_side / crop_side)

    if FLAGS.geom_aug:
        s1 = FLAGS.scale_aug_down / 100
        s2 = FLAGS.scale_aug_up / 100
        cam.zoom(geom_rng.uniform(1 - s1, 1 + s2))
        r = (np.pi if FLAGS.full_rot_aug_prob and geom_rng.random() < FLAGS.full_rot_aug_prob
             else np.deg2rad(FLAGS.rot_aug))
        cam.rotate(roll=geom_rng.uniform(-r, r))

    if FLAGS.geom_aug and learning_phase == TRAIN and geom_rng.random() < 0.5:
        cam.horizontal_flip()
        # Must reorder the joints due to left and right flip
        imcoords = ex.coords[joint_info.mirror_mapping]
    else:
        imcoords = ex.coords

    if has_3d_camera:
        cam.center_principal_point((FLAGS.proc_side, FLAGS.proc_side))
    else:
        new_center_point = cameralib.reproject_image_points(center_point, orig_cam, cam)
        cam.shift_to_center(new_center_point, (FLAGS.proc_side, FLAGS.proc_side))

    is_annotation_invalid = (np.nan_to_num(imcoords[:, 1]) > im_from_file.shape[0] * 0.95)
    imcoords[is_annotation_invalid] = np.nan
    imcoords = cameralib.reproject_image_points(imcoords, orig_cam, cam)

    interp_str = (FLAGS.image_interpolation_train
                  if learning_phase == TRAIN else FLAGS.image_interpolation_test)
    antialias = (FLAGS.antialias_train if learning_phase == TRAIN else FLAGS.antialias_test)
    interp = getattr(cv2, 'INTER_' + interp_str.upper())
    im = cameralib.reproject_image(
        im_from_file, orig_cam, cam, (FLAGS.proc_side, FLAGS.proc_side),
        antialias_factor=antialias, interp=interp)

    # Background augmentation
    if (hasattr(ex, 'mask') and
            ex.mask is not None and
            FLAGS.background_aug_prob and
            (learning_phase == TRAIN or FLAGS.test_aug) and
            background_rng.random() < FLAGS.background_aug_prob):
        fgmask = rlemasklib.decode(ex.mask)
        fgmask = cameralib.reproject_image(
            fgmask, orig_cam, cam, (FLAGS.proc_side, FLAGS.proc_side),
            antialias_factor=antialias, interp=interp)
        im = bgaug.augment_background(im, fgmask, background_rng)

    # Occlusion and color augmentation
    im = appearance_aug.augment_appearance(
        im, learning_phase, FLAGS.occlude_aug_prob, appearance_rng)
    im = tfu.nhwc_to_std(im)
    im = improc.normalize01(im)

    joint_validity_mask = ~np.any(np.isnan(imcoords), axis=1)
    with np.errstate(invalid='ignore'):
        is_joint_in_fov = ~np.logical_or(
            np.any(imcoords < 0, axis=-1),
            np.any(imcoords >= FLAGS.proc_side, axis=-1))

    # We must eliminate NaNs because some TensorFlow ops can't deal with any NaNs touching them,
    # even if they would not influence the result. Therefore we use a separate "joint_validity_mask"
    # to indicate which joint coords are valid.
    imcoords = np.nan_to_num(imcoords)

    return dict(
        image_2d=np.float32(im),
        intrinsics_2d=np.float32(cam.intrinsic_matrix),
        image_path_2d=ex.image_path,
        coords2d_true_2d=np.float32(imcoords),
        joint_validity_mask_2d=joint_validity_mask,
        is_joint_in_fov_2d=is_joint_in_fov)
