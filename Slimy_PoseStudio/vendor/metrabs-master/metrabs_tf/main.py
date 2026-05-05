import contextlib
import os.path as osp
import re
import sys

import attrdict
import fleras.optimizers
import numpy as np
import posepile.datasets2d as ds2d
import posepile.datasets3d as ds3d
import simplepyutils as spu
import tensorflow as tf
import tf_parallel_map as tfpm
from simplepyutils import FLAGS, logger

import metrabs_tf.backbones.builder as backbone_builder
import metrabs_tf.data_loading as data_loading
from metrabs_tf import init, models, tfu, util
from metrabs_tf.models import metrabs, util as model_util
from metrabs_tf.util import TEST, TRAIN, VALID


def main():
    init.initialize()

    if FLAGS.train:
        train()
    elif FLAGS.predict:
        predict()
    elif FLAGS.export_file:
        export()


def train():
    strategy = get_distribution_strategy()
    n_replicas = strategy.num_replicas_in_sync

    n_completed_steps = get_n_completed_steps()
    rng = np.random.Generator(np.random.PCG64(FLAGS.seed))

    #######
    # TRAINING DATA
    #######
    dataset2d = ds2d.get_dataset(FLAGS.dataset2d)
    dataset3d = ds3d.get_dataset(FLAGS.dataset3d)

    joint_info2d = dataset2d.joint_info
    joint_info3d = dataset3d.joint_info

    examples2d = [*dataset2d.examples[TRAIN], *dataset2d.examples[VALID]]
    examples3d = get_examples(dataset3d, TRAIN)

    example_sections2d, roundrobin_sizes2d = organize_data_stream2d(examples2d, n_replicas)
    example_sections3d, roundrobin_sizes3d = organize_data_stream3d(examples3d, n_replicas)

    data2d_train = tfpm.build_dataflow(
        examples=example_sections2d, load_fn=data_loading.load_and_transform2d,
        extra_load_fn_args=(joint_info2d, TRAIN), learning_phase='train',
        batch_size=sum(roundrobin_sizes2d) // FLAGS.grad_accum_steps,
        rng=util.new_rng(rng), n_completed_steps=n_completed_steps,
        n_total_steps=FLAGS.training_steps * FLAGS.grad_accum_steps,
        roundrobin_sizes=roundrobin_sizes2d)
    data3d_train = tfpm.build_dataflow(
        examples=example_sections3d, load_fn=data_loading.load_and_transform3d,
        extra_load_fn_args=(joint_info3d, TRAIN), learning_phase='train',
        batch_size=sum(roundrobin_sizes3d) // FLAGS.grad_accum_steps,
        rng=util.new_rng(rng), n_completed_steps=n_completed_steps,
        n_total_steps=FLAGS.training_steps * FLAGS.grad_accum_steps,
        roundrobin_sizes=roundrobin_sizes3d)
    data_train = tf.data.Dataset.zip((data2d_train, data3d_train)).map(
        lambda batch2d, batch3d: {**batch2d, **batch3d})

    if not FLAGS.multi_gpu:
        data_train = data_train.apply(tf.data.experimental.prefetch_to_device('GPU:0', 1))

    opt = tf.data.Options()
    opt.experimental_distribute.auto_shard_policy = tf.data.experimental.AutoShardPolicy.DATA
    data_train = data_train.with_options(opt)

    #######
    # VALIDATION DATA
    #######
    examples3d_val = get_examples(dataset3d, VALID)
    if FLAGS.validate_period:
        data_val = tfpm.build_dataflow(
            examples=examples3d_val, load_fn=data_loading.load_and_transform3d,
            extra_load_fn_args=(joint_info3d, VALID), learning_phase='valid',
            batch_size=FLAGS.batch_size_test, rng=util.new_rng(rng))
        data_val = data_val.with_options(opt)
        validation_steps = int(np.ceil(len(examples3d_val) / FLAGS.batch_size_test))
    else:
        data_val = None
        validation_steps = None

    #######
    # MODEL
    #######
    with strategy.scope():
        tf.random.set_global_generator(tf.random.Generator.from_seed(FLAGS.seed))
        #        global_step = tf.Variable(n_completed_steps, dtype=tf.int32, trainable=False)
        model, trainer = build_model_and_trainer(dataset3d, joint_info2d, joint_info3d)

        if FLAGS.dual_finetune_lr:
            # Higher learning rate for the head, smaller for the backbone
            optimizer = build_multi_optimizer(model.backbone, model.heatmap_heads)
        else:
            optimizer = build_optimizer()

        trainer.compile(optimizer=optimizer)

    #######
    # CHECKPOINTING
    #######
    ckpt = tf.train.Checkpoint(model=model)
    ckpt_manager = tf.train.CheckpointManager(
        ckpt, directory=FLAGS.checkpoint_dir, max_to_keep=2, step_counter=trainer.train_counter,
        checkpoint_interval=FLAGS.checkpoint_period)
    restore_if_ckpt_available(ckpt)

    #######
    # CALLBACKS
    #######
    cbacks = [
        fleras.callbacks.Checkpoint(ckpt_manager),
        fleras.callbacks.ProgbarLogger(),
        fleras.callbacks.Wandb(
            project_name=FLAGS.wandb_project, logdir=FLAGS.logdir, config_dict=FLAGS,
            grad_accum_steps=FLAGS.grad_accum_steps),
    ]

    if FLAGS.finetune_in_inference_mode:
        switch_step = (
                (FLAGS.training_steps - FLAGS.finetune_in_inference_mode) * FLAGS.grad_accum_steps)
        cbacks.append(fleras.callbacks.SwitchToInferenceModeCallback(switch_step, ckpt_manager))

    #######
    # FITTING
    #######
    try:
        trainer.fit_epochless(
            training_data=data_train, initial_step=n_completed_steps,
            steps=FLAGS.training_steps * FLAGS.grad_accum_steps,
            verbose=1 if sys.stdout.isatty() else 0, callbacks=cbacks, validation_data=data_val,
            validation_freq=FLAGS.validate_period * FLAGS.grad_accum_steps,
            validation_steps=validation_steps)
        model.save(
            f'{FLAGS.checkpoint_dir}/model', include_optimizer=False, overwrite=True,
            options=tf.saved_model.SaveOptions(experimental_custom_gradients=True))
    except KeyboardInterrupt:
        logger.info('Training interrupted.')
    except tf.errors.ResourceExhaustedError:
        logger.info('Resource Exhausted!')
        # Give a specific return code that may be caught in a shell script
        sys.exit(42)
    finally:
        ckpt_manager.save(trainer.train_counter, check_interval=False)
        logger.info('Saved checkpoint.')


def get_distribution_strategy():
    if FLAGS.multi_gpu:
        return tf.distribute.MirroredStrategy(cross_device_ops=tf.distribute.ReductionToOneDevice())
    else:
        # Dummy strategy
        @contextlib.contextmanager
        def dummy_scope():
            yield

        return attrdict.AttrDict(scope=dummy_scope, num_replicas_in_sync=1)


def build_model_and_trainer(dataset3d, joint_info2d, joint_info3d):
    bone_lengths = (
        dataset3d.trainval_bones if FLAGS.train_on == 'trainval' else dataset3d.train_bones)
    extra_args = [bone_lengths] if FLAGS.model_class.startswith('Model25D') else []
    extra_kwargs_trainer = {}
    trainer_class = getattr(models, FLAGS.model_class + 'Trainer')
    model_class = getattr(models, FLAGS.model_class)
    backbone = backbone_builder.build_backbone()
    model = model_class(backbone, joint_info3d, *extra_args)
    trainer = trainer_class(
        model, joint_info=joint_info3d, joint_info2d=joint_info2d,
        random_seed=FLAGS.seed, gradient_accumulation_steps=FLAGS.grad_accum_steps,
        **extra_kwargs_trainer)

    if FLAGS.load_backbone_from:
        loaded_model = tf.keras.models.load_model(FLAGS.load_backbone_from, compile=False)
        backbone.set_weights(loaded_model.backbone.get_weights())
        if not FLAGS.transform_coords:
            model.heatmap_heads.set_last_point_weights(loaded_model.heatmap_heads.get_weights())
        del loaded_model

    return model, trainer


def build_optimizer():
    total_training_steps = FLAGS.training_steps
    weight_decay = FLAGS.weight_decay / np.sqrt(total_training_steps) / FLAGS.base_learning_rate

    optimizer = tf.keras.optimizers.Adam(
        learning_rate=lr_schedule(), weight_decay=weight_decay, epsilon=1e-8,
        use_ema=FLAGS.ema_momentum < 1, ema_momentum=FLAGS.ema_momentum, jit_compile=False)

    if FLAGS.grad_accum_steps > 1 or FLAGS.force_grad_accum:
        optimizer = fleras.optimizers.GradientAccumulationOptimizer(
            optimizer, FLAGS.grad_accum_steps, jit_compile=False)

    optimizer = tf.keras.mixed_precision.LossScaleOptimizer(
        optimizer, dynamic=FLAGS.dynamic_loss_scale, initial_scale=FLAGS.loss_scale)

    optimizer.finalize_variable_values = optimizer.inner_optimizer.finalize_variable_values
    return optimizer


def build_multi_optimizer(backbone, heads):
    total_training_steps = 400000
    weight_decay = FLAGS.weight_decay / np.sqrt(total_training_steps) / FLAGS.base_learning_rate

    optimizer1 = tf.keras.optimizers.Adam(
        learning_rate=lr_schedule_finetune_low(), weight_decay=weight_decay, epsilon=1e-8,
        use_ema=FLAGS.ema_momentum < 1, ema_momentum=FLAGS.ema_momentum, jit_compile=False)
    # Make sure these exist so checkpoints work properly
    # Might not be needed for the new-style Keras optimizers

    optimizer2 = tf.keras.optimizers.Adam(
        learning_rate=lr_schedule_finetune_high(), weight_decay=weight_decay, epsilon=1e-8,
        use_ema=FLAGS.ema_momentum < 1, ema_momentum=FLAGS.ema_momentum, jit_compile=False)
    optimizer = fleras.optimizers.MultiOptimizer([(optimizer1, backbone), (optimizer2, heads)])

    if FLAGS.grad_accum_steps > 1 or FLAGS.force_grad_accum:
        optimizer = fleras.optimizers.GradientAccumulationOptimizer(
            optimizer, FLAGS.grad_accum_steps, jit_compile=False)

    optimizer = tf.keras.mixed_precision.LossScaleOptimizer(
        optimizer, dynamic=False, initial_scale=FLAGS.loss_scale)

    optimizer.finalize_variable_values = optimizer.inner_optimizer.finalize_variable_values
    return optimizer


@fleras.optimizers.schedules.wrap(jit_compile=True)
def lr_schedule(step):
    training_steps = FLAGS.training_steps
    n_phase1_steps = 0.92 * training_steps
    n_phase2_steps = training_steps - n_phase1_steps
    step_float = tf.cast(step, tf.float32)
    b = tf.constant(FLAGS.base_learning_rate, tf.float32)

    if step_float < n_phase1_steps:
        return tf.keras.optimizers.schedules.ExponentialDecay(
            b, decay_rate=1 / 3, decay_steps=n_phase1_steps, staircase=False)(step_float)
    else:
        return tf.keras.optimizers.schedules.ExponentialDecay(
            b * tf.cast(1 / 30, tf.float32), decay_rate=0.3, decay_steps=n_phase2_steps,
            staircase=False)(step_float - n_phase1_steps)


@fleras.optimizers.schedules.wrap(jit_compile=True)
def lr_schedule_finetune_high(step):
    training_steps = FLAGS.training_steps
    n_phase1_steps = 0.5 * training_steps
    n_phase2_steps = training_steps - n_phase1_steps
    step_float = tf.cast(step, tf.float32)
    b = tf.constant(FLAGS.base_learning_rate, tf.float32)

    if step_float < n_phase1_steps:
        return tf.keras.optimizers.schedules.ExponentialDecay(
            b, decay_rate=1 / 3, decay_steps=n_phase1_steps, staircase=False)(step_float)
    else:
        return tf.keras.optimizers.schedules.ExponentialDecay(
            b * tf.cast(1 / 30, tf.float32), decay_rate=0.3, decay_steps=n_phase2_steps,
            staircase=False)(step_float - n_phase1_steps)


@fleras.optimizers.schedules.wrap(jit_compile=True)
def lr_schedule_finetune_low(step):
    training_steps = FLAGS.training_steps
    step_float = tf.cast(step, tf.float32)
    b = tf.constant(FLAGS.base_learning_rate, tf.float32)
    return tf.keras.optimizers.schedules.ExponentialDecay(
        b * tf.cast(1 / 30, tf.float32), decay_rate=0.3, decay_steps=training_steps,
        staircase=False)(step_float)


def get_examples(dataset, learning_phase):
    if learning_phase == TRAIN:
        str_example_phase = FLAGS.train_on
    elif learning_phase == VALID:
        str_example_phase = FLAGS.validate_on
    elif learning_phase == TEST:
        str_example_phase = FLAGS.test_on
    else:
        raise Exception(f'No such learning_phase as {learning_phase}')

    if str_example_phase == 'train':
        examples = dataset.examples[TRAIN]
    elif str_example_phase == 'valid':
        examples = dataset.examples[VALID]
    elif str_example_phase == 'test':
        examples = dataset.examples[TEST]
    elif str_example_phase == 'trainval':
        examples = [*dataset.examples[TRAIN], *dataset.examples[VALID]]
    else:
        raise Exception(f'No such phase as {str_example_phase}')
    return examples


def organize_data_stream3d(examples3d, n_replicas):
    if FLAGS.dataset3d in ('huge8', 'huge8_dummy') or 'annotations_28ds' in FLAGS.dataset3d:
        ds_parts = {
            'h36m_': 4, 'muco_downscaled': 6, 'humbi': 5, '3doh_down': 3, 'agora': 3,
            'surreal': 5, 'panoptic_': 7, 'aist_': 6, 'aspset_': 4, 'gpa_': 4,
            '3dpeople': 4, 'sailvos': 5, 'bml_movi': 5, 'mads_down': 2, 'umpm_down': 2,
            'bmhad_down': 3, '3dhp_full_down': 3, 'totalcapture': 3,
            'jta_down': 3, 'ikea_down': 2, 'human4d': 1,
            'behave_down': 3, 'rich_down': 4, 'spec_down': 2,
            'fit3d_': 2, 'chi3d_': 1, 'humansc3d_': 1, 'hspace_': 3
        }
        dataset_section_names = list(ds_parts.keys())
        roundrobin_sizes = list(ds_parts.values())
    elif FLAGS.dataset3d == 'medium3':
        ds_parts = {
            'h36m_': 9, 'muco_downscaled': 9, 'humbi': 7, 'agora': 5,
            'surreal': 8, 'panoptic_': 9, 'aist_': 9,
            '3dpeople': 6, 'sailvos': 7,
            'totalcapture': 5,
            'jta_down': 5, '3dhp_full_down': 5,
            'rich_down': 7,
            'hspace_': 5,
        }
        dataset_section_names = list(ds_parts.keys())
        roundrobin_sizes = list(ds_parts.values())
    elif FLAGS.dataset3d == 'small5':
        ds_parts = {'surreal': 32, 'h36m': 32, 'muco_downscaled': 32}
        dataset_section_names = list(ds_parts.keys())
        roundrobin_sizes = list(ds_parts.values())
    else:
        return [examples3d], [FLAGS.batch_size]

    example_sections = build_dataset_sections(examples3d, dataset_section_names)
    return example_sections, roundrobin_sizes


def organize_data_stream2d(examples2d, n_replicas):
    if 'huge2d' in FLAGS.dataset2d:
        n_pieces = FLAGS.grad_accum_steps * n_replicas
        if n_pieces == 3:
            # If the total batch size needs to be divisible by 3, we add one more coco example
            # 33 examples
            ds_parts = {'mpii_down': 8, 'coco_down': 9, 'jrdb_down': 8, 'posetrack_down': 8}
        elif n_pieces == 6:
            # If by 6, we remove a jrdb and a posetrack example -> 30 examples
            ds_parts = {'mpii_down': 8, 'coco_down': 8, 'jrdb_down': 7, 'posetrack_down': 7}
        else:
            ds_parts = {'mpii_down': 8, 'coco_down': 8, 'jrdb_down': 8, 'posetrack_down': 8}

        dataset_section_names = list(ds_parts.keys())
        roundrobin_sizes = list(ds_parts.values())
    else:
        return [examples2d], [FLAGS.batch_size_2d]

    example_sections = build_dataset_sections(examples2d, dataset_section_names)
    return example_sections, roundrobin_sizes


def build_dataset_sections(examples, section_names):
    sections = {name: [] for name in section_names}
    for ex in spu.progressbar(examples, desc='Building dataset sections'):
        for name in section_names:
            if name in ex.image_path.lower():
                sections[name].append(ex)
                break
        else:
            raise RuntimeError(f'No section for {ex.image_path}')
    return [sections[name] for name in section_names]


def get_n_completed_steps():
    if FLAGS.load_path is not None:
        return get_step_count_from_checkpoint_path(FLAGS.load_path)

    latest_checkpoint_path = tf.train.latest_checkpoint(FLAGS.checkpoint_dir)
    if latest_checkpoint_path is not None:
        return get_step_count_from_checkpoint_path(latest_checkpoint_path)
    else:
        return 0


def get_step_count_from_checkpoint_path(checkpoint_path):
    return int(re.search(r'ckpt-(?P<num>\d+)', checkpoint_path)['num'])


def restore_if_ckpt_available(ckpt, expect_partial=False):
    # See if there's a checkpoint and restore it if there is one.
    resuming_checkpoint_path = FLAGS.load_path
    if resuming_checkpoint_path:
        if resuming_checkpoint_path.endswith('.index'):
            resuming_checkpoint_path = osp.splitext(resuming_checkpoint_path)[0]
        if not osp.isabs(resuming_checkpoint_path):
            resuming_checkpoint_path = osp.join(FLAGS.checkpoint_dir, resuming_checkpoint_path)
    else:
        resuming_checkpoint_path = tf.train.latest_checkpoint(FLAGS.checkpoint_dir)

    load_path = resuming_checkpoint_path if resuming_checkpoint_path else FLAGS.init_path
    if load_path:
        s = ckpt.restore(load_path)
        if expect_partial:
            s.expect_partial()


def export():
    ji = ds3d.get_joint_info(FLAGS.dataset3d)
    logger.info(f'Constructing model...')
    backbone = backbone_builder.build_backbone()
    model = metrabs.Metrabs(backbone, ji)
    inp = tf.keras.Input(shape=(None, None, 3), dtype=tfu.get_dtype())
    intr = tf.keras.Input(shape=(3, 3), dtype=tf.float32)
    logger.info(f'Calling model...')
    model((inp, intr), training=False)

    logger.info(f'Loading ckpt...')
    ckpt = tf.train.Checkpoint(model=model)
    restore_if_ckpt_available(ckpt, expect_partial=True)

    if FLAGS.load_path:
        load_path = util.ensure_absolute_path(FLAGS.load_path, FLAGS.checkpoint_dir)
    else:
        ckpt = tf.train.get_checkpoint_state(FLAGS.checkpoint_dir)
        load_path = ckpt.model_checkpoint_path

    checkpoint_dir = osp.dirname(load_path)
    out_path = util.ensure_absolute_path(FLAGS.export_file, checkpoint_dir)
    logger.info(f'Saving to {out_path}...')
    model.save(
        out_path, include_optimizer=False, overwrite=True,
        options=tf.saved_model.SaveOptions(experimental_custom_gradients=True))


def predict():
    tfpm.initialize_pool(FLAGS.workers, spu.flags_getter)

    dataset3d = ds3d.get_dataset(FLAGS.dataset3d)
    backbone = backbone_builder.build_backbone()
    model_class = getattr(models, FLAGS.model_class)
    trainer_class = getattr(models, FLAGS.model_class + 'Trainer')
    model_joint_info = ds3d.get_joint_info(FLAGS.model_joints)

    if FLAGS.model_class.startswith('Model25D'):
        bone_dataset = ds3d.get_dataset(FLAGS.bone_length_dataset)
        bone_lengths = (
            bone_dataset.trainval_bones if FLAGS.train_on == 'trainval'
            else bone_dataset.train_bones)
        extra_args = [bone_lengths]
    else:
        extra_args = []

    model = model_class(backbone, model_joint_info, *extra_args)

    trainer = trainer_class(model, model_joint_info)
    if FLAGS.test_time_mirror_aug:
        trainer.test_time_flip_aug = True

    ckpt = tf.train.Checkpoint(model=model)
    restore_if_ckpt_available(ckpt, expect_partial=True)

    examples3d_test = get_examples(dataset3d, TEST)
    data_test = tfpm.build_dataflow(
        examples3d_test, data_loading.load_and_transform3d,
        (dataset3d.joint_info, TEST), learning_phase='test', batch_size=FLAGS.batch_size_test)
    n_predict_steps = int(np.ceil(len(examples3d_test) / FLAGS.batch_size_test))

    callbacks = [PredTransformCallback()]

    spu.ensure_parent_dir_exists(FLAGS.pred_path)
    callbacks.append(
        fleras.callbacks.StorePredictionsAsHDF5(FLAGS.pred_path, clear=True)
        if FLAGS.pred_path.endswith('.h5')
        else fleras.callbacks.StorePredictionsAsNPZ(FLAGS.pred_path))

    trainer.predict_no_store(
        data_test, verbose=1 if sys.stdout.isatty() else 0, steps=n_predict_steps,
        callbacks=callbacks)


class PredTransformCallback(tf.keras.callbacks.Callback):
    def on_predict_batch_end(self, batch, logs=None):
        r = logs['outputs']
        try:
            coords3d_pred_cam = r['coords3d_pred_abs']
        except KeyError:
            coords3d_pred_cam = r['coords3d_rel_pred']

        coords3d_pred_cam = model_util.select_skeleton(
            coords3d_pred_cam, self.model.joint_info, FLAGS.output_joints).numpy()
        coords3d_pred_world = tf.einsum(
            'nCc, njc->njC', r['rot_to_world'], coords3d_pred_cam) + tf.expand_dims(r['cam_loc'], 1)

        coords3d_true_cam = r['coords3d_true']
        coords3d_true_world = tf.einsum(
            'nCc, njc->njC', r['rot_to_world'], coords3d_true_cam) + tf.expand_dims(r['cam_loc'], 1)

        image_path = r['image_path']
        r.clear()
        r.update(
            image_path=image_path, coords3d_pred_world=coords3d_pred_world,
            coords3d_pred_cam=coords3d_pred_cam, coords3d_true_world=coords3d_true_world,
            coords3d_true_cam=coords3d_true_cam)


if __name__ == '__main__':
    main()
