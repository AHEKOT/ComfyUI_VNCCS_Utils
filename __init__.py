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
import re
import numpy as np
import struct
import asyncio

_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]+")
_CAPTURE_CACHE_MAX_IMAGES = 16
_CAPTURE_CACHE_MAX_TOTAL_CHARS = 64 * 1024 * 1024
_SAM3D_MAX_UPLOAD_BYTES = 32 * 1024 * 1024
_SAM3D_MAX_PIXELS = 4096 * 4096
_VNCCS_MORPH_DATA_BINARY = None
_VNCCS_MORPH_DATA_LOCK = None
_VNCCS_PREVIEW_LOCK = None
_VNCCS_DATA_LOAD_LOCK = None

async def _vnccs_async_checkpoint():
    await asyncio.sleep(0)

async def _vnccs_load_obj_async(file_path, checkpoint_lines=1500):
    from .CharacterData.obj_loader import Mesh

    vertices = []
    faces = []
    face_groups = []
    current_group = "default"
    vertex_to_uv = {}
    texcoords = []
    line_count = 0

    with open(file_path, "r", encoding="utf-8") as handle:
        for line in handle:
            line_count += 1
            if line.startswith("v "):
                parts = line.strip().split()
                vertices.append([float(parts[1]), float(parts[2]), float(parts[3])])
            elif line.startswith("vt "):
                parts = line.strip().split()
                texcoords.append([float(parts[1]), float(parts[2])])
            elif line.startswith("g "):
                parts = line.strip().split()
                current_group = parts[1] if len(parts) > 1 else "default"
            elif line.startswith("f "):
                parts = line.strip().split()
                face_indices = []
                for item in parts[1:]:
                    components = item.split("/")
                    if not components[0]:
                        continue
                    vertex_index = int(components[0]) - 1
                    face_indices.append(vertex_index)
                    if len(components) > 1 and components[1]:
                        uv_index = int(components[1]) - 1
                        if 0 <= uv_index < len(texcoords):
                            vertex_to_uv[vertex_index] = texcoords[uv_index]
                faces.append(face_indices)
                face_groups.append(current_group)

            if line_count % checkpoint_lines == 0:
                await _vnccs_async_checkpoint()

    vertex_uvs = np.zeros((len(vertices), 2), dtype=np.float32)
    for vertex_index, uv in vertex_to_uv.items():
        if vertex_index < len(vertex_uvs):
            vertex_uvs[vertex_index] = uv

    mesh = Mesh(np.array(vertices, dtype=np.float32), faces, face_groups)
    mesh.vertex_uvs = vertex_uvs
    return mesh

async def _vnccs_load_target_data_async(target_entry, checkpoint_lines=1200):
    if target_entry.get("data") is not None:
        return target_entry["data"]

    indices = []
    deltas = []
    line_count = 0

    try:
        with open(target_entry["path"], "r", encoding="utf-8") as handle:
            for line in handle:
                line_count += 1
                line = line.strip()
                if not line or line.startswith("#"):
                    continue

                parts = line.split()
                if len(parts) == 4:
                    try:
                        indices.append(int(parts[0]))
                        deltas.append([float(parts[1]), float(parts[2]), float(parts[3])])
                    except ValueError:
                        pass

                if line_count % checkpoint_lines == 0:
                    await _vnccs_async_checkpoint()
    except Exception as exc:
        print(f"Error reading {target_entry['path']}: {exc}")
        return None

    if not indices:
        return None

    data = (np.array(indices, dtype=np.int32), np.array(deltas, dtype=np.float32))
    target_entry["data"] = data
    return data

async def _vnccs_scan_targets_async(parser):
    base_folders = ["macrodetails", "breast", "genitals"]
    all_targets = []

    for folder in base_folders:
        base_path = os.path.join(parser.makehuman_path, "makehuman", "data", "targets", folder)
        if not os.path.exists(base_path):
            base_path = os.path.join(parser.makehuman_path, "data", "targets", folder)
            if not os.path.exists(base_path):
                continue

        for root, _dirs, files in os.walk(base_path):
            for file_name in files:
                if not file_name.endswith(".target"):
                    continue

                tags = parser._parse_filename(file_name)
                keep = False
                if folder == "macrodetails":
                    keep = len(tags) > 0
                elif folder == "breast":
                    keep = "cup" in tags
                elif folder == "genitals":
                    keep = any(key.startswith("penis") for key in tags)
                if not keep:
                    continue

                target_entry = {
                    "path": os.path.join(root, file_name),
                    "tags": tags,
                    "data": None,
                    "filename": file_name.replace(".target", ""),
                }
                await _vnccs_load_target_data_async(target_entry)
                all_targets.append(target_entry)
                if len(all_targets) % 8 == 0:
                    await _vnccs_async_checkpoint()

    parser.macro_targets = all_targets
    return all_targets

def _vnccs_content_length_ok(request, max_bytes):
    try:
        raw_length = request.headers.get("Content-Length")
        if raw_length is None:
            return not getattr(request, "can_read_body", False)
        length = int(raw_length)
    except Exception:
        return False
    return length <= int(max_bytes or 0)

def _vnccs_safe_id(value, fallback="item"):
    cleaned = _SAFE_ID_RE.sub("_", str(value or "")).strip("_")
    return cleaned[:128] or fallback

def _vnccs_validate_capture_payload(data):
    captured_images = data.get("captured_images", [])
    lighting_prompts = data.get("lighting_prompts", [])
    if not isinstance(captured_images, list):
        raise ValueError("captured_images must be a list")
    if len(captured_images) > _CAPTURE_CACHE_MAX_IMAGES:
        raise ValueError(f"captured_images limit is {_CAPTURE_CACHE_MAX_IMAGES}")
    total_chars = 0
    for image in captured_images:
        if not isinstance(image, str):
            raise ValueError("captured_images entries must be strings")
        total_chars += len(image)
        if total_chars > _CAPTURE_CACHE_MAX_TOTAL_CHARS:
            raise ValueError("captured_images payload is too large")
    if not isinstance(lighting_prompts, list):
        lighting_prompts = []
    lighting_prompts = [str(prompt)[:4096] for prompt in lighting_prompts[:_CAPTURE_CACHE_MAX_IMAGES]]
    return captured_images, lighting_prompts

async def _vnccs_ensure_pose_data_loaded_async():
    from .CharacterData.mh_parser import TargetParser
    from .CharacterData.mh_skeleton import Skeleton
    from .nodes.pose_studio import POSE_STUDIO_CACHE, _get_character_data_path

    if POSE_STUDIO_CACHE.get("base_mesh") is not None:
        return

    global _VNCCS_DATA_LOAD_LOCK
    if _VNCCS_DATA_LOAD_LOCK is None:
        _VNCCS_DATA_LOAD_LOCK = asyncio.Lock()

    async with _VNCCS_DATA_LOAD_LOCK:
        if POSE_STUDIO_CACHE.get("base_mesh") is not None:
            return

        char_data_path = _get_character_data_path()
        mh_path = os.path.join(char_data_path, "makehuman")
        if not os.path.exists(mh_path):
            raise RuntimeError(f"MakeHuman data not found at: {mh_path}")

        print(f"[VNCCS Pose Studio] Loading MakeHuman data from {mh_path}...")

        base_obj_paths = [
            os.path.join(mh_path, "makehuman", "data", "3dobjs", "base.obj"),
            os.path.join(mh_path, "data", "3dobjs", "base.obj"),
        ]
        base_path = next((path for path in base_obj_paths if os.path.exists(path)), None)
        if not base_path:
            raise RuntimeError("Could not find base.obj inside makehuman data.")

        base_mesh = await _vnccs_load_obj_async(base_path)
        await _vnccs_async_checkpoint()

        parser = TargetParser(mh_path)
        targets = await _vnccs_scan_targets_async(parser)
        print(f"[VNCCS Pose Studio] Loaded {len(targets)} targets.")
        await _vnccs_async_checkpoint()

        skeleton = None
        skel_path = os.path.join(mh_path, "makehuman", "data", "rigs", "game_engine.mhskel")
        if not os.path.exists(skel_path):
            skel_path = os.path.join(mh_path, "makehuman", "data", "rigs", "default.mhskel")

        if os.path.exists(skel_path):
            print(f"[VNCCS Pose Studio] Loading skeleton from {skel_path}...")
            skeleton = Skeleton()
            await asyncio.to_thread(skeleton.fromFile, skel_path, base_mesh)
        else:
            print(f"[VNCCS Pose Studio] Warning: Default skeleton not found at {skel_path}")

        POSE_STUDIO_CACHE.update({
            "base_mesh": base_mesh,
            "targets": targets,
            "parser": parser,
            "skeleton": skeleton,
        })

def _vnccs_build_update_preview_payload(data):
    age = float(data.get('age', 25.0))
    gender = float(data.get('gender', 0.5))
    weight = float(data.get('weight', 0.5))
    muscle = float(data.get('muscle', 0.5))
    height = float(data.get('height', 0.5))
    breast_size = float(data.get('breast_size', 0.5))
    firmness = float(data.get('firmness', 0.5))
    penis_len = float(data.get('penis_len', 0.5))
    penis_circ = float(data.get('penis_circ', 0.5))
    penis_test = float(data.get('penis_test', 0.5))

    from .CharacterData.mh_parser import HumanSolver
    from .nodes.pose_studio import POSE_STUDIO_CACHE

    mh_age = (age - 1.0) / (90.0 - 1.0)
    mh_age = max(0.0, min(1.0, mh_age))

    if POSE_STUDIO_CACHE.get("base_mesh") is None:
        raise RuntimeError("Pose Studio data is not loaded")

    solver = HumanSolver()
    factors = solver.calculate_factors(mh_age, gender, weight, muscle, height, breast_size, firmness, penis_len, penis_circ, penis_test)
    new_verts = solver.solve_mesh(POSE_STUDIO_CACHE['base_mesh'], POSE_STUDIO_CACHE['targets'], factors)

    skel = POSE_STUDIO_CACHE.get('skeleton')
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

        if skel.vertexWeights:
            for bone_name, (indices, w_vals) in skel.vertexWeights.data.items():
                weights_for_frontend[bone_name] = {
                    "indices": indices.tolist() if hasattr(indices, 'tolist') else list(indices),
                    "weights": w_vals.tolist() if hasattr(w_vals, 'tolist') else list(w_vals)
                }

    return {
        "status": "success",
        "vertices": new_verts.flatten().tolist(),
        "uvs": base_mesh.vertex_uvs.flatten().tolist() if hasattr(base_mesh, 'vertex_uvs') else [],
        "indices": tri_indices,
        "normals": [],
        "bones": bones_data,
        "weights": weights_for_frontend,
        "landmarks": landmarks_for_frontend,
        "landmark_indices": landmark_indices_for_frontend
    }

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
            global _VNCCS_PREVIEW_LOCK
            if not _vnccs_content_length_ok(request, 1024 * 1024):
                return web.json_response({"error": "Request body is too large"}, status=413)
            data = await request.json()
            if _VNCCS_PREVIEW_LOCK is None:
                _VNCCS_PREVIEW_LOCK = asyncio.Lock()
            async with _VNCCS_PREVIEW_LOCK:
                await _vnccs_ensure_pose_data_loaded_async()
                return web.json_response(await asyncio.to_thread(_vnccs_build_update_preview_payload, data))
        except Exception as e:
            import traceback
            traceback.print_exc()
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/character_studio/morph_data.bin")
    async def vnccs_character_studio_morph_data(request):
        try:
            global _VNCCS_MORPH_DATA_BINARY, _VNCCS_MORPH_DATA_LOCK
            if _VNCCS_MORPH_DATA_BINARY is None:
                if _VNCCS_MORPH_DATA_LOCK is None:
                    _VNCCS_MORPH_DATA_LOCK = asyncio.Lock()
                async with _VNCCS_MORPH_DATA_LOCK:
                    if _VNCCS_MORPH_DATA_BINARY is None:
                        from .nodes.pose_studio import POSE_STUDIO_CACHE

                        await _vnccs_ensure_pose_data_loaded_async()
                        base_mesh = POSE_STUDIO_CACHE["base_mesh"]
                        targets = POSE_STUDIO_CACHE["targets"] or []

                        buffers = []
                        header = {
                            "version": 1,
                            "vertex_count": int(len(base_mesh.vertices)),
                            "base_vertices": {"offset": 0, "length": int(base_mesh.vertices.size)},
                            "targets": [],
                            "joints": {},
                            "bones": [],
                        }

                        offset = 0
                        base_vertices = np.asarray(base_mesh.vertices, dtype="<f4")
                        base_bytes = base_vertices.tobytes(order="C")
                        buffers.append(base_bytes)
                        offset += len(base_bytes)

                        for target in targets:
                            data = target.get("data")
                            if data is None:
                                continue
                            indices, deltas = data
                            indices = np.asarray(indices, dtype="<u4")
                            deltas = np.asarray(deltas, dtype="<f4").reshape(-1, 3)
                            if len(indices) == 0 or len(deltas) != len(indices):
                                continue

                            indices_bytes = indices.tobytes(order="C")
                            deltas_bytes = deltas.tobytes(order="C")
                            target_header = {
                                "tags": target.get("tags", {}),
                                "count": int(len(indices)),
                                "indices": {"offset": offset, "length": int(len(indices))},
                            }
                            buffers.append(indices_bytes)
                            offset += len(indices_bytes)
                            target_header["deltas"] = {"offset": offset, "length": int(deltas.size)}
                            buffers.append(deltas_bytes)
                            offset += len(deltas_bytes)
                            header["targets"].append(target_header)

                        skeleton = POSE_STUDIO_CACHE.get("skeleton")
                        if skeleton:
                            header["joints"] = {
                                name: [int(index) for index in indices]
                                for name, indices in skeleton.joint_pos_idxs.items()
                            }
                            header["bones"] = [
                                {
                                    "name": bone.name,
                                    "parent": bone.parent.name if bone.parent else None,
                                    "head_joint": bone.headJoint,
                                    "tail_joint": bone.tailJoint,
                                }
                                for bone in skeleton.getBones()
                            ]

                        header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
                        header_padding = b"\0" * ((4 - ((12 + len(header_bytes)) % 4)) % 4)
                        _VNCCS_MORPH_DATA_BINARY = (
                            b"VNMORPH1"
                            + struct.pack("<I", len(header_bytes))
                            + header_bytes
                            + header_padding
                            + b"".join(buffers)
                        )

            return web.Response(
                body=_VNCCS_MORPH_DATA_BINARY,
                content_type="application/octet-stream",
                headers={"Cache-Control": "no-store"},
            )
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
            if not _vnccs_content_length_ok(request, _CAPTURE_CACHE_MAX_TOTAL_CHARS + 1024 * 1024):
                return web.json_response({"error": "captured_images payload is too large"}, status=413)
            data = await request.json()
            capture_id = data.get("capture_id")
            if not capture_id:
                return web.json_response({"error": "missing capture_id"}, status=400)
            capture_id = _vnccs_safe_id(capture_id, "capture")
            try:
                captured_images, lighting_prompts = _vnccs_validate_capture_payload(data)
            except ValueError as exc:
                return web.json_response({"error": str(exc)}, status=413)

            VNCCS_CAPTURE_CACHE[capture_id] = {
                "captured_images": captured_images,
                "lighting_prompts": lighting_prompts,
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
        capture_id = _vnccs_safe_id(request.match_info["capture_id"], "capture")
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
