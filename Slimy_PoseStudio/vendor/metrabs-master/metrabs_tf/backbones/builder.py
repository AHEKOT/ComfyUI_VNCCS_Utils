import functools

import keras.layers
import numpy as np
import tensorflow as tf
from fleras.layers import GhostBatchNormalization
from keras.layers import Lambda
from keras.models import Sequential
from simplepyutils import FLAGS

from metrabs_tf.backbones import mobilenet_v3, resnet
from metrabs_tf.backbones.efficientnet import effnetv2_model, effnetv2_utils


def build_backbone():
    build_fn = get_build_fn()
    normalizer = get_normalizer()
    backbone, preproc_fn = build_fn(normalizer)
    return Sequential([Lambda(preproc_fn, output_shape=lambda x: x), backbone])


def get_build_fn():
    prefix_to_build_fn = dict(
        efficientnetv2=build_effnetv2, resnet=build_resnet, mobilenet=build_mobilenet)
    for prefix, build_fn in prefix_to_build_fn.items():
        if FLAGS.backbone.startswith(prefix):
            return build_fn

    raise Exception(f'No backbone builder found for {FLAGS.backbone}.')


def build_resnet(bn):
    class MyLayers(keras.layers.VersionAwareLayers):
        def __getattr__(self, name):
            if name == 'BatchNormalization':
                return bn
            return super().__getattr__(name)

    classname = f'ResNet{FLAGS.backbone[len("resnet"):]}'.replace('-', '_')
    backbone = getattr(resnet, classname)(
        include_top=False, weights='imagenet',
        input_shape=(None, None, 3), layers=MyLayers())
    if 'V2' in FLAGS.backbone:
        preproc_fn = tf_preproc
    elif 'V1-5' in FLAGS.backbone or 'V1_5' in FLAGS.backbone:
        preproc_fn = torch_preproc
    else:
        preproc_fn = caffe_preproc
    return backbone, preproc_fn


def build_effnetv2(bn):
    effnetv2_utils.set_batchnorm(bn)
    if FLAGS.constrain_kernel_norm != np.inf:
        model_config = dict(
            kernel_constraint=tf.keras.constraints.MinMaxNorm(
                0, FLAGS.constrain_kernel_norm, axis=[0, 1, 2]),
            depthwise_constraint=tf.keras.constraints.MinMaxNorm(
                0, FLAGS.constrain_kernel_norm, axis=[0, 1]))
    else:
        model_config = {}

    backbone = effnetv2_model.get_model(
        FLAGS.backbone, model_config=model_config, include_top=False)
    return backbone, tf_preproc


def build_mobilenet(bn):
    class MyLayers(mobilenet_v3.VersionAwareLayers):
        def __getattr__(self, name):
            if name == 'BatchNormalization':
                return bn
            return super().__getattr__(name)

    arch = FLAGS.backbone
    arch = arch[:-4] if arch.endswith('mini') else arch
    classname = f'MobileNet{arch[len("mobilenet"):]}'
    backbone = getattr(mobilenet_v3, classname)(
        include_top=False, weights='imagenet', minimalistic=FLAGS.backbone.endswith('mini'),
        input_shape=(FLAGS.proc_side, FLAGS.proc_side, 3), layers=MyLayers(),
        centered_stride=FLAGS.centered_stride, pooling=None)
    return backbone, mobilenet_preproc


def get_normalizer():
    if FLAGS.backbone.startswith('efficientnetv2'):
        bn = effnetv2_utils.BatchNormalization
    else:
        bn = keras.layers.BatchNormalization

    if FLAGS.ghost_bn:
        split = [int(x) for x in FLAGS.ghost_bn.split(',')]
        prefix = 'tpu_' if FLAGS.backbone.startswith('efficientnetv2') else ''
        bn = functools.partial(
            GhostBatchNormalization, split=split, name=f'{prefix}batch_normalization')
    return bn


def torch_preproc(x):
    mean_rgb = tf.convert_to_tensor(np.array([0.485, 0.456, 0.406]), x.dtype)
    stdev_rgb = tf.convert_to_tensor(np.array([0.229, 0.224, 0.225]), x.dtype)
    normalized = (x - mean_rgb) / stdev_rgb
    return normalized


def caffe_preproc(x):
    mean_rgb = tf.convert_to_tensor(np.array([103.939, 116.779, 123.68]), x.dtype)
    return tf.cast(255, x.dtype) * x - mean_rgb


def tf_preproc(x):
    x = tf.cast(2, x.dtype) * x - tf.cast(1, x.dtype)
    return x


def mobilenet_preproc(x):
    return tf.cast(255, x.dtype) * x
