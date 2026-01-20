"""VNCCS Pose Studio - Combined mesh editor and multi-pose generator.

Combines Character Studio mesh sliders with dynamic pose tabs.
Each pose stores bone rotations and global model rotation.
Outputs rendered mesh images with skin material.

This node is fully self-contained with all data loading logic.
"""

import json
import os
import base64
from io import BytesIO
import torch
import numpy as np
from PIL import Image, ImageDraw

# Import from CharacterData module
from ..CharacterData.mh_parser import TargetParser, HumanSolver
from ..CharacterData.obj_loader import load_obj
from ..CharacterData import matrix
from ..CharacterData.mh_skeleton import Skeleton


# === Data Cache and Loader (from Character Studio) ===

# Singleton storage for loaded MH data to avoid reloading every time
POSE_STUDIO_CACHE = {
    "base_mesh": None,
    "targets": None,
    "parser": None,
    "skeleton": None
}


def _get_character_data_path():
    """Get the path to CharacterData folder."""
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "CharacterData"))


def _ensure_data_loaded():
    """Load MakeHuman data if not already loaded."""
    if POSE_STUDIO_CACHE['base_mesh'] is not None:
        return

    char_data_path = _get_character_data_path()
    mh_path = os.path.join(char_data_path, "makehuman")
    
    if not os.path.exists(mh_path):
        raise Exception(f"MakeHuman data not found at: {mh_path}")

    print(f"[VNCCS Pose Studio] Loading MakeHuman data from {mh_path}...")

    # 1. Load Base Mesh
    base_obj_paths = [
        os.path.join(mh_path, "makehuman", "data", "3dobjs", "base.obj"),
        os.path.join(mh_path, "data", "3dobjs", "base.obj"),
    ]
    
    base_path = next((p for p in base_obj_paths if os.path.exists(p)), None)
    if not base_path:
        raise Exception("Could not find base.obj inside makehuman data.")

    POSE_STUDIO_CACHE['base_mesh'] = load_obj(base_path)
    
    # 2. Load Targets
    parser = TargetParser(mh_path)
    POSE_STUDIO_CACHE['targets'] = parser.scan_targets()
    POSE_STUDIO_CACHE['parser'] = parser
    
    print(f"[VNCCS Pose Studio] Loaded {len(POSE_STUDIO_CACHE['targets'])} targets.")
    
    # 3. Load Skeleton (Preference: game_engine > default)
    skel_path = os.path.join(mh_path, "makehuman", "data", "rigs", "game_engine.mhskel")
    if not os.path.exists(skel_path):
        skel_path = os.path.join(mh_path, "makehuman", "data", "rigs", "default.mhskel")
        
    if os.path.exists(skel_path):
        print(f"[VNCCS Pose Studio] Loading skeleton from {skel_path}...")
        skel = Skeleton()
        skel.fromFile(skel_path, POSE_STUDIO_CACHE['base_mesh'])
        POSE_STUDIO_CACHE['skeleton'] = skel
    else:
        print(f"[VNCCS Pose Studio] Warning: Default skeleton not found at {skel_path}")


# === Main Node Class ===

class VNCCS_PoseStudio:
    """Pose Studio with mesh editing and multiple pose generation."""
    
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "generate"
    CATEGORY = "VNCCS/pose"
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # ALL settings come from widget via pose_data
                "pose_data": ("STRING", {"multiline": True, "default": "{}"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID"
            }
        }
    
    def generate(
        self,
        pose_data: str = "{}",
        unique_id: str = None
    ):
        """Generate rendered mesh images for all poses."""
        
        # Parse pose data
        try:
            data = json.loads(pose_data) if pose_data else {}
        except (json.JSONDecodeError, TypeError):
            data = {}
            
        if not isinstance(data, dict):
            print(f"Pose Studio Error: pose_data is not a dict, got {type(data)}. Using default.")
            data = {}
        
        # Extract settings from JSON
        mesh = data.get("mesh", {})
        age = mesh.get("age", 25.0)
        gender = mesh.get("gender", 0.5)
        weight = mesh.get("weight", 0.5)
        muscle = mesh.get("muscle", 0.5)
        height = mesh.get("height", 0.5)
        breast_size = mesh.get("breast_size", 0.5)
        breast_size = mesh.get("breast_size", 0.5)
        firmness = mesh.get("firmness", 0.5)
        
        # Male specifics
        penis_len = mesh.get("penis_len", 0.5)
        penis_circ = mesh.get("penis_circ", 0.5)
        penis_test = mesh.get("penis_test", 0.5)
        # Fallback for old configs
        if "genital_size" in mesh:
            genital_size = mesh["genital_size"]
            penis_len = genital_size # Map old single slider to length
        
        export = data.get("export", {})
        view_width = export.get("view_width", export.get("view_size", 512))
        view_height = export.get("view_height", export.get("view_size", 512))
        cam_zoom = export.get("cam_zoom", 1.0)
        output_mode = export.get("output_mode", "LIST")
        grid_columns = export.get("grid_columns", 2)
        bg_color = export.get("bg_color", [40, 40, 40])  # RGB
        
        poses = data.get("poses", [{}])
        if not poses:
            poses = [{}]
            
        # === 1. Try Client-Side Rendered Images (CSR) ===
        # If frontend sent captured images, use them directly.
        captured_images = data.get("captured_images", [])
        
        if captured_images:
            rendered_images = []
            for b64 in captured_images:
                if not b64: continue
                # Remove header if present (data:image/png;base64,...)
                if "," in b64:
                    b64 = b64.split(",", 1)[1]
                
                try:
                    img_data = base64.b64decode(b64)
                    img = Image.open(BytesIO(img_data)).convert('RGB')
                    rendered_images.append(img)
                except Exception as e:
                    print(f"Pose Studio Error: Failed to decode image: {e}")
            
            if rendered_images:
                # Convert to tensors
                tensors = []
                for img in rendered_images:
                    np_img = np.array(img).astype(np.float32) / 255.0
                    tensors.append(torch.from_numpy(np_img))
                
                if output_mode == "LIST":
                    batch = torch.stack(tensors)
                    return (batch,)
                else:
                    grid_img = self._make_grid(rendered_images, grid_columns, tuple(bg_color))
                    np_grid = np.array(grid_img).astype(np.float32) / 255.0
                    grid_tensor = torch.from_numpy(np_grid).unsqueeze(0)
                    return (grid_tensor,)
        
        # === 2. Fallback to Python Rendering ===
        
        # Ensure data loaded
        _ensure_data_loaded()
        
        # Normalize age
        mh_age = (age - 1.0) / (90.0 - 1.0)
        mh_age = max(0.0, min(1.0, mh_age))
        
        # Solve base mesh
        solver = HumanSolver()
        factors = solver.calculate_factors(mh_age, gender, weight, muscle, height, breast_size, firmness, penis_len, penis_circ, penis_test)
        base_verts = solver.solve_mesh(
            POSE_STUDIO_CACHE['base_mesh'],
            POSE_STUDIO_CACHE['targets'],
            factors
        )
        
        # Render each pose
        rendered_images = []
        view_size = (view_width, view_height)
        
        for pose_idx, pose in enumerate(poses):
            bones = pose.get("bones", {})
            model_rotation = pose.get("modelRotation", [0, 0, 0])
            
            # Apply pose to skeleton and get posed vertices
            posed_verts = self._apply_pose(base_verts, bones, model_rotation)
            
            # Render with background color
            img = self._render_mesh(posed_verts, view_size, tuple(bg_color))
            rendered_images.append(img)
        
        # Convert to tensors
        tensors = []
        for img in rendered_images:
            np_img = np.array(img).astype(np.float32) / 255.0
            tensors.append(torch.from_numpy(np_img))
        
        if output_mode == "LIST":
            # Return batch of images
            batch = torch.stack(tensors)
            return (batch,)
        else:
            # GRID mode - concatenate into single image
            grid_img = self._make_grid(rendered_images, grid_columns, tuple(bg_color))
            np_grid = np.array(grid_img).astype(np.float32) / 255.0
            grid_tensor = torch.from_numpy(np_grid).unsqueeze(0)
            return (grid_tensor,)
    
    def _apply_pose(self, verts, bones_data, model_rotation):
        """Apply bone rotations (FK) and global rotation to vertices."""
        
        # 1. Setup Wrapper for Mesh (needed for skeleton update)
        class MeshWrapper:
            def __init__(self, v): self.vertices = v
        
        mesh_wrapper = MeshWrapper(verts)
        
        # 2. Get and copy skeleton
        # We must copy because we modify joint positions (fitting) and bone rotations
        orig_skel = POSE_STUDIO_CACHE['skeleton']
        if not orig_skel:
            # Should not happen if _ensure_data_loaded is called
            return verts
            
        skel = orig_skel.copy()
        
        # 3. Fit skeleton to current mesh (proportions)
        # This moves joints to match the morphing target
        skel.updateJointPositions(mesh_wrapper)
        
        # 4. Apply rotations to bones
        deg2rad = np.pi / 180.0
        
        for bone_name, rot_deg in bones_data.items():
            bone = skel.getBone(bone_name)
            if not bone:
                continue
            
            # Rotation order: Z * Y * X (Extrinsic? Intrinsic?)
            # Three.js (Frontend) uses Euler XYZ.
            # Assuming standard composition:
            rx, ry, rz = rot_deg[0] * deg2rad, rot_deg[1] * deg2rad, rot_deg[2] * deg2rad
            
            # Create rotation matrix
            # Note: matrix.rotx returns 4x4
            rot_mat = np.dot(
                matrix.rotz(rz),
                np.dot(matrix.roty(ry), matrix.rotx(rx))
            )
            
            bone.matPose = rot_mat

        # 5. Update global matrices (FK)
        # boneslist is breadth-first sorted, so parents always processed before children
        for bone in skel.boneslist:
            bone.update()
            
        # 6. Linear Blend Skinning (LBS)
        # Pre-allocate result (N, 3)
        skinned_verts = np.zeros_like(verts)
        
        # Helper arrays
        # Expand verts to (N, 4) for matrix multiplication
        ones = np.ones((len(verts), 1), dtype=np.float32)
        verts4 = np.hstack([verts, ones])
        
        has_weights = False
        # Iterate over all bones that have weights
        # skel.vertexWeights.data is OrderedDict {bone: (indices, weights)}
        if skel.vertexWeights:
            has_weights = True
            for bname, (indices, weights) in skel.vertexWeights.data.items():
                bone = skel.getBone(bname)
                if not bone or len(indices) == 0:
                    continue
                
                # Get Skinning Matrix: Pose * InvBind
                # shape (4, 4)
                mat_skin = bone.matPoseVerts
                
                # Select vertices affected by this bone
                # v_subset shape (K, 4)
                v_subset = verts4[indices]
                
                # Transform: v' = v * M^T
                v_transformed = np.asarray(np.dot(v_subset, mat_skin.T))
                
                # Weighted accumulation
                # weights shape (K,) -> reshape to (K, 1)
                w_expanded = weights[:, np.newaxis]
                
                # Optimization: Doing it in place.
                current = skinned_verts[indices]
                skinned_verts[indices] = current + v_transformed[:, :3] * w_expanded

        if not has_weights:
            print("Pose Studio Warning: No weights found, skinning skipped!")
            skinned_verts = verts.copy()

        # 7. Apply Global Model Rotation
        posed = skinned_verts
        
        rx, ry, rz = model_rotation
        if abs(rx) > 0.01 or abs(ry) > 0.01 or abs(rz) > 0.01:
            # Convert degrees to radians
            rx, ry, rz = rx * deg2rad, ry * deg2rad, rz * deg2rad
            
            rot_mat = np.dot(
                matrix.rotz(rz),
                np.dot(matrix.roty(ry), matrix.rotx(rx))
            )[:3, :3]
            
            # Center for rotation
            center = posed.mean(axis=0)  # Rotate around body center
            posed = posed - center
            posed = np.dot(posed, rot_mat.T)
            posed = posed + center
        
        return posed
    
    def _render_mesh(self, verts, size, bg_color=(40, 40, 40)):
        """Render mesh with skin-colored Phong shading."""
        from PIL import Image, ImageDraw
        
        base_mesh = POSE_STUDIO_CACHE['base_mesh']
        
        # Setup viewport
        W, H = size
        img = Image.new('RGB', (W, H), bg_color)
        draw = ImageDraw.Draw(img)
        
        # Project vertices
        center = verts.mean(axis=0)
        scale = min(W, H) * 0.4 / max(np.abs(verts - center).max(), 0.001)
        
        verts_screen = np.zeros((len(verts), 2))
        verts_screen[:, 0] = (verts[:, 0] - center[0]) * scale + W / 2
        verts_screen[:, 1] = H / 2 - (verts[:, 1] - center[1]) * scale
        
        # Get valid faces
        valid_prefixes = ["body", "helper-r-eye", "helper-l-eye", "helper-upper-teeth", "helper-lower-teeth"]
        faces = []
        if base_mesh.face_groups:
            for i, group in enumerate(base_mesh.face_groups):
                g_clean = group.strip()
                if g_clean in valid_prefixes:
                    faces.append(base_mesh.faces[i])
        
        # Render with flat shading
        self._render_flat_shaded(draw, verts_screen, verts, faces, W, H)
        
        return img
    
    def _render_flat_shaded(self, draw, verts_screen, verts_3d, faces, W, H):
        """Render faces with flat shading and skin color."""
        light_dir = np.array([0.5, 0.8, 1.0])
        light_dir = light_dir / np.linalg.norm(light_dir)
        
        # Skin base color (warm tone)
        base_color = np.array([212, 165, 116])  # 0xd4a574
        
        face_data = []
        for face in faces:
            if len(face) < 3:
                continue
            
            # Get vertex indices
            v_indices = []
            for item in face:
                if isinstance(item, (list, tuple)):
                    v_indices.append(item[0])
                else:
                    v_indices.append(item)
            
            if any(vi >= len(verts_3d) for vi in v_indices):
                continue
            
            # Calculate face center Z for sorting
            z_avg = np.mean([verts_3d[vi][2] for vi in v_indices[:3]])
            
            # Calculate normal
            p0 = verts_3d[v_indices[0]]
            p1 = verts_3d[v_indices[1]]
            p2 = verts_3d[v_indices[2]]
            
            v1 = p1 - p0
            v2 = p2 - p0
            normal = np.cross(v1, v2)
            norm_len = np.linalg.norm(normal)
            if norm_len < 1e-8:
                continue
            normal = normal / norm_len
            
            # Lighting
            diffuse = max(0, np.dot(normal, light_dir))
            ambient = 0.3
            intensity = min(1.0, ambient + diffuse * 0.7)
            
            color = (base_color * intensity).astype(int)
            color = tuple(np.clip(color, 0, 255))
            
            face_data.append((z_avg, v_indices, color))
        
        # Sort by depth (painter's algorithm)
        face_data.sort(key=lambda x: x[0])
        
        # Draw faces
        for _, v_indices, color in face_data:
            points = [(verts_screen[vi][0], verts_screen[vi][1]) for vi in v_indices[:4]]
            if len(points) >= 3:
                draw.polygon(points, fill=color)
    
    def _make_grid(self, images, columns, bg_color=(40, 40, 40)):
        """Combine images into a grid."""
        if not images:
            return Image.new('RGB', (512, 512), bg_color)
        
        n = len(images)
        cols = min(columns, n)
        rows = (n + cols - 1) // cols
        
        w, h = images[0].size
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
