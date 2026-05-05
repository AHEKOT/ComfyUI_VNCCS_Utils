"""One-off blend-shape key renamer for all_parts_bs.fbx.

Applies a fixed rename map to the shape keys of every mesh in the FBX
and saves the file in place. Safe to re-run — renames only keys that
still have the old name.

Run under Blender (headless):

    "C:/Program Files/Blender Foundation/Blender 4.1/blender.exe" ^
        --background --python tools/rename_blendshape_keys.py

After running this, also run `tools/extract_face_blendshapes.py` to
refresh `presets/face_blendshapes.npz`.
"""

import sys
from pathlib import Path

try:
    import bpy
except ImportError:
    print("ERROR: this script must run under Blender (bpy unavailable)")
    sys.exit(1)


HERE = Path(__file__).resolve().parent
FBX_PATH = HERE / "bone_backup" / "all_parts_bs.fbx"

# Blender UI renames: old shape-key name -> new.
RENAMES = {
    "face_wide": "face_mangabig",
}


def main():
    if not FBX_PATH.exists():
        print(f"ERROR: FBX not found: {FBX_PATH}")
        sys.exit(1)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    print(f"Importing {FBX_PATH}")
    bpy.ops.import_scene.fbx(filepath=str(FBX_PATH))

    total = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH" or obj.data.shape_keys is None:
            continue
        for kb in obj.data.shape_keys.key_blocks:
            if kb.name in RENAMES:
                new = RENAMES[kb.name]
                # Guard against a target name already taken.
                existing = {k.name for k in obj.data.shape_keys.key_blocks}
                if new in existing:
                    print(f"  WARN {obj.name}: '{new}' already exists; "
                          f"skipping rename of '{kb.name}'")
                    continue
                print(f"  {obj.name}: {kb.name} -> {new}")
                kb.name = new
                total += 1
    print(f"Total shape keys renamed: {total}")

    # Match the export settings documented in README.md for
    # all_parts_bs.fbx: scale 1.0, -Z forward, Y up, bake transforms.
    bpy.ops.export_scene.fbx(
        filepath=str(FBX_PATH),
        use_selection=False,
        object_types={"ARMATURE", "MESH"},
        axis_forward="-Z",
        axis_up="Y",
        global_scale=1.0,
        apply_unit_scale=True,
        bake_space_transform=True,
        add_leaf_bones=False,
        bake_anim=True,
    )
    print(f"Wrote {FBX_PATH}")


if __name__ == "__main__":
    main()
