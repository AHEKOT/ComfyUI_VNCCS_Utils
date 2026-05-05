import einops
import fleras
import numpy as np
import tensorflow as tf
from attrdict import AttrDict
from simplepyutils import FLAGS

import metrabs_tf.models.util
from metrabs_tf import tfu, tfu3d
from metrabs_tf.models import eval_metrics


class Metro(tf.keras.Model):
    def __init__(self, backbone, joint_info):
        super().__init__()
        self.backbone = backbone
        self.joint_names = tf.Variable(np.array(joint_info.names), trainable=False)
        self.joint_edges = tf.Variable(np.array(joint_info.stick_figure_edges), trainable=False)
        self.input_resolution = tf.Variable(np.int32(FLAGS.proc_side), trainable=False)
        self.heatmap_head = Head3D(n_points=joint_info.n_joints)
        self.predict_multi.get_concrete_function(
            tf.TensorSpec(shape=(None, None, None, 3), dtype=tf.float16))

    def call(self, image, training=None):
        features = self.backbone(image, training=training)
        coords3d = self.heatmap_head(features, training=training)
        return coords3d

    @tf.function
    def predict_multi(self, image):
        return self.call(image, training=False)


class Head3D(tf.keras.layers.Layer):
    def __init__(self, n_points):
        super().__init__()
        self.n_points = n_points
        self.conv_final = tf.keras.layers.Conv2D(filters=FLAGS.depth * self.n_points, kernel_size=1)

    def call(self, inp, training=None):
        logits = self.conv_final(inp)
        current_format = 'b h w (d j)' if tfu.get_data_format() == 'NHWC' else 'b (d j) h w'
        logits = einops.rearrange(logits, f'{current_format} -> b h w d j', j=self.n_points)
        coords_heatmap = tfu.soft_argmax(tf.cast(logits, tf.float32), axis=[2, 1, 3])
        return metrabs_tf.models.util.heatmap_to_metric(coords_heatmap, training)


class MetroTrainer(fleras.ModelTrainer):
    def __init__(self, metro_model, joint_info, joint_info2d=None):
        super().__init__()
        self.joint_info = joint_info
        self.joint_info_2d = joint_info2d
        self.model = metro_model
        inp = tf.keras.Input(shape=(None, None, 3), dtype=tfu.get_dtype())
        self(inp, training=False)

    def forward_test(self, inps):
        return dict(coords3d_rel_pred=self.model(inps['image'], training=False))

    def forward_train(self, inps, training):
        preds = AttrDict()

        image_both = tf.concat([inps.image, inps.image_2d], axis=0)
        coords3d_pred_both = self.model(image_both, training=training)
        batch_sizes = [t.shape.as_list()[0] for t in [inps.image, inps.image_2d]]
        preds.coords3d_rel_pred, preds.coords3d_pred_2d = tf.split(
            coords3d_pred_both, batch_sizes, axis=0)

        joint_ids_3d = [
            [self.joint_info.ids[n2] for n2 in self.joint_info.names if n2.startswith(n1)]
            for n1 in self.joint_info_2d.names]

        def get_2dlike_joints(coords):
            return tf.stack(
                [tf.reduce_mean(tf.gather(coords, ids, axis=1)[..., :2], axis=1)
                 for ids in joint_ids_3d], axis=1)

        # numbers mean: like 2d dataset joints, 2d batch
        preds.coords2d_pred_2d = get_2dlike_joints(preds.coords3d_pred_2d[..., :2])
        return preds

    def compute_losses(self, inps, preds):
        losses = AttrDict()

        ####################
        # 3D BATCH
        ####################
        coords3d_true_rootrel = tfu3d.center_relative_pose(
            inps.coords3d_true, inps.joint_validity_mask, FLAGS.mean_relative)
        coords3d_pred_rootrel = tfu3d.center_relative_pose(
            preds.coords3d_rel_pred, inps.joint_validity_mask, FLAGS.mean_relative)

        rootrel_absdiff = tf.abs((coords3d_true_rootrel - coords3d_pred_rootrel) / 1000)
        losses.loss3d = tfu.reduce_mean_masked(rootrel_absdiff, inps.joint_validity_mask)

        ####################
        # 2D BATCH
        ####################
        scale_2d = 1 / FLAGS.proc_side * FLAGS.box_size_mm / 1000
        preds.coords2d_pred_2d = metrabs_tf.models.util.align_2d_skeletons(
            preds.coords2d_pred_2d, inps.coords2d_true_2d, inps.joint_validity_mask_2d)
        losses.loss2d = tfu.reduce_mean_masked(
            tf.abs((inps.coords2d_true_2d - preds.coords2d_pred_2d) * scale_2d),
            inps.joint_validity_mask_2d)

        losses.loss = losses.loss3d + FLAGS.loss2d_factor * losses.loss2d
        return losses

    @tf.function
    def compute_metrics(self, inps, preds):
        return eval_metrics.compute_pose3d_metrics(inps, preds)
