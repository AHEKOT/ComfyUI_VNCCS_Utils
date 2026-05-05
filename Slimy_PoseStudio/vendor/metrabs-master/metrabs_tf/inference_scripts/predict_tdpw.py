import argparse
import functools
import glob
import itertools
import os.path as osp
import random

import cameralib
import more_itertools
import numpy as np
import poseviz
import rlemasklib
import scipy.optimize
import simplepyutils as spu
import tensorflow as tf
import tensorflow_hub as tfhub
import tensorflow_inputs as tfinp
from posepile.joint_info import JointInfo
from posepile.paths import DATA_ROOT
from simplepyutils import FLAGS, logger

from metrabs_tf import improc


def initialize():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-path', type=str, required=True)
    parser.add_argument('--output-path', type=str, required=True)
    parser.add_argument('--out-video-dir', type=str)
    parser.add_argument('--default-fov', type=float, default=55)
    parser.add_argument('--num-aug', type=int, default=5)
    parser.add_argument('--real-intrinsics', action=spu.argparse.BoolAction)
    parser.add_argument('--gtassoc', action=spu.argparse.BoolAction)
    parser.add_argument('--batch-size', type=int, default=64)
    parser.add_argument('--internal-batch-size', type=int, default=64)
    parser.add_argument('--antialias-factor', type=int, default=2)
    parser.add_argument('--viz', action=spu.argparse.BoolAction)
    spu.argparse.initialize(parser)
    for gpu in tf.config.experimental.list_physical_devices('GPU'):
        tf.config.experimental.set_memory_growth(gpu, True)


def main():
    initialize()
    model = tfhub.load(FLAGS.model_path)
    ji3d = get_joint_info(model, 'smpl_24')

    predict_fn = functools.partial(
        model.detect_poses_batched, internal_batch_size=FLAGS.internal_batch_size,
        detector_threshold=0.2, detector_nms_iou_threshold=0.7, detector_flip_aug=True,
        antialias_factor=FLAGS.antialias_factor, num_aug=FLAGS.num_aug,
        suppress_implausible_poses=False, default_fov_degrees=FLAGS.default_fov, skeleton='smpl_24')

    seq_filepaths = sorted(glob.glob(f'{DATA_ROOT}/3dpw/sequenceFiles/*/*.pkl'))
    random.shuffle(seq_filepaths)
    seq_names = [osp.basename(p).split('.')[0] for p in seq_filepaths]

    ji2d = JointInfo(
        'nose,neck,rsho,relb,rwri,lsho,lelb,lwri,rhip,rkne,rank,lhip,lkne,lank,reye,leye,lear,rear',
        'lsho-lelb-lwri,rsho-relb-rwri,lhip-lkne-lank,rhip-rkne-rank,lear-leye-nose-reye-rear')
    viz = poseviz.PoseViz(ji3d.names, ji3d.stick_figure_edges) if FLAGS.viz else None

    for seq_name, seq_filepath in spu.progressbar(zip(seq_names, seq_filepaths)):
        if FLAGS.viz:
            viz.reinit_camera_view()
            if FLAGS.out_video_dir:
                viz.new_sequence_output(f'{FLAGS.out_video_dir}/{seq_name}.mp4', fps=25)

        already_done_files = glob.glob(f'{FLAGS.output_path}/*/*.pkl')
        if any(seq_name in p for p in already_done_files):
            logger.info(f'{seq_name} has been processed already.')
            continue
        logger.info(f'Predicting {seq_name}...')
        frame_paths = sorted(
            glob.glob(f'{DATA_ROOT}/3dpw/imageFiles/{seq_name}/image_*.jpg'))
        n_frames = len(frame_paths)
        poses2d_true = get_poses2d_3dpw(seq_name)
        frames_gpu, frames_cpu = tfinp.image_files(
            frame_paths, batch_size=FLAGS.batch_size, prefetch_gpu=2, tee_cpu=True)

        camera = get_3dpw_camera(seq_filepath) if FLAGS.real_intrinsics else None
        cameras = itertools.repeat(camera, times=n_frames) if camera is not None else None
        if not FLAGS.gtassoc:
            masks = spu.load_pickle(f'{DATA_ROOT}/3dpw-more/stcn-pred/{seq_name}.pkl')
        else:
            masks = None

        tracks = predict_sequence(
            predict_fn, frames_gpu, frames_cpu, n_frames, poses2d_true, masks, ji2d, ji3d,
            viz, cameras)
        save_result_file(seq_name, FLAGS.output_path, tracks)

    if viz is not None:
        viz.close()


def predict_sequence(
        predict_fn, frame_batches_gpu, frame_batches_cpu, n_frames, poses2d_true, masks,
        joint_info2d, joint_info3d, viz, cameras=None):
    n_tracks = poses2d_true.shape[1]
    prev_poses2d_pred_ordered = np.zeros((n_tracks, joint_info3d.n_joints, 2))
    tracks = [[] for _ in range(n_tracks)]
    if cameras is not None:
        camera_batches = more_itertools.chunked(cameras, FLAGS.batch_size)
    else:
        camera_batches = itertools.repeat(None)
    progbar = spu.progressbar(total=n_frames)
    i_frame = 0
    for frames_gpu, frames_cpu, camera_batch in zip(
            frame_batches_gpu, frame_batches_cpu, camera_batches):
        if camera_batch is not None:
            extr = np.array([c.get_extrinsic_matrix() for c in camera_batch], dtype=np.float32)
            intr = np.array([c.intrinsic_matrix for c in camera_batch], dtype=np.float32)
            # print(extr.shape, intr.shape, frames_gpu.shape)
            pred = predict_fn(frames_gpu, extrinsic_matrix=extr, intrinsic_matrix=intr)
        else:
            camera_batch = itertools.repeat(None)
            pred = predict_fn(frames_gpu)

        pred = tf.nest.map_structure(lambda x: x.numpy(), pred)

        for frame, boxes, poses3d, poses2d, camera in zip(
                frames_cpu, pred['boxes'], pred['poses3d'], pred['poses2d'], camera_batch):
            if FLAGS.gtassoc:
                poses3d_ordered, prev_poses2d_pred_ordered = associate_predictions(
                    poses3d, poses2d, poses2d_true[i_frame], prev_poses2d_pred_ordered,
                    joint_info3d, joint_info2d)
            else:
                poses3d_ordered = associate_predictions_to_masks(
                    poses3d, poses2d, frame.shape[:2], masks[i_frame], joint_info3d)

            for pose, track in zip(poses3d_ordered, tracks):
                if not np.any(np.isnan(pose)):
                    track.append((i_frame, pose))

            poses3d = np.array([t[-1][1] for t in tracks if t])
            if viz is not None:
                if camera is None:
                    camera = cameralib.Camera.from_fov(FLAGS.default_fov, frame.shape)
                viz.update(frame, boxes[:, :4], poses3d, camera)
            progbar.update(1)
            i_frame += 1

    return tracks


def get_3dpw_camera(seq_filepath):
    intr = spu.load_pickle(seq_filepath)['cam_intrinsics']
    return cameralib.Camera(intrinsic_matrix=intr, world_up=[0, -1, 0])


def get_poses2d_3dpw(seq_name):
    seq_filepaths = glob.glob(f'{DATA_ROOT}/3dpw/sequenceFiles/*/*.pkl')
    filepath = next(p for p in seq_filepaths if osp.basename(p) == f'{seq_name}.pkl')
    seq = spu.load_pickle(filepath)
    return np.transpose(np.array(seq['poses2d']), [1, 0, 3, 2])  # [Frame, Track, Joint, Coord]


def pose2d_auc(pose2d_pred, pose2d_true, prev_pose2d_pred, joint_info3d, joint_info2d):
    pose2d_true = pose2d_true.copy()
    pose2d_true[pose2d_true[:, 2] < 0.2] = np.nan
    selected_joints = 'lsho,rsho,lelb,relb,lhip,rhip,lkne,rkne'.split(',')
    indices_true = [joint_info2d.ids[name] for name in selected_joints]
    indices_pred = [joint_info3d.ids[name] for name in selected_joints]
    size = np.linalg.norm(pose2d_pred[joint_info3d.ids.rsho] - pose2d_pred[joint_info3d.ids.lhip])
    dist = np.linalg.norm(pose2d_true[indices_true, :2] - pose2d_pred[indices_pred], axis=-1)
    if np.count_nonzero(~np.isnan(dist)) < 5:
        dist = np.linalg.norm(prev_pose2d_pred[indices_pred] - pose2d_pred[indices_pred], axis=-1)
    return np.nanmean(np.maximum(0, 1 - dist / size))


def associate_predictions(
        poses3d_pred, poses2d_pred, poses2d_true, prev_poses2d_pred_ordered, joint_info3d,
        joint_info2d):
    auc_matrix = np.array([
        [pose2d_auc(pose_pred, pose_true, prev_pose, joint_info3d, joint_info2d)
         for pose_pred in poses2d_pred]
        for pose_true, prev_pose in zip(poses2d_true, prev_poses2d_pred_ordered)])

    true_indices, pred_indices = scipy.optimize.linear_sum_assignment(-auc_matrix)
    n_true_poses = len(poses2d_true)

    result = np.full((n_true_poses, joint_info3d.n_joints, 3), np.nan)
    poses2d_pred_ordered = np.array(prev_poses2d_pred_ordered).copy()
    for ti, pi in zip(true_indices, pred_indices):
        result[ti] = poses3d_pred[pi]
        poses2d_pred_ordered[ti] = poses2d_pred[pi]

    return result, poses2d_pred_ordered


def associate_predictions_to_masks(poses3d_pred, poses2d_pred, frame_shape, masks, joint_info3d):
    masks = np.array([rlemasklib.decode(m) for m in masks])
    mask_shape = masks.shape[1:3]
    mask_size = np.array([mask_shape[1], mask_shape[0]], np.float32)
    frame_size = np.array([frame_shape[1], frame_shape[0]], np.float32)
    poses2d_pred = poses2d_pred * mask_size / frame_size
    pose_masks = np.array([pose_to_mask(p, mask_shape, joint_info3d, 8) for p in poses2d_pred])
    iou_matrix = np.array([[rlemasklib.iou(m1, m2) for m2 in pose_masks] for m1 in masks])
    true_indices, pred_indices = scipy.optimize.linear_sum_assignment(-iou_matrix)
    n_true_poses = len(masks)

    result = np.full((n_true_poses, joint_info3d.n_joints, 3), np.nan)
    for ti, pi in zip(true_indices, pred_indices):
        result[ti] = poses3d_pred[pi]
    return result


def complete_track(track, n_frames):
    track_dict = dict(track)
    result = []
    for i in range(n_frames):
        if i in track_dict:
            result.append(track_dict[i])
        elif result:
            result.append(result[-1])
        else:
            result.append(np.full_like(track[0][1], fill_value=np.nan))
    return result


def save_result_file(seq_name, pred_dir, tracks):
    seq_filepaths = glob.glob(f'{DATA_ROOT}/3dpw/sequenceFiles/*/*.pkl')
    seq_path = next(p for p in seq_filepaths if osp.basename(p) == f'{seq_name}.pkl')
    rel_path = '/'.join(spu.split_path(seq_path)[-2:])
    out_path = f'{pred_dir}/{rel_path}'
    n_frames = len(glob.glob(f'{DATA_ROOT}/3dpw/imageFiles/{seq_name}/image_*.jpg'))
    coords3d_raw = np.array([complete_track(track, n_frames) for track in tracks]) / 1000
    spu.dump_pickle(dict(jointPositions=coords3d_raw), out_path)


def get_joint_info(model, skeleton):
    joint_names = model.per_skeleton_joint_names[skeleton].numpy().astype(str)
    edges = model.per_skeleton_joint_edges[skeleton].numpy()
    return JointInfo(joint_names, edges)


def pose_to_mask(pose2d, imshape, joint_info, thickness, thresh=0.2):
    result = np.zeros(imshape[:2], dtype=np.uint8)
    if pose2d.shape[1] == 3:
        is_valid = pose2d[:, 2] > thresh
    else:
        is_valid = np.ones(shape=[pose2d.shape[0]], dtype=np.bool)

    for i_joint1, i_joint2 in joint_info.stick_figure_edges:
        if pose2d.shape[1] != 3 or (is_valid[i_joint1] and is_valid[i_joint2]):
            improc.line(
                result, pose2d[i_joint1, :2], pose2d[i_joint2, :2], color=(1, 1, 1),
                thickness=thickness)

    j = joint_info.ids
    torso_joints = [j.lhip, j.rhip, j.rsho, j.lsho]
    if np.all(is_valid[torso_joints]):
        improc.fill_polygon(result, pose2d[torso_joints, :2], (1, 1, 1))
    return result


if __name__ == '__main__':
    main()
