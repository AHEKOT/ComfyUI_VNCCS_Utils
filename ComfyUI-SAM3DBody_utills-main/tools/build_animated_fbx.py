"""Build an animated rigged FBX (armature + mesh + LBS vertex groups +
multi-frame pose animation) from a package JSON produced by the
`SAM 3D Body: Export Animated FBX` ComfyUI node.

Run under Blender (headless). The ComfyUI node invokes this
automatically; running by hand is only useful for debugging.

    blender --background --python tools/build_animated_fbx.py -- \
        --input <package.json>

The rig is bound to the character's **rest pose** (body_pose = 0); every
frame in `frames_posed_joint_rots` contributes a keyframe computed as a
local delta from that rest rotation. This keeps skinning consistent
across all frames and matches the bind-pose convention that DCCs /
Unity / Unreal expect for motion-capture clips.

Package JSON schema:
    output_path              : str
    rest_verts               : [V, 3] — MHR native, final character rest mesh
    faces                    : [F, 3]
    joint_parents            : [J]    — parent index per joint (-1 = root)
    joint_names              : [J]    — bone names
    rest_joint_coords        : [J, 3] — MHR native rest joint world positions
    rest_joint_rots          : [J, 3, 3] — MHR native rest world rotations
    frames_posed_joint_rots  : [N, J, 3, 3] — per-frame posed world rotations
    frames_root_trans        : [N, 3] — MHR native per-frame root world
                                        translation (anchored to first
                                        detected frame = origin). Optional;
                                        absent/empty means no root motion.
    fps                      : float — animation frame rate
    lbs_v_idx / lbs_j_idx / lbs_weight : sparse LBS skinning weights
"""

import sys
import json
import argparse
from pathlib import Path

try:
    import bpy
    from mathutils import Vector, Matrix
except ImportError:
    print("ERROR: this script must run under Blender")
    sys.exit(1)


# Axis swap: MHR native (X right, Y up, Z forward) -> Blender internal
# (X right, Y back, Z up). Identical to build_rigged_fbx.py.
_A = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
_A_T = _A.transposed()


def mhr_to_blender_vec(v):
    return Vector((float(v[0]), -float(v[2]), float(v[1])))


def mhr_to_blender_rot(R):
    return _A @ Matrix(R) @ _A_T


def _parse_args():
    idx = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    return parser.parse_args(sys.argv[idx + 1:])


def _pick_chain_child(j, parent_idx, kids, rest_coords):
    """Same child-selection heuristic as build_rigged_fbx.py — prefer the
    child most aligned with the parent->self axis so straight chains
    (spine, neck) stay straight."""
    if len(kids) == 1:
        return kids[0]
    if parent_idx >= 0:
        axis = rest_coords[j] - rest_coords[parent_idx]
        if axis.length > 1e-6:
            axis.normalize()
            best, best_s = kids[0], -1e9
            for k in kids:
                d = rest_coords[k] - rest_coords[j]
                if d.length < 1e-6:
                    continue
                s = d.normalized().dot(axis)
                if s > best_s:
                    best_s, best = s, k
            return best
    return max(kids, key=lambda k: rest_coords[k].z)


def main():
    args = _parse_args()
    data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    output_path = data["output_path"]
    fps = float(data.get("fps", 30.0))

    # ----- Fresh scene -----
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # ----- Armature (rest pose) -----
    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
    arm_obj = bpy.context.object
    arm_obj.name = "SAM3D_Armature"
    arm_obj.data.name = "SAM3D_ArmatureData"
    for b in list(arm_obj.data.edit_bones):
        arm_obj.data.edit_bones.remove(b)

    rest_coords = [mhr_to_blender_vec(p) for p in data["rest_joint_coords"]]
    rest_rots = [mhr_to_blender_rot(r) for r in data["rest_joint_rots"]]
    parents = data["joint_parents"]
    names = data["joint_names"]
    num_joints = len(names)

    children_by_parent = {}
    for j, p in enumerate(parents):
        if p >= 0:
            children_by_parent.setdefault(p, []).append(j)

    DEFAULT_LENGTH = 0.05
    for j in range(num_joints):
        bone = arm_obj.data.edit_bones.new(names[j])
        kids = children_by_parent.get(j, [])
        if kids:
            child_k = _pick_chain_child(j, parents[j], kids, rest_coords)
            dist = (rest_coords[child_k] - rest_coords[j]).length
            bone.length = max(dist, 1e-3)
        else:
            bone.length = DEFAULT_LENGTH
        M = rest_rots[j].to_4x4()
        M.translation = rest_coords[j]
        bone.matrix = M

    for j in range(num_joints):
        p = parents[j]
        if p < 0:
            continue
        pb = arm_obj.data.edit_bones.get(names[p])
        jb = arm_obj.data.edit_bones.get(names[j])
        if pb is None or jb is None:
            continue
        jb.parent = pb

    bpy.ops.object.mode_set(mode="OBJECT")

    # ----- Mesh -----
    verts = [mhr_to_blender_vec(v) for v in data["rest_verts"]]
    faces = [tuple(f) for f in data["faces"]]
    mesh = bpy.data.meshes.new("SAM3D_Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()

    mesh_obj = bpy.data.objects.new("SAM3D_Character", mesh)
    bpy.context.collection.objects.link(mesh_obj)
    mesh_obj.parent = arm_obj

    # ----- Vertex groups + LBS weights -----
    vg_by_joint = {}
    for j in range(num_joints):
        vg_by_joint[j] = mesh_obj.vertex_groups.new(name=names[j])

    v_idx = data["lbs_v_idx"]
    j_idx = data["lbs_j_idx"]
    w_val = data["lbs_weight"]
    per_vert = {}
    for vi, ji, w in zip(v_idx, j_idx, w_val):
        per_vert.setdefault(int(ji), []).append((int(vi), float(w)))
    for ji, pairs in per_vert.items():
        vg = vg_by_joint[ji]
        for vi, w in pairs:
            vg.add([vi], w, 'REPLACE')

    # ----- Armature modifier -----
    mod = mesh_obj.modifiers.new(name="Armature", type='ARMATURE')
    mod.object = arm_obj
    mod.use_vertex_groups = True

    # ----- Per-frame pose keyframes -----
    frames_posed_rots = data["frames_posed_joint_rots"]
    num_frames = len(frames_posed_rots)
    if num_frames == 0:
        raise RuntimeError("frames_posed_joint_rots is empty")
    frames_root_trans = data.get("frames_root_trans") or []
    has_root_motion = (
        len(frames_root_trans) == num_frames
        and any(any(abs(c) > 1e-8 for c in t) for t in frames_root_trans)
    )
    # Identify the (single) root joint so we can write location
    # keyframes on it. Any joint whose parent is -1 counts; in practice
    # there is exactly one.
    root_idx = next((j for j, p in enumerate(parents) if p < 0), None)
    print(
        f"[build_animated_fbx] Baking {num_frames} frames @ {fps} fps "
        f"(root motion: {'yes' if has_root_motion else 'no'}, "
        f"root bone: {names[root_idx] if root_idx is not None else '<none>'})"
    )

    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode='POSE')

    # Ensure quaternion rotation mode for every pose bone once up front
    # (keyframe_insert on rotation_quaternion requires the mode to match).
    for pbone in arm_obj.pose.bones:
        pbone.rotation_mode = 'QUATERNION'
        pbone.location = (0.0, 0.0, 0.0)
        pbone.scale = (1.0, 1.0, 1.0)

    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = max(num_frames, 1)
    scene.render.fps = int(round(fps))

    rest_rots_T = [R.transposed() for R in rest_rots]

    # Precompute bone-local conversion for the root: world delta -> local
    # location is `R_rest_root.T @ delta_world`. Cache the transpose so
    # the per-frame inner loop stays cheap.
    root_rest_rot_T = rest_rots_T[root_idx] if root_idx is not None else None
    root_bone = (
        arm_obj.pose.bones.get(names[root_idx])
        if root_idx is not None else None
    )

    for f_i, posed_rots_raw in enumerate(frames_posed_rots):
        frame = f_i + 1
        scene.frame_set(frame)
        posed_rots_bl = [mhr_to_blender_rot(r) for r in posed_rots_raw]
        posed_rots_bl_T = [R.transposed() for R in posed_rots_bl]

        for j in range(num_joints):
            pbone = arm_obj.pose.bones.get(names[j])
            if pbone is None:
                continue
            R_rest_j = rest_rots[j]
            R_posed_j = posed_rots_bl[j]
            p = parents[j]
            if p < 0:
                # Root: local delta = R_rest_j^T @ R_posed_j
                delta = rest_rots_T[j] @ R_posed_j
            else:
                R_rest_p = rest_rots[p]
                # pose_delta = (R_rest_j^T @ R_rest_p)
                #              @ (R_posed_p^T @ R_posed_j)
                delta = (
                    rest_rots_T[j] @ R_rest_p
                    @ posed_rots_bl_T[p] @ R_posed_j
                )
            pbone.rotation_quaternion = delta.to_quaternion()
            pbone.keyframe_insert(data_path="rotation_quaternion", frame=frame)

        # Root translation: pose_bone.location lives in the bone's
        # local rest frame, so we convert the world-space delta with
        # the root bone's rest rotation. We keyframe every frame (not
        # just when `has_root_motion` is True) once the feature is
        # active, to keep the F-Curve dense enough for Unity's clip
        # importer — otherwise a single initial key would hold.
        if has_root_motion and root_bone is not None:
            world_delta = mhr_to_blender_vec(frames_root_trans[f_i])
            local_delta = root_rest_rot_T @ world_delta
            root_bone.location = local_delta
            root_bone.keyframe_insert(data_path="location", frame=frame)

    bpy.ops.object.mode_set(mode='OBJECT')

    # ----- FBX export -----
    bpy.ops.object.select_all(action='DESELECT')
    arm_obj.select_set(True)
    mesh_obj.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.fbx(
        filepath=str(output_path),
        use_selection=True,
        object_types={"ARMATURE", "MESH"},
        axis_forward="-Z",
        axis_up="Y",
        global_scale=1.0,
        apply_unit_scale=True,
        bake_space_transform=False,
        add_leaf_bones=False,
        bake_anim=True,
        bake_anim_use_all_actions=False,
        bake_anim_use_nla_strips=False,
        bake_anim_use_all_bones=True,
        bake_anim_force_startend_keying=True,
        bake_anim_step=1.0,
        bake_anim_simplify_factor=0.0,
    )
    print(f"[build_animated_fbx] Wrote {output_path} ({num_frames} frames)")


if __name__ == "__main__":
    main()
