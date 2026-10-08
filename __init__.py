from .nodes.vnccs_nodes import VNCCS_PositionControl, VNCCS_VisualPositionControl
from .nodes.vnccs_qwen_detailer import VNCCS_QWEN_Detailer, VNCCS_BBox_Extractor
from .nodes.vnccs_model_manager import VNCCS_ModelManager, VNCCS_ModelSelector
from .nodes.pose_studio import VNCCS_PoseStudio
from .nodes.unicanvas import VNCCS_UniCanvas, register_unicanvas_routes
from .nodes.vncss_config import VNCCS_Config
from .nodes.factory3d import VNCCS_3DFactory
from .nodes.factory3d_render import VNCCS_FactoryRender, VNCCS_FactoryMask

NODE_CLASS_MAPPINGS = {
    "VNCCS_PositionControl": VNCCS_PositionControl,
    "VNCCS_VisualPositionControl": VNCCS_VisualPositionControl,
    "VNCCS_QWEN_Detailer": VNCCS_QWEN_Detailer,
    "VNCCS_BBox_Extractor": VNCCS_BBox_Extractor,
    "VNCCS_ModelManager": VNCCS_ModelManager,
    "VNCCS_ModelSelector": VNCCS_ModelSelector,
    "VNCCS_PoseStudio": VNCCS_PoseStudio,
    "VNCCS_UniCanvas": VNCCS_UniCanvas,
    "VNCCS_Config": VNCCS_Config,
    "VNCCS_3DFactory": VNCCS_3DFactory,
    "VNCCS_FactoryRender": VNCCS_FactoryRender,
    "VNCCS_FactoryMask": VNCCS_FactoryMask,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VNCCS_PositionControl": "VNCCS Position Control",
    "VNCCS_VisualPositionControl": "VNCCS Visual Camera Control",
    "VNCCS_QWEN_Detailer": "VNCCS QWEN Detailer",
    "VNCCS_BBox_Extractor": "VNCCS BBox Extractor",
    "VNCCS_ModelManager": "VNCCS Model Manager",
    "VNCCS_ModelSelector": "VNCCS Model Selector",
    "VNCCS_PoseStudio": "VNCCS Pose Studio",
    "VNCCS_UniCanvas": "VNCCS UniCanvas",
    "VNCCS_Config": "VNCSS Config",
    "VNCCS_3DFactory": "VNCCS 3D Factory",
    "VNCCS_FactoryRender": "VNCCS Factory Render",
    "VNCCS_FactoryMask": "VNCCS Factory Mask",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

import json
import numpy as np

_SAM3D_MAX_UPLOAD_BYTES = 32 * 1024 * 1024
_SAM3D_MAX_PIXELS = 4096 * 4096

from .api.runtime_caches import (
    VNCCS_CAPTURE_CACHE, VNCCS_POSE_ANIMATION_CACHE, VNCCS_UNICANVAS_STATE_CACHE,
    vnccs_get_capture_cache, vnccs_get_pose_animation_cache,
    _vnccs_content_length_ok, _vnccs_safe_id,
    _vnccs_register_capture_cache, _vnccs_register_pose_animation_cache,
    _vnccs_register_unicanvas_state_cache,
)

# Register Pose Library API
def _vnccs_register_pose_library():
    try:
        from server import PromptServer
        from .api.pose_library import register_routes
        register_routes(PromptServer.instance.app)
    except Exception as e:
        print(f"[VNCCS] Failed to register Pose Library API: {e}")

_vnccs_register_pose_library()

# Register Pose Studio runtime synchronization API
def _vnccs_register_pose_sync():
    try:
        from server import PromptServer
        from .api.pose_sync import register_routes
        register_routes(PromptServer.instance.app)
    except Exception as e:
        print(f"[VNCCS] Failed to register Pose Sync API: {e}")

_vnccs_register_pose_sync()

# === Pose Studio Capture Cache ===

_vnccs_register_capture_cache()

_vnccs_register_pose_animation_cache()

_vnccs_register_unicanvas_state_cache()
register_unicanvas_routes()

def _vnccs_register_sam3d_pose_import():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.get("/vnccs/sam3d/import_status/{task_id}")
    async def vnccs_sam3d_import_status(request):
        try:
            from .vnccs_sam3d import progress

            return web.json_response(progress.get_task(request.match_info["task_id"]))
        except Exception as e:
            return web.json_response({
                "status": "unknown",
                "message": str(e),
                "progress": 0,
            })

    @PromptServer.instance.routes.post("/vnccs/sam3d/process_image_to_pose_json")
    async def vnccs_sam3d_process_image_to_pose_json(request):
        try:
            import io
            import json
            import asyncio
            import torch
            from PIL import Image

            if not _vnccs_content_length_ok(request, _SAM3D_MAX_UPLOAD_BYTES + 1024 * 1024):
                return web.json_response({"error": "image upload is too large"}, status=413)
            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                return web.json_response({"error": "missing image"}, status=400)
            task_id = str(post.get("task_id") or "")

            image_bytes = image_field.file.read()
            if len(image_bytes) > _SAM3D_MAX_UPLOAD_BYTES:
                return web.json_response({"error": "image upload is too large"}, status=413)
            pil_image = Image.open(io.BytesIO(image_bytes))
            if pil_image.width * pil_image.height > _SAM3D_MAX_PIXELS:
                return web.json_response({"error": "image dimensions are too large"}, status=413)
            pil_image = pil_image.convert("RGB")
            image_np = np.asarray(pil_image).astype(np.float32) / 255.0
            image_tensor = torch.from_numpy(image_np).unsqueeze(0)

            def run_sam3d_process():
                from .vnccs_sam3d import process_image_to_pose_json, progress

                progress.start_task(task_id)
                with progress.task_context(task_id):
                    progress.update("Step 1/6: Image uploaded. Preparing SAM 3D Body import...", 2)
                    return process_image_to_pose_json(image_tensor)

            pose_json = await asyncio.to_thread(run_sam3d_process)

            try:
                pose_data = json.loads(pose_json)
            except Exception:
                pose_data = None

            return web.json_response({
                "status": "success",
                "pose_json": pose_json,
                "pose_data": pose_data,
            })
        except Exception as e:
            try:
                from .vnccs_sam3d import progress
                with progress.task_context(task_id if "task_id" in locals() else ""):
                    progress.fail(str(e))
            except Exception:
                pass
            import traceback
            traceback.print_exc()
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/vnccs/sam3d/render_mesh_overlay")
    async def vnccs_sam3d_render_mesh_overlay(request):
        try:
            import asyncio

            if not _vnccs_content_length_ok(request, 32 * 1024 * 1024):
                return web.json_response({"error": "mesh overlay payload is too large"}, status=413)
            data = await request.json()
            pose_data = data.get("pose_data")
            if not isinstance(pose_data, dict):
                return web.json_response({"error": "missing pose_data"}, status=400)
            body_preset = data.get("body_preset") if isinstance(data.get("body_preset"), dict) else {}
            pose_adjust = float(data.get("pose_adjust") or 0.0)

            def build_overlay():
                from .vnccs_sam3d.pose_import import process_pose_json_to_overlay_mesh

                return process_pose_json_to_overlay_mesh(
                    pose_data,
                    body_preset=body_preset,
                    pose_adjust=pose_adjust,
                )

            mesh_data = await asyncio.to_thread(build_overlay)
            return web.json_response({"status": "success", "mesh": mesh_data})
        except Exception as e:
            import traceback
            traceback.print_exc()
            return web.json_response({"error": str(e)}, status=500)

_vnccs_register_sam3d_pose_import()

# === Pose Studio text-to-motion API ===
def _vnccs_register_text_to_motion():
    try:
        from server import PromptServer
        from .api.text_to_motion.service import register_routes
    except Exception:
        return
    # Motion models (Kimodo, HY-Motion, ...) are optional and imported lazily on the first generation.
    register_routes(PromptServer.instance.routes)

_vnccs_register_text_to_motion()

# === VNCCS 3D Factory API ===
def _vnccs_register_3d_factory():
    try:
        from server import PromptServer
        from .api.factory3d import register_routes

        # Core Factory and its independent Gaussian model library are
        # registered together on ComfyUI's /api RouteTableDef.
        register_routes(PromptServer.instance.routes)
    except Exception as exc:
        # Keep the rest of the extension importable when ComfyUI's server is
        # not present (for example during isolated node/unit tests).
        print(f"[VNCCS] Failed to register 3D Factory API: {exc}")

_vnccs_register_3d_factory()
