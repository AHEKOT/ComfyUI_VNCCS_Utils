"""Pose Studio outputs a user enables in the widget's Additional Outputs settings.

A socket position is the slot number in a ComfyUI prompt, so only enabled outputs
have sockets (web/pose_studio/additional_outputs.mjs). The widget saves their names
in socket order in ``export.additional_outputs`` and the node fills the slots after
``lighting_prompt`` in that order. Only outputs in ``export.linked_additional_outputs``
are produced; every other slot is an empty list.
"""
from .character_passes import POSE_CHARACTER_OUTPUTS
from .conditioning import POSE_CONDITIONING_OUTPUTS
from .crop_guide import POSE_CROP_GUIDE_OUTPUTS

POSE_ADDITIONAL_OUTPUTS = POSE_CONDITIONING_OUTPUTS + POSE_CROP_GUIDE_OUTPUTS + POSE_CHARACTER_OUTPUTS
# A slot can hold any additional output, depending on what is enabled.
POSE_ADDITIONAL_OUTPUT_TYPE = "IMAGE,MASK,STRING"


def _names(export, key):
    return export.get(key) if isinstance(export, dict) else None


def _invalid(key, names):
    return ValueError(f"export.{key} is not a valid output list: {names!r}")


def enabled_additional_outputs(export):
    """Enabled outputs in socket order. A wrong list would send images to the wrong link."""
    names = _names(export, "additional_outputs")
    if names is None:
        return ()
    if (
        not isinstance(names, list)
        or len(set(map(str, names))) != len(names)
        or any(name not in POSE_ADDITIONAL_OUTPUTS for name in names)
    ):
        raise _invalid("additional_outputs", names)
    return tuple(names)


def linked_additional_outputs(export, enabled):
    """Enabled outputs to produce. Without a saved link list, all of them."""
    names = _names(export, "linked_additional_outputs")
    if names is None:
        return tuple(enabled)
    if not isinstance(names, list) or any(name not in enabled for name in names):
        raise _invalid("linked_additional_outputs", names)
    return tuple(name for name in enabled if name in names)
