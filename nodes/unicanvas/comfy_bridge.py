"""Helpers that call ComfyUI node classes directly, outside a workflow graph."""

from __future__ import annotations

import importlib.util
import inspect
import sys
from typing import Any, Callable


def find_loaded_module(predicate: Callable[[str, Any], bool]) -> Any:
    """First already-imported module (e.g. another custom node's) that matches ``predicate``."""
    for name, module in list(sys.modules.items()):
        try:
            if module is not None and predicate(name, module):
                return module
        except Exception:
            continue
    return None


def import_loaded_submodule(name: str) -> Any:
    """Import ``name`` (a submodule of an already loaded package) the way ``import`` would."""
    module = sys.modules.get(name)
    if module is not None:
        return module
    spec = importlib.util.find_spec(name)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module


def _call_comfy_node(class_name: str, **kwargs):
    """Invoke a built-in/registered ComfyUI node class without a graph."""
    import inspect

    import nodes as comfy_nodes

    mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {}) or {}
    cls = mappings.get(class_name)
    if cls is None:
        raise RuntimeError(f"Required node '{class_name}' is not available")
    instance = cls()
    method_name = getattr(cls, "FUNCTION", None)
    method = getattr(instance, method_name, None) if method_name else None
    if method is None:
        for candidate in ("execute", "sample", "decode", "process"):
            method = getattr(instance, candidate, None)
            if method is not None:
                break
    if method is None:
        raise RuntimeError(f"Node '{class_name}' has no callable FUNCTION")
    signature = inspect.signature(method)
    accepts_kwargs = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in signature.parameters.values())
    accepted = kwargs if accepts_kwargs else {k: v for k, v in kwargs.items() if k in signature.parameters}
    result = method(**accepted)
    # V3 (io.ComfyNode) nodes return a NodeOutput; callers expect the V1 result tuple.
    args = getattr(result, "args", None)
    if not isinstance(result, (tuple, list)) and isinstance(args, tuple) and hasattr(result, "block_execution"):
        return args
    return result


def _safe_filename_list(category: str) -> list[str]:
    try:
        import folder_paths

        return folder_paths.get_filename_list(category)
    except Exception:
        return []


def _get_node_combo_values(class_names: list[str], input_name: str) -> list[str]:
    try:
        import nodes

        mappings = getattr(nodes, "NODE_CLASS_MAPPINGS", {}) or {}
        for class_name in class_names:
            node_cls = mappings.get(class_name)
            if node_cls is None or not hasattr(node_cls, "INPUT_TYPES"):
                continue
            input_types = node_cls.INPUT_TYPES()
            if not isinstance(input_types, dict):
                continue
            for section_name in ("required", "optional"):
                section = input_types.get(section_name) or {}
                if not isinstance(section, dict) or input_name not in section:
                    continue
                spec = section.get(input_name)
                if isinstance(spec, (list, tuple)) and spec:
                    values = spec[0]
                    if isinstance(values, (list, tuple)):
                        return [str(value) for value in values]
    except Exception:
        return []
    return []


def _call_loader_node(class_names: list[str], method_names: list[str], **kwargs):
    import nodes

    mappings = getattr(nodes, "NODE_CLASS_MAPPINGS", {}) or {}
    for class_name in class_names:
        loader_cls = mappings.get(class_name)
        if loader_cls is None:
            continue
        loader = loader_cls()
        candidate_method_names = list(method_names)
        function_name = getattr(loader_cls, "FUNCTION", None)
        if function_name and function_name not in candidate_method_names:
            candidate_method_names.append(function_name)
        for method_name in candidate_method_names:
            method = getattr(loader, method_name, None)
            if method is None:
                continue
            accepted_kwargs = _filter_node_kwargs(loader_cls, method, kwargs)
            result = method(**accepted_kwargs)
            return _unwrap_single_node_result(result)
    return None


def _is_comfy_node_output(value: Any) -> bool:
    return hasattr(value, "result") and hasattr(value, "args") and type(value).__name__ == "NodeOutput"


def _unwrap_comfy_node_output(value: Any) -> Any:
    if not _is_comfy_node_output(value):
        return value
    block_execution = getattr(value, "block_execution", None)
    if block_execution:
        raise RuntimeError(str(block_execution))
    return getattr(value, "result", None)


def _unwrap_single_node_result(result: Any) -> Any:
    result = _unwrap_comfy_node_output(result)
    if isinstance(result, tuple):
        if not result:
            return None
        return result[0]
    return result


def _node_input_names(node_cls: Any) -> set[str]:
    input_types_fn = getattr(node_cls, "INPUT_TYPES", None)
    if input_types_fn is None:
        return set()
    try:
        input_types = input_types_fn()
    except Exception:
        return set()
    names: set[str] = set()
    if not isinstance(input_types, dict):
        return names
    for section_name in ("required", "optional", "hidden"):
        section = input_types.get(section_name)
        if isinstance(section, dict):
            names.update(str(key) for key in section.keys())
    return names


def _filter_node_kwargs(node_cls: Any, method: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    signature = inspect.signature(method)
    has_var_keyword = any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values())
    input_names = _node_input_names(node_cls)
    if input_names:
        return {key: value for key, value in kwargs.items() if key in input_names}
    if has_var_keyword:
        return dict(kwargs)
    return {key: value for key, value in kwargs.items() if key in signature.parameters}


def _call_node_method(class_names: list[str], method_names: list[str], **kwargs):
    import nodes

    mappings = getattr(nodes, "NODE_CLASS_MAPPINGS", {}) or {}
    for class_name in class_names:
        node_cls = mappings.get(class_name)
        if node_cls is None:
            continue
        node_instance = node_cls()
        candidate_method_names = list(method_names)
        function_name = getattr(node_cls, "FUNCTION", None)
        if function_name and function_name not in candidate_method_names:
            candidate_method_names.append(function_name)
        for method_name in candidate_method_names:
            method = getattr(node_instance, method_name, None)
            if method is None:
                continue
            accepted_kwargs = _filter_node_kwargs(node_cls, method, kwargs)
            return _unwrap_single_node_result(method(**accepted_kwargs))
    return None
