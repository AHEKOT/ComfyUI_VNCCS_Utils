"""Declarative ComfyUI node pipelines used by model modules with non-standard graphs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .comfy_bridge import _call_node_method, _is_comfy_node_output, _unwrap_comfy_node_output
from .debug import _uc_log


@dataclass(frozen=True)
class UniCanvasNodeStep:
    """One declarative Comfy node invocation inside a UniCanvas pipeline.

    Inputs may reference values in the pipeline context with "$name". The node is
    called through ComfyUI's NODE_CLASS_MAPPINGS and its FUNCTION metadata, so
    contributors do not need to know Python method names for most core nodes.
    """

    node: str | tuple[str, ...]
    inputs: dict[str, Any]
    output: str
    methods: tuple[str, ...] = ()
    output_index: int = 0
    optional: bool = False
    description: str = ""


@dataclass(frozen=True)
class UniCanvasPipeline:
    """Declarative inference graph for model modules with non-standard nodes."""

    reference: tuple[UniCanvasNodeStep, ...] = ()
    sample: tuple[UniCanvasNodeStep, ...] = ()
    decode: tuple[UniCanvasNodeStep, ...] = ()


def _pipeline_ref_path(context: dict[str, Any], path: str) -> Any:
    value: Any = context
    for part in path.split("."):
        if isinstance(value, dict):
            value = value.get(part)
        else:
            value = getattr(value, part)
    return value


def _resolve_pipeline_value(value: Any, context: dict[str, Any]) -> Any:
    if isinstance(value, str) and value.startswith("$"):
        return _pipeline_ref_path(context, value[1:])
    if isinstance(value, dict):
        return {key: _resolve_pipeline_value(item, context) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_resolve_pipeline_value(item, context) for item in value)
    return value


def _select_pipeline_output(result: Any, output_index: int) -> Any:
    if _is_comfy_node_output(result):
        result = _unwrap_comfy_node_output(result)
    if isinstance(result, tuple):
        if not result:
            return None
        return result[min(max(int(output_index), 0), len(result) - 1)]
    return result


def _run_pipeline_step(step: UniCanvasNodeStep, context: dict[str, Any], draw_id: str) -> Any:
    node_names = list(step.node if isinstance(step.node, tuple) else (step.node,))
    inputs = {key: _resolve_pipeline_value(value, context) for key, value in step.inputs.items()}
    result = _call_node_method(node_names, list(step.methods), **inputs)
    selected = _select_pipeline_output(result, step.output_index)
    if selected is None and not step.optional:
        label = step.description or step.node
        raise RuntimeError(f"{label} is unavailable or returned no output")
    context[step.output] = selected
    if step.description:
        _uc_log(draw_id, f"pipeline step {step.description}", {"output": step.output, "type": type(selected).__name__})
    return selected


def _run_pipeline_steps(steps: tuple[UniCanvasNodeStep, ...], context: dict[str, Any], draw_id: str) -> dict[str, Any]:
    for step in steps:
        _run_pipeline_step(step, context, draw_id)
    return context
