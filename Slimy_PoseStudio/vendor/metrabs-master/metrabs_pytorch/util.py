import functools
import os.path as osp

import hydra
import hydra.core.global_hydra
import posepile.datasets3d as ds3d
import simplepyutils as spu
import torch
import os
from posepile.paths import DATA_ROOT


def select_skeleton(coords_src, joint_info_src, skeleton_type_dst):
    if skeleton_type_dst == '':
        return coords_src

    def get_index(name):
        if name + '_' + skeleton_type_dst in joint_info_src.names:
            return joint_info_src.names.index(name + '_h36m')
        else:
            return joint_info_src.names.index(name)

    joint_info_dst = ds3d.get_joint_info(skeleton_type_dst)
    selected_indices = [get_index(name) for name in joint_info_dst.names]
    return torch.gather(coords_src, dim=-2, index=selected_indices)


def ensure_absolute_path(path, root=DATA_ROOT):
    if not root:
        return path

    if osp.isabs(path):
        return path
    else:
        return osp.join(root, path)


_cfg = None


@functools.lru_cache()
def get_config(config_name=None):
    global _cfg
    if _cfg is not None:
        return _cfg
    hydra.core.global_hydra.GlobalHydra.instance().clear()

    if config_name is not None and osp.isabs(config_name):
        config_path = osp.dirname(config_name)
        config_name = osp.basename(config_name)
        hydra.initialize_config_dir(config_path, version_base='1.1')
    else:
        hydra.initialize(config_path='config', version_base='1.1')

    _cfg = hydra.compose(
        config_name=config_name if config_name is not None else spu.FLAGS.config_name)
    return _cfg
