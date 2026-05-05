"""Build a rigged FBX (armature + mesh + LBS vertex groups + single-frame
pose animation) from a package JSON produced by the
`SAM 3D Body: Export Rigged FBX` ComfyUI node.

Run under Blender (headless). The ComfyUI node invokes this
automatically; running by hand is only useful for debugging.

    blender --background --python tools/build_rigged_fbx.py -- \
        --input <package.json>

Package JSON schema:
    output_path         : str
    rest_verts          : [V, 3] — MHR native, final character rest mesh
    faces               : [F, 3] — triangle indices
    joint_parents       : [J]    — parent index per joint (-1 = root)
    joint_names         : [J]    — bone names
    rest_joint_coords   : [J, 3] — MHR native rest joint world positions
    rest_joint_rots     : [J, 3, 3] — MHR native rest world rotations
    posed_joint_coords  : [J, 3] — MHR native posed world positions
    posed_joint_rots    : [J, 3, 3] — MHR native posed world rotations
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
# (X right, Y back, Z up). Verified against existing extract / build
# scripts in tools/.
#
#   A = [[1,  0,  0],
#        [0,  0, -1],
#        [0,  1,  0]]
#
# For a MHR-native rotation R:
#   R_blender = A @ R @ A^T
_A = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
_A_T = _A.transposed()


def mhr_to_blender_vec(v):
    return Vector((float(v[0]), -float(v[2]), float(v[1])))


def mhr_to_blender_rot(R):
    return _A @ Matrix(R) @ _A_T


def _parse_args():
    # Blender swallows args before "--"; everything after goes to us.
    idx = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    return parser.parse_args(sys.argv[idx + 1:])


def _pick_chain_child(j, parent_idx, kids, rest_coords):
    """Pick which child to use for bone length estimation, preferring the
    one most aligned with the parent->self axis. Keeps straight chains
    (spine, neck) from veering into side branches (clavicle)."""
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
    # Root joints with no parent: pick the highest child (spine direction).
    return max(kids, key=lambda k: rest_coords[k].z)


def main():
    args = _parse_args()
    data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    output_path = data["output_path"]

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
    # Set each bone's full rest transform via `edit_bone.matrix` rather
    # than head/tail/roll. This plants the bone's rest orientation at
    # the MHR rest rotation, which is ESSENTIAL for pose_bone.matrix in
    # pose mode to compute the right local delta — otherwise Blender
    # derives a default orientation from head/tail and every posed bone
    # ends up tilted by the mismatch.
    for j in range(num_joints):
        bone = arm_obj.data.edit_bones.new(names[j])
        # Choose a sensible length from child distance (so the bone
        # visualization isn't a 1m stick). Must be > 0 BEFORE setting
        # .matrix because `matrix` preserves current length while
        # planting head/tail on the new orientation.
        kids = children_by_parent.get(j, [])
        if kids:
            child_k = _pick_chain_child(j, parents[j], kids, rest_coords)
            dist = (rest_coords[child_k] - rest_coords[j]).length
            bone.length = max(dist, 1e-3)
        else:
            bone.length = DEFAULT_LENGTH
        # Now write the full rest world transform (armature local space,
        # but armature.matrix_world = identity so that equals world).
        M = rest_rots[j].to_4x4()
        M.translation = rest_coords[j]
        bone.matrix = M

    # Second pass: set parents once all bones exist, since edit_bones.new
    # doesn't take a parent.
    for j in range(num_joints):
        p = parents[j]
        if p < 0:
            continue
        pb = arm_obj.data.edit_bones.get(names[p])
        jb = arm_obj.data.edit_bones.get(names[j])
        if pb is None or jb is None:
            continue
        jb.parent = pb
        # Intentionally NOT use_connect: connecting forces head to parent
        # tail, which would clobber the rest position we just set.

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
    # Group weights by vertex to minimize Python->Blender calls.
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

    # ----- Pose: compute LOCAL delta rotation per bone, set it on
    # pose_bone.rotation_quaternion. pose_bone.location stays at 0 so
    # the bone chain's world positions come from forward kinematics
    # (rest link offsets + cumulative local rotations). Using
    # pose_bone.matrix = world_matrix instead produced huge
    # pose_bone.location values in our output — the Blender exporter
    # would bake those offsets into the animation, destroying the rig.
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode='POSE')

    posed_rots_bl = [mhr_to_blender_rot(r) for r in data["posed_joint_rots"]]
    # rest_rots already computed above; reuse.

    from mathutils import Quaternion
    identity_rot = Matrix.Identity(3)
    for j in range(num_joints):
        pbone = arm_obj.pose.bones.get(names[j])
        if pbone is None:
            continue
        R_rest_j = rest_rots[j]
        R_posed_j = posed_rots_bl[j]
        p = parents[j]
        if p < 0:
            # Root: local delta = R_rest_j^T @ R_posed_j
            delta = R_rest_j.transposed() @ R_posed_j
        else:
            R_rest_p = rest_rots[p]
            R_posed_p = posed_rots_bl[p]
            # Derivation:
            #   bone_world_posed = parent_world_posed
            #                       @ (R_rest_p^-1 @ R_rest_j)   ← rest link
            #                       @ pose_delta
            #   => pose_delta = (R_rest_j^-1 @ R_rest_p)
            #                   @ (R_posed_p^-1 @ R_posed_j)
            delta = (
                R_rest_j.transposed() @ R_rest_p
                @ R_posed_p.transposed() @ R_posed_j
            )
        pbone.rotation_quaternion = delta.to_quaternion()
        pbone.rotation_mode = 'QUATERNION'
        pbone.location = (0.0, 0.0, 0.0)
        pbone.scale = (1.0, 1.0, 1.0)

    # Keyframe the posed state at BOTH frame 1 and frame _ANIM_LAST so
    # the exported clip has a non-zero duration — Unity (and other DCCs)
    # treat zero-length clips as empty. We write the same pose on both
    # keys, so the result is a 1-second "static pose" animation.
    _ANIM_LAST = 30
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = _ANIM_LAST
    scene.frame_current = 1
    for pbone in arm_obj.pose.bones:
        for frame in (1, _ANIM_LAST):
            pbone.keyframe_insert(data_path="location",            frame=frame)
            pbone.keyframe_insert(data_path="rotation_quaternion", frame=frame)
            pbone.keyframe_insert(data_path="scale",               frame=frame)

    bpy.ops.object.mode_set(mode='OBJECT')

    # ----- FBX export -----
    bpy.ops.object.select_all(action='DESELECT')
    arm_obj.select_set(True)
    mesh_obj.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    # NOTE: We build everything in Blender's internal coord system (Z-up)
    # using the mhr_to_blender_vec / mhr_to_blender_rot conversions
    # above. The export writes the file with `axis_forward="-Z",
    # axis_up="Y"` so that the *file on disk* lands in the classic
    # Y-up / -Z-forward FBX convention that Unity/UE expect.
    # bake_space_transform is left OFF: mixing that flag with explicit
    # axis_forward/up has, in this pipeline, led to doubled-up axis
    # swaps. Letting the exporter transform on the fly is correct here.
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
    print(f"[build_rigged_fbx] Wrote {output_path}")


if __name__ == "__main__":
    main()
