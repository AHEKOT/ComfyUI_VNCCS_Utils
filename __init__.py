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
                "weights": weights_for_frontend
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
