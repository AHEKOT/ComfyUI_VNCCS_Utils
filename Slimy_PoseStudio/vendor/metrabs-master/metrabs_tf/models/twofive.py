import einops
import einops
import fleras
import numpy as np
import tensorflow as tf
from attrdict import AttrDict
from simplepyutils import FLAGS

import metrabs_tf.models.util
from metrabs_tf import tfu, tfu3d
from metrabs_tf.models import eval_metrics


class Model25D(tf.keras.Model):
    def __init__(self, backbone, joint_info, bone_lengths_ideal):
        super().__init__()
        self.backbone = backbone
        self.bone_lengths_ideal = bone_lengths_ideal
        self.joint_names = tf.Variable(np.array(joint_info.names), trainable=False)
        self.joint_edges = tf.Variable(np.array(joint_info.stick_figure_edges), trainable=False)
        n_raw_points = 32 if FLAGS.transform_coords else joint_info.n_joints
        self.edges = joint_info.stick_figure_edges
        self.heatmap_head = Head25D(n_points=n_raw_points)
        self.input_resolution = tf.Variable(np.int32(FLAGS.proc_side), trainable=False)

    def call(self, inp, training=None):
        image, intrinsics = inp
        features = self.backbone(image, training=training)
        coords25d = self.heatmap_head(features, training=training)
        if FLAGS.transform_coords:
            coords25d = self.latent_points_to_joints(coords25d)
        coords3d_abs = tfu3d.reconstruct_absolute_by_bone_lengths(
            coords25d, intrinsics, self.bone_lengths_ideal, self.edges)
        return coords3d_abs

    @tf.function(input_signature=[
        tf.TensorSpec(shape=(None, None, None, 3), dtype=tf.float16),
        tf.TensorSpec(shape=(None, 3, 3), dtype=tf.float32)])
    def predict_multi(self, image, intrinsic_matrix):
        return self.call((image, intrinsic_matrix), training=False)

    def latent_points_to_joints(self, points):
        return tfu3d.linear_combine_points(points, self.recombination_weights)


class Head25D(tf.keras.layers.Layer):
    def __init__(self, n_points):
        super().__init__()
        self.n_points = n_points
        self.conv_final = tf.keras.layers.Conv2D(filters=FLAGS.depth * self.n_points, kernel_size=1)

    def call(self, inp, training=None):
        logits = self.conv_final(inp)
        current_format = 'b h w (d j)' if tfu.get_data_format() == 'NHWC' else 'b (d j) h w'
        logits = einops.rearrange(logits, f'{current_format} -> b h w d j', j=self.n_points)
        coords_heatmap = tfu.soft_argmax(tf.cast(logits, tf.float32), axis=[2, 1, 3])
        return metrabs_tf.models.util.heatmap_to_25d(coords_heatmap, training)


class Model25DTrainer(fleras.ModelTrainer):
    def __init__(self, model25d, joint_info, joint_info2d=None):
        super().__init__()
        self.joint_info = joint_info
        self.joint_info_2d = joint_info2d
        self.model = model25d
        inp = tf.keras.Input(shape=(None, None, 3), dtype=tfu.get_dtype())
        intr = tf.keras.Input(shape=(3, 3), dtype=tf.float32)
        self.model((inp, intr), training=False)

    def forward_train(self, inps, training):
        preds = AttrDict()
        image_both = tf.concat([inps.image, inps.image_2d], axis=0)
        features = self.model.backbone(image_both, training=training)
        coords25d_pred_both = self.model.heatmap_head(features, training=training)
        batch_sizes = [t.shape.as_list()[0] for t in [inps.image, inps.image_2d]]
        preds.coords25d_pred, preds.coords25d_pred_2d = tf.split(
            coords25d_pred_both, batch_sizes, axis=0)

        if FLAGS.transform_coords:
            l2j = self.model.latent_points_to_joints
            preds.coords25d_pred_2d = l2j(preds.coords25d_pred_2d)
            preds.coords25d_pred = l2j(preds.coords25d_pred)

        preds.coords2d_pred = preds.coords25d_pred[..., :2]
        preds.coords3d_pred_abs = tfu3d.reconstruct_absolute_by_bone_lengths(
            preds.coords25d_pred, inps.intrinsics, self.model.bone_lengths_ideal,
            self.model.edges)

        joint_ids_3d = [
            [self.joint_info.ids[n2] for n2 in self.joint_info.names if n2.startswith(n1)]
            for n1 in self.joint_info_2d.names]

        def get_2dlike_joints(coords):
            return tf.stack(
                [tf.reduce_mean(tf.gather(coords, ids, axis=1)[..., :2], axis=1)
                 for ids in joint_ids_3d], axis=1)

        # numbers mean: 25d head, 2d dataset joints, 2d batch
        preds.coords2d_pred_2d = get_2dlike_joints(preds.coords25d_pred_2d[..., :2])
        return preds

    def compute_losses(self, inps, preds):
        losses = AttrDict()
        scale_2d = 1 / FLAGS.proc_side * FLAGS.box_size_mm / 1000
        losses.loss23d = tfu.reduce_mean_masked(
            tf.abs((inps.coords2d_true - preds.coords2d_pred) * scale_2d),
            inps.joint_validity_mask)

        z_ref = tfu3d.center_relative_pose(
            inps.coords3d_true[..., 2], inps.joint_validity_mask,
            FLAGS.mean_relative) + 0.5 * FLAGS.box_size_mm
        z_pred = preds.coords25d_pred[..., 2]
        losses.loss_z = tfu.reduce_mean_masked(
            tf.abs(z_ref - z_pred), inps.joint_validity_mask) / 1000

        losses.loss2d = tfu.reduce_mean_masked(
            tf.abs((inps.coords2d_true_2d - preds.coords2d_pred_2d) * scale_2d),
            inps.joint_validity_mask_2d)

        losses.loss3d = losses.loss_z / 3 + 2 * losses.loss23d / 3
        losses.loss = losses.loss3d + FLAGS.loss2d_factor * losses.loss2d
        return losses

    def compute_metrics(self, inps, preds):
        return eval_metrics.compute_pose3d_metrics(inps, preds)

    def forward_test(self, inps):
        preds = AttrDict()
        features = self.model.backbone(inps.image, training=False)
        coords25d_pred = self.model.heatmap_head(features, training=False)
        if FLAGS.transform_coords:
            coords25d_pred = self.model.latent_points_to_joints(coords25d_pred)

        preds.coords2d_pred = coords25d_pred[..., :2]
        preds.coords3d_pred_abs = tfu3d.reconstruct_absolute_by_bone_lengths(
            coords25d_pred, inps.intrinsics, self.model.bone_lengths_ideal, self.model.edges)
        return preds
