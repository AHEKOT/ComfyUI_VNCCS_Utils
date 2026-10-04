"""Build vendored ARDY / Kimodo models from their checkpoint ``config.yaml`` without Hydra.

The released checkpoints describe the model as a Hydra config: nested dicts whose
``_target_`` names a class (``ardy.model.Ardy``) and ``${...}`` references to other
keys (``${checkpoint_dir}/denoiser.safetensors``). This module reads that YAML with
PyYAML, resolves the references, and instantiates the classes. ``_target_`` can only
name a class or function of the vendored packages: anything else is refused, so a
config file cannot reach arbitrary Python.
"""

from __future__ import annotations

import functools
import re
import sys
from pathlib import Path

import yaml

_REF_RE = re.compile(r"\$\{([^${}]+)\}")
_RESERVED = {"_target_", "_partial_", "_args_", "_recursive_", "_convert_"}
_MAX_DEPTH = 64


class ConfigError(ValueError):
    pass


def load_yaml(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    if not isinstance(data, dict):
        raise ConfigError(f"{path.name} is not a mapping")
    return data


def _lookup(root: dict, dotted: str):
    node = root
    for part in dotted.strip().split("."):
        if isinstance(node, dict) and part in node:
            node = node[part]
        elif isinstance(node, list) and part.isdigit() and int(part) < len(node):
            node = node[int(part)]
        else:
            raise ConfigError(f"config reference ${{{dotted}}} does not exist")
    return node


def resolve(cfg, root: dict | None = None, depth: int = 0):
    """Replace ``${a.b}`` references with the referenced values (recursively)."""
    root = cfg if root is None else root
    if depth > _MAX_DEPTH:
        raise ConfigError("config references are nested too deeply or circular")
    if isinstance(cfg, dict):
        return {key: resolve(value, root, depth + 1) for key, value in cfg.items()}
    if isinstance(cfg, list):
        return [resolve(value, root, depth + 1) for value in cfg]
    if isinstance(cfg, str) and "${" in cfg:
        refs = _REF_RE.findall(cfg)
        for ref in refs:
            if ":" in ref:
                raise ConfigError(f"config resolver ${{{ref}}} is not supported")
        whole = _REF_RE.fullmatch(cfg)
        if whole:
            return resolve(_lookup(root, whole.group(1)), root, depth + 1)
        return _REF_RE.sub(lambda m: str(resolve(_lookup(root, m.group(1)), root, depth + 1)), cfg)
    return cfg


class TargetRegistry:
    """Classes and functions of the vendored packages, under their original dotted names.

    ``vendor_package`` is the import name of this vendor folder (for example
    ``custom_nodes.ComfyUI_VNCCS_Utils.api.text_to_motion.vendor``); a module
    ``<vendor_package>.ardy.model.backbone`` is known as ``ardy.model.backbone``.
    """

    def __init__(self, vendor_package: str, families: tuple):
        self.vendor_package = vendor_package
        self.families = tuple(families)

    def _modules(self):
        prefix = self.vendor_package + "."
        for name, module in list(sys.modules.items()):
            if module is None or not name.startswith(prefix):
                continue
            original = name[len(prefix):]
            if original.split(".")[0] in self.families:
                yield original, module

    def resolve(self, target: str):
        if not isinstance(target, str) or "." not in target:
            raise ConfigError(f"invalid _target_: {target!r}")
        if target.split(".")[0] not in self.families:
            raise ConfigError(f"_target_ {target!r} is outside the vendored motion models")
        module_name, attr = target.rsplit(".", 1)
        candidates = []
        for original, module in self._modules():
            if original == module_name or original.startswith(module_name + "."):
                value = getattr(module, attr, None)
                if callable(value) and getattr(value, "__module__", "").startswith(self.vendor_package + "."):
                    if original == module_name:
                        return value
                    candidates.append(value)
        unique = list(dict.fromkeys(candidates))
        if len(unique) == 1:
            return unique[0]
        if not unique:
            raise ConfigError(f"_target_ {target!r} is not part of the vendored code")
        raise ConfigError(f"_target_ {target!r} is ambiguous")


def instantiate(cfg, registry: TargetRegistry, depth: int = 0):
    """Hydra-style instantiation limited to vendored classes (``_partial_`` and ``_args_`` supported)."""
    if depth > _MAX_DEPTH:
        raise ConfigError("config is nested too deeply")
    if isinstance(cfg, list):
        return [instantiate(value, registry, depth + 1) for value in cfg]
    if not isinstance(cfg, dict):
        return cfg
    if "_target_" not in cfg:
        return {key: instantiate(value, registry, depth + 1) for key, value in cfg.items()}
    target = registry.resolve(cfg["_target_"])
    recursive = cfg.get("_recursive_", True)
    build = (lambda value: instantiate(value, registry, depth + 1)) if recursive else (lambda value: value)
    args = [build(value) for value in cfg.get("_args_", [])]
    kwargs = {key: build(value) for key, value in cfg.items() if key not in _RESERVED}
    if cfg.get("_partial_"):
        return functools.partial(target, *args, **kwargs)
    return target(*args, **kwargs)
