"""Extract bounding-box detections into a padded image batch."""

import torch

from nodes import MAX_RESOLUTION


class VNCCS_BBox_Extractor:
    """Extract regions detected by BBox detector from image"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",),
                "bbox_detector": ("BBOX_DETECTOR",),
                "threshold": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
                "dilation": ("INT", {"default": 300, "min": -512, "max": 512, "step": 1}),
                "drop_size": ("INT", {"min": 1, "max": MAX_RESOLUTION, "step": 1, "default": 10}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "extract"
    CATEGORY = "VNCCS/detailing"

    def extract(self, image, bbox_detector, threshold=0.5, dilation=300, drop_size=10):
        """Extract regions detected by BBox detector"""

        if len(image) > 1:
            raise Exception('[VNCCS] ERROR: VNCCS_BBox_Extractor does not allow image batches.')

        # Fixed crop_factor for bbox detection
        crop_factor = 1.0

        try:
            segs_result = bbox_detector.detect(image, threshold, dilation, crop_factor, drop_size)
        except Exception as e:
            raise Exception(f'[VNCCS] ERROR: Failed to detect segments with bbox_detector: {str(e)}')

        segs = segs_result

        # Validate segs format
        if not isinstance(segs, tuple) or len(segs) != 2:
            raise Exception(f'[VNCCS] ERROR: Invalid segs format from bbox_detector. Expected tuple of length 2, got: {type(segs)}')

        if not isinstance(segs[1], (list, tuple)):
            raise Exception(f'[VNCCS] ERROR: Invalid segments list. Expected list or tuple, got: {type(segs[1])}')

        # Apply dilation to crop_region manually
        image_height, image_width = segs[0]
        valid_segs = []
        min_region_size = 10  # Minimum width and height to avoid too small regions

        for seg in segs[1]:
            x1, y1, x2, y2 = seg.crop_region
            x1 = max(0, x1 - dilation)
            y1 = max(0, y1 - dilation)
            x2 = min(image_width, x2 + dilation)
            y2 = min(image_height, y2 + dilation)

            if x2 - x1 >= min_region_size and y2 - y1 >= min_region_size:
                valid_segs.append((x1, y1, x2, y2))

        if len(valid_segs) == 0:
            # No segments detected, return empty image
            return (torch.zeros((1, 1, 1, 3), dtype=image.dtype, device=image.device),)

        # Extract cropped images
        extracted_images = []
        max_h = 0
        max_w = 0

        # First pass: find max dimensions
        for x1, y1, x2, y2 in valid_segs:
            h = y2 - y1
            w = x2 - x1
            max_h = max(max_h, h)
            max_w = max(max_w, w)

        # Second pass: crop and pad to max dimensions
        for x1, y1, x2, y2 in valid_segs:
            cropped = image[:, y1:y2, x1:x2, :]
            h = y2 - y1
            w = x2 - x1

            # Pad if needed to match max dimensions
            if h < max_h or w < max_w:
                pad_h_bottom = max_h - h
                pad_w_right = max_w - w
                cropped = torch.nn.functional.pad(cropped, (0, 0, 0, pad_w_right, 0, pad_h_bottom), mode='constant', value=0)

            extracted_images.append(cropped)

        # Concatenate all extracted images along batch dimension
        extracted_batch = torch.cat(extracted_images, dim=0)

        return (extracted_batch,)


NODE_CLASS_MAPPINGS = {"VNCCS_BBox_Extractor": VNCCS_BBox_Extractor}
NODE_DISPLAY_NAME_MAPPINGS = {"VNCCS_BBox_Extractor": "VNCCS BBox Extractor"}
