"""VNCCS Pose Studio - Combined mesh editor and multi-pose generator.

Combines Character Studio mesh sliders with dynamic pose tabs.
Each pose stores bone rotations and global model rotation.
Outputs rendered mesh images with skin material.

MakeHuman morphing, skinning, posing, and rendering run in the browser widget.
The Python node only synchronizes captures and converts them to ComfyUI outputs.
"""

import json
import os
import base64
import math
import re
import uuid
from fractions import Fraction
from io import BytesIO
import hashlib
import torch
import numpy as np
from PIL import Image
_CAPTURED_IMAGE_MAX_COUNT = 600
_CAPTURED_IMAGE_MAX_TOTAL_CHARS = 64 * 1024 * 1024
_CAPTURED_IMAGE_MAX_BYTES = 32 * 1024 * 1024
_CAPTURED_IMAGE_MAX_PIXELS = 4096 * 4096
_POSE_OUTPUT_MAX_PIXELS = 4096 * 4096

_CAMERA_AZIMUTH_PHRASES = (
    ("front-right quarter view", "from a front-right three-quarter angle"),
    ("back-right quarter view", "from a back-right three-quarter angle"),
    ("back-left quarter view", "from a back-left three-quarter angle"),
    ("front-left quarter view", "from a front-left three-quarter angle"),
    ("right side view", "from the right side"),
    ("left side view", "from the left side"),
    ("front view", "from the front"),
    ("back view", "from the back"),
)

_CAMERA_ELEVATION_PHRASES = (
    ("low-angle shot", "at a low angle"),
    ("eye-level shot", "at eye level"),
    ("elevated shot", "at an elevated angle"),
    ("high-angle shot", "at a high angle"),
)

_CAMERA_DISTANCE_PHRASES = (
    ("close-up", "a close-up"),
    ("medium shot", "a medium shot"),
    ("wide shot", "a wide shot"),
)


def _clean_camera_prompt(camera_prompt):
    text = "" if camera_prompt is None else str(camera_prompt)
    text = re.sub(r"<\s*sks\s*>", " ", text, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", text).strip(" \t\r\n,.;")


def _find_camera_phrase(text, phrases):
    lowered = text.lower()
    for source, natural in phrases:
        if source in lowered:
            return source, natural
    return None, ""


def _format_camera_prompt(camera_prompt):
    text = _clean_camera_prompt(camera_prompt)
    if not text:
        return ""

    azimuth_source, azimuth = _find_camera_phrase(text, _CAMERA_AZIMUTH_PHRASES)
    elevation_source, elevation = _find_camera_phrase(text, _CAMERA_ELEVATION_PHRASES)
    distance_source, distance = _find_camera_phrase(text, _CAMERA_DISTANCE_PHRASES)

    if azimuth and elevation and distance:
        return f"Use {distance} {azimuth}, with the camera {elevation}."

    remaining = text
    for source in (azimuth_source, elevation_source, distance_source):
        if source:
            remaining = re.sub(re.escape(source), " ", remaining, flags=re.IGNORECASE)
    remaining = re.sub(r"\s+", " ", remaining).strip(" \t\r\n,.;")

    parts = []
    if distance:
        parts.append(distance)
    if azimuth:
        parts.append(azimuth)
    if elevation:
        parts.append(f"with the camera {elevation}")

    if parts:
        sentence = "Use " + ", ".join(parts)
        if remaining:
            sentence += f", following this additional direction: {remaining}"
        return sentence.rstrip(".") + "."

    return f"Camera framing: {text.rstrip('.')}."


def _merge_camera_prompt(base_prompt, camera_prompt):
    base = "" if base_prompt is None else str(base_prompt).strip()
    camera = _format_camera_prompt(camera_prompt)
    if not camera:
        return base
    if not base:
        return camera
    return f"{base}\n{camera}"


def _decode_captured_images(captured_images):
    if not isinstance(captured_images, list):
        raise ValueError("captured_images must be a list")
    if len(captured_images) > _CAPTURED_IMAGE_MAX_COUNT:
        raise ValueError(f"captured_images limit is {_CAPTURED_IMAGE_MAX_COUNT}")

    rendered_images = []
    total_chars = 0
    for b64 in captured_images:
        if not b64:
            continue
        if not isinstance(b64, str):
            raise ValueError("captured_images entries must be strings")
        total_chars += len(b64)
        if total_chars > _CAPTURED_IMAGE_MAX_TOTAL_CHARS:
            raise ValueError("captured_images payload is too large")
        if "," in b64:
            b64 = b64.split(",", 1)[1]

        img_data = base64.b64decode(b64)
        if len(img_data) > _CAPTURED_IMAGE_MAX_BYTES:
            raise ValueError("captured image is too large")
        img = Image.open(BytesIO(img_data))
        if img.width * img.height > _CAPTURED_IMAGE_MAX_PIXELS:
            raise ValueError("captured image dimensions are too large")
        rendered_images.append(img.convert('RGB'))
    return rendered_images


def _animation_frame_rate(data):
    animation = data.get("animation", {}) if isinstance(data, dict) else {}
    try:
        fps = float(animation.get("fps", animation.get("frame_rate", 12.0)))
    except (TypeError, ValueError):
        fps = 12.0
    if not math.isfinite(fps):
        fps = 12.0
    return max(1.0, min(120.0, fps))


def _positive_int(value, name, default):
    if value is None:
        value = default
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a positive integer") from exc
    if not math.isfinite(number) or number < 1 or not number.is_integer():
        raise ValueError(f"{name} must be a positive integer")
    return int(number)


def _create_comfy_video(frame_batch, fps):
    """Build the same VIDEO value as ComfyUI's built-in CreateVideo node."""
    try:
        from comfy_api.latest import InputImpl, Types
    except ImportError as exc:
        raise RuntimeError(
            "Pose Studio Animation output requires a ComfyUI version with the "
            "official VIDEO datatype (CreateVideo)."
        ) from exc

    return InputImpl.VideoFromComponents(
        Types.VideoComponents(
            images=frame_batch,
            audio=None,
            frame_rate=Fraction(str(fps)),
        )
    )


# === Main Node Class ===

def _hydrate_cached_pose_animation(data):
    if not isinstance(data, dict):
        return data
    reference = data.get("animation")
    if not isinstance(reference, dict) or reference.get("storage") != "server_cache":
        return data
    cache_id = reference.get("cacheId", reference.get("cache_id"))
    if not cache_id:
        return data
    try:
        from .. import vnccs_get_pose_animation_cache
        entry = vnccs_get_pose_animation_cache(cache_id)
        animation = entry.get("animation") if isinstance(entry, dict) else None
        if isinstance(animation, dict):
            hydrated = dict(data)
            hydrated["animation"] = animation
            return hydrated
        print(f"[VNCCS Pose Studio] Animation cache is missing (id={cache_id})")
    except Exception as exc:
        print(f"[VNCCS Pose Studio] Animation cache fallback failed: {exc}")
    return data


class VNCCS_PoseStudio:
    """Pose Studio with mesh editing and multiple pose generation."""
    
    # The first socket is narrowed to IMAGE or VIDEO by the frontend according
    # to editor_mode. Keeping the backend union makes both workflow variants
    # valid during server-side prompt validation.
    RETURN_TYPES = ("IMAGE,VIDEO", "STRING")
    RETURN_NAMES = ("images", "lighting_prompt")
    OUTPUT_IS_LIST = (True, True)
    FUNCTION = "generate"
    CATEGORY = "VNCCS/pose"
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # ALL settings come from widget via pose_data
                "pose_data": ("STRING", {"multiline": True, "default": "{}"}),
            },
            "optional": {
                "pose_image": ("IMAGE",),
                "camera_prompt": ("STRING", {
                    "default": "",
                    "forceInput": True,
                    "tooltip": "Camera direction from VNCCS Visual Camera Control.",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID"
            }
        }

    @classmethod
    def IS_CHANGED(
        cls,
        pose_data: str = "{}",
        pose_image=None,
        camera_prompt: str = "",
        unique_id: str = None,
    ):
        # Force re-execution if Debug Mode is enabled
        try:
            data = json.loads(pose_data)
            export = data.get("export", {})
            if export.get("debugMode", False):
                return float("NaN")
        except Exception:
            pass
        change_key = f"{pose_data}|camera_prompt:{camera_prompt or ''}"
        if pose_image is None:
            return change_key
        try:
            tensor = pose_image.detach().cpu()
            arr = tensor.numpy()
            sample = arr.flat[::max(1, arr.size // 1000)]
            digest = hashlib.sha256(bytes(sample)).hexdigest()
            return f"{change_key}|pose_image:{digest}"
        except Exception:
            return f"{change_key}|pose_image:{id(pose_image)}"

    def _wait_for_frontend_sync(
        self,
        unique_id,
        start_time,
        timeout=15.0,
        sync_token=None,
    ):
        import time
        import folder_paths

        temp_dir = folder_paths.get_temp_directory()
        token_suffix = f"_{sync_token}" if sync_token else ""
        filepath = os.path.join(temp_dir, f"vnccs_debug_{unique_id}{token_suffix}.json")

        while time.time() - start_time < timeout:
            if os.path.exists(filepath) and os.path.getmtime(filepath) > start_time - 1.0:
                try:
                    with open(filepath, "r", encoding="utf-8") as f:
                        sync_data = json.load(f)
                    try:
                        os.remove(filepath)
                    except Exception:
                        pass
                    return sync_data
                except Exception:
                    pass
            time.sleep(0.1)
        return None

    def _apply_pose_image_via_frontend(self, pose_image, unique_id, camera_prompt=""):
        if pose_image is None or not unique_id:
            return None

        try:
            from server import PromptServer
            import time
            from ..vnccs_sam3d import process_image_to_pose_json, progress

            task_id = f"node-{unique_id}-pose-image"
            progress.start_task(task_id)
            with progress.task_context(task_id):
                progress.update("Step 1/6: Pose image input received. Preparing SAM 3D Body import...", 2)
                pose_json = process_image_to_pose_json(pose_image[:1])
            try:
                pose_payload = json.loads(pose_json)
            except Exception:
                pose_payload = None
            if not pose_payload:
                print("[VNCCS Pose Studio] pose_image SAM import returned empty pose data.")
                return None

            sync_token = uuid.uuid4().hex
            start_time = time.time()
            PromptServer.instance.send_sync("vnccs_apply_sam3d_pose", {
                "node_id": unique_id,
                "pose_data": pose_payload,
                "camera_prompt": camera_prompt or "",
                "sync_token": sync_token,
            })
            synced = self._wait_for_frontend_sync(
                unique_id,
                start_time,
                timeout=20.0,
                sync_token=sync_token,
            )
            if synced:
                print("[VNCCS Pose Studio] Applied pose_image SAM pose through frontend sync.")
                return synced
            print("[VNCCS Pose Studio] pose_image was analyzed, but frontend sync timed out. Using existing pose_data.")
        except Exception as e:
            print(f"[VNCCS Pose Studio] pose_image SAM import failed: {e}")
        return None
    
    def generate(
        self,
        pose_data: str = "{}",
        pose_image=None,
        camera_prompt: str = "",
        unique_id: str = None
    ):
        """Generate rendered mesh images for all poses."""
        
        # Parse pose data
        try:
            data = json.loads(pose_data) if pose_data else {}
            data = _hydrate_cached_pose_animation(data)
            pose_image_synced = False
            export_settings = data.get("export", {}) if isinstance(data, dict) else {}
            if (
                isinstance(export_settings, dict)
                and export_settings.get("directional_skydome_enabled", False) is not True
            ):
                camera_prompt = ""
            if isinstance(export_settings, dict) and export_settings.get("interface_mode") == "manager":
                pose_image = None

            if pose_image is not None:
                synced = self._apply_pose_image_via_frontend(
                    pose_image,
                    unique_id,
                    camera_prompt,
                )
                if isinstance(synced, dict):
                    data = _hydrate_cached_pose_animation(synced)
                    pose_image_synced = True
            
            # --- LIVE SYNC with Frontend ---
            # We request a fresh capture/sync from the frontend on every run
            # and pass this execution's resolved camera prompt so queued random
            # runs cannot reuse the skydome orientation from another execution.
            if unique_id and not pose_image_synced:
                sync_error_message = None
                try:
                    from server import PromptServer
                    import time
                    sync_token = uuid.uuid4().hex
                    start_time = time.time()
                    PromptServer.instance.send_sync("vnccs_req_pose_sync", {
                        "node_id": unique_id,
                        "camera_prompt": camera_prompt or "",
                        "sync_token": sync_token,
                    })
                    sync_timeout = 5.0
                    if export_settings.get("editor_mode", export_settings.get("content_mode")) == "animation":
                        animation = data.get("animation") if isinstance(data.get("animation"), dict) else {}
                        frame_count = max(1, int(animation.get("frameCount", animation.get("frame_count", 1)) or 1))
                        sync_timeout = min(120.0, max(15.0, 5.0 + frame_count * 0.25))
                    else:
                        character_count = len(data.get("characters", [])) if isinstance(data.get("characters"), list) else 1
                        if character_count > 1:
                            # A freshly opened multi-character workflow may
                            # still be materializing up to four independent rigs.
                            sync_timeout = min(60.0, 10.0 + character_count * 10.0)
                    synced = self._wait_for_frontend_sync(
                        unique_id,
                        start_time,
                        timeout=sync_timeout,
                        sync_token=sync_token,
                    )
                    if synced:
                        if isinstance(synced, dict) and synced.get("sync_error"):
                            sync_error_message = str(synced["sync_error"])
                        else:
                            data = _hydrate_cached_pose_animation(synced)
                except Exception as e:
                    print(f"[VNCCS Pose Studio] Sync error: {e}")
                if sync_error_message:
                    raise RuntimeError(f"Pose Studio frontend sync failed: {sync_error_message}")
            # ---------------------------------------------
            
        except (json.JSONDecodeError, TypeError):
            data = {}

        # Fallback: if live sync produced no captured_images, try LRU cache
        if isinstance(data, dict) and not data.get("captured_images"):
            capture_id = data.get("capture_id")
            if capture_id:
                try:
                    from .. import vnccs_get_capture_cache
                    cached = vnccs_get_capture_cache(capture_id)
                    if cached:
                        data["captured_images"] = cached.get("captured_images", [])
                        data["lighting_prompts"] = cached.get("lighting_prompts", [])
                        print(f"[VNCCS Pose Studio] Loaded {len(data['captured_images'])} captures from LRU cache (id={capture_id})")
                except Exception as e:
                    print(f"[VNCCS Pose Studio] Cache fallback failed: {e}")

        if not isinstance(data, dict):
            print(f"Pose Studio Error: pose_data is not a dict, got {type(data)}. Using default.")
            data = {}
        
        export = data.get("export", {})
        view_width = _positive_int(export.get("view_width", export.get("view_size", 512)), "view_width", 512)
        view_height = _positive_int(export.get("view_height", export.get("view_size", 512)), "view_height", 512)
        if view_width * view_height > _POSE_OUTPUT_MAX_PIXELS:
            raise ValueError("Pose Studio output dimensions are too large")
        output_mode = export.get("output_mode", "LIST")
        grid_columns = _positive_int(export.get("grid_columns", 2), "grid_columns", 2)
        bg_color = export.get("bg_color", [40, 40, 40])  # RGB
        
        editor_mode = export.get("editor_mode", export.get("content_mode", "image"))
            
        # === 1. Try Client-Side Rendered Images (CSR) ===
        # If frontend sent captured images, use them directly.
        captured_images = data.get("captured_images", [])
        
        if captured_images:
            # Extract prompts (frontend generated)
            lighting_prompts = list(data.get("lighting_prompts", []) or [])
            
            # Pad prompts to match images count if needed
            while len(lighting_prompts) < len(captured_images):
                lighting_prompts.append("")
            lighting_prompts = [
                _merge_camera_prompt(prompt, camera_prompt)
                for prompt in lighting_prompts[:len(captured_images)]
            ]
            rendered_images = _decode_captured_images(captured_images)
            
            if rendered_images:
                # Convert to tensors
                tensors = []
                for img in rendered_images:
                    np_img = np.array(img).astype(np.float32) / 255.0
                    tensors.append(torch.from_numpy(np_img))

                if editor_mode == "animation":
                    frame_batch = torch.stack(tensors, dim=0)
                    video = _create_comfy_video(
                        frame_batch,
                        _animation_frame_rate(data),
                    )
                    # OUTPUT_IS_LIST stays enabled for the image-mode contract.
                    # A one-item list still supplies one ordinary VIDEO value to
                    # downstream nodes while LIST images retain their old behavior.
                    return ([video], lighting_prompts)
                
                if output_mode == "LIST":
                    # Return list of individual images and prompts
                    tensor_list = [t.unsqueeze(0) for t in tensors]
                    return (tensor_list, lighting_prompts)
                else:
                    grid_img = self._make_grid(rendered_images, grid_columns, tuple(bg_color))
                    np_grid = np.array(grid_img).astype(np.float32) / 255.0
                    grid_tensor = torch.from_numpy(np_grid).unsqueeze(0)
                    
                    
                    # For grid, return only the first prompt (conceptually the "main" prompt)
                    combined_prompt = lighting_prompts[0] if lighting_prompts else ""
                    return ([grid_tensor], [combined_prompt])

        raise RuntimeError(
            "Pose Studio did not receive images rendered by the browser widget. "
            "Backend 3D rendering has been removed; keep the ComfyUI browser tab open "
            "and ensure WebGL is available while the workflow executes."
        )
    
    def _make_grid(self, images, columns, bg_color=(40, 40, 40)):
        """Combine images into a grid."""
        if not images:
            return Image.new('RGB', (512, 512), bg_color)
        
        n = len(images)
        cols = min(_positive_int(columns, "grid_columns", 1), n)
        rows = (n + cols - 1) // cols
        
        w, h = images[0].size
        if w * cols * h * rows > _POSE_OUTPUT_MAX_PIXELS:
            raise ValueError("Pose Studio grid dimensions are too large")
        grid = Image.new('RGB', (w * cols, h * rows), bg_color)
        
        for i, img in enumerate(images):
            row = i // cols
            col = i % cols
            grid.paste(img, (col * w, row * h))
        
        return grid


# Node mappings
NODE_CLASS_MAPPINGS = {
    "VNCCS_PoseStudio": VNCCS_PoseStudio
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VNCCS_PoseStudio": "VNCCS Pose Studio"
}
