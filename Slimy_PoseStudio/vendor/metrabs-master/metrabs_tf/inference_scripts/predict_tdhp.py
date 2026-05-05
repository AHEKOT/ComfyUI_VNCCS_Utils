import argparse
import functools

import h5py
import numpy as np
import posepile.ds.tdhp.main as tdhp_main
import poseviz
import simplepyutils as spu
import tensorflow as tf
import tensorflow_hub as tfhub
import tensorflow_inputs as tfinp
from posepile.paths import DATA_ROOT
from simplepyutils import FLAGS


def initialize():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-path', type=str, required=True)
    parser.add_argument('--output-path', type=str, required=True)
    parser.add_argument('--out-video-dir', type=str)
    parser.add_argument('--num-aug', type=int, default=1)
    parser.add_argument('--batch-size', type=int, default=64)
    parser.add_argument('--internal-batch-size', type=int, default=0)
    parser.add_argument('--viz', action=spu.argparse.BoolAction)
    spu.argparse.initialize(parser)
    for gpu in tf.config.experimental.list_physical_devices('GPU'):
        tf.config.experimental.set_memory_growth(gpu, True)


def main():
    initialize()
    model = tfhub.load(FLAGS.model_path)
    skeleton = 'mpi_inf_3dhp_17'
    joint_names = model.per_skeleton_joint_names[skeleton].numpy().astype(str)
    joint_edges = model.per_skeleton_joint_edges[skeleton].numpy()

    predict_fn = functools.partial(
        model.detect_poses_batched, internal_batch_size=FLAGS.internal_batch_size,
        num_aug=FLAGS.num_aug, detector_threshold=0, detector_flip_aug=True, antialias_factor=2,
        max_detections=1, suppress_implausible_poses=False, skeleton=skeleton)

    viz = poseviz.PoseViz(
        joint_names, joint_edges, world_up=(0, 1, 0), downscale=4,
        queue_size=2 * FLAGS.batch_size) if FLAGS.viz else None

    image_relpaths_all = []
    coords_all = []
    cam1_4 = tdhp_main.get_test_camera_subj1_4()
    cam5_6 = tdhp_main.get_test_camera_subj5_6()

    for subj in range(1, 7):
        if FLAGS.viz:
            viz.reinit_camera_view()
            if FLAGS.out_video_dir:
                viz.new_sequence_output(f'{FLAGS.out_video_dir}/TS{subj}.mp4', fps=50)

        camera = cam1_4 if subj <= 4 else cam5_6
        with h5py.File(f'{DATA_ROOT}/3dhp/TS{subj}/annot_data.mat', 'r') as m:
            valid_frames = np.where(m['valid_frame'][:, 0])[0]

        frame_relpaths = [f'3dhp/TS{subj}/imageSequence/img_{i + 1:06d}.jpg' for i in valid_frames]
        frame_paths = [f'{DATA_ROOT}/{p}' for p in frame_relpaths]
        frames_gpu, frames_cpu = tfinp.image_files(
            frame_paths, batch_size=FLAGS.batch_size, prefetch_gpu=2, tee_cpu=FLAGS.viz)

        coords3d_pred_world = predict_sequence(
            predict_fn, frames_gpu, frames_cpu, len(frame_paths), camera, viz)
        image_relpaths_all.append(frame_relpaths)
        coords_all.append(coords3d_pred_world)

    np.savez(
        FLAGS.output_path, image_path=np.concatenate(image_relpaths_all, axis=0),
        coords3d_pred_world=np.concatenate(coords_all, axis=0))

    if FLAGS.viz:
        viz.close()


def predict_sequence(predict_fn, frames_gpu, frames_cpu, n_frames, camera, viz):
    predict_fn = functools.partial(
        predict_fn,
        intrinsic_matrix=camera.intrinsic_matrix[np.newaxis],
        distortion_coeffs=camera.get_distortion_coeffs()[np.newaxis],
        extrinsic_matrix=camera.get_extrinsic_matrix()[np.newaxis],
        world_up_vector=camera.world_up)
    progbar = spu.progressbar(total=n_frames)
    pose_batches = []

    for frames_b, frames_b_cpu in zip(frames_gpu, frames_cpu):
        pred = predict_fn(frames_b)
        pred = tf.nest.map_structure(lambda x: tf.squeeze(x, 1).numpy(), pred)
        pose_batches.append(pred['poses3d'])
        progbar.update(frames_b.shape[0])

        if FLAGS.viz:
            for frame, box, pose3d in zip(frames_b_cpu, pred['boxes'], pred['poses3d']):
                viz.update(frame, box[np.newaxis], pose3d[np.newaxis], camera)

    return np.concatenate(pose_batches, axis=0)


if __name__ == '__main__':
    main()
