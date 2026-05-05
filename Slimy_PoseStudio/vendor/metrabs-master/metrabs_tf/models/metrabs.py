import os.path as osp

import einops
import fleras
import numpy as np
import tensorflow as tf
from attrdict import AttrDict
from posepile.paths import DATA_ROOT
from simplepyutils import FLAGS

import metrabs_tf.models.util as model_util
from metrabs_tf import tfu, tfu3d
from metrabs_tf.models import eval_metrics


class Metrabs(tf.keras.Model):
    def __init__(self, backbone, joint_info):
        super().__init__()
        self.backbone = backbone
        self.joint_names = tf.Variable(np.array(joint_info.names), trainable=False)
        edges = np.array([[i, j] for i, j in joint_info.stick_figure_edges])
        self.joint_edges = tf.Variable(edges, trainable=False)
        self.input_resolution = tf.Variable(np.int32(FLAGS.proc_side), trainable=False)
        self.joint_info = joint_info

        if FLAGS.affine_weights:
            if not osp.exists(FLAGS.affine_weights):
                affine_path = f'{DATA_ROOT}/skeleton_conversion/{FLAGS.affine_weights}.npz'
            else:
                affine_path = FLAGS.affine_weights
            ws = np.load(affine_path)
            self.n_latents = ws['w2'].shape[0]
            self.recombination_weights = tf.constant(ws['w2'], tf.float32)
            self.encoder_weights = tf.constant(ws['w1'], tf.float32)
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

    def call(self, inp, training=None):
        image, intrinsics = inp
        features, coords2d, coords3d = self.backbone_and_head(image, training)

        if FLAGS.predict_all_and_latents:
            coords2d = coords2d[:, :self.n_latents]
            coords3d = coords3d[:, :self.n_latents]

        coords3d_abs = tfu3d.reconstruct_absolute(
            coords2d, coords3d, intrinsics,
            mix_3d_inside_fov=FLAGS.mix_3d_inside_fov)

        if FLAGS.transform_coords or FLAGS.predict_all_and_latents:
            coords3d_abs = self.latent_points_to_joints(coords3d_abs)

        return coords3d_abs

    def backbone_and_head(self, image, training):
        features = self.backbone(image, training=training)
        head2d, head3d = self.heatmap_heads(features, training=training)
        return features, head2d, head3d

    @tf.function(input_signature=[
        tf.TensorSpec(shape=(None, None, None, 3), dtype=tf.float16),
        tf.TensorSpec(shape=(None, 3, 3), dtype=tf.float32)])
    def predict_multi(self, image, intrinsic_matrix):
        # This function is needed to avoid having to go through Keras' __call__
        # in the exported SavedModel, which causes all kinds of problems.
        return self.call((image, intrinsic_matrix), training=False)

    def latent_points_to_joints(self, points):
        return tfu3d.linear_combine_points(points, self.recombination_weights)

    def joints_to_latent_points(self, points):
        return tfu3d.linear_combine_points(points, self.encoder_weights)

    def joints_to_joints(self, points):
        return tfu3d.linear_combine_points(points, self.reconstruction_weights)


class MetrabsHeads(tf.keras.layers.Layer):
    def __init__(self, n_points):
        super().__init__()
        self.n_points = n_points
        self.n_outs = [self.n_points, FLAGS.depth * self.n_points]
        self.conv_final = tf.keras.layers.Conv2D(filters=sum(self.n_outs), kernel_size=1)

    def call(self, inp, training=None):
        x = self.conv_final(inp)
        logits2d, logits3d = tf.split(x, self.n_outs, axis=tfu.channel_axis())
        current_format = 'b h w (d j)' if tfu.get_data_format() == 'NHWC' else 'b (d j) h w'
        logits3d = einops.rearrange(logits3d, f'{current_format} -> b h w d j', j=self.n_points)
        coords3d = tfu.soft_argmax(tf.cast(logits3d, tf.float32), axis=[2, 1, 3])
        coords3d_rel_pred = model_util.heatmap_to_metric(coords3d, training)
        coords2d = tfu.soft_argmax(tf.cast(logits2d, tf.float32), axis=tfu.image_axes()[::-1])
        coords2d_pred = model_util.heatmap_to_image(coords2d, training)
        return coords2d_pred, coords3d_rel_pred

    def set_last_point_weights(self, weights):
        # In the fine-tuning phase, the channel count of the last layer can change, since
        # we may be estimating more points for the "hybrid" student-teacher case.
        # For that case, we need to still restore the weights for the part that predicts the
        # full joint set. So this function sets the weights for the second part of the
        # set of points to `weights`. The second part because in the hybrid variant we
        # have the latents first and the full joint set afterwards.
        kernel_other, bias_other = weights
        n_total_out_other = kernel_other.shape[-1]
        n_points_other = n_total_out_other // (1 + FLAGS.depth)
        kernel2d_other, kernel3d_other = np.split(kernel_other, [n_points_other], axis=-1)
        bias2d_other, bias3d_other = np.split(bias_other, [n_points_other], axis=-1)

        kernel, bias = self.get_weights()
        kernel2d, kernel3d = np.split(kernel, [self.n_points], axis=-1)
        bias2d, bias3d = np.split(bias, [self.n_points], axis=-1)

        kernel2d[..., -n_points_other:] = kernel2d_other
        bias2d[..., -n_points_other:] = bias2d_other

        bias3d_reshape = einops.rearrange(bias3d, f'(d j) -> d j', d=FLAGS.depth)
        bias3d_other_reshape = einops.rearrange(bias3d_other, f'(d j) -> d j', d=FLAGS.depth)
        bias3d_reshape[..., -n_points_other:] = bias3d_other_reshape
        bias3d = einops.rearrange(bias3d_reshape, f'd j -> (d j)')

        kernel3d_reshape = einops.rearrange(kernel3d, f'h w c (d j) -> h w c d j', d=FLAGS.depth)
        kernel3d_other_reshape = einops.rearrange(
            kernel3d_other, f'h w c (d j) -> h w c d j', d=FLAGS.depth)
        kernel3d_reshape[..., -n_points_other:] = kernel3d_other_reshape
        kernel3d = einops.rearrange(kernel3d_reshape, f'h w c d j -> h w c (d j)')

        kernel = np.concatenate([kernel2d, kernel3d], axis=-1)
        bias = np.concatenate([bias2d, bias3d], axis=-1)
        self.set_weights([kernel, bias])


class MetrabsTrainer(fleras.ModelTrainer):
    def __init__(
            self, metrabs_model, joint_info, joint_info2d=None, test_time_flip_aug=False, **kwargs):
        super().__init__(**kwargs)
        self.joint_info = joint_info
        self.joint_info_2d = joint_info2d
        self.test_time_flip_aug = test_time_flip_aug
        self.model = metrabs_model
        inp = tf.keras.Input(shape=(None, None, 3), dtype=tfu.get_dtype())
        intr = tf.keras.Input(shape=(3, 3), dtype=tf.float32)
        self.model((inp, intr), training=False)

    def forward_train(self, inps, training):
        preds = AttrDict()

        image_both = tf.concat([inps.image, inps.image_2d], axis=0)
        intrinsics = tf.concat([inps.intrinsics, inps.intrinsics_2d], axis=0)

        features, head2d, head3d = self.model.backbone_and_head(image_both, training)
        tf.debugging.assert_all_finite(features, 'Nonfinite features!')

        mix_3d_inside_fov = (
            tf.random.uniform([tf.shape(head3d)[0], 1, 1])
            if training else FLAGS.mix_3d_inside_fov)

        if FLAGS.predict_all_and_latents:
            # The latent and the alljoints predictors should work independently
            # Therefore the abs reconstruction is done separately
            head2d_latent, head2d_allhead = self.split_latent_and_all(head2d)
            head3d_latent, head3d_allhead = self.split_latent_and_all(head3d)

            if FLAGS.stop_gradient_whole_latenthead_to_backbone:
                head2d_sg, head3d_sg = self.model.heatmap_heads(
                    tf.stop_gradient(features), training=training)
                head2d_latent, _ = self.split_latent_and_all(head2d_sg)
                head3d_latent, _ = self.split_latent_and_all(head3d_sg)

            preds.coords3d_pred_abs_both = tf.concat([
                self.reconstruct_absolute(
                    head2d_latent, head3d_latent, intrinsics, mix_3d_inside_fov),
                self.reconstruct_absolute(
                    head2d_allhead, head3d_allhead, intrinsics, mix_3d_inside_fov)], axis=1)
        else:
            preds.coords3d_pred_abs_both = self.reconstruct_absolute(
                head2d, head3d, intrinsics, mix_3d_inside_fov)

        if FLAGS.transform_coords:
            preds.coords3d_pred_abs_both = self.model.latent_points_to_joints(
                preds.coords3d_pred_abs_both)

        preds.coords2d_pred_both = tfu3d.project_pose(preds.coords3d_pred_abs_both, intrinsics)

        batch_sizes = [t.shape.as_list()[0] for t in [inps.image, inps.image_2d]]
        preds.coords3d_pred_abs, preds.coords3d_pred_abs2d = tf.split(
            preds.coords3d_pred_abs_both, batch_sizes, axis=0)
        preds.coords2d_pred, preds.coords2d_pred2d = tf.split(
            preds.coords2d_pred_both, batch_sizes, axis=0)
        preds.head3d_pred, preds.head3d_pred2d = tf.split(
            preds.coords2d_pred_both, batch_sizes, axis=0)

        if FLAGS.predict_all_and_latents:
            names = ['coords3d_pred_abs', 'coords3d_pred_abs2d', 'coords2d_pred', 'coords2d_pred2d']
            for name in names:
                preds[name + '_latenthead'], preds[name] = self.split_latent_and_all(preds[name])

        for n, p in preds.items():
            tf.debugging.assert_all_finite(p, f'Nonfinite preds.{n}!')

        return preds

    def reconstruct_absolute(self, head2d, head3d, intrinsics, mix_3d_inside_fov):
        weak_persp = tfu3d.reconstruct_absolute(
            head2d, head3d, intrinsics, mix_3d_inside_fov=mix_3d_inside_fov,
            weak_perspective=True)
        full_persp = tfu3d.reconstruct_absolute(
            head2d, head3d, intrinsics, mix_3d_inside_fov=mix_3d_inside_fov,
            weak_perspective=False)

        # Use the weak perspective reconstruction at the very beginning,
        # else there are some numerical instabilities as the 3D and 2D heads are not
        # giving compatible outputs yet.
        return weak_persp if self.train_counter < 500 else full_persp

    def compute_losses(self, inps, preds):
        if FLAGS.predict_all_and_latents:
            return self.compute_losses_latents_and_all(inps, preds)

        losses = AttrDict()
        losses.loss_3dbatch = self.compute_loss_with_3d_gt(
            preds.coords3d_pred_abs, inps.coords3d_true, inps.intrinsics, inps.joint_validity_mask)
        losses.loss_2dbatch = self.compte_loss_with_2d_gt(
            preds.coords3d_pred_abs2d, inps.coords2d_true_2d, inps.intrinsics_2d,
            inps.joint_validity_mask_2d)

        if FLAGS.regularize_to_manifold:
            j2j = self.model.joints_to_joints

            losses.loss_pred_vs_reconstr = tf.reduce_mean(
                tf.abs(preds.coords3d_pred_abs - j2j(preds.coords3d_pred_abs))) / 1000
            losses.loss_pred_vs_reconstr_2dbatch = tf.reduce_mean(
                tf.abs(preds.coords3d_pred_abs2d - j2j(preds.coords3d_pred_abs2d))) / 1000

            loss_manif_factor = FLAGS.loss_manif_factor
            losses.loss = tf.add_n([
                losses.loss_3dbatch,
                loss_manif_factor * losses.loss_pred_vs_reconstr,
                FLAGS.loss2d_factor * losses.loss_2dbatch,
                FLAGS.loss2d_factor * loss_manif_factor * FLAGS.loss_manif_factor2d *
                losses.loss_pred_vs_reconstr_2dbatch
            ])
        else:
            losses.loss = losses.loss_3dbatch + FLAGS.loss2d_factor * losses.loss_2dbatch

        return losses

    def compute_loss_with_3d_gt(
            self, coords3d_pred_abs, coords3d_true, intrinsics, joint_validity_mask=None):
        # Rootrel loss
        diff = coords3d_true - coords3d_pred_abs

        coords3d_true_rootrel = tfu3d.center_relative_pose(
            coords3d_true, joint_validity_mask, FLAGS.mean_relative)
        coords3d_pred_rootrel = tfu3d.center_relative_pose(
            coords3d_pred_abs, joint_validity_mask, FLAGS.mean_relative)
        rootrel_absdiff = tf.abs((coords3d_true_rootrel - coords3d_pred_rootrel)) / 1000
        loss3d = tfu.reduce_mean_masked(rootrel_absdiff, joint_validity_mask)

        is_far_enough = coords3d_true[..., 2] > 300
        is_valid_and_far_enough = (
            tf.logical_and(joint_validity_mask, is_far_enough)
            if joint_validity_mask is not None else is_far_enough)

        # Absolute loss
        absdiff = tf.abs(diff)
        scale_factor_for_far = tf.minimum(np.float32(1), 10000 / tf.abs(coords3d_true[..., 2:]))
        absdiff_xy = absdiff[..., :2]
        absdiff_z = absdiff[..., 2:] * scale_factor_for_far
        absdiff = (absdiff_xy * 2 + absdiff_z) / 3
        loss3d_abs = tfu.reduce_mean_masked(absdiff, is_valid_and_far_enough) / 1000

        # Projection loss
        coords2d_pred = tfu3d.project_pose(coords3d_pred_abs, intrinsics)
        coords2d_true = tfu3d.project_pose(coords3d_true, intrinsics)

        scale_2d = 1 / FLAGS.proc_side * FLAGS.box_size_mm / 1000
        is_in_fov_pred = tf.logical_and(
            tfu3d.is_within_fov(coords2d_pred),
            coords3d_pred_abs[..., 2] > 1)
        is_near_fov_true = tf.logical_and(
            tfu3d.is_within_fov(coords2d_true, border_factor=-20),
            coords3d_true[..., 2] > 1)
        loss2d = tfu.reduce_mean_masked(
            tf.abs((coords2d_true - coords2d_pred) * scale_2d),
            tf.logical_and(
                is_valid_and_far_enough,
                tf.logical_and(is_in_fov_pred, is_near_fov_true)))

        absloss_factor = (
            FLAGS.absloss_factor if self.train_counter > FLAGS.absloss_start_step else np.float32(
                0))

        return loss3d + loss2d + absloss_factor * loss3d_abs

    def compte_loss_with_2d_gt(
            self, coords3d_pred_abs, coords2d_true, intrinsics, joint_validity_mask):
        scale_2d = 1 / FLAGS.proc_side * FLAGS.box_size_mm / 1000
        coords2d_pred_2dlike = self.get_2dlike_joints(
            tfu3d.project_pose(coords3d_pred_abs, intrinsics))
        is_in_fov_pred2d = tfu3d.is_within_fov(coords2d_pred_2dlike)
        is_near_fov_true2d = tfu3d.is_within_fov(coords2d_true, border_factor=-20)
        return tfu.reduce_mean_masked(
            tf.abs((coords2d_true - coords2d_pred_2dlike) * scale_2d),
            tf.logical_and(
                joint_validity_mask,
                tf.logical_and(is_in_fov_pred2d, is_near_fov_true2d)))

    def compute_losses_latents_and_all(self, inps, preds):
        losses = AttrDict()

        l2j = self.model.latent_points_to_joints
        j2l = self.model.joints_to_latent_points
        j2j = self.model.joints_to_joints
        sg = tf.stop_gradient if FLAGS.stop_gradient_latent else lambda x: x

        # 3D BATCH
        # All vs GT
        losses.loss_allhead_vs_gt = self.compute_loss_with_3d_gt(
            preds.coords3d_pred_abs, inps.coords3d_true, inps.intrinsics, inps.joint_validity_mask)
        # Latent-decode vs GT
        losses.loss_latentheadreconstruction_vs_gt = self.compute_loss_with_3d_gt(
            l2j(preds.coords3d_pred_abs_latenthead), inps.coords3d_true, inps.intrinsics,
            inps.joint_validity_mask)
        # All vs all-encode-decode
        losses.loss_allhead_vs_reconstr = tf.reduce_mean(
            tf.abs(preds.coords3d_pred_abs - j2j(preds.coords3d_pred_abs))) / 1000
        # All-encode-decode vs GT
        losses.loss_allhead_ae_vs_gt = self.compute_loss_with_3d_gt(
            j2j(preds.coords3d_pred_abs), inps.coords3d_true, inps.intrinsics,
            inps.joint_validity_mask)

        # Latent vs all-encode
        losses.loss_latenthead_vs_latents_from_allhead = self.compute_loss_with_3d_gt(
            preds.coords3d_pred_abs_latenthead, j2l(sg(preds.coords3d_pred_abs)),
            inps.intrinsics)

        teacher_factor = (
            np.float32(FLAGS.teacher_loss_factor)
            if self.train_counter > FLAGS.teacher_start_step else np.float32(0))
        losses.loss_3dbatch = tf.add_n([
            losses.loss_allhead_vs_gt,
            losses.loss_latentheadreconstruction_vs_gt,
            FLAGS.allhead_aegt_loss_factor * losses.loss_allhead_ae_vs_gt,
            FLAGS.loss_manif_factor * losses.loss_allhead_vs_reconstr,
            teacher_factor * losses.loss_latenthead_vs_latents_from_allhead
        ])

        # 2D BATCH
        # All vs GT
        losses.loss_allhead_vs_gt_2dbatch = self.compte_loss_with_2d_gt(
            preds.coords3d_pred_abs2d, inps.coords2d_true_2d, inps.intrinsics_2d,
            inps.joint_validity_mask_2d)
        # Latent-decode vs GT
        losses.loss_latentheadreconstruction_vs_gt_2dbatch = self.compte_loss_with_2d_gt(
            l2j(preds.coords3d_pred_abs2d_latenthead), inps.coords2d_true_2d, inps.intrinsics_2d,
            inps.joint_validity_mask_2d)
        # All vs all-encode-decode
        losses.loss_allhead_vs_reconstr_2dbatch = tf.reduce_mean(
            tf.abs(preds.coords3d_pred_abs2d - j2j(preds.coords3d_pred_abs2d))) / 1000
        # All-encode-decode vs GT
        losses.loss_allhead_ae_vs_gt_2dbatch = self.compte_loss_with_2d_gt(
            j2j(preds.coords3d_pred_abs2d), inps.coords2d_true_2d, inps.intrinsics_2d,
            inps.joint_validity_mask_2d)
        # Latent vs all-encode
        losses.loss_latenthead_vs_latents_from_allhead_2dbatch = self.compute_loss_with_3d_gt(
            preds.coords3d_pred_abs2d_latenthead, j2l(sg(preds.coords3d_pred_abs2d)),
            inps.intrinsics_2d)

        losses.loss_2dbatch = tf.add_n([
            losses.loss_allhead_vs_gt_2dbatch,
            losses.loss_latentheadreconstruction_vs_gt_2dbatch,
            FLAGS.allhead_aegt_loss_factor * losses.loss_allhead_ae_vs_gt_2dbatch,
            0.5 * (FLAGS.loss_manif_factor * FLAGS.loss_manif_factor2d *
                   losses.loss_allhead_vs_reconstr_2dbatch),
            0.5 * teacher_factor * losses.loss_latenthead_vs_latents_from_allhead_2dbatch
        ])

        losses.loss = losses.loss_3dbatch + FLAGS.loss2d_factor * losses.loss_2dbatch
        return losses

    def split_latent_and_all(self, x):
        return tf.split(x, [self.model.n_latents, self.model.joint_info.n_joints], axis=1)

    def get_2dlike_joints(self, coords):
        # Get the joints that can be compared with the weak 2D annotations on the 2D part of the
        # batch.
        # (Weak supervision from 2D labels)
        joint_ids_3d = [
            [self.joint_info.ids[n2] for n2 in self.joint_info.names if n2.startswith(n1)]
            for n1 in self.joint_info_2d.names]
        return tf.stack(
            [tf.reduce_mean(tf.gather(coords, ids, axis=1)[..., :2], axis=1)
             for ids in joint_ids_3d], axis=1)

    def compute_metrics(self, inps, preds):
        return eval_metrics.compute_pose3d_metrics(inps, preds)

    def forward_test_basic(self, inps):
        preds = AttrDict()
        preds.coords3d_pred_abs = self.model((inps.image, inps.intrinsics), training=False)
        preds.coords2d_pred = tfu3d.project_pose(preds.coords3d_pred_abs, inps.intrinsics)
        return preds

    def forward_test_flipped(self, inps):
        inps_new = AttrDict(inps.copy())
        inps_new.image = inps.image[:, :, ::-1]

        preds = self.forward_test_basic(inps_new)

        preds.coords3d_pred_abs = preds.coords3d_pred_abs * np.array([-1, 1, 1], np.float32)
        preds.coords3d_pred_abs = tf.gather(
            preds.coords3d_pred_abs, self.joint_info.mirror_mapping, axis=1)

        preds.coords2d_pred = tfu3d.project_pose(preds.coords3d_pred_abs, inps.intrinsics)
        return preds

    def forward_test(self, inps):
        if self.test_time_flip_aug:
            p1 = self.forward_test_basic(inps)
            p2 = self.forward_test_flipped(inps)
            return AttrDict(
                coords2d_pred=(p1.coords2d_pred + p2.coords2d_pred) / 2,
                coords3d_pred_abs=(p1.coords3d_pred_abs + p2.coords3d_pred_abs) / 2)
        else:
            return self.forward_test_basic(inps)
