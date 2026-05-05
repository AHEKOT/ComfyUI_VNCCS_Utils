import argparse
import functools

import numpy as np
import posekit.io
import posepile.ds.aspset.main as aspset_main
import poseviz
import simplepyutils as spu
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
    skeleton = 'aspset_17'
    joint_names = model.per_skeleton_joint_names[skeleton].numpy().astype(str)
    joint_edges = model.per_skeleton_joint_edges[skeleton].numpy()
    predict_fn = functools.partial(
        model.estimate_poses_batched, internal_batch_size=FLAGS.internal_batch_size,
        num_aug=FLAGS.num_aug, antialias_factor=2, skeleton=skeleton)

    viz = poseviz.PoseViz(
        joint_names, joint_edges, world_up=(0, -1, 0), ground_plane_height=0,
        queue_size=2 * FLAGS.batch_size) if FLAGS.viz else None

    aspset_root = f'{DATA_ROOT}/aspset/data'
    seq_train, seq_val, seq_test = aspset_main.load_split(f'{aspset_root}/splits.csv')

    for subj_id, vid_id, view in spu.progressbar(seq_test):
        bboxes = aspset_main.load_boxes(
            f'{aspset_root}/test/boxes/{subj_id}/{subj_id}-{vid_id}-{view}.csv')
        camera = aspset_main.load_camera(
            f'{aspset_root}/test/cameras/{subj_id}/{subj_id}-{view}.json')
        video_path = f'{aspset_root}/test/videos/{subj_id}/{subj_id}-{vid_id}-{view}.mkv'

        logger.info(f'Predicting {video_path}...')
        box_ds = tf.data.Dataset.from_tensor_slices(bboxes)
        ds, frame_batches_cpu = tfinp.video_file(
            video_path, extra_data=box_ds, batch_size=FLAGS.batch_size, tee_cpu=FLAGS.viz)

        coords3d_pred_world = predict_sequence(predict_fn, ds, frame_batches_cpu, camera, viz)
        mocap = posekit.io.Mocap(coords3d_pred_world, 'aspset_17j', 50)
        out_file = f'{FLAGS.output_path}/{subj_id}-{vid_id}-{view}.c3d'
        spu.ensure_parent_dir_exists(out_file)
        posekit.io.save_mocap(mocap, out_file)

    if FLAGS.viz:
        viz.close()


def predict_sequence(predict_fn, dataset, frame_batches_cpu, camera, viz):
    predict_fn = functools.partial(
        predict_fn, intrinsic_matrix=camera.intrinsic_matrix[np.newaxis],
        extrinsic_matrix=camera.get_extrinsic_matrix()[np.newaxis],
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


if __name__ == '__main__':
    main()
