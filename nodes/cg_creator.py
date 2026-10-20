"""Workflow output for the standalone VNCCS CG Creator."""

import json
import re

EMPTY_STATE = '{"schema_version":1,"background_id":"","selected_image_id":"","model_id":"","selected_cg_id":""}'
_ID = re.compile(r"^[a-f0-9]{32}$")


def parse_state(raw):
    if not isinstance(raw, str) or len(raw) > 256 * 1024:
        raise ValueError("CG Creator state is invalid or too large")
    try:
        state = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise ValueError("CG Creator state is not valid JSON") from exc
    if not isinstance(state, dict) or type(state.get("schema_version")) is not int or state["schema_version"] != 1:
        raise ValueError("Unsupported CG Creator state version")
    for key in ("background_id", "selected_image_id", "model_id", "selected_cg_id"):
        value = state.get(key, "")
        if not isinstance(value, str) or (value and not _ID.fullmatch(value)):
            raise ValueError(f"CG Creator {key} is invalid")
    if state.get("camera") is not None:
        from .cg_creator_storage import _camera
        _camera(state["camera"])
    return state


class VNCCS_CGCreator:
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "create_cg"
    CATEGORY = "VNCCS/3D"
    OUTPUT_NODE = True
    DESCRIPTION = "Select a saved background, build its TripoSplat model and compose CG camera views. Workflow execution returns the selected finished CG."

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"cg_data": ("STRING", {"default": EMPTY_STATE, "multiline": True, "dynamicPrompts": False})}}

    @classmethod
    def VALIDATE_INPUTS(cls, cg_data=EMPTY_STATE):
        try:
            parse_state(cg_data)
        except ValueError as exc:
            return str(exc)
        return True

    def create_cg(self, cg_data=EMPTY_STATE):
        from .cg_creator_storage import cg_image_path
        from .factory3d.node import _preview_tensor
        state = parse_state(cg_data)
        if not state.get("background_id") or not state.get("selected_cg_id"):
            raise ValueError("Generate and select a finished CG inside VNCCS CG Creator before running the workflow")
        return (_preview_tensor(cg_image_path(state["background_id"], state["selected_cg_id"])),)
