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

            def average_vertices(indices):
                valid = [int(index) for index in indices if 0 <= int(index) < len(new_verts)]
                if not valid:
                    return None
                point = new_verts[valid].mean(axis=0)
                return point.tolist() if hasattr(point, "tolist") else list(point)

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
                point = candidates[np.argmax(candidates[:, 2])]
                return point.tolist() if hasattr(point, "tolist") else list(point)

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
                left_eye = average_group("helper-l-eye")
                right_eye = average_group("helper-r-eye")
                if left_eye is not None:
                    landmarks_for_frontend["left_eye"] = left_eye
                if right_eye is not None:
                    landmarks_for_frontend["right_eye"] = right_eye
                nose = surface_nose_point()
                if nose is not None:
                    landmarks_for_frontend["nose"] = nose

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
                "landmarks": landmarks_for_frontend
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

    @PromptServer.instance.routes.post("/vnccs/sam3d/process_image_to_pose_json")
    async def vnccs_sam3d_process_image_to_pose_json(request):
        try:
            import importlib
            import io
            import json
            import asyncio
            import torch
            from PIL import Image

            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                return web.json_response({"error": "missing image"}, status=400)

            image_bytes = image_field.file.read()
            pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            image_np = np.asarray(pil_image).astype(np.float32) / 255.0
            image_tensor = torch.from_numpy(image_np).unsqueeze(0)

            def run_sam3d_process():
                import inspect

                comfy_nodes = importlib.import_module("nodes")
                node_classes = comfy_nodes.NODE_CLASS_MAPPINGS

                process_cls = node_classes["SAM3DBodyProcessToJson"]
                process_module_name = process_cls.__module__
                load_cls = None

                # Prefer the loader from the same installed SAM3DBody_utills package
                # as SAM3DBodyProcessToJson. Global NODE_CLASS_MAPPINGS can contain
                # similarly named loaders from other SAM/SAM3 extensions.
                try:
                    if ".processing." in process_module_name:
                        package_root = process_module_name.split(".processing.", 1)[0]
                        load_module = importlib.import_module(f"{package_root}.processing.load_model")
                        load_cls = getattr(load_module, "LoadSAM3DBodyModel", None)
                except Exception:
                    load_cls = None

                if load_cls is None:
                    process_root = process_module_name.rsplit(".", 1)[0]
                    for candidate in node_classes.values():
                        if (
                            getattr(candidate, "__name__", "") == "LoadSAM3DBodyModel"
                            and getattr(candidate, "__module__", "").startswith(process_root.rsplit(".", 1)[0])
                        ):
                            load_cls = candidate
                            break

                if load_cls is None:
                    load_cls = node_classes["LoadSAM3DBodyModel"]

                model_node = load_cls()
                process_node = process_cls()

                def call_node_method(method, kwargs, fallback_args=()):
                    sig = inspect.signature(method)
                    params = sig.parameters
                    accepts_kwargs = any(
                        param.kind == inspect.Parameter.VAR_KEYWORD
                        for param in params.values()
                    )
                    filtered_kwargs = kwargs if accepts_kwargs else {
                        key: value for key, value in kwargs.items()
                        if key in params
                    }

                    try:
                        return method(**filtered_kwargs)
                    except TypeError:
                        if fallback_args:
                            try:
                                return method(*fallback_args)
                            except TypeError:
                                pass
                        return method()

                model = call_node_method(
                    model_node.load_model,
                    {"device_mode": "Auto"},
                    ("Auto",),
                )[0]

                process_kwargs = {
                    "model": model,
                    "image": image_tensor,
                    "bbox_threshold": 0.8,
                    "inference_type": "full",
                }

                pose_json = call_node_method(
                    process_node.process_to_json,
                    process_kwargs,
                )[0]

                try:
                    pose_data = json.loads(pose_json)
                    process_module = importlib.import_module(process_module_name)
                    load_sam3d_model = getattr(process_module, "_load_sam3d_model", None)
                    if load_sam3d_model is None:
                        return pose_json

                    loaded = load_sam3d_model(model)
                    sam_3d_model = loaded["model"]
                    device = torch.device(loaded["device"])
                    mhr_head = sam_3d_model.head_pose
                    to_batched_tensor = getattr(process_module, "_to_batched_tensor", None)
                    if to_batched_tensor is None:
                        return pose_json

                    global_trans = torch.zeros((1, 3), dtype=torch.float32, device=device)
                    rest_global_rot = torch.zeros((1, 3), dtype=torch.float32, device=device)
                    rest_body_pose = torch.zeros((1, 133), dtype=torch.float32, device=device)
                    rest_hand_pose = torch.zeros((1, 108), dtype=torch.float32, device=device)
                    scale_params = torch.zeros(
                        (1, mhr_head.num_scale_comps), dtype=torch.float32, device=device
                    )
                    shape_params = torch.zeros(
                        (1, mhr_head.num_shape_comps), dtype=torch.float32, device=device
                    )
                    expr_params = torch.zeros(
                        (1, mhr_head.num_face_comps), dtype=torch.float32, device=device
                    )

                    with torch.no_grad():
                        posed_out = mhr_head.mhr_forward(
                            global_trans=global_trans,
                            global_rot=to_batched_tensor(pose_data.get("global_rot"), device, width=3),
                            body_pose_params=to_batched_tensor(pose_data.get("body_pose_params"), device, width=133),
                            hand_pose_params=to_batched_tensor(pose_data.get("hand_pose_params"), device, width=108),
                            scale_params=scale_params,
                            shape_params=shape_params,
                            expr_params=expr_params,
                            return_keypoints=True,
                            return_joint_rotations=True,
                            return_joint_coords=True,
                        )
                        rest_out = mhr_head.mhr_forward(
                            global_trans=global_trans,
                            global_rot=rest_global_rot,
                            body_pose_params=rest_body_pose,
                            hand_pose_params=rest_hand_pose,
                            scale_params=scale_params,
                            shape_params=shape_params,
                            expr_params=expr_params,
                            return_joint_rotations=True,
                            return_joint_coords=True,
                        )

                    posed_rots = None
                    posed_coords = None
                    posed_keypoints = None
                    for tensor in posed_out[1:]:
                        if tensor.ndim == 4 and tensor.shape[-1] == 3 and tensor.shape[-2] == 3:
                            posed_rots = tensor.detach().cpu().numpy()
                        elif tensor.ndim == 3 and tensor.shape[-1] == 3 and tensor.shape[-2] > 127:
                            posed_keypoints = tensor.detach().cpu().numpy()
                        elif tensor.ndim == 3 and tensor.shape[-1] == 3 and tensor.shape[-2] != 3:
                            posed_coords = tensor.detach().cpu().numpy()
                    if posed_rots is not None:
                        if posed_rots.ndim == 4:
                            posed_rots = posed_rots[0]
                        pose_data["joint_rotations"] = posed_rots.tolist()
                    if posed_coords is not None:
                        if posed_coords.ndim == 3:
                            posed_coords = posed_coords[0]
                        pose_data["joint_coords"] = posed_coords.tolist()
                    if posed_keypoints is not None:
                        if posed_keypoints.ndim == 3:
                            posed_keypoints = posed_keypoints[0]
                        pose_data["canonical_keypoints_3d"] = posed_keypoints[:70].tolist()

                    try:
                        get_rest_verts = getattr(process_module, "_get_mhr_rest_verts", None)
                        face_cache = getattr(process_module, "_FACE_BS_CACHE", None)
                        apply_lean_rig = getattr(process_module, "apply_pose_lean_correction_rig", None)
                        if (
                            get_rest_verts is not None
                            and isinstance(face_cache, dict)
                            and apply_lean_rig is not None
                            and posed_rots is not None
                            and posed_coords is not None
                        ):
                            get_rest_verts(mhr_head, device)
                            parents = face_cache.get("joint_parents")
                            if parents is not None:
                                corrected_rots, corrected_coords = apply_lean_rig(
                                    np.asarray(posed_rots, dtype=np.float32),
                                    np.asarray(posed_coords, dtype=np.float32),
                                    np.asarray(parents, dtype=np.int32),
                                    0.5,
                                )
                                pose_data["joint_rotations"] = corrected_rots.tolist()
                                pose_data["joint_coords"] = corrected_coords.tolist()
                                pose_data["sam3d_pose_postprocess"] = "apply_pose_lean_correction_rig:0.5"
                    except Exception as exc:
                        print(f"[VNCCS] SAM3D lean-corrected rig export failed: {exc}")

                    rest_rots = None
                    rest_coords = None
                    for tensor in rest_out[1:]:
                        if tensor.ndim == 4 and tensor.shape[-1] == 3 and tensor.shape[-2] == 3:
                            rest_rots = tensor.detach().cpu().numpy()
                        elif tensor.ndim == 3 and tensor.shape[-1] == 3 and tensor.shape[-2] != 3:
                            rest_coords = tensor.detach().cpu().numpy()
                    if rest_rots is not None:
                        if rest_rots.ndim == 4:
                            rest_rots = rest_rots[0]
                        pose_data["rest_joint_rotations"] = rest_rots.tolist()
                    if rest_coords is not None:
                        if rest_coords.ndim == 3:
                            rest_coords = rest_coords[0]
                        pose_data["rest_joint_coords"] = rest_coords.tolist()

                    try:
                        get_rest_verts = getattr(process_module, "_get_mhr_rest_verts", None)
                        face_cache = getattr(process_module, "_FACE_BS_CACHE", None)
                        if get_rest_verts is not None and isinstance(face_cache, dict):
                            get_rest_verts(mhr_head, device)
                            parents = face_cache.get("joint_parents")
                            if parents is not None:
                                pose_data["joint_parents"] = np.asarray(parents, dtype=np.int32).tolist()
                    except Exception:
                        pass

                    num_joints = 0
                    for candidate in (
                        pose_data.get("joint_rotations"),
                        pose_data.get("rest_joint_rotations"),
                        pose_data.get("joint_coords"),
                    ):
                        if isinstance(candidate, list):
                            num_joints = max(num_joints, len(candidate))
                    known_joint_names = {
                        1: "pelvis",
                        2: "thigh_l", 3: "calf_l", 4: "foot_l",
                        18: "thigh_r", 19: "calf_r", 20: "foot_r",
                        35: "spine_01", 36: "spine_02", 37: "spine_03",
                        38: "clavicle_r", 39: "upperarm_r", 40: "lowerarm_r", 42: "hand_r",
                        74: "clavicle_l", 75: "upperarm_l", 76: "lowerarm_l", 78: "hand_l",
                        110: "neck_01", 113: "head",
                    }
                    pose_data["joint_names"] = [
                        known_joint_names.get(index, f"joint_{index:03d}")
                        for index in range(num_joints)
                    ]

                    pose_data["sam3d_pose_space"] = "mhr_forward_canonical"

                    return json.dumps(pose_data, ensure_ascii=False, indent=2)
                except Exception as exc:
                    print(f"[VNCCS] SAM3D rest skeleton export failed: {exc}")
                    return pose_json

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
            import traceback
            traceback.print_exc()
            return web.json_response({"error": str(e)}, status=500)


_vnccs_register_sam3d_pose_import()
