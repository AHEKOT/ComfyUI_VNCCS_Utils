import sys
import urllib.request

import tensorflow_io as tfio

import cameralib
from demos import metrabsviz


def main():
    vizmodel = metrabsviz.VizModel('https://bit.ly/metrabs_l', skeleton='smpl_24')

    frame_batches = tfio.IODataset.from_ffmpeg(get_video(sys.argv[1]), 'v:0').batch(8).prefetch(1)
    camera = cameralib.Camera.from_fov(55, imshape=frame_batches.element_spec.shape[1:3])

    for frame_batch in frame_batches:
        pred = vizmodel.detect_and_visualize_poses_batched(frame_batch, camera)
        # use pred['poses3d']


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
