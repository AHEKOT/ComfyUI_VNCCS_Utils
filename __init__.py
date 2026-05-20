from .nodes.vnccs_nodes import VNCCS_PositionControl, VNCCS_VisualPositionControl
from .nodes.vnccs_qwen_detailer import VNCCS_QWEN_Detailer, VNCCS_BBox_Extractor
from .nodes.vnccs_model_manager import VNCCS_ModelManager, VNCCS_ModelSelector
from .nodes.pose_studio import VNCCS_PoseStudio

NODE_CLASS_MAPPINGS = {
    "VNCCS_PositionControl": VNCCS_PositionControl,
    "VNCCS_VisualPositionControl": VNCCS_VisualPositionControl,
    "VNCCS_QWEN_Detailer": VNCCS_QWEN_Detailer,
    "VNCCS_BBox_Extractor": VNCCS_BBox_Extractor,
    "VNCCS_ModelManager": VNCCS_ModelManager,
    "VNCCS_ModelSelector": VNCCS_ModelSelector,
    "VNCCS_PoseStudio": VNCCS_PoseStudio,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VNCCS_PositionControl": "VNCCS Position Control",
    "VNCCS_VisualPositionControl": "VNCCS Visual Camera Control",
    "VNCCS_QWEN_Detailer": "VNCCS QWEN Detailer",
    "VNCCS_BBox_Extractor": "VNCCS BBox Extractor",
    "VNCCS_ModelManager": "VNCCS Model Manager",
    "VNCCS_ModelSelector": "VNCCS Model Selector",
    "VNCCS_PoseStudio": "VNCCS Pose Studio",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]


# === API Endpoint Registration for Pose Studio ===
import os
import json
import numpy as np

def _vnccs_register_endpoint():
    """Lazy registration to avoid import errors in analysis tools."""
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.post("/vnccs/character_studio/update_preview")
    async def vnccs_character_studio_update_preview(request):
        try:
            data = await request.json()
            
            # Extract params
            age = float(data.get('age', 25.0))
            gender = float(data.get('gender', 0.5))
            weight = float(data.get('weight', 0.5))
            muscle = float(data.get('muscle', 0.5))
            height = float(data.get('height', 0.5))
            breast_size = float(data.get('breast_size', 0.5))
            breast_size = float(data.get('breast_size', 0.5))
            firmness = float(data.get('firmness', 0.5))
            penis_len = float(data.get('penis_len', 0.5))
            penis_circ = float(data.get('penis_circ', 0.5))
            penis_test = float(data.get('penis_test', 0.5))
            
            # Import from CharacterData
            from .CharacterData.mh_parser import HumanSolver
            from .CharacterData import matrix
            from .nodes.pose_studio import POSE_STUDIO_CACHE, _ensure_data_loaded
            
            # Normalize age
            mh_age = (age - 1.0) / (90.0 - 1.0)
            mh_age = max(0.0, min(1.0, mh_age))
            
            # Ensure data loaded
            _ensure_data_loaded()
            
            # Solve mesh
            solver = HumanSolver()
            factors = solver.calculate_factors(mh_age, gender, weight, muscle, height, breast_size, firmness, penis_len, penis_circ, penis_test)
            new_verts = solver.solve_mesh(POSE_STUDIO_CACHE['base_mesh'], POSE_STUDIO_CACHE['targets'], factors)
            
            # Get skeleton
            skel = POSE_STUDIO_CACHE.get('skeleton')
            
            # Filter faces and return
            base_mesh = POSE_STUDIO_CACHE['base_mesh']
            valid_prefixes = ["body", "helper-r-eye", "helper-l-eye", "helper-upper-teeth", "helper-lower-teeth", "helper-tongue", "helper-genital"]
            
            valid_faces = []
            if base_mesh.face_groups:
                for i, group in enumerate(base_mesh.face_groups):
                    g_clean = group.strip()
                    is_valid = g_clean in valid_prefixes
                    if g_clean.startswith("joint-"): is_valid = False
                    if g_clean in ["helper-skirt", "helper-tights", "helper-hair"]: is_valid = False
                    if g_clean == "helper-genital" and gender < 0.99: is_valid = False
                    
                    if is_valid:
                        valid_faces.append(base_mesh.faces[i])
            
            # Convert quads to triangles
            tri_indices = []
            for face in valid_faces:
                v_indices = []
                for item in face:
                    if isinstance(item, (list, tuple)):
                        v_indices.append(item[0])
                    else:
                        v_indices.append(item)
                
                if len(v_indices) == 3:
                    tri_indices.extend([v_indices[0], v_indices[1], v_indices[2]])
                elif len(v_indices) == 4:
                    tri_indices.extend([v_indices[0], v_indices[1], v_indices[2]])
                    tri_indices.extend([v_indices[0], v_indices[2], v_indices[3]])
            
            # Extract Bones Data
            bones_data = []
            weights_for_frontend = {}
            landmarks_for_frontend = {}
            landmark_indices_for_frontend = {}

            def average_vertices(indices):
                valid = [int(index) for index in indices if 0 <= int(index) < len(new_verts)]
                if not valid:
                    return None
                point = new_verts[valid].mean(axis=0)
                return point.tolist() if hasattr(point, "tolist") else list(point)

            def set_landmark_from_indices(name, indices):
                valid = sorted({int(index) for index in indices if 0 <= int(index) < len(new_verts)})
                point = average_vertices(valid)
                if point is None:
                    return None
                landmarks_for_frontend[name] = point
                landmark_indices_for_frontend[name] = valid
                return point

            def group_vertex_indices(group_names):
                names = set(group_names if isinstance(group_names, (list, tuple, set)) else [group_names])
                result = set()
                if not base_mesh.face_groups:
                    return result
                for face, group in zip(base_mesh.faces, base_mesh.face_groups):
                    if str(group).strip() not in names:
                        continue
                    for item in face:
                        result.add(int(item[0] if isinstance(item, (list, tuple)) else item))
                return result

            def average_group(group_names):
                return average_vertices(group_vertex_indices(group_names))

            def set_landmark_from_group(name, group_names):
                return set_landmark_from_indices(name, group_vertex_indices(group_names))

            def surface_nose_point():
                body_indices = sorted(group_vertex_indices("body"))
                if not body_indices:
                    return None
                points = new_verts[body_indices]
                if points.size == 0:
                    return None

                left_eye = landmarks_for_frontend.get("left_eye")
                right_eye = landmarks_for_frontend.get("right_eye")
                if left_eye and right_eye:
                    eye_mid = (np.asarray(left_eye, dtype=np.float32) + np.asarray(right_eye, dtype=np.float32)) * 0.5
                    eye_span = float(abs(left_eye[0] - right_eye[0]))
                    x_limit = max(0.18, eye_span * 0.45)
                    mask = (
                        (np.abs(points[:, 0] - eye_mid[0]) <= x_limit)
                        & (points[:, 1] >= eye_mid[1] - 0.65)
                        & (points[:, 1] <= eye_mid[1] - 0.03)
                    )
                else:
                    mask = (
                        (np.abs(points[:, 0]) <= 0.25)
                        & (points[:, 1] >= 6.4)
                        & (points[:, 1] <= 7.4)
                    )

                candidates = points[mask]
                if len(candidates) == 0:
                    candidates = points[
                        (np.abs(points[:, 0]) <= 0.35)
                        & (points[:, 1] >= 6.4)
                        & (points[:, 1] <= 7.4)
                    ]
                if len(candidates) == 0:
                    return None
                selected = candidates[np.argmax(candidates[:, 2])]
                distances = np.linalg.norm(points - selected, axis=1)
                nearest_order = np.argsort(distances)[:12]
                selected_indices = [body_indices[int(i)] for i in nearest_order]
                return set_landmark_from_indices("nose", selected_indices)

            def average_joint(joints_data, name):
                indices = joints_data.get(name) if isinstance(joints_data, dict) else None
                if not indices:
                    return None
                valid = [int(index) for index in indices if 0 <= int(index) < len(new_verts)]
                if not valid:
                    return None
                point = new_verts[valid].mean(axis=0)
                return point.tolist() if hasattr(point, "tolist") else list(point)

            try:
                set_landmark_from_group("left_eye", "helper-l-eye")
                set_landmark_from_group("right_eye", "helper-r-eye")
                surface_nose_point()

                char_data_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "CharacterData"))
                mh_path = os.path.join(char_data_path, "makehuman")
                default_skel_path = os.path.join(mh_path, "makehuman", "data", "rigs", "default.mhskel")
                if os.path.exists(default_skel_path):
                    with open(default_skel_path, "r", encoding="utf-8") as f:
                        default_skel_data = json.load(f)
                    default_joints = default_skel_data.get("joints", {})
                    landmark_sources = {
                        "left_eye": "eye.L____head",
                        "left_eye_front": "eye.L____tail",
                        "right_eye": "eye.R____head",
                        "right_eye_front": "eye.R____tail",
                        "nose": "special01____tail",
                        "mouth": "oris05____head",
                        "jaw": "jaw____head",
                        "head": "head____tail",
                    }
                    for landmark_name, joint_name in landmark_sources.items():
                        if landmark_name in landmarks_for_frontend:
                            continue
                        point = average_joint(default_joints, joint_name)
                        if point is not None:
                            landmarks_for_frontend[landmark_name] = point
            except Exception as exc:
                print(f"[VNCCS] Failed to build MH face landmarks: {exc}")
            
            if skel:
                class MeshWrapper:
                    def __init__(self, verts):
                        self.vertices = verts
                mesh_wrapper = MeshWrapper(new_verts)
                skel.updateJointPositions(mesh_wrapper)

                for bone in skel.getBones():
                    headPos = bone.headPos.tolist() if hasattr(bone.headPos, 'tolist') else list(bone.headPos)
                    tailPos = bone.tailPos.tolist() if hasattr(bone.tailPos, 'tolist') else list(bone.tailPos)
                    
                    restMatrix = None
                    if bone.matRestGlobal is not None:
                        restMatrix = bone.matRestGlobal.flatten().tolist()
                    
                    bones_data.append({
                        "name": bone.name,
                        "headPos": headPos,
                        "tailPos": tailPos,
                        "parent": bone.parent.name if bone.parent else None,
                        "length": float(bone.length) if hasattr(bone, 'length') else 0.0,
                        "restMatrix": restMatrix
                    })
                
                # Prepare weights for frontend skinning
                if skel.vertexWeights:
                    for bone_name, (indices, w_vals) in skel.vertexWeights.data.items():
                        weights_for_frontend[bone_name] = {
                            "indices": indices.tolist() if hasattr(indices, 'tolist') else list(indices),
                            "weights": w_vals.tolist() if hasattr(w_vals, 'tolist') else list(w_vals)
                        }

            return web.json_response({
                "status": "success",
                "vertices": new_verts.flatten().tolist(),
                "uvs": base_mesh.vertex_uvs.flatten().tolist() if hasattr(base_mesh, 'vertex_uvs') else [],
                "indices": tri_indices,
                "normals": [],
                "bones": bones_data,
                "weights": weights_for_frontend,
                "landmarks": landmarks_for_frontend,
                "landmark_indices": landmark_indices_for_frontend
            })
        except Exception as e:
            import traceback
            traceback.print_exc()
            return web.json_response({"error": str(e)}, status=500)

_vnccs_register_endpoint()

# Register Pose Library API
def _vnccs_register_pose_library():
    try:
        from server import PromptServer
        from .api.pose_library import register_routes
        register_routes(PromptServer.instance.app)
    except Exception as e:
        print(f"[VNCCS] Failed to register Pose Library API: {e}")

_vnccs_register_pose_library()


# === Pose Studio Capture Cache ===
VNCCS_CAPTURE_CACHE = {}
_CAPTURE_CACHE_MAX = 10

def _vnccs_register_capture_cache():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.post("/vnccs/pose_captures_upload")
    async def vnccs_pose_captures_upload(request):
        try:
            data = await request.json()
            capture_id = data.get("capture_id")
            if not capture_id:
                return web.json_response({"error": "missing capture_id"}, status=400)

            VNCCS_CAPTURE_CACHE[capture_id] = {
                "captured_images": data.get("captured_images", []),
                "lighting_prompts": data.get("lighting_prompts", []),
            }

            # LRU eviction: keep only last _CAPTURE_CACHE_MAX entries
            while len(VNCCS_CAPTURE_CACHE) > _CAPTURE_CACHE_MAX:
                oldest = next(iter(VNCCS_CAPTURE_CACHE))
                del VNCCS_CAPTURE_CACHE[oldest]

            return web.json_response({"status": "ok", "capture_id": capture_id})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/pose_captures/{capture_id}")
    async def vnccs_pose_captures_get(request):
        capture_id = request.match_info["capture_id"]
        entry = VNCCS_CAPTURE_CACHE.get(capture_id)
        if not entry:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(entry)

_vnccs_register_capture_cache()


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

            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                return web.json_response({"error": "missing image"}, status=400)
            task_id = str(post.get("task_id") or "")

            image_bytes = image_field.file.read()
            pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
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
