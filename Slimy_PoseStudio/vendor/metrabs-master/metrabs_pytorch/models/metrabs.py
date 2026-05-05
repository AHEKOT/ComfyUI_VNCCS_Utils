import os.path as osp

import einops
import numpy as np
import torch
from posepile.paths import DATA_ROOT

import metrabs_pytorch.models.util as model_util
from metrabs_pytorch import ptu, ptu3d
from metrabs_pytorch.util import get_config

class Metrabs(torch.nn.Module):
    def __init__(self, backbone, joint_info):
        super().__init__()
        FLAGS = get_config()
        self.backbone = backbone
        self.joint_names = np.array(joint_info.names)
        edges = np.array([[i, j] for i, j in joint_info.stick_figure_edges])
        self.joint_edges = edges
        self.input_resolution = np.int32(FLAGS.proc_side)
        self.joint_info = joint_info

        if FLAGS.affine_weights:
            if not osp.exists(FLAGS.affine_weights):
                affine_path = f'{DATA_ROOT}/skeleton_conversion/{FLAGS.affine_weights}.npz'
            else:
                affine_path = FLAGS.affine_weights
            ws = np.load(affine_path)
            self.n_latents = ws['w2'].shape[0]
            self.recombination_weights = torch.from_numpy(ws['w2']).float()
            self.encoder_weights = torch.from_numpy(ws['w1']).float()
            self.reconstruction_weights = self.encoder_weights @ self.recombination_weights

            if FLAGS.transform_coords:
                n_raw_points = self.n_latents
            elif FLAGS.predict_all_and_latents:
                n_raw_points = self.n_latents + joint_info.n_joints
            elif FLAGS.regularize_to_manifold:
                n_raw_points = joint_info.n_joints
            else:
                raise Exception('affine weights not used')
        else:
            n_raw_points = joint_info.n_joints

        self.heatmap_heads = MetrabsHeads(n_points=n_raw_points)

    def forward(self, inp):
        FLAGS = get_config()
        image, intrinsics = inp
        features = self.backbone(image)
        coords2d, coords3d = self.heatmap_heads(features)

        if FLAGS.predict_all_and_latents:
            coords2d = coords2d[:, :self.n_latents]
            coords3d = coords3d[:, :self.n_latents]

        coords3d_abs = ptu3d.reconstruct_absolute(
            coords2d, coords3d, intrinsics,
            mix_3d_inside_fov=FLAGS.mix_3d_inside_fov)

        if FLAGS.transform_coords or FLAGS.predict_all_and_latents:
            coords3d_abs = self.latent_points_to_joints(coords3d_abs)

        return coords3d_abs


class MetrabsHeads(torch.nn.Module):
    def __init__(self, n_points):
        super().__init__()
        FLAGS = get_config()
        self.n_points = n_points
        self.n_outs = [self.n_points, FLAGS.depth * self.n_points]
        self.conv_final = torch.nn.LazyConv2d(out_channels=sum(self.n_outs), kernel_size=1)

    def forward(self, inp):
        x = self.conv_final(inp)

        logits2d, logits3d = torch.split(x, self.n_outs, dim=1)
        logits3d = einops.rearrange(logits3d, 'b (d j) h w -> b d j h w ', j=self.n_points)
        coords3d = ptu.soft_argmax(logits3d.float(), dim=(4, 3, 1))
        coords3d_rel_pred = model_util.heatmap_to_metric(coords3d, self.training)
        coords2d = ptu.soft_argmax(logits2d.float(), dim=(3, 2))
        coords2d_pred = model_util.heatmap_to_image(coords2d, self.training)

        return coords2d_pred, coords3d_rel_pred
