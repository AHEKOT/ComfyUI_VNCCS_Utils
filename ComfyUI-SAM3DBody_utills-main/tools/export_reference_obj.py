"""Export the MHR rest-pose mesh as a single unpartitioned OBJ.

This is the canonical reference body used by all vertex-index JSONs and
blend-shape deltas. Keep a copy around as a backup in case the partitioned
`all_parts_*.obj` / `all_parts_bs.fbx` gets broken or needs to be rebuilt
from scratch.

Usage (from ComfyUI root):

    .venv/Scripts/python.exe custom_nodes/ComfyUI-SAM3DBody_utills/tools/export_reference_obj.py

Output: tools/bone_backup/mhr_reference.obj
    - 18439 vertices (MHR rest pose, meters, Y-up)
    - 36874 triangle faces, single continuous mesh (no `o <group>` sections)
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import torch


HERE = Path(__file__).resolve().parent
NODE_ROOT = HERE.parent
COMFYUI_ROOT = NODE_ROOT.parent.parent
sys.path.insert(0, str(COMFYUI_ROOT))
sys.path.insert(0, str(NODE_ROOT))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="C:/ComfyUI/models/sam3dbody/model.ckpt")
    ap.add_argument("--mhr",  default="C:/ComfyUI/models/sam3dbody/assets/mhr_model.pt")
    ap.add_argument("--out",  default=str(HERE / "bone_backup" / "mhr_reference.obj"))
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

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
    v = verts.detach().cpu().numpy()
    if v.ndim == 3:
        v = v[0]
    f = head.faces.detach().cpu().numpy().astype(np.int64)
    V, F = v.shape[0], f.shape[0]
    print(f"V={V}  F={F}")

    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(f"# MHR rest-pose reference body (single unpartitioned mesh)\n")
        fh.write(f"# V={V}  F={F}  units=meters  up=+Y\n")
        for p in v:
            fh.write(f"v {p[0]:.6f} {p[1]:.6f} {p[2]:.6f}\n")
        for tri in f:
            fh.write(f"f {int(tri[0])+1} {int(tri[1])+1} {int(tri[2])+1}\n")

    size = out_path.stat().st_size
    print(f"\nWrote {out_path}  ({size:,} bytes)")


if __name__ == "__main__":
    main()
