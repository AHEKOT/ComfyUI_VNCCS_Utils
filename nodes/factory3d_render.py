"""Graph outputs for persistent Factory conditioning captures."""

import json
import time

import numpy as np
import torch
from PIL import Image, ImageFilter


def _services():
    from ..api import factory3d, factory3d_conditioning
    return factory3d, factory3d_conditioning


def _image(path):
    with Image.open(path) as image:
        array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255
    return torch.from_numpy(array[None].copy())


def capture_outputs(backend, service, handle):
    directory, manifest = service.load_capture(backend, handle)
    settings = manifest["settings"]
    rgb, depth, normals, alpha, ids, metadata = [], [], [], [], [], []
    for index in range(len(manifest["shots"])):
        root = directory / str(index)
        rgb.append(_image(root / "rgb.png")); normals.append(_image(root / "normal.png")); ids.append(_image(root / "object_id.png"))
        with Image.open(root / "alpha.png") as image:
            coverage = np.asarray(image, dtype=np.float32) / 255
        alpha.append(torch.from_numpy(coverage[None].copy()))
        metric = np.fromfile(root / "depth.f32", dtype="<f4").reshape(settings["height"], settings["width"])
        gray = 1 - np.clip((metric - settings["depth_min"]) / (settings["depth_max"] - settings["depth_min"]), 0, 1)
        gray[coverage == 0] = 0
        depth.append(torch.from_numpy(np.repeat(gray[None, :, :, None], 3, axis=-1)))
        info = json.loads((root / "metadata.json").read_text())
        info.update(entity_ids=manifest["entity_ids"], depth_preview="inverse_linear",
                    depth_min=settings["depth_min"], depth_max=settings["depth_max"])
        metadata.append(json.dumps(info, sort_keys=True))
    return rgb, depth, normals, alpha, ids, metadata, handle


class VNCCS_FactoryRender:
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "MASK", "IMAGE", "STRING", "VNCCS_FACTORY_CAPTURE")
    RETURN_NAMES = ("rgb", "depth", "normal", "alpha", "object_id", "camera_metadata", "capture")
    OUTPUT_IS_LIST = (True, True, True, True, True, True, False)
    FUNCTION = "render"
    CATEGORY = "VNCCS/3D"
    DESCRIPTION = "Capture RGB, metric depth, view normals and object masks from the connected 3D Factory scene. Fresh captures require its open widget in 3D view."

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "scene": ("VNCCS_FACTORY_SCENE",),
            "profile": (["Mesh geometry", "Coarse boxes for Gaussian objects"],
                        {"tooltip": "Gaussian splats require explicit coarse box approval. Boxes are approximate conditioning geometry."}),
            "width": ("INT", {"default": 1024, "min": 64, "max": 2048, "step": 64}),
            "height": ("INT", {"default": 1024, "min": 64, "max": 2048, "step": 64}),
            "depth_min": ("FLOAT", {"default": 0.1, "min": 0, "max": 1000000, "tooltip": "Meters; white in the depth preview."}),
            "depth_max": ("FLOAT", {"default": 100, "min": 0.001, "max": 1000000, "tooltip": "Meters; black in the preview. Raw metric depth is retained independently."}),
        }}

    def render(self, scene, profile, width, height, depth_min, depth_max):
        backend, service = _services()
        job = service.prepare_capture(backend, scene, profile, width, height, depth_min, depth_max)
        if "capture" in job:
            return capture_outputs(backend, service, job["capture"])
        try:
            if not scene.get("owner_node_id"):
                raise RuntimeError("Render host required: execute 3D Factory with its widget open in 3D view")
            from server import PromptServer
            PromptServer.instance.send_sync("vnccs_req_factory_conditioning", {
                "node_id": scene["owner_node_id"], "scene_id": scene["scene_id"], "job_id": job["job_id"],
            })
            deadline = time.monotonic() + 300
            while time.monotonic() < deadline:
                from comfy.model_management import throw_exception_if_processing_interrupted
                throw_exception_if_processing_interrupted()
                current = service.read_job(backend, scene["scene_id"], job["job_id"])
                if current["status"] == "complete":
                    return capture_outputs(backend, service, current["capture"])
                if current["status"] == "failed":
                    raise RuntimeError(current.get("error", "Conditioning capture failed"))
                time.sleep(0.1)
            raise RuntimeError("Render host required or capture timed out. Keep the 3D Factory widget open and execute again.")
        except BaseException as exc:
            service.fail_job(backend, scene["scene_id"], job["job_id"], str(exc))
            raise


class VNCCS_FactoryMask:
    RETURN_TYPES = ("MASK", "STRING")
    RETURN_NAMES = ("mask", "metadata")
    OUTPUT_IS_LIST = (True, True)
    FUNCTION = "mask"
    CATEGORY = "VNCCS/3D"
    DESCRIPTION = "Select exact entity IDs from a Factory capture. White means selected foreground. Empty selection selects all geometry."

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "capture": ("VNCCS_FACTORY_CAPTURE",),
            "entities": ("STRING", {"default": "", "multiline": True,
                                   "tooltip": "Comma/newline-separated entity keys from camera_metadata, e.g. object:<id>, wall:<id>, room:<id>. Empty selects all."}),
            "invert": ("BOOLEAN", {"default": False}),
            "grow_pixels": ("INT", {"default": 0, "min": -64, "max": 64, "tooltip": "Positive dilates; negative erodes."}),
            "feather_pixels": ("FLOAT", {"default": 0, "min": 0, "max": 64}),
        }}

    def mask(self, capture, entities="", invert=False, grow_pixels=0, feather_pixels=0):
        backend, service = _services()
        directory, manifest = service.load_capture(backend, capture)
        keys = {key.strip() for key in str(entities).replace("\n", ",").split(",") if key.strip()}
        unknown = keys.difference(manifest["entity_ids"])
        if unknown:
            raise ValueError("Unknown capture entities: " + ", ".join(sorted(unknown)))
        if type(grow_pixels) is not int or not -64 <= grow_pixels <= 64 or not 0 <= float(feather_pixels) <= 64:
            raise ValueError("Mask grow/feather must be within 64 pixels")
        selected = [manifest["entity_ids"][key] for key in keys]
        masks, metadata = [], []
        for index, shot in enumerate(manifest["shots"]):
            with Image.open(directory / str(index) / "object_id.png") as image:
                pixels = np.asarray(image.convert("RGB"), dtype=np.uint32)
            ids = pixels[:, :, 0] * 65536 + pixels[:, :, 1] * 256 + pixels[:, :, 2]
            mask = (np.isin(ids, selected) if keys else ids != 0).astype(np.uint8) * 255
            if invert:
                mask = 255 - mask
            image = Image.fromarray(mask)
            if grow_pixels:
                kernel = abs(grow_pixels) * 2 + 1
                image = image.filter(ImageFilter.MaxFilter(kernel) if grow_pixels > 0 else ImageFilter.MinFilter(kernel))
            if feather_pixels:
                image = image.filter(ImageFilter.GaussianBlur(float(feather_pixels)))
            masks.append(torch.from_numpy((np.asarray(image, dtype=np.float32) / 255)[None].copy()))
            metadata.append(json.dumps({"shot_id": shot["shot_id"], "entities": sorted(keys),
                                        "invert": bool(invert), "foreground": 1,
                                        "grow_pixels": grow_pixels, "feather_pixels": feather_pixels}))
        return masks, metadata
