"""Native comfy-kitchen ConvRot INT4 checkpoints, separate from original weights."""

from __future__ import annotations

import json
from pathlib import Path

FORMAT = "vnccs-convrot-w4a4-v1"


def checkpoint_metadata(path):
    from safetensors import safe_open

    with safe_open(str(path), framework="pt", device="cpu") as handle:
        return handle.metadata() or {}


def load_state(path):
    """Restore packed tensor wrappers; never expand all weights to floating point."""
    import torch
    from safetensors.torch import load_file

    metadata = checkpoint_metadata(path)
    state = load_file(str(path))
    if metadata.get("format") != FORMAT:
        return state
    from comfy_kitchen.tensor import QuantizedTensor, TensorCoreConvRotW4A4Layout as Layout

    mapping = json.loads(metadata["quantization_map"])
    for name, spec in mapping.items():
        data = state[name]
        shape = tuple(spec["shape"])
        scale = state.pop(name + "_scale")
        if (len(shape) != 2 or any(type(dim) is not int or dim <= 0 for dim in shape)
                or shape[1] % 64 or spec["group_size"] not in (4, 16, 64, 256)
                or shape[1] % spec["group_size"] or spec["dtype"] not in ("float32", "float16", "bfloat16")
                or data.dtype != torch.int8 or tuple(data.shape) != (shape[0], shape[1] // 2)
                or scale.dtype != torch.float32 or scale.shape != (shape[0],)):
            raise ValueError(f"Invalid packed ConvRot weight: {name}")
        params = Layout.Params(scale=scale, orig_dtype=getattr(torch, spec["dtype"]), orig_shape=shape,
                               convrot_groupsize=spec["group_size"], quant_group_size=64)
        state[name] = QuantizedTensor(data, "TensorCoreConvRotW4A4Layout", params)
    return state


def assign_state(model, state):
    """Assign tensor subclasses, retaining ordinary checkpoint copy behavior."""
    import torch

    packed = any(getattr(value, "_layout_cls", None) == "TensorCoreConvRotW4A4Layout" for value in state.values())
    # Preserve BF16 checkpoint precision instead of copying it into FP32 parameters.
    reduced = any(value.dtype == torch.bfloat16 for value in state.values())
    return model.load_state_dict(state, assign=packed or reduced)


def compact_embedding(model):
    """Decode only requested vocabulary rows, avoiding a full floating-point embedding table."""
    import torch
    from comfy_kitchen.tensor import TensorCoreConvRotW4A4Layout as Layout

    class PackedEmbedding(torch.nn.Embedding):
        def forward(self, indices):
            from dataclasses import replace

            weight = self.weight
            rows = indices.reshape(-1)
            data = weight._qdata.index_select(0, rows)
            scale = weight._params.scale.index_select(0, rows)
            params = replace(weight._params, scale=scale, orig_shape=(len(rows), self.embedding_dim))
            return Layout.dequantize(data, params).reshape(*indices.shape, self.embedding_dim)

    original = model.embed_tokens
    replacement = PackedEmbedding(original.num_embeddings, original.embedding_dim,
                                  padding_idx=original.padding_idx, device="meta")
    model.embed_tokens = replacement
