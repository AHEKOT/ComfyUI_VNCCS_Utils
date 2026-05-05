# Copyright 2021 Google Research. All Rights Reserved.
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
"""Model utilities."""
import functools

import keras
import tensorflow as tf

from metrabs_tf import tfu


def activation_fn(features: tf.Tensor, act_fn: str):
    """Customized non-linear activation type."""
    if act_fn in ('silu', 'swish'):
        return tf.nn.swish(features)
    elif act_fn == 'silu_native':
        return features * tf.sigmoid(features)
    elif act_fn == 'hswish':
        return features * tf.nn.relu6(features + 3) / 6
    elif act_fn == 'relu':
        return tf.nn.relu(features)
    elif act_fn == 'relu6':
        return tf.nn.relu6(features)
    elif act_fn == 'elu':
        return tf.nn.elu(features)
    elif act_fn == 'leaky_relu':
        return tf.nn.leaky_relu(features)
    elif act_fn == 'selu':
        return tf.nn.selu(features)
    elif act_fn == 'mish':
        return features * tf.math.tanh(tf.math.softplus(features))
    else:
        raise ValueError('Unsupported act_fn {}'.format(act_fn))


def get_act_fn(act_fn):
    if not act_fn:
        return tf.nn.silu
    if isinstance(act_fn, str):
        return functools.partial(activation_fn, act_fn=act_fn)
    return act_fn


class BatchNormalization(keras.layers.BatchNormalization):
    """Fixed default name of BatchNormalization to match TpuBatchNormalization."""

    def __init__(self, **kwargs):
        if not kwargs.get('name', None):
            kwargs['name'] = 'tpu_batch_normalization'
        super().__init__(**kwargs)


_BatchNorm = None


def set_batchnorm(cls):
    global _BatchNorm
    _BatchNorm = cls


def normalization(
        norm_type: str, axis=-1, epsilon=0.001, momentum=0.99, groups=8, name=None):
    """Normalization after conv layers."""
    return _BatchNorm(axis=axis, momentum=momentum, epsilon=epsilon, name=name)


def drop_connect(inputs, is_training, survival_prob):
    """Drop the entire conv with given survival probability."""
    # "Deep Networks with Stochastic Depth", https://arxiv.org/pdf/1603.09382.pdf
    if not is_training:
        return inputs

    # Compute tensor.
    batch_size = tf.shape(inputs)[0]
    random_tensor = survival_prob

    rng = tf.random.get_global_generator()
    random_tensor += tf.cast(rng.uniform([batch_size, 1, 1, 1], dtype=tf.float32), inputs.dtype)
    binary_tensor = tf.floor(random_tensor)

    # Unlike conventional way that multiply survival_prob at test time, here we
    # divide survival_prob at training time, such that no addition compute is
    # needed at test time.
    output = inputs / survival_prob * binary_tensor
    return output


def fixed_padding(inputs, kernel_size, rate=1, shifts=(0, 0), data_format=None):
    """Pads the input along the spatial dimensions independently of input size.

    Pads the input such that if it was used in a convolution with 'VALID' padding,
    the output would have the same dimensions as if the unpadded input was used
    in a convolution with 'SAME' padding.

    Args:
      inputs: A tensor of size [batch, height_in, width_in, channels].
      kernel_size: The kernel to be used in the conv2d or max_pool2d operation.
      rate: An integer, rate for atrous convolution.

    Returns:
      output: A tensor of size [batch, height_out, width_out, channels] with the
        input, either intact (if kernel_size == 1) or padded (if kernel_size > 1).
    """
    # The total area covered by the kernel is its size plus the dilation gaps
    # There are `kernel_size - 1` gaps and each gap has size `rate - 1`
    if isinstance(kernel_size, tuple):
        assert kernel_size[0] == kernel_size[1]
        kernel_size = kernel_size[0]

    kernel_size_effective = kernel_size + (kernel_size - 1) * (rate - 1)
    pad_total = kernel_size_effective - 1

    # Half of the padding is at the start
    pad_beg = pad_total // 2
    pad_end = pad_total - pad_beg
    pad_vertical = [pad_beg - shifts[0], pad_end + shifts[0]]
    pad_horizontal = [pad_beg - shifts[1], pad_end + shifts[1]]
    s = inputs.shape.as_list()

    if data_format is None:
        data_format = 'channels_last' if tfu.get_data_format() == 'NHWC'  else 'channels_first'
    if data_format == 'channels_last':
        padded_inputs = tf.pad(inputs, [[0, 0], pad_vertical, pad_horizontal, [0, 0]])
        if s[1] is not None:
            padded_inputs.set_shape([s[0], s[1] + pad_total, s[2] + pad_total, s[3]])
    else:
        padded_inputs = tf.pad(inputs, [[0, 0], [0, 0], pad_vertical, pad_horizontal])
        if s[1] is not None:
            padded_inputs.set_shape([s[0], s[1], s[2] + pad_total, s[3] + pad_total])

    return padded_inputs
