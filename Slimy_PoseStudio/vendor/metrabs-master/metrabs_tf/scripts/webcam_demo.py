import logging
import os

os.environ['OMP_NUM_THREADS'] = '1'
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '1'
os.environ['KMP_INIT_AT_FORK'] = 'FALSE'

import tensorflow as tf
import tensorflow_hub as tfhub
import numpy as np
import transforms3d
import poseviz

import argparse

import cameralib
import functools
from simplepyutils import FLAGS
import simplepyutils as spu
import tensorflow_inputs as tfinp


def initialize():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-path', type=str, default='https://bit.ly/metrabs_s')
    parser.add_argument('--camera-id', type=int, default=0)
    parser.add_argument('--viz-downscale', type=int, default=4)
    parser.add_argument('--out-video-path', type=str)
    parser.add_argument('--out-video-fps', type=int, default=15)
    parser.add_argument('--num-aug', type=int, default=5)
    parser.add_argument('--skeleton', type=str, default='smpl+head_30')
    parser.add_argument('--batch-size', type=int, default=1)
    parser.add_argument('--internal-batch-size', type=int, default=128)
    parser.add_argument('--max-detections', type=int, default=-1)
    parser.add_argument('--antialias-factor', type=int, default=2)
    parser.add_argument('--detector-flip-aug', action=spu.argparse.BoolAction, default=True)
    parser.add_argument('--random', action=spu.argparse.BoolAction)
    parser.add_argument('--detector-threshold', type=float, default=0.2)
    parser.add_argument('--detector-nms-iou-threshold', type=float, default=0.7)
    parser.add_argument('--pitch', type=float, default=5)
    parser.add_argument('--camera-height', type=float, default=1000)
    spu.argparse.initialize(parser)
    logging.getLogger('absl').setLevel('ERROR')
    for gpu in tf.config.experimental.list_physical_devices('GPU'):
        tf.config.experimental.set_memory_growth(gpu, True)


def main():
    initialize()
    model = tfhub.load(FLAGS.model_path)
    joint_names = model.per_skeleton_joint_names[FLAGS.skeleton].numpy().astype(str)
    joint_edges = model.per_skeleton_joint_edges[FLAGS.skeleton].numpy()

    extrinsic_matrix = np.eye(4, dtype=np.float32)
    extrinsic_matrix[:3, :3] = transforms3d.euler.euler2mat(0, np.deg2rad(FLAGS.pitch), 0, 'ryxz')
    extrinsic_matrix[1, 3] = FLAGS.camera_height
    camera = cameralib.Camera(
        intrinsic_matrix=np.array(
            [[616.68, 0, 301.59], [0, 618.78, 231.30], [0, 0, 1]], np.float32),
        extrinsic_matrix=extrinsic_matrix)
    predict_fn = functools.partial(
        model.detect_poses_batched, intrinsic_matrix=camera.intrinsic_matrix[np.newaxis],
        internal_batch_size=FLAGS.internal_batch_size,
        extrinsic_matrix=extrinsic_matrix[np.newaxis], detector_threshold=FLAGS.detector_threshold,
        detector_nms_iou_threshold=FLAGS.detector_nms_iou_threshold,
        detector_flip_aug=FLAGS.detector_flip_aug,
        max_detections=FLAGS.max_detections,
        antialias_factor=FLAGS.antialias_factor, num_aug=FLAGS.num_aug,
        suppress_implausible_poses=True, skeleton=FLAGS.skeleton)

    viz = poseviz.PoseViz(joint_names, joint_edges, high_quality=False, ground_plane_height=0)
    frame_batches_gpu, frame_batches_cpu = tfinp.webcam(
        capture_id=FLAGS.camera_id, batch_size=FLAGS.batch_size, prefetch_gpu=1)
    progbar = spu.progressbar()
    if FLAGS.out_video_path:
        viz.new_sequence_output(FLAGS.out_video_path, fps=FLAGS.out_video_fps)

    try:
        for frames_gpu, frames_cpu in zip(frame_batches_gpu, frame_batches_cpu):
            # Horizontally flip the images,
            # so that the demo feels more natural, like looking into a mirror.
            frames_gpu = frames_gpu[:, :, ::-1]
            frames_cpu = [f[:, ::-1] for f in frames_cpu]

            pred = predict_fn(frames_gpu)
            for frame, boxes, poses in zip(
                    frames_cpu, pred['boxes'].numpy(), pred['poses3d'].numpy()):
                viz.update(frame, boxes[:, :4], poses, camera, block=False)
                progbar.update()
    finally:
        viz.close()


if __name__ == '__main__':
    main()
