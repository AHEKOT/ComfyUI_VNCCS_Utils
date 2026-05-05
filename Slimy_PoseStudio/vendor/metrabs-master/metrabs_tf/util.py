import itertools
import os.path as osp

import numpy as np
from numpy.random import PCG64
from posepile.paths import DATA_ROOT

TRAIN = 0
VALID = 1
TEST = 2


def new_rng(rng):
    return np.random.Generator(np.random.PCG64(rng.integers(low=0, high=2 ** 32 - 1)))


def choice(items, rng):
    return items[rng.integers(low=0, high=len(items) - 1)]


def random_uniform_disc(rng):
    """Samples a random 2D point from the unit disc with a uniform distribution."""
    angle = rng.uniform(-np.pi, np.pi)
    radius = np.sqrt(rng.uniform(0, 1))
    return radius * np.array([np.cos(angle), np.sin(angle)])


def ensure_absolute_path(path, root=DATA_ROOT):
    if not root:
        return path

    if osp.isabs(path):
        return path
    else:
        return osp.join(root, path)


def cycle_over_colors(range_zero_one=False):
    """Returns a generator that cycles over a list of nice colors, indefinitely."""
    colors = ((0.12156862745098039, 0.46666666666666667, 0.70588235294117652),
              (1.0, 0.49803921568627452, 0.054901960784313725),
              (0.17254901960784313, 0.62745098039215685, 0.17254901960784313),
              (0.83921568627450982, 0.15294117647058825, 0.15686274509803921),
              (0.58039215686274515, 0.40392156862745099, 0.74117647058823533),
              (0.5490196078431373, 0.33725490196078434, 0.29411764705882354),
              (0.8901960784313725, 0.46666666666666667, 0.76078431372549016),
              (0.49803921568627452, 0.49803921568627452, 0.49803921568627452),
              (0.73725490196078436, 0.74117647058823533, 0.13333333333333333),
              (0.090196078431372548, 0.74509803921568629, 0.81176470588235294))

    if not range_zero_one:
        colors = [[c * 255 for c in color] for color in colors]

    return itertools.cycle(colors)
