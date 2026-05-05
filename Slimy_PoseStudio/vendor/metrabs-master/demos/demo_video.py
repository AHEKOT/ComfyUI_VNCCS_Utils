import sys
import urllib.request

import tensorflow as tf
import tensorflow_hub as tfhub
import tensorflow_io as tfio

import cameralib
import poseviz


def main():
    model = tfhub.load('https://bit.ly/metrabs_l')
    skeleton = 'smpl_24'
    joint_names = model.per_skeleton_joint_names[skeleton].numpy().astype(str)
    joint_edges = model.per_skeleton_joint_edges[skeleton].numpy()

    video_filepath = get_video(sys.argv[1])  # You can also specify the filepath directly here.
    frame_batches = tfio.IODataset.from_ffmpeg(video_filepath, 'v:0').batch(8).prefetch(1)

    camera = cameralib.Camera.from_fov(
        fov_degrees=55, imshape=frame_batches.element_spec.shape[1:3])

    with poseviz.PoseViz(joint_names, joint_edges) as viz:
        for frame_batch in frame_batches:
            pred = model.detect_poses_batched(
                frame_batch, intrinsic_matrix=camera.intrinsic_matrix[tf.newaxis],
                skeleton=skeleton)

            for frame, boxes, poses in zip(frame_batch, pred['boxes'], pred['poses3d']):
                viz.update(frame=frame, boxes=boxes, poses=poses, camera=camera)


def get_video(source, temppath='/tmp/video.mp4'):
    if not source.startswith('http'):
        return source

    opener = urllib.request.build_opener()
    opener.addheaders = [('User-agent', 'Mozilla/5.0')]
    urllib.request.install_opener(opener)
    urllib.request.urlretrieve(source, temppath)
    return temppath


if __name__ == '__main__':
    main()
