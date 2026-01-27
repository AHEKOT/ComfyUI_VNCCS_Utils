import numpy as np
import os

class Mesh:
    def __init__(self, vertices, faces, face_groups=None):
        self.vertices = vertices  # Numpy array (N, 3)
        self.faces = faces        # Numpy array (F, 3) or (F, 4) etc.
        self.face_groups = face_groups # List of group names corresponding to faces

    def copy(self):
        fg = self.face_groups.copy() if self.face_groups is not None else None
        return Mesh(self.vertices.copy(), self.faces.copy(), fg)

def load_obj(file_path):
    """
    Simple OBJ loader.
    Returns a Mesh object with vertices and faces.
    """
    vertices = []
    faces = []
    face_groups = []
    current_group = "default"
    
    vertex_to_uv = {} # Map vertex index to UV [u, v]
    texcoords = []

    with open(file_path, 'r', encoding='utf-8') as f:
        for line in f:
            if line.startswith('v '):
                parts = line.strip().split()
                vertices.append([float(parts[1]), float(parts[2]), float(parts[3])])
            
            elif line.startswith('vt '):
                parts = line.strip().split()
                # vt u v (sometimes w)
                texcoords.append([float(parts[1]), float(parts[2])])

            elif line.startswith('g '):
                # New group
                parts = line.strip().split()
                if len(parts) > 1:
                    current_group = parts[1]
                else:
                    current_group = "default"
                
            elif line.startswith('f '):
                parts = line.strip().split()
                # Handle face formats like 1/1/1 or 1//1 or 1
                face_indices = []
                for p in parts[1:]:
                    components = p.split('/')
                    # v_idx handling
                    if not components[0]: continue
                    
                    v_idx = int(components[0]) - 1 # OBJ is 1-based index
                    face_indices.append(v_idx)
                    
                    # Texture coordinate index (if present)
                    # face format: v/vt/vn
                    if len(components) > 1 and components[1]:
                        vt_idx = int(components[1]) - 1
                        if 0 <= vt_idx < len(texcoords):
                            # Assign UV to vertex (last wins strategy for seams)
                            vertex_to_uv[v_idx] = texcoords[vt_idx]
                            
                faces.append(face_indices)
                face_groups.append(current_group)
    
    # Create UV array matching vertices
    vertex_uvs = np.zeros((len(vertices), 2), dtype=np.float32)
    for v_idx, uv in vertex_to_uv.items():
        if v_idx < len(vertex_uvs):
            vertex_uvs[v_idx] = uv

    mesh = Mesh(np.array(vertices, dtype=np.float32), faces, face_groups)
    mesh.vertex_uvs = vertex_uvs
    return mesh
