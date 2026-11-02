"""VNCCS Character Export: per-character crops and masks from VNCCS Pose Studio.

Pure image processing on Pose Studio outputs; it does not depend on the Pose
Studio widget or 3D viewer.
"""
import torch

from .posestudio.character_export import (
    CHARACTER_EXPORT_ALIGNS,
    CHARACTER_EXPORT_KINDS,
    DEPTH_NORMALIZATIONS,
    export_character_lists,
)


def _first(value, default):
    if isinstance(value, list):
        return value[0] if value else default
    return default if value is None else value


class VNCCS_CharacterExport:
    """Splits multi-character Pose Studio images into per-character crops."""

    # Lists in, lists out: every per-kind output has one item per exported
    # character (captured image first, then ascending slot), sized to that
    # character's crop_rect; meta has one JSON string per captured image.
    INPUT_IS_LIST = True
    RETURN_TYPES = ("IMAGE",) * len(CHARACTER_EXPORT_KINDS) + ("STRING",)
    RETURN_NAMES = CHARACTER_EXPORT_KINDS + ("meta",)
    OUTPUT_IS_LIST = (True,) * (len(CHARACTER_EXPORT_KINDS) + 1)
    FUNCTION = "export"
    CATEGORY = "VNCCS/pose"
    DESCRIPTION = (
        "Crops every character of VNCCS Pose Studio images into its own control images: solo "
        "normal and depth (including parts hidden by other characters), the Character ID crop, "
        "the visible mask for compositing, the full-body mask for inpainting and the RGB crop. "
        "meta gives each crop_rect in full-image pixels."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "images output of VNCCS Pose Studio (LIST)."}),
                "character_id": ("IMAGE", {"tooltip": "character_id output of the same Pose Studio run."}),
                "character_json": ("STRING", {"forceInput": True}),
                "character_passes": ("IMAGE", {"tooltip": "character_passes output of the same Pose Studio run."}),
                "margin": ("INT", {
                    "default": 64, "min": 0, "max": 4096, "step": 1,
                    "tooltip": "Pixels added around each character's full-body bounds, at the output resolution.",
                }),
                "align": ([str(value) for value in CHARACTER_EXPORT_ALIGNS], {
                    "default": "8",
                    "tooltip": "Crop width and height are grown to multiples of this value.",
                }),
                "depth_normalization": (list(DEPTH_NORMALIZATIONS), {
                    "default": "scene",
                    "tooltip": (
                        "scene: one depth scale for every character of the image (nearest 255, farthest 32). "
                        "character: 255..32 over this character's own body."
                    ),
                }),
            },
        }

    def export(self, images, character_id, character_json, character_passes,
               margin=None, align=None, depth_normalization=None):
        margin = _first(margin, 64)
        align = int(_first(align, "8"))
        mode = _first(depth_normalization, "scene")
        outputs, metas = export_character_lists(
            images, character_id, character_json, character_passes, margin, align, mode,
        )
        lists = tuple(
            [torch.from_numpy(array).unsqueeze(0) for array in outputs[kind]]
            for kind in CHARACTER_EXPORT_KINDS
        )
        return lists + (metas,)


NODE_CLASS_MAPPINGS = {"VNCCS_CharacterExport": VNCCS_CharacterExport}
NODE_DISPLAY_NAME_MAPPINGS = {"VNCCS_CharacterExport": "VNCCS Character Export"}
