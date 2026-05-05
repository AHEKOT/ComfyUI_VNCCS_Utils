import argparse
import functools
import itertools

import numpy as np
import posepile.ds.h36m.main as h36m_main
import poseviz
import simplepyutils as spu
import spacepy
import tensorflow as tf
import tensorflow_hub as tfhub
import tensorflow_inputs as tfinp
from posepile.paths import DATA_ROOT
from simplepyutils import FLAGS, logger


def initialize():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-path', type=str, required=True)
    parser.add_argument('--output-path', type=str, required=True)
    parser.add_argument('--out-video-dir', type=str)
    parser.add_argument('--num-joints', type=int, default=17)
    parser.add_argument('--num-aug', type=int, default=1)
    parser.add_argument('--frame-step', type=int, default=64)
    parser.add_argument('--batch-size', type=int, default=64)
    parser.add_argument('--internal-batch-size', type=int, default=0)
    parser.add_argument('--correct-S9', action=spu.argparse.BoolAction, default=False)
    parser.add_argument('--viz', action=spu.argparse.BoolAction)
    spu.argparse.initialize(parser)
    for gpu in tf.config.experimental.list_physical_devices('GPU'):
        tf.config.experimental.set_memory_growth(gpu, True)


def main():
    initialize()
    model = tfhub.load(FLAGS.model_path)
    assert FLAGS.num_joints in (17, 25)
    skeleton = f'h36m_{FLAGS.num_joints}'
    joint_names = model.per_skeleton_joint_names[skeleton].numpy().astype(str)
    joint_edges = model.per_skeleton_joint_edges[skeleton].numpy()
    predict_fn = functools.partial(
        model.estimate_poses_batched, internal_batch_size=FLAGS.internal_batch_size,
        num_aug=FLAGS.num_aug, antialias_factor=2, skeleton=skeleton)

    viz = poseviz.PoseViz(
        joint_names, joint_edges, world_up=(0, 0, 1), ground_plane_height=0,
        queue_size=2 * FLAGS.batch_size) if FLAGS.viz else None

    image_relpaths_all = []
    coords_all = []
    for i_subject in (9, 11):
        for activity_name, camera_id in itertools.product(
                h36m_main.get_activity_names(i_subject), range(4)):
            if FLAGS.viz:
                viz.reinit_camera_view()
                if FLAGS.out_video_dir:
                    viz.new_sequence_output(
                        f'{FLAGS.out_video_dir}/S{i_subject}/{activity_name}.{camera_id}.mp4',
                        fps=max(50 / FLAGS.frame_step, 2))

            logger.info(f'Predicting S{i_subject} {activity_name} {camera_id}...')
            frame_relpaths, bboxes, camera = get_sequence(i_subject, activity_name, camera_id)
            frame_paths = [f'{DATA_ROOT}/{p}' for p in frame_relpaths]
            box_ds = tf.data.Dataset.from_tensor_slices(bboxes)
            ds, frame_batches_cpu = tfinp.image_files(
                frame_paths, extra_data=box_ds, batch_size=FLAGS.batch_size, tee_cpu=FLAGS.viz)

            coords3d_pred_world = predict_sequence(predict_fn, ds, frame_batches_cpu, camera, viz)
            image_relpaths_all.append(frame_relpaths)
            coords_all.append(coords3d_pred_world)

    np.savez(
        FLAGS.output_path, image_path=np.concatenate(image_relpaths_all, axis=0),
        coords3d_pred_world=np.concatenate(coords_all, axis=0))

    if FLAGS.viz:
        viz.close()


def predict_sequence(predict_fn, dataset, frame_batches_cpu, camera, viz):
    predict_fn = functools.partial(
        predict_fn, intrinsic_matrix=camera.intrinsic_matrix[np.newaxis],
        extrinsic_matrix=camera.get_extrinsic_matrix()[np.newaxis],
        distortion_coeffs=camera.get_distortion_coeffs()[np.newaxis],
        world_up_vector=camera.world_up)

    pose_batches = []

    for (frames_b, box_b), frames_b_cpu in zip(dataset, frame_batches_cpu):
        boxes_b = tf.RaggedTensor.from_tensor(box_b[:, tf.newaxis])
        pred = predict_fn(frames_b, boxes_b)
        pred = tf.nest.map_structure(lambda x: tf.squeeze(x, 1).numpy(), pred)
        pose_batches.append(pred['poses3d'])

        if FLAGS.viz:
            for frame, box, pose3d in zip(frames_b_cpu, box_b.numpy(), pred['poses3d']):
                viz.update(frame, box[np.newaxis], pose3d[np.newaxis], camera)

    return np.concatenate(pose_batches, axis=0)


def get_sequence(i_subject, activity_name, i_camera):
    camera_name = ['54138969', '55011271', '58860488', '60457274'][i_camera]
    camera = h36m_main.get_cameras(
        f'{DATA_ROOT}/h36m/Release-v1.2/metadata.xml')[i_camera][i_subject - 1]
    coord_path = (f'{DATA_ROOT}/h36m/S{i_subject}/'
                  f'MyPoseFeatures/D3_Positions/{activity_name}.cdf')

    with spacepy.pycdf.CDF(coord_path) as cdf_file:
        coords_raw_all = np.array(cdf_file['Pose'], np.float32)[0]
    n_total_frames = coords_raw_all.shape[0]
    coords_raw = coords_raw_all[::FLAGS.frame_step]
    i_relevant_joints = [1, 2, 3, 6, 7, 8, 12, 13, 14, 15, 17, 18, 19, 25, 26, 27, 0]
    world_coords = coords_raw.reshape([coords_raw.shape[0], -1, 3])[:, i_relevant_joints]
    image_relfolder = f'h36m/S{i_subject}/Images/{activity_name}.{camera_name}'
    image_relpaths = [f'{image_relfolder}/frame_{i_frame:06d}.jpg'
                      for i_frame in range(0, n_total_frames, FLAGS.frame_step)]
    bbox_path = f'{DATA_ROOT}/h36m/S{i_subject}/BBoxes/{activity_name}.{camera_name}.npy'
    bboxes = np.load(bbox_path)[::FLAGS.frame_step]
    assert len(bboxes) == len(image_relpaths) == len(world_coords)
    if FLAGS.correct_S9:
        world_coords = h36m_main.correct_world_coords(world_coords, coord_path)
        bboxes = h36m_main.correct_boxes(bboxes, bbox_path, world_coords, camera)

    return image_relpaths, bboxes, camera


if __name__ == '__main__':
    main()
