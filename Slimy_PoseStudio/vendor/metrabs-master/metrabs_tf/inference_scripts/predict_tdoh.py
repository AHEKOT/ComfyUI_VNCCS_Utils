import argparse
import functools

import cameralib
import numpy as np
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
    spu.initialize(parser)
    for gpu in tf.config.experimental.list_physical_devices('GPU'):
        tf.config.experimental.set_memory_growth(gpu, True)


def main():
    initialize()
    model = tfhub.load(FLAGS.model_path)
    skeleton = 'lsp_14'
    joint_names = model.per_skeleton_joint_names[skeleton].numpy().astype(str)
    joint_edges = model.per_skeleton_joint_edges[skeleton].numpy()
    predict_fn = functools.partial(
        model.estimate_poses_batched, internal_batch_size=FLAGS.internal_batch_size,
        num_aug=FLAGS.num_aug, antialias_factor=2, skeleton=skeleton)

    viz = poseviz.PoseViz(
        joint_names, joint_edges, queue_size=2 * FLAGS.batch_size) if FLAGS.viz else None

    root = f'{DATA_ROOT}/3doh'
    annotations = spu.load_json(f'{root}/testset/annots.json')
    image_dir = f'{root}/testset/images'
    image_paths = [f'{image_dir}/{image_id}.jpg' for image_id in annotations.keys()]
    image_ids = list(annotations.keys())
    intrinsics = [np.array(anno['intri'], np.float32) for anno in annotations.values()]
    bboxes = [load_bbox(anno) for anno in annotations.values()]
    box_ds = tf.data.Dataset.from_tensor_slices(bboxes)
    intr_ds = tf.data.Dataset.from_tensor_slices(intrinsics)
    extra_ds = tf.data.Dataset.zip((box_ds, intr_ds))
    ds, frame_batches_cpu = tfinp.image_files(
        image_paths, extra_data=extra_ds, batch_size=FLAGS.batch_size, tee_cpu=FLAGS.viz)
    pose_batches = []
    n_batches = int(np.ceil(len(image_paths) / FLAGS.batch_size))

    for (frames_b, (box_b, intr_b)), frames_b_cpu in zip(
            spu.progressbar(ds, total=n_batches), frame_batches_cpu):
        boxes_b = tf.RaggedTensor.from_tensor(box_b[:, tf.newaxis])
        pred = predict_fn(frames_b, boxes_b, intrinsic_matrix=intr_b)
        pred = tf.nest.map_structure(lambda x: tf.squeeze(x, 1).numpy(), pred)
        pose_batches.append(pred['poses3d'])

        if FLAGS.viz:
            for frame, box, intr, pose3d in zip(
                    frames_b_cpu, box_b.numpy(), intr_b.numpy(), pred['poses3d']):
                camera = cameralib.Camera(intrinsic_matrix=intr)
                viz.update(frame, box[np.newaxis], pose3d[np.newaxis], camera)

    np.savez(
        FLAGS.output_path,
        coords3d_pred_cam=np.concatenate(pose_batches, axis=0),
        image_id=image_ids)

    if FLAGS.viz:
        viz.close()


def load_bbox(anno):
    (x1, y1), (x2, y2) = anno['bbox']
    return np.array([x1, y1, x2 - x1, y2 - y1], np.float32)


if __name__ == '__main__':
    main()
