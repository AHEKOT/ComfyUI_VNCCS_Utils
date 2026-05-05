# Copyright 2015 The TensorFlow Authors. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ==============================================================================
# pylint: disable=invalid-name
"""ResNet models for Keras.

Reference:
  - [Deep Residual Learning for Image Recognition](
      https://arxiv.org/abs/1512.03385) (CVPR 2015)

ResNet v2 models for Keras.

Reference:
  - [Identity Mappings in Deep Residual Networks]
    (https://arxiv.org/abs/1603.05027) (CVPR 2016)
"""
from __future__ import absolute_import, division, print_function

import numpy as np
from fleras.layers.conv2d_dense import Conv2DDenseSame, StridingInfo
from fleras.layers.train_test_switch_layer import TrainTestSwitchLayer
from keras import backend
from keras.applications import imagenet_utils
from keras.engine import training
from keras.layers import VersionAwareLayers
from keras.utils import data_utils, layer_utils
from simplepyutils import FLAGS
from tensorflow.python.lib.io import file_io

BASE_WEIGHTS_PATH = (
    'https://storage.googleapis.com/tensorflow/keras-applications/resnet/')
WEIGHTS_HASHES = {
    # hash order: (with_top, no_top)
    # v1 basic block
    'resnet18': ('a04f614a6c28f19f9e766a22a65d87d7', 'cd9aca5b625298765956a04230be071a'),
    'resnet34': ('25351c4102513ba73866398dfda04546', '5d0432fa0b4d5bf5fd88f04151f590a4'),

    # v1 bottleneck block
    'resnet50': ('2cb95161c43110f7111970584f804107', '4d473c1dd8becc155b73f8504c6f6626'),
    'resnet101': ('f1aeb4b969a6efcfb50fad2f0c20cfc5', '88cf7a10940856eca736dc7b7e228a21'),
    'resnet152': ('100835be76be38e30d865e96f2aaae62', 'ee4c566cf9a93f14d82f913c2dc6dd0c'),

    # v1.5
    'resnet50v1_5_groupnorm': (None, 'f38ae1ec7a58292f901f03a0ea3285eb'),
    'resnet50v1_5': ('595763ceca1995bf6e34ccd730b81741', '315b92000a86ce737f460441071d7579'),
    'resnet101v1_5': ('b16e80439827b6abfb2c378ac434fd45', '0b87f84107ae1a0616f76d028781b6a6'),
    'resnet152v1_5': ('2e445ecb46e5d72aa0004b51f668623c', '471a7a36f82f50879a64731f1615f2df'),

    # v2
    'resnet50v2': ('3ef43a0b657b3be2300d5770ece849e0', 'fac2f116257151a9d068a22e544a4917'),
    'resnet101v2': ('6343647c601c52e1368623803854d971', 'c0ed64b8031c3730f411d2eb4eea35b5'),
    'resnet152v2': ('a49b44d1979771252814e80f8ec446f9', 'ed17cf2e0169df9d443503ef94b23b33'),

    # resnext
    'resnext50': ('67a5b30d522ed92f75a1f16eef299d1a', '62527c363bdd9ec598bed41947b379fc'),
    'resnext101': ('34fb605428fcc7aa4d62f44404c11509', '0f678c91647380debd923963594981b3'),
}

layers = VersionAwareLayers()
batchnorm_epsilon = 1e-5
batchnorm_momentum = 0.997


def ResNet(
        stack_fn, preact, use_bias, model_name='resnet', include_top=True, weights='imagenet',
        input_tensor=None, input_shape=None, pooling=None, classes=1000,
        classifier_activation='softmax', bottomright_maxpool_test=False,
        use_group_norm=False, **kwargs):
    """Instantiates the ResNet, ResNetV2, and ResNeXt architecture.

    Reference:
    - [Deep Residual Learning for Image Recognition](
        https://arxiv.org/abs/1512.03385) (CVPR 2015)

    Optionally loads weights pre-trained on ImageNet.
    Note that the data format convention used by the model is
    the one specified in your Keras config at `~/.keras/keras.json`.

    Arguments:
      stack_fn: a function that returns output tensor for the
        stacked residual blocks.
      preact: whether to use pre-activation or not
        (True for ResNetV2, False for ResNet and ResNeXt).
      use_bias: whether to use biases for convolutional layers or not
        (True for ResNet and ResNetV2, False for ResNeXt).
      model_name: string, model name.
      include_top: whether to include the fully-connected
        layer at the top of the network.
      weights: one of `None` (random initialization),
        'imagenet' (pre-training on ImageNet),
        or the path to the weights file to be loaded.
      input_tensor: optional Keras tensor
        (i.e. output of `layers.Input()`)
        to use as image input for the model.
      input_shape: optional shape tuple, only to be specified
        if `include_top` is False (otherwise the input shape
        has to be `(224, 224, 3)` (with `channels_last` data format)
        or `(3, 224, 224)` (with `channels_first` data format).
        It should have exactly 3 inputs channels.
      pooling: optional pooling mode for feature extraction
        when `include_top` is `False`.
        - `None` means that the output of the model will be
            the 4D tensor output of the
            last convolutional layer.
        - `avg` means that global average pooling
            will be applied to the output of the
            last convolutional layer, and thus
            the output of the model will be a 2D tensor.
        - `max` means that global max pooling will
            be applied.
      classes: optional number of classes to classify images
        into, only to be specified if `include_top` is True, and
        if no `weights` argument is specified.
      classifier_activation: A `str` or callable. The activation function to use
        on the "top" layer. Ignored unless `include_top=True`. Set
        `classifier_activation=None` to return the logits of the "top" layer.
      **kwargs: For backwards compatibility only.
    Returns:
      A `keras.Model` instance.

    Raises:
      ValueError: in case of invalid argument for `weights`,
        or invalid input shape.
      ValueError: if `classifier_activation` is not `softmax` or `None` when
        using a pretrained top layer.
    """
    global layers
    if 'layers' in kwargs:
        layers = kwargs.pop('layers')
    else:
        layers = VersionAwareLayers()
    if kwargs:
        raise ValueError('Unknown argument(s): %s' % (kwargs,))
    if not (weights in {'imagenet', None} or file_io.file_exists_v2(weights)):
        raise ValueError('The `weights` argument should be either '
                         '`None` (random initialization), `imagenet` '
                         '(pre-training on ImageNet), '
                         'or the path to the weights file to be loaded.')

    if weights == 'imagenet' and include_top and classes != 1000:
        raise ValueError('If using `weights` as `"imagenet"` with `include_top`'
                         ' as true, `classes` should be 1000')

    # Determine proper input shape
    input_shape = imagenet_utils.obtain_input_shape(
        input_shape, default_size=224, min_size=32, data_format=backend.image_data_format(),
        require_flatten=include_top, weights=weights)

    if input_tensor is None:
        img_input = layers.Input(shape=input_shape)
    else:
        if not backend.is_keras_tensor(input_tensor):
            img_input = layers.Input(tensor=input_tensor, shape=input_shape)
        else:
            img_input = input_tensor

    bn_axis = 3 if backend.image_data_format() == 'channels_last' else 1

    x = layers.ZeroPadding2D(padding=((3, 3), (3, 3)), name='conv1_pad')(img_input)
    x = layers.Conv2D(
        64, 7, strides=2, use_bias=use_bias and not use_group_norm, name='conv1_conv')(x)

    if use_group_norm:
        def norm_layer(name):
            return layers.GroupNormalization(epsilon=batchnorm_epsilon, name=name)
    else:
        def norm_layer(name):
            return layers.BatchNormalization(
                axis=bn_axis, epsilon=batchnorm_epsilon, momentum=batchnorm_momentum,
                name=name)

    if not preact:
        x = norm_layer(name='conv1_gn' if use_group_norm else 'conv1_bn')(x)
        x = layers.Activation('relu', name='conv1_relu')(x)

    padding_layer = layers.ZeroPadding2D(padding=((1, 1), (1, 1)), name='pool1_pad')
    if bottomright_maxpool_test:
        padding_test = layers.ZeroPadding2D(padding=((0, 2), (0, 2)), name='pool1_pad')
        padding_layer = TrainTestSwitchLayer(padding_layer, padding_test)

    x = padding_layer(x)
    x = layers.MaxPooling2D(3, strides=2, name='pool1_pool')(x)
    x = stack_fn(x)

    if preact:
        x = norm_layer(name='post_gn' if use_group_norm else 'post_bn')(x)
        x = layers.Activation('relu', name='post_relu')(x)

    if include_top:
        x = layers.GlobalAveragePooling2D(name='avg_pool')(x)
        imagenet_utils.validate_activation(classifier_activation, weights)
        x = layers.Dense(classes, activation=classifier_activation, name='predictions')(x)
    else:
        if pooling == 'avg':
            x = layers.GlobalAveragePooling2D(name='avg_pool')(x)
        elif pooling == 'max':
            x = layers.GlobalMaxPooling2D(name='max_pool')(x)

    # Ensure that the model takes into account
    # any potential predecessors of `input_tensor`.
    if input_tensor is not None:
        inputs = layer_utils.get_source_inputs(input_tensor)
    else:
        inputs = img_input

    # Create model.
    if use_group_norm:
        model_name = model_name + '_groupnorm'
    model = training.Model(inputs, x, name=model_name)

    # Load weights.
    if (weights == 'imagenet') and (model_name in WEIGHTS_HASHES):
        if include_top:
            file_name = model_name + f'_weights_tf_dim_ordering_tf_kernels.h5'
            file_hash = WEIGHTS_HASHES[model_name][0]
        else:
            file_name = model_name + f'_weights_tf_dim_ordering_tf_kernels_notop.h5'
            file_hash = WEIGHTS_HASHES[model_name][1]
        weights_path = data_utils.get_file(
            file_name, BASE_WEIGHTS_PATH + file_name, cache_subdir='models', file_hash=file_hash)
        model.load_weights(weights_path)
    elif weights is not None:
        model.load_weights(weights)

    return model


def block1_dense(
        x, filters, kernel_size=3, striding_info=None, conv_shortcut=True,
        use_group_norm=False, v1_5=False, name=None):
    """A bottleneck residual block.

    Arguments:
      x: input tensor.
      filters: integer, filters of the bottleneck layer.
      kernel_size: default 3, kernel size of the bottleneck layer.
      stride: default 1, stride of the first layer.
      conv_shortcut: default True, use convolution shortcut if True,
          otherwise identity shortcut.
      name: string, block label.

    Returns:
      Output tensor for the residual block.
    """
    if striding_info is None:
        striding_info = StridingInfo()

    bn_axis = 3 if backend.image_data_format() == 'channels_last' else 1

    if use_group_norm:
        def norm_layer(name):
            return layers.GroupNormalization(epsilon=batchnorm_epsilon, name=name)
    else:
        def norm_layer(name):
            return layers.BatchNormalization(
                axis=bn_axis, epsilon=batchnorm_epsilon, momentum=batchnorm_momentum,
                name=name)

    use_bias = not use_group_norm
    if conv_shortcut:
        shortcut = Conv2DDenseSame(
            4 * filters, 1, strides=striding_info.strides,
            strides_test=striding_info.strides_test,
            bottomright_stride=striding_info.bottomright_stride,
            bottomright_stride_test=striding_info.bottomright_stride_test,
            use_bias=use_bias, name=name + '_0_conv')(x)
        shortcut = norm_layer(name + ('_0_gn' if use_group_norm else '_0_bn'))(shortcut)
    else:
        shortcut = x

    if v1_5:
        x = layers.Conv2D(filters, 1, strides=1, use_bias=use_bias, name=name + '_1_conv')(x)
    else:
        x = Conv2DDenseSame(
            filters, 1, strides=striding_info.strides,
            strides_test=striding_info.strides_test,
            bottomright_stride=striding_info.bottomright_stride,
            bottomright_stride_test=striding_info.bottomright_stride_test,
            use_bias=use_bias, name=name + '_1_conv')(x)

    x = norm_layer(name + ('_1_gn' if use_group_norm else '_1_bn'))(x)
    x = layers.Activation('relu', name=name + '_1_relu')(x)

    if v1_5:
        x = Conv2DDenseSame(
            filters, kernel_size, strides=striding_info.strides,
            strides_test=striding_info.strides_test,
            bottomright_stride=striding_info.bottomright_stride,
            bottomright_stride_test=striding_info.bottomright_stride_test,
            dilation_rate=striding_info.dilation_rate,
            dilation_rate_test=striding_info.dilation_rate_test,
            use_bias=use_bias, name=name + '_2_conv')(x)
    else:
        x = Conv2DDenseSame(
            filters, kernel_size, strides=1, use_bias=use_bias,
            dilation_rate=striding_info.dilation_rate,
            dilation_rate_test=striding_info.dilation_rate_test,
            name=name + '_2_conv')(x)

    x = norm_layer(name + ('_2_gn' if use_group_norm else '_2_bn'))(x)
    x = layers.Activation('relu', name=name + '_2_relu')(x)

    x = layers.Conv2D(4 * filters, 1, use_bias=use_bias, name=name + '_3_conv')(x)
    x = norm_layer(name + ('_3_gn' if use_group_norm else '_3_bn'))(x)

    x = layers.Add(name=name + '_add')([shortcut, x])
    x = layers.Activation('relu', name=name + '_out')(x)
    return x


def block1_basic_dense(
        x, filters, kernel_size=3, striding_info=None, conv_shortcut=True, use_group_norm=False,
        name=None):
    """A basic residual block.

    Arguments:
      x: input tensor.
      filters: integer, filters of the bottleneck layer.
      kernel_size: default 3, kernel size of the bottleneck layer.
      stride: default 1, stride of the first layer.
      conv_shortcut: default True, use convolution shortcut if True,
          otherwise identity shortcut.
      name: string, block label.

    Returns:
      Output tensor for the residual block.
    """
    if striding_info is None:
        striding_info = StridingInfo()
    si = striding_info

    bn_axis = 3 if backend.image_data_format() == 'channels_last' else 1

    if use_group_norm:
        def norm_layer(name):
            return layers.GroupNormalization(epsilon=batchnorm_epsilon, name=name)
    else:
        def norm_layer(name):
            return layers.BatchNormalization(
                axis=bn_axis, epsilon=batchnorm_epsilon, momentum=batchnorm_momentum,
                name=name)

    if conv_shortcut:
        shortcut = Conv2DDenseSame(
            filters, 1, strides=si.strides,
            strides_test=si.strides_test,
            bottomright_stride=si.bottomright_stride,
            bottomright_stride_test=si.bottomright_stride_test,
            use_bias=False, name=name + '_0_conv')(x)
        shortcut = norm_layer(name + ('_0_gn' if use_group_norm else '_0_bn'))(shortcut)
    else:
        shortcut = x

    x = Conv2DDenseSame(
        filters, kernel_size, strides=si.strides,
        strides_test=si.strides_test,
        bottomright_stride=si.bottomright_stride,
        bottomright_stride_test=si.bottomright_stride_test,
        dilation_rate=si.dilation_rate,
        dilation_rate_test=si.dilation_rate_test,
        use_bias=False, name=name + '_1_conv')(x)

    x = norm_layer(name + ('_1_gn' if use_group_norm else '_1_bn'))(x)
    x = layers.Activation('relu', name=name + '_1_relu')(x)

    dilation_test_conv2 = tuple(
        (np.array(si.dilation_rate_test) * si.strides / si.strides_test).astype(int))
    x = Conv2DDenseSame(
        filters, kernel_size, strides=1, use_bias=False,
        dilation_rate=si.dilation_rate,
        dilation_rate_test=dilation_test_conv2,
        name=name + '_2_conv')(x)

    x = norm_layer(name + ('_2_gn' if use_group_norm else '_2_bn'))(x)
    x = layers.Add(name=name + '_add')([shortcut, x])
    x = layers.Activation('relu', name=name + '_out')(x)
    return x


def block2_dense(x, filters, kernel_size=3, striding_info=None, conv_shortcut=False, name=None):
    """A residual block.

    Arguments:
        x: input tensor.
        filters: integer, filters of the bottleneck layer.
        kernel_size: default 3, kernel size of the bottleneck layer.
        stride: default 1, stride of the first layer.
        conv_shortcut: default False, use convolution shortcut if True,
          otherwise identity shortcut.
        name: string, block label.

    Returns:
      Output tensor for the residual block.
    """
    if striding_info is None:
        striding_info = StridingInfo()

    bn_axis = 3 if backend.image_data_format() == 'channels_last' else 1

    preact = layers.BatchNormalization(
        axis=bn_axis, epsilon=batchnorm_epsilon, momentum=batchnorm_momentum,
        name=name + '_preact_bn')(x)
    preact = layers.Activation('relu', name=name + '_preact_relu')(preact)

    if conv_shortcut:
        shortcut = Conv2DDenseSame(
            4 * filters, 1, strides=striding_info.strides,
            strides_test=striding_info.strides_test,
            bottomright_stride=striding_info.bottomright_stride,
            bottomright_stride_test=striding_info.bottomright_stride_test,
            name=name + '_0_conv')(preact)
    else:
        c_train = 1 if striding_info.bottomright_stride else 0
        crop_train = layers.Cropping2D(((c_train, 0), (c_train, 0)), name='pool1_pad')
        c_test = 1 if striding_info.bottomright_stride_test else 0
        crop_test = layers.Cropping2D(((c_test, 0), (c_test, 0)), name='pool1_pad')
        x = TrainTestSwitchLayer(crop_train, crop_test)(x)
        pool_train = layers.MaxPooling2D(1, strides=striding_info.strides)
        pool_test = layers.MaxPooling2D(1, strides=striding_info.strides_test)
        shortcut = TrainTestSwitchLayer(pool_train, pool_test)(x)

    x = layers.Conv2D(filters, 1, use_bias=False, name=name + '_1_conv')(preact)
    x = layers.BatchNormalization(
        axis=bn_axis, epsilon=batchnorm_epsilon, momentum=batchnorm_momentum,
        name=name + '_1_bn')(x)
    x = layers.Activation('relu', name=name + '_1_relu')(x)

    x = Conv2DDenseSame(
        filters, kernel_size, strides=striding_info.strides,
        strides_test=striding_info.strides_test,
        bottomright_stride=striding_info.bottomright_stride,
        bottomright_stride_test=striding_info.bottomright_stride_test,
        dilation_rate=striding_info.dilation_rate,
        dilation_rate_test=striding_info.dilation_rate_test,
        use_bias=False, name=name + '_2_conv')(x)

    x = layers.BatchNormalization(
        axis=bn_axis, epsilon=batchnorm_epsilon, momentum=batchnorm_momentum,
        name=name + '_2_bn')(x)
    x = layers.Activation('relu', name=name + '_2_relu')(x)
    x = layers.Conv2D(4 * filters, 1, name=name + '_3_conv')(x)
    x = layers.Add(name=name + '_out')([shortcut, x])
    return x


def block3(x, filters, kernel_size=3, stride=1, groups=32, conv_shortcut=True, name=None):
    """A residual block.

    Arguments:
      x: input tensor.
      filters: integer, filters of the bottleneck layer.
      kernel_size: default 3, kernel size of the bottleneck layer.
      stride: default 1, stride of the first layer.
      groups: default 32, group size for grouped convolution.
      conv_shortcut: default True, use convolution shortcut if True,
          otherwise identity shortcut.
      name: string, block label.

    Returns:
      Output tensor for the residual block.
    """
    bn_axis = 3 if backend.image_data_format() == 'channels_last' else 1

    if conv_shortcut:
        shortcut = layers.Conv2D(
            (64 // groups) * filters, 1, strides=stride, use_bias=False, name=name + '_0_conv')(x)
        shortcut = layers.BatchNormalization(
            axis=bn_axis, epsilon=batchnorm_epsilon, momentum=batchnorm_momentum,
            name=name + '_0_bn')(shortcut)
    else:
        shortcut = x

    x = layers.Conv2D(filters, 1, use_bias=False, name=name + '_1_conv')(x)
    x = layers.BatchNormalization(
        axis=bn_axis, epsilon=batchnorm_epsilon, momentum=batchnorm_momentum, name=name + '_1_bn')(
        x)
    x = layers.Activation('relu', name=name + '_1_relu')(x)

    c = filters // groups
    x = layers.ZeroPadding2D(padding=((1, 1), (1, 1)), name=name + '_2_pad')(x)
    x = layers.DepthwiseConv2D(
        kernel_size, strides=stride, depth_multiplier=c, use_bias=False,
        name=name + '_2_conv')(x)
    x_shape = backend.int_shape(x)[1:-1]
    x = layers.Reshape(x_shape + (groups, c, c))(x)
    x = layers.Lambda(
        lambda x: sum(x[:, :, :, :, i] for i in range(c)), name=name + '_2_reduce')(x)
    x = layers.Reshape(x_shape + (filters,))(x)
    x = layers.BatchNormalization(
        axis=bn_axis, epsilon=batchnorm_epsilon, momentum=batchnorm_momentum,
        name=name + '_2_bn')(x)
    x = layers.Activation('relu', name=name + '_2_relu')(x)

    x = layers.Conv2D((64 // groups) * filters, 1, use_bias=False, name=name + '_3_conv')(x)
    x = layers.BatchNormalization(
        axis=bn_axis, epsilon=batchnorm_epsilon, momentum=batchnorm_momentum,
        name=name + '_3_bn')(x)

    x = layers.Add(name=name + '_add')([shortcut, x])
    x = layers.Activation('relu', name=name + '_out')(x)
    return x


def stack1_dense(
        x, filters, blocks, use_group_norm=False, v1_5=False, striding_info_in=None,
        striding_info_out=None, name=None):
    """A set of stacked residual blocks.

    Arguments:
      x: input tensor.
      filters: integer, filters of the bottleneck layer in a block.
      blocks: integer, blocks in the stacked blocks.
      stride1: default 2, stride of the first layer in the first block.
      name: string, stack label.

    Returns:
      Output tensor for the stacked blocks.
    """
    x = block1_dense(
        x, filters, striding_info=striding_info_in, use_group_norm=use_group_norm, v1_5=v1_5,
        name=name + '_block1')
    for i in range(2, blocks + 1):
        x = block1_dense(
            x, filters, conv_shortcut=False, use_group_norm=use_group_norm, v1_5=v1_5,
            striding_info=striding_info_out, name=f'{name}_block{i}')
    return x


def stack1_basic_dense(
        x, filters, blocks, use_group_norm=False, striding_info_in=None, striding_info_out=None,
        conv1_shortcut=True, name=None):
    """A set of stacked residual blocks.

    Returns:
      Output tensor for the stacked blocks.
    """
    x = block1_basic_dense(
        x, filters, conv_shortcut=conv1_shortcut, striding_info=striding_info_in,
        use_group_norm=use_group_norm, name=name + '_block1')
    for i in range(2, blocks + 1):
        x = block1_basic_dense(
            x, filters, conv_shortcut=False, use_group_norm=use_group_norm,
            striding_info=striding_info_out, name=f'{name}_block{i}')
    return x


def stack2_dense(
        x, filters, blocks, striding_info_in, striding_info_out, name=None):
    """A set of stacked residual blocks.

    Arguments:
        x: input tensor.
        filters: integer, filters of the bottleneck layer in a block.
        blocks: integer, blocks in the stacked blocks.
        stride1: default 2, stride of the first layer in the first block.
        name: string, stack label.

    Returns:
        Output tensor for the stacked blocks.
    """
    x = block2_dense(
        x, filters, conv_shortcut=True, striding_info=striding_info_in, name=name + '_block1')
    for i in range(2, blocks):
        x = block2_dense(x, filters, striding_info=striding_info_in, name=name + '_block' + str(i))
    x = block2_dense(
        x, filters, striding_info=striding_info_out, name=name + '_block' + str(blocks))
    return x


def stack3(x, filters, blocks, stride1=2, groups=32, name=None):
    """A set of stacked residual blocks.

    Arguments:
      x: input tensor.
      filters: integer, filters of the bottleneck layer in a block.
      blocks: integer, blocks in the stacked blocks.
      stride1: default 2, stride of the first layer in the first block.
      groups: default 32, group size for grouped convolution.
      name: string, stack label.

    Returns:
      Output tensor for the stacked blocks.
    """
    x = block3(x, filters, stride=stride1, groups=groups, name=name + '_block1')
    for i in range(2, blocks + 1):
        x = block3(x, filters, groups=groups, conv_shortcut=False, name=name + '_block' + str(i))
    return x


def get_strides_and_dilations(output_stride):
    brs = [False, False, False]
    i_last_strided = int(np.round(np.log2(output_stride))) - 3
    if FLAGS.centered_stride and i_last_strided >= 0:
        brs[i_last_strided] = True
    dil_in = [1, 1, 1]
    dil_out = [1, 1, 1]
    strides = [2, 2, 2]
    i_first_nonstrided = i_last_strided + 1
    for i in range(max(0, i_first_nonstrided), 3):
        strides[i] = 1
        dil_in[i] = 2 ** (i - i_first_nonstrided)
        dil_out[i] = dil_in[i] * 2
    print('strides', strides)
    print('dil_in', dil_in)
    print('dil_out', dil_out)
    print('brs', brs)
    return strides, dil_in, dil_out, brs


def ResNetUnified(
        include_top=True, weights='imagenet', input_tensor=None, input_shape=None, pooling=None,
        classes=1000, v1_5=False, block_counts=None, name=None, **kwargs):
    use_group_norm = FLAGS.group_norm

    strides, dil_in, dil_out, brs = get_strides_and_dilations(FLAGS.stride_train)
    strides_test, dil_in_test, dil_out_test, brs_test = get_strides_and_dilations(FLAGS.stride_test)

    if v1_5:
        # for V1.5, the 3x3 conv is before the striding
        striding_infos_in = [
            StridingInfo(strides=strides[i], strides_test=strides_test[i], dilation_rate=dil_in[i],
                         dilation_rate_test=dil_in_test[i], bottomright_stride=brs[i],
                         bottomright_stride_test=brs_test[i]) for i in range(3)]
    else:
        # for V1, the 3x3 conv is after the striding, so dil_in is replaced by dil_out
        striding_infos_in = [
            StridingInfo(strides=strides[i], strides_test=strides_test[i], dilation_rate=dil_out[i],
                         dilation_rate_test=dil_out_test[i], bottomright_stride=brs[i],
                         bottomright_stride_test=brs_test[i]) for i in range(3)]
    striding_infos_out = [
        StridingInfo(strides=1, strides_test=1, dilation_rate=dil_out[i],
                     dilation_rate_test=dil_out_test[i]) for i in range(3)]
    striding_infos_first = StridingInfo(dilation_rate=dil_in[0], dilation_rate_test=dil_in_test[0])

    def stack_fn(x):
        x = stack1_dense(
            x, 64, block_counts[0], use_group_norm=use_group_norm, v1_5=v1_5, name='conv2',
            striding_info_in=striding_infos_first, striding_info_out=striding_infos_first)
        x = stack1_dense(
            x, 128, block_counts[1], use_group_norm=use_group_norm, v1_5=v1_5, name='conv3',
            striding_info_in=striding_infos_in[0], striding_info_out=striding_infos_out[0])
        x = stack1_dense(
            x, 256, block_counts[2], use_group_norm=use_group_norm, v1_5=v1_5, name='conv4',
            striding_info_in=striding_infos_in[1], striding_info_out=striding_infos_out[1])
        x = stack1_dense(
            x, 512, block_counts[3], use_group_norm=use_group_norm, v1_5=v1_5, name='conv5',
            striding_info_in=striding_infos_in[2], striding_info_out=striding_infos_out[2])
        return x

    if v1_5:
        name = name + 'v1_5'
    return ResNet(
        stack_fn, False, True, name,
        include_top, weights, input_tensor, input_shape, pooling, classes,
        use_group_norm=use_group_norm, bottomright_maxpool_test=FLAGS.stride_test == 4, **kwargs)


def ResNetUnifiedBasic(
        include_top=True, weights='imagenet', input_tensor=None, input_shape=None, pooling=None,
        classes=1000, block_counts=None, name=None, **kwargs):
    # Basic is ResNet18 and 34.
    # These are different from Resnet50, 101 and 152 and there is no V1/V1.5 distinction
    use_group_norm = FLAGS.group_norm

    strides, dil_in, dil_out, brs = get_strides_and_dilations(FLAGS.stride_train)
    strides_test, dil_in_test, dil_out_test, brs_test = get_strides_and_dilations(FLAGS.stride_test)

    striding_infos_in = [
        StridingInfo(strides=strides[i], strides_test=strides_test[i], dilation_rate=dil_out[i],
                     dilation_rate_test=dil_out_test[i], bottomright_stride=brs[i],
                     bottomright_stride_test=brs_test[i]) for i in range(3)]
    striding_infos_out = [
        StridingInfo(strides=1, strides_test=1, dilation_rate=dil_out[i],
                     dilation_rate_test=dil_out_test[i]) for i in range(3)]
    striding_infos_first = StridingInfo(dilation_rate=dil_in[0], dilation_rate_test=dil_in_test[0])

    def stack_fn(x):
        x = stack1_basic_dense(
            x, 64, block_counts[0], use_group_norm=use_group_norm, name='conv2',
            striding_info_in=striding_infos_first, striding_info_out=striding_infos_first,
            conv1_shortcut=False)
        x = stack1_basic_dense(
            x, 128, block_counts[1], use_group_norm=use_group_norm, name='conv3',
            striding_info_in=striding_infos_in[0], striding_info_out=striding_infos_out[0])
        x = stack1_basic_dense(
            x, 256, block_counts[2], use_group_norm=use_group_norm, name='conv4',
            striding_info_in=striding_infos_in[1], striding_info_out=striding_infos_out[1])
        x = stack1_basic_dense(
            x, 512, block_counts[3], use_group_norm=use_group_norm, name='conv5',
            striding_info_in=striding_infos_in[2], striding_info_out=striding_infos_out[2])
        return x

    return ResNet(
        stack_fn, False, False, name,
        include_top, weights, input_tensor, input_shape, pooling, classes,
        use_group_norm=use_group_norm, bottomright_maxpool_test=FLAGS.stride_test == 4, **kwargs)


def ResNetUnifiedV2(
        include_top=True, weights='imagenet', input_tensor=None, input_shape=None, pooling=None,
        classes=1000, classifier_activation='softmax', block_counts=None, name=None, **kwargs):
    strides, dil_in, dil_out, brs = get_strides_and_dilations(FLAGS.stride_train)
    strides_test, dil_in_test, dil_out_test, brs_test = get_strides_and_dilations(FLAGS.stride_test)
    striding_infos_in = [
        StridingInfo(strides=1, strides_test=1, dilation_rate=dil_in[i],
                     dilation_rate_test=dil_in_test[i]) for i in range(3)]
    striding_infos_out = [
        StridingInfo(strides=strides[i], strides_test=strides_test[i], dilation_rate=dil_in[i],
                     dilation_rate_test=dil_in_test[i], bottomright_stride=brs[i],
                     bottomright_stride_test=brs_test[i]) for i in range(3)]
    striding_infos_last = StridingInfo(
        dilation_rate=dil_out[-1], dilation_rate_test=dil_out_test[-1])

    def stack_fn(x):
        x = stack2_dense(
            x, 64, block_counts[0], name='conv2',
            striding_info_in=striding_infos_in[0], striding_info_out=striding_infos_out[0])
        x = stack2_dense(
            x, 128, block_counts[1], name='conv3',
            striding_info_in=striding_infos_in[1], striding_info_out=striding_infos_out[1])
        x = stack2_dense(
            x, 256, block_counts[2], name='conv4',
            striding_info_in=striding_infos_in[2], striding_info_out=striding_infos_out[2])
        x = stack2_dense(
            x, 512, block_counts[3], name='conv5',
            striding_info_in=striding_infos_last, striding_info_out=striding_infos_last)
        return x

    return ResNet(
        stack_fn, True, True, name, include_top, weights, input_tensor, input_shape,
        pooling, classes, bottomright_maxpool_test=FLAGS.stride_test == 4,
        classifier_activation=classifier_activation, **kwargs)


def ResNet18(
        include_top=True, weights='imagenet', input_tensor=None, input_shape=None, pooling=None,
        classes=1000, classifier_activation='softmax', **kwargs):
    return ResNetUnifiedBasic(
        include_top, weights, input_tensor, input_shape, pooling, classes,
        classifier_activation=classifier_activation,
        block_counts=[2, 2, 2, 2], name='resnet18', **kwargs)


def ResNet34(
        include_top=True, weights='imagenet', input_tensor=None, input_shape=None, pooling=None,
        classes=1000, classifier_activation='softmax', **kwargs):
    return ResNetUnifiedBasic(
        include_top, weights, input_tensor, input_shape, pooling, classes,
        classifier_activation=classifier_activation,
        block_counts=[3, 4, 6, 3], name='resnet34', **kwargs)


def ResNet50(
        include_top=True, weights='imagenet', input_tensor=None, input_shape=None, pooling=None,
        classes=1000, v1_5=False, **kwargs):
    """Instantiates the ResNet50 architecture."""
    return ResNetUnified(
        include_top, weights, input_tensor, input_shape, pooling, classes, v1_5,
        block_counts=[3, 4, 6, 3], name='resnet50', **kwargs)


def ResNet101(
        include_top=True, weights='imagenet', input_tensor=None, input_shape=None, pooling=None,
        classes=1000, v1_5=False, **kwargs):
    """Instantiates the ResNet101 architecture."""
    return ResNetUnified(
        include_top, weights, input_tensor, input_shape, pooling, classes, v1_5,
        block_counts=[3, 4, 23, 3], name='resnet101', **kwargs)


def ResNet152(
        include_top=True, weights='imagenet', input_tensor=None, input_shape=None, pooling=None,
        classes=1000, v1_5=False, **kwargs):
    """Instantiates the ResNet152 architecture."""
    return ResNetUnified(
        include_top, weights, input_tensor, input_shape, pooling, classes, v1_5,
        block_counts=[3, 8, 36, 3], name='resnet152', **kwargs)


def ResNet50V1_5(*args, **kwargs):
    return ResNet50(*args, **kwargs, v1_5=True)


def ResNet101V1_5(*args, **kwargs):
    return ResNet101(*args, **kwargs, v1_5=True)


def ResNet152V1_5(*args, **kwargs):
    return ResNet152(*args, **kwargs, v1_5=True)


def ResNet50V2(
        include_top=True, weights='imagenet', input_tensor=None, input_shape=None, pooling=None,
        classes=1000, classifier_activation='softmax', **kwargs):
    """Instantiates the ResNet50V2 architecture."""

    return ResNetUnifiedV2(
        include_top, weights, input_tensor, input_shape, pooling, classes, classifier_activation,
        block_counts=[3, 4, 6, 3], name='resnet50v2', **kwargs)


def ResNet101V2(
        include_top=True, weights='imagenet', input_tensor=None, input_shape=None, pooling=None,
        classes=1000, classifier_activation='softmax', **kwargs):
    """Instantiates the ResNet101V2 architecture."""

    return ResNetUnifiedV2(
        include_top, weights, input_tensor, input_shape, pooling, classes, classifier_activation,
        block_counts=[3, 4, 23, 3], name='resnet101v2', **kwargs)


def ResNet152V2(
        include_top=True, weights='imagenet', input_tensor=None, input_shape=None, pooling=None,
        classes=1000, classifier_activation='softmax', **kwargs):
    """Instantiates the ResNet152V2 architecture."""

    return ResNetUnifiedV2(
        include_top, weights, input_tensor, input_shape, pooling, classes, classifier_activation,
        block_counts=[3, 8, 36, 3], name='resnet152v2', **kwargs)


def preprocess_input_v2(x, data_format=None):
    return imagenet_utils.preprocess_input(x, data_format=data_format, mode='tf')


def preprocess_input(x, data_format=None):
    return imagenet_utils.preprocess_input(x, data_format=data_format, mode='caffe')


def decode_predictions(preds, top=5):
    return imagenet_utils.decode_predictions(preds, top=top)
