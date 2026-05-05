"""Extract per-object blend-shape deltas from an FBX into a numpy .npz.

Scans EVERY mesh object in the FBX. For each object that owns at least one of
the named shape keys, emits:
  - base__<obj>             : (N_obj, 3) basis vertex positions
  - delta__<obj>__<shape>   : (N_obj, 3) delta (target - basis) for that shape
Also emits metadata arrays:
  - meta_objects            : object names that contributed data
  - meta_shapes             : union of shape names found

Every non-Basis shape key found on any mesh object is extracted (no hard
allowlist). Runtime reads `meta_shapes` from the npz and exposes each as a
UI slider, so adding a new shape key in Blender and re-running extraction
is enough to surface it in the node.

Run under Blender (headless):

    "C:/Program Files/Blender Foundation/Blender 4.1/blender.exe" ^
        --background --python tools/extract_face_blendshapes.py

Input : tools/bone_backup/all_parts_bs.fbx
Output: presets/face_blendshapes.npz
"""

import sys
from pathlib import Path

try:
    import bpy
except ImportError:
    print("ERROR: this script must run under Blender (bpy unavailable)")
    sys.exit(1)

import numpy as np  # type: ignore  (Blender ships numpy)


# Shape key names sometimes carry trailing / leading whitespace or common
# typos picked up from Blender UI editing. Normalize on the way out so the
# npz is always clean. Extend this dict when new typos surface.
SHAPE_NAME_ALIASES = {
    "houlder_slope": "shoulder_slope",
}


def _normalize_shape_name(raw: str) -> str:
    s = raw.strip()
    return SHAPE_NAME_ALIASES.get(s, s)


HERE = Path(__file__).resolve().parent
NODE_ROOT = HERE.parent
FBX_PATH = HERE / "bone_backup" / "all_parts_bs.fbx"


def _resolve_active_pack_dir() -> Path:
    """Read active_preset.ini to find the active preset pack. Blender's
    bundled Python can't import our `nodes.preset_pack` module (no
    package context when called via --python), so we re-parse the ini
    here with only stdlib."""
    import configparser
    ini = NODE_ROOT / "active_preset.ini"
    name = "default"
    if ini.exists():
        try:
            cp = configparser.ConfigParser()
            cp.read(ini, encoding="utf-8")
            name = cp.get("active", "pack", fallback="default").strip() or "default"
        except Exception as exc:
            print(f"[extract_face_blendshapes] active_preset.ini parse "
                  f"failed: {exc}; using 'default'")
    pack_dir = NODE_ROOT / "presets" / name
    if not pack_dir.is_dir():
        pack_dir = NODE_ROOT / "presets" / "default"
        pack_dir.mkdir(parents=True, exist_ok=True)
    return pack_dir


OUT_PATH = _resolve_active_pack_dir() / "face_blendshapes.npz"

# No hardcoded list — every non-Basis shape key on any mesh object is exported.


def _read_coords_world(key_block, obj):
    """Return shape-key positions in WORLD space. Each FBX object has its
    own matrix_world (translation + rotation + scale), so reading raw
    `key_block.data[i].co` would give object-local coords that differ
    between objects. Multiplying by matrix_world puts every object into a
    common world frame, which our downstream NN matching assumes.
    """
    mw = obj.matrix_world
    n = len(key_block.data)
    arr = np.zeros((n, 3), dtype=np.float32)
    for i, p in enumerate(key_block.data):
        w = mw @ p.co  # Vector in world space
        arr[i] = (w.x, w.y, w.z)
    return arr


def main():
    if not FBX_PATH.exists():
        print(f"ERROR: FBX not found: {FBX_PATH}")
        sys.exit(1)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    print(f"Importing {FBX_PATH}")
    bpy.ops.import_scene.fbx(filepath=str(FBX_PATH))

    out = {}
    objects_with_shapes = []
    all_object_names = []
    shapes_found = set()

    # Stable iteration order: sort by object name for deterministic output.
    mesh_objs = sorted(
        (o for o in bpy.data.objects if o.type == "MESH"),
        key=lambda o: o.name,
    )

    # Save world-space base positions for EVERY mesh object (even those
    # without shape keys) under `all_base__<name>`. These are used by
    # tools/rebuild_vertex_jsons.py to recreate presets/<obj>_vertices.json
    # from the FBX whenever the source OBJ changes.
    for obj in mesh_objs:
        all_object_names.append(obj.name)
        mw = obj.matrix_world
        n = len(obj.data.vertices)
        positions = np.zeros((n, 3), dtype=np.float32)
        for i, v in enumerate(obj.data.vertices):
            w = mw @ v.co
            positions[i] = (w.x, w.y, w.z)
        out[f"all_base__{obj.name}"] = positions

    for obj in mesh_objs:
        sk = obj.data.shape_keys
        if sk is None:
            print(f"  {obj.name:<20s} verts={len(obj.data.vertices):5d}  (no shape keys)")
            continue
        kb = sk.key_blocks
        # Every non-basis key counts. Blender guarantees index 0 is Basis.
        raw_names = [kb[i].name for i in range(1, len(kb))]
        if not raw_names:
            print(f"  {obj.name:<20s} verts={len(obj.data.vertices):5d}  (basis only)")
            continue

        basis = kb[0]
        base = _read_coords_world(basis, obj)
        out[f"base__{obj.name}"] = base
        objects_with_shapes.append(obj.name)

        # Build (raw_name -> normalized_name) pairs; report name changes
        # so the user can fix the source FBX if they want.
        pairs = []
        for raw in raw_names:
            norm = _normalize_shape_name(raw)
            pairs.append((raw, norm))
        print(f"  {obj.name:<20s} verts={base.shape[0]:5d}  basis='{basis.name}'  "
              f"shapes={[n for _, n in pairs]}")
        for raw, norm in pairs:
            if raw != norm:
                print(f"      [normalize] '{raw}' -> '{norm}'")

        for raw, norm in pairs:
            tgt = _read_coords_world(kb[raw], obj)
            delta = (tgt - base).astype(np.float32)
            max_disp = float(np.linalg.norm(delta, axis=1).max()) if len(delta) else 0.0
            out[f"delta__{obj.name}__{norm}"] = delta
            shapes_found.add(norm)
            print(f"      {norm:<18s} max per-vert delta = {max_disp:.5f}")

    if not objects_with_shapes:
        print("\nERROR: no mesh objects with any of the expected shape keys.")
        print(f"Expected shape names: {SHAPE_NAMES}")
        sys.exit(1)

    out["meta_objects"] = np.asarray(objects_with_shapes)
    out["meta_shapes"] = np.asarray(sorted(shapes_found))
    out["meta_all_objects"] = np.asarray(all_object_names)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(OUT_PATH, **out)
    print(f"\nWrote {OUT_PATH}")
    print(f"Objects: {objects_with_shapes}")
    print(f"Shapes : {sorted(shapes_found)}")


def _sync_downstream():
    """Propagate the just-written npz to the preset JSONs and to
    process.py's _UI_BLENDSHAPE_ORDER. Runs as a post-step of main().
    Silent if nothing changed."""
    try:
        import sys as _sys
        _sys.path.insert(0, str(HERE))
        from sync_presets_with_npz import sync_all
        sync_all()
    except Exception as exc:  # noqa: BLE001 — best-effort helper
        print(f"[extract_face_blendshapes] preset / UI sync failed "
              f"(non-fatal): {exc}")


if __name__ == "__main__":
    main()
    _sync_downstream()
