import argparse

import numpy as np
import simplepyutils as spu
import tensorflow as tf
import tensorflow_hub as hub
from simplepyutils import FLAGS, logger

import metrabs_tf.multiperson.multiperson_model


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input-model-path', type=str, required=True)
    parser.add_argument('--output-model-path', type=str, required=True)
    parser.add_argument('--detector-path', type=str)
    parser.add_argument('--bone-length-dataset', type=str)
    parser.add_argument('--bone-length-file', type=str)
    parser.add_argument('--skeleton-types-file', type=str)
    parser.add_argument('--joint-transform-file', type=str)
    parser.add_argument('--rot-aug', type=float, default=25)
    parser.add_argument('--rot-aug-360', action=spu.argparse.BoolAction)
    parser.add_argument('--rot-aug-360-half', action=spu.argparse.BoolAction)
    parser.add_argument('--detector-flip-vertical-too', action=spu.argparse.BoolAction)
    parser.add_argument('--return-crops', action=spu.argparse.BoolAction)
    spu.argparse.initialize(parser)

    crop_model = hub.load(FLAGS.input_model_path)
    detector = hub.load(FLAGS.detector_path) if FLAGS.detector_path else None

    skeleton_infos = spu.load_pickle(FLAGS.skeleton_types_file)
    joint_transform_matrix = (
        np.load(FLAGS.joint_transform_file) if FLAGS.joint_transform_file else None)

    model = metrabs_tf.multiperson.multiperson_model.Pose3dEstimator(
        crop_model, detector, skeleton_infos, joint_transform_matrix)

    tf.saved_model.save(
        model, FLAGS.output_model_path,
        options=tf.saved_model.SaveOptions(experimental_custom_gradients=True),
        signatures=dict(
            detect_poses_batched=model.detect_poses_batched,
            estimate_poses_batched=model.estimate_poses_batched,
            detect_poses=model.detect_poses,
            estimate_poses=model.estimate_poses))
    logger.info(f'Full image model has been exported to {FLAGS.output_model_path}')


if __name__ == '__main__':
    main()
