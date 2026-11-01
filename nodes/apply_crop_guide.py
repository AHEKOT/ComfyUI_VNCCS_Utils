"""VNCCS Apply Crop Guide: crop any IMAGE with a Pose Studio crop_json.

Pure image processing; it does not depend on the Pose Studio widget or 3D viewer.
"""
from .posestudio.crop_guide import apply_crop_guide, parse_crop_json


class VNCCS_ApplyCropGuide:
    """Crops images with the normalized rectangle of a Pose Studio crop guide."""

    # Lists in, lists out: crops of different poses can have different sizes and
    # are never stacked into one tensor. Each output item keeps the batch of its
    # input image, cropped with the same rectangle.
    INPUT_IS_LIST = True
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("cropped_image",)
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "apply"
    CATEGORY = "VNCCS/pose"
    DESCRIPTION = (
        "Crops an image with a VNCCS Pose Studio crop_json at the image's own resolution "
        "(no resize). Pairs images and crop_json values in order; a single crop_json applies "
        "to every image, and one batched image is split per crop_json. A disabled guide "
        "returns the image unchanged."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "crop_json": ("STRING", {"forceInput": True}),
            },
            "optional": {
                "aspect_mismatch": (["error", "stretch"], {
                    "default": "error",
                    "tooltip": (
                        "When the image aspect ratio differs from the Pose Studio capture: error "
                        "(safe; letterboxed or center-cropped results need their own transform) or "
                        "stretch (the image was only resized, so scale the rectangle per axis)."
                    ),
                }),
            },
        }

    def apply(self, image, crop_json, aspect_mismatch=None):
        images = list(image or [])
        records = [parse_crop_json(value) for value in (crop_json or [])]
        mode = (aspect_mismatch or ["error"])[0]
        if mode not in ("error", "stretch"):
            raise ValueError(f"aspect_mismatch must be error or stretch, got {mode!r}")
        if not images:
            raise ValueError("Apply Crop Guide received no image")
        if not records:
            raise ValueError("Apply Crop Guide received no crop_json")
        if len(records) == 1:
            pairs = [(item, records[0]) for item in images]
        elif len(images) == len(records):
            pairs = list(zip(images, records))
        elif len(images) == 1 and int(images[0].shape[0]) == len(records):
            # One batch holding one image per pose: split it so each pose gets its own crop.
            pairs = [(images[0][index:index + 1], record) for index, record in enumerate(records)]
        else:
            batch = ", ".join(str(int(item.shape[0])) for item in images)
            raise ValueError(
                f"Apply Crop Guide received {len(images)} image item(s) (batch sizes {batch}) and "
                f"{len(records)} crop_json values. Provide one crop_json, one per image, or one "
                "batch with one image per crop_json, in Pose Studio pose order."
            )
        return ([apply_crop_guide(item, record, mode) for item, record in pairs],)


NODE_CLASS_MAPPINGS = {"VNCCS_ApplyCropGuide": VNCCS_ApplyCropGuide}
NODE_DISPLAY_NAME_MAPPINGS = {"VNCCS_ApplyCropGuide": "VNCCS Apply Crop Guide"}
