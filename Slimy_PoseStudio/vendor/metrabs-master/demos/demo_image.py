import sys
import urllib.request

import tensorflow as tf
import tensorflow_hub as tfhub

import cameralib
import poseviz


def main():
    model = tfhub.load('https://bit.ly/metrabs_l')
    skeleton = 'smpl_24'
    joint_names = model.per_skeleton_joint_names[skeleton].numpy().astype(str)
    joint_edges = model.per_skeleton_joint_edges[skeleton].numpy()

    image_filepath = get_image(sys.argv[1])  # You can also specify the filepath directly here.
    image = tf.image.decode_jpeg(tf.io.read_file(image_filepath))
    camera = cameralib.Camera.from_fov(fov_degrees=55, imshape=image.shape[:2])

    with poseviz.PoseViz(joint_names, joint_edges, paused=True) as viz:
        for num_aug in range(1,50):
            pred = model.detect_poses(
                image, detector_threshold=0.01, suppress_implausible_poses=False, max_detections=1,
                intrinsic_matrix=camera.intrinsic_matrix, skeleton=skeleton, num_aug=num_aug)
            print(pred['boxes'])
            viz.update(frame=image, boxes=pred['boxes'], poses=pred['poses3d'], camera=camera)


def get_image(source, temppath='/tmp/image.jpg'):
    if not source.startswith('http'):
        return source

    opener = urllib.request.build_opener()
    opener.addheaders = [('User-agent', 'Mozilla/5.0')]
    urllib.request.install_opener(opener)
    urllib.request.urlretrieve(source, temppath)
    return temppath


if __name__ == '__main__':
    main()
