"""Rebuild per-object vertex JSONs from the FBX-derived base positions.

Reads `all_base__<obj>` entries from presets/face_blendshapes.npz (saved by
extract_face_blendshapes.py), loads the MHR rest pose, and for each object
nearest-neighbour matches the FBX world-space base positions to MHR rest
vertices. For every MHR vertex that lies in exactly one object's region
(decided by majority-vote when boundary duplicates collide), writes the
MHR vertex index into `presets/<obj>_vertices.json`.

This gives a FBX-authoritative partition: whenever the FBX topology or
object naming changes, regenerate the npz in Blender then run this script
to refresh the region JSONs.

Usage (from ComfyUI root):

    .venv/Scripts/python.exe custom_nodes/ComfyUI-SAM3DBody_utills/tools/rebuild_vertex_jsons.py
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch


HERE = Path(__file__).resolve().parent
NODE_ROOT = HERE.parent
COMFYUI_ROOT = NODE_ROOT.parent.parent
sys.path.insert(0, str(COMFYUI_ROOT))
sys.path.insert(0, str(NODE_ROOT))


def _active_pack_dir() -> Path:
    """Read active_preset.ini (stdlib only) to find the active pack."""
    import configparser
    ini = NODE_ROOT / "active_preset.ini"
    name = "default"
    if ini.exists():
        try:
            cp = configparser.ConfigParser()
            cp.read(ini, encoding="utf-8")
            name = cp.get("active", "pack", fallback="default").strip() or "default"
        except Exception:
            pass
    pack_dir = NODE_ROOT / "presets" / name
    if not pack_dir.is_dir():
        pack_dir = NODE_ROOT / "presets" / "default"
    return pack_dir


def main():
    pack_dir = _active_pack_dir()
    ap = argparse.ArgumentParser()
    ap.add_argument("--npz", default=str(pack_dir / "face_blendshapes.npz"))
    ap.add_argument("--out", default=str(pack_dir))
    ap.add_argument("--ckpt", default="C:/ComfyUI/models/sam3dbody/model.ckpt")
    ap.add_argument("--mhr",  default="C:/ComfyUI/models/sam3dbody/assets/mhr_model.pt")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()

    npz_path = Path(args.npz)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not npz_path.exists():
        print(f"ERROR: npz not found: {npz_path}")
        print("Run tools/extract_face_blendshapes.py in Blender first.")
        sys.exit(1)

    # --- Rotation from FBX world frame to MHR world frame (mirror of the
    #     _FBX_TO_MHR_ROT constant in process.py) ---
    R = np.array(
        [[1.0,  0.0, 0.0],
         [0.0,  0.0, 1.0],
         [0.0, -1.0, 0.0]],
        dtype=np.float32,
    )

    # --- Load MHR rest-pose verts ---
    from nodes.sam_3d_body.build_models import load_sam_3d_body
    print(f"Loading MHR rest pose (ckpt={args.ckpt})")
    model, _, _ = load_sam_3d_body(
        checkpoint_path=args.ckpt, device=args.device, mhr_path=args.mhr,
    )
    head = model.head_pose
    d = torch.device(args.device)
    zeros3 = torch.zeros((1, 3), dtype=torch.float32, device=d)
    body_p = torch.zeros((1, 133), dtype=torch.float32, device=d)
    hand_p = torch.zeros((1, 108), dtype=torch.float32, device=d)
    scale  = torch.zeros((1, head.num_scale_comps), dtype=torch.float32, device=d)
    shape  = torch.zeros((1, head.num_shape_comps), dtype=torch.float32, device=d)
    expr   = torch.zeros((1, head.num_face_comps), dtype=torch.float32, device=d)
    with torch.no_grad():
        verts = head.mhr_forward(zeros3, zeros3, body_p, hand_p, scale, shape, expr)[0]
    mhr_verts = verts.detach().cpu().numpy()
    if mhr_verts.ndim == 3:
        mhr_verts = mhr_verts[0]
    V = mhr_verts.shape[0]
    print(f"MHR rest-pose verts: V={V}")

    # --- Parse npz ---
    npz = np.load(npz_path)
    if "meta_all_objects" not in npz.files:
        print("ERROR: npz missing 'meta_all_objects'. Regenerate with the "
              "updated extract_face_blendshapes.py first.")
        sys.exit(1)
    object_names = [str(x) for x in np.asarray(npz["meta_all_objects"])]
    print(f"FBX objects: {object_names}")

    # --- For each MHR vertex, find the nearest FBX object's vertex ---
    # Collect all (fbx_world_rotated_pos, object_name) pairs, NN to MHR
    all_positions = []
    all_object_ids = []
    name_to_id = {n: i for i, n in enumerate(object_names)}
    for obj_name in object_names:
        key = f"all_base__{obj_name}"
        if key not in npz.files:
            print(f"  [warn] no base data for '{obj_name}'")
            continue
        pos_fbx = np.asarray(npz[key], dtype=np.float32)
        pos_mhr = pos_fbx @ R.T
        all_positions.append(pos_mhr)
        all_object_ids.append(np.full(len(pos_mhr), name_to_id[obj_name], dtype=np.int32))
    all_positions = np.concatenate(all_positions, axis=0)
    all_object_ids = np.concatenate(all_object_ids, axis=0)
    print(f"Total FBX vertices across objects: {len(all_positions)}")

    try:
        from scipy.spatial import cKDTree
        tree = cKDTree(all_positions)
        dists, nn_idx = tree.query(mhr_verts, k=1)
    except Exception:
        print("scipy missing; using brute-force NN (slow)")
        dists = np.zeros(V, dtype=np.float32)
        nn_idx = np.zeros(V, dtype=np.int64)
        for i, p in enumerate(mhr_verts):
            d2 = ((all_positions - p) ** 2).sum(axis=1)
            j = int(d2.argmin())
            dists[i] = float(np.sqrt(d2[j]))
            nn_idx[i] = j
    print(f"NN dist: max={dists.max():.6f}  mean={dists.mean():.6f}")

    # --- Partition MHR vertices per object ---
    mhr_object_id = all_object_ids[nn_idx]
    # For each MHR vertex, resolve ties (multiple objects share a position
    # at seams) via the first encountered — cKDTree already picked one,
    # which is deterministic.
    region_ids = {obj: [] for obj in object_names}
    for v, oid in enumerate(mhr_object_id):
        region_ids[object_names[int(oid)]].append(int(v))

    # --- Delete stale <obj>_vertices.json files that no longer correspond
    # --- to an FBX object (partition rename / removal). Keeps presets/
    # --- synchronized with the current FBX structure.
    expected_names = {f"{n}_vertices.json" for n in object_names}
    stale = []
    for fp in out_dir.glob("*_vertices.json"):
        if fp.name not in expected_names:
            stale.append(fp)
    for fp in stale:
        print(f"  [cleanup] removing stale {fp.name}")
        fp.unlink()

    # --- Write per-object JSONs ---
    total = 0
    for obj_name in object_names:
        idxs = sorted(region_ids[obj_name])
        path = out_dir / f"{obj_name}_vertices.json"
        path.write_text(json.dumps(idxs, ensure_ascii=False), encoding="utf-8")
        total += len(idxs)
        print(f"  {obj_name:<20s} -> {len(idxs):5d} verts  ({path})")
    print(f"\nTotal MHR vertices assigned: {total} / {V}")
    if stale:
        print(f"Removed {len(stale)} stale JSON(s) from earlier partition.")


if __name__ == "__main__":
    main()
