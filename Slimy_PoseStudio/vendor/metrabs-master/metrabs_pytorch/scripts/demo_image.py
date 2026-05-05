import argparse
import urllib.request

import cameralib
import numpy as np
import posepile.joint_info
import poseviz
import simplepyutils as spu
import torch
import torchvision.io

import metrabs_pytorch.backbones.efficientnet as effnet_pt
import metrabs_pytorch.models.metrabs as metrabs_pt
from metrabs_pytorch.multiperson import multiperson_model
from metrabs_pytorch.util import get_config


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', type=str)
    parser.add_argument('--image-path', type=str)
    spu.argparse.initialize(parser)
    get_config(f'{spu.FLAGS.model_dir}/config.yaml')

    skeleton = 'smpl+head_30'

    multiperson_model_pt = load_multiperson_model().cuda()
    joint_names = multiperson_model_pt.per_skeleton_joint_names[skeleton]
    joint_edges = multiperson_model_pt.per_skeleton_joint_edges[skeleton].cpu().numpy()

    with torch.inference_mode(), torch.device('cuda'):
        with poseviz.PoseViz(joint_names, joint_edges, paused=True) as viz:
            image_filepath = get_image(spu.argparse.FLAGS.image_path)
            image = torchvision.io.read_image(image_filepath).cuda()
            camera = cameralib.Camera.from_fov(fov_degrees=55, imshape=image.shape[1:])

            for num_aug in range(1, 50):
                pred = multiperson_model_pt.detect_poses(
                    image, detector_threshold=0.01, suppress_implausible_poses=False,
                    max_detections=1, intrinsic_matrix=camera.intrinsic_matrix,
                    skeleton=skeleton, num_aug=num_aug)

                viz.update(
                    frame=image.cpu().numpy().transpose(1, 2, 0),
                    boxes=pred['boxes'].cpu().numpy(),
                    poses=pred['poses3d'].cpu().numpy(), camera=camera)


def load_multiperson_model():
    model_pytorch = load_crop_model()
    skeleton_infos = spu.load_pickle(f'{spu.FLAGS.model_dir}/skeleton_infos.pkl')
    joint_transform_matrix = np.load(f'{spu.FLAGS.model_dir}/joint_transform_matrix.npy')

    with torch.device('cuda'):
        return multiperson_model.Pose3dEstimator(
            model_pytorch.cuda(), skeleton_infos, joint_transform_matrix)


def load_crop_model():
    cfg = get_config()
    ji_np = np.load(f'{spu.FLAGS.model_dir}/joint_info.npz')
    ji = posepile.joint_info.JointInfo(ji_np['joint_names'], ji_np['joint_edges'])
    backbone_raw = getattr(effnet_pt, f'efficientnet_v2_{cfg.efficientnet_size}')()
    preproc_layer = effnet_pt.PreprocLayer()
    backbone = torch.nn.Sequential(preproc_layer, backbone_raw.features)
    model = metrabs_pt.Metrabs(backbone, ji)
    model.eval()

    inp = torch.zeros((1, 3, cfg.proc_side, cfg.proc_side), dtype=torch.float32)
    intr = torch.eye(3, dtype=torch.float32)[np.newaxis]

    model((inp, intr))
    model.load_state_dict(torch.load(f'{spu.FLAGS.model_dir}/ckpt.pt'))
    return model


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
