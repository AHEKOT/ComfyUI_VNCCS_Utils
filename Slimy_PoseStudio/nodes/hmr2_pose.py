"""
Slimy_HMR2Pose — HMR2.0 3D pose estimator for ComfyUI (Windows + WSL2)
"""

import json
import os
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

import numpy as np
import torch
from PIL import Image as PILImage, ImageDraw


WSL_DISTRO = "Ubuntu"
WSL_PYTHON  = "/home/nori/miniconda/envs/4dhumans/bin/python"
WSL_SCRIPT  = "/home/nori/hmr2_infer.py"


def _win_to_wsl(win_path: str) -> str:
    p = Path(win_path)
    drive = p.drive
    if drive:
        letter = drive[0].lower()
        rest = str(p)[len(drive):].replace("\\", "/")
        return f"/mnt/{letter}{rest}"
    return win_path.replace("\\", "/")


def _run_wsl_infer(image_win_path: str, max_people: int) -> dict:
    image_wsl = _win_to_wsl(image_win_path)
    out_wsl   = f"/tmp/hmr2_out_{os.getpid()}.json"
    out_win   = f"\\\\wsl$\\{WSL_DISTRO}\\tmp\\hmr2_out_{os.getpid()}.json"

    cmd = [
        "wsl", "-d", WSL_DISTRO, "--",
        WSL_PYTHON, WSL_SCRIPT,
        image_wsl, out_wsl, str(max_people),
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return {"error": "WSL2 推論がタイムアウトしました（120秒）"}
    except FileNotFoundError:
        return {"error": "wsl コマンドが見つかりません。WSL2 がインストールされていますか？"}

    if result.returncode != 0:
        return {"error": f"WSL2 推論エラー:\n{result.stderr.strip()[-500:]}"}

    stdout = result.stdout.strip()
    try:
        status = json.loads(stdout.split("\n")[-1])
    except Exception:
        return {"error": f"stdout パース失敗: {stdout[-200:]}"}

    if "error" in status:
        return status

    try:
        out_path = Path(out_win)
        if not out_path.exists():
            return {"error": f"出力 JSON が見つかりません: {out_win}"}
        data = json.loads(out_path.read_text(encoding="utf-8"))
        out_path.unlink(missing_ok=True)
        return data
    except Exception as e:
        return {"error": f"JSON 読み込み失敗: {e}"}


# ── 骨格描画 ──────────────────────────────────────────────────────────────────

_C = {
    'body':  (204, 204, 204),
    'left':  ( 68, 136, 255),
    'right': (255,  68,  68),
}

# OpenPose 25ポイント順に合わせたキー（JOINT_NAMESのname）
_LEFT_NAMES  = {"left_shoulder", "left_elbow", "left_wrist", "left_hip", "left_knee", "left_ankle",
                "left_eye", "left_ear", "left_big_toe", "left_small_toe", "left_heel"}
_RIGHT_NAMES = {"right_shoulder", "right_elbow", "right_wrist", "right_hip", "right_knee", "right_ankle",
                "right_eye", "right_ear", "right_big_toe", "right_small_toe", "right_heel"}

_CONNS = [
    # 顔
    ("nose",           "right_eye",      'right'),
    ("nose",           "left_eye",       'left'),
    ("right_eye",      "right_ear",      'right'),
    ("left_eye",       "left_ear",       'left'),
    # 首
    ("nose",           "neck",           'body'),
    # 肩
    ("neck",           "right_shoulder", 'right'),
    ("neck",           "left_shoulder",  'left'),
    # 右腕
    ("right_shoulder", "right_elbow",    'right'),
    ("right_elbow",    "right_wrist",    'right'),
    # 左腕
    ("left_shoulder",  "left_elbow",     'left'),
    ("left_elbow",     "left_wrist",     'left'),
    # 胴体
    ("neck",           "pelvis",         'body'),
    ("right_shoulder", "right_hip",      'right'),
    ("left_shoulder",  "left_hip",       'left'),
    # 腰
    ("pelvis",         "right_hip",      'right'),
    ("pelvis",         "left_hip",       'left'),
    # 右脚
    ("right_hip",      "right_knee",     'right'),
    ("right_knee",     "right_ankle",    'right'),
    # 左脚
    ("left_hip",       "left_knee",      'left'),
    ("left_knee",      "left_ankle",     'left'),
]


def _get_pts(person: dict, W: int, H: int) -> dict:
    """keypoints_2d_norm [0,1] → ピクセル座標"""
    pts = {}
    kp2d = person.get("keypoints_2d_norm", {})
    for name, (nx, ny) in kp2d.items():
        pts[name] = (nx * W, ny * H)
    return pts


def _draw_skeleton(canvas: PILImage.Image, person: dict, W: int, H: int):
    draw = ImageDraw.Draw(canvas)
    lw   = max(2, min(W, H) // 200)
    jr   = max(3, min(W, H) // 150)

    pts = _get_pts(person, W, H)

    for a, b, ck in _CONNS:
        if a in pts and b in pts:
            ax, ay = pts[a]
            bx, by = pts[b]
            # 両端が画像内にある場合のみ描画
            if 0 <= ax < W and 0 <= ay < H and 0 <= bx < W and 0 <= by < H:
                draw.line([pts[a], pts[b]], fill=_C[ck], width=lw)

    for name, pt in pts.items():
        x, y = pt
        if not (0 <= x < W and 0 <= y < H):
            continue
        color = _C['left'] if name in _LEFT_NAMES else \
                _C['right'] if name in _RIGHT_NAMES else _C['body']
        draw.ellipse([x - jr, y - jr, x + jr, y + jr], fill=color)


def _to_tensor(img: PILImage.Image) -> torch.Tensor:
    arr = np.array(img.convert("RGB")).astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


class VNCCS_HMR2Pose:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image":           ("IMAGE",),
                "person_index":    ("STRING", {"default": "0"}),
                "output_filename": ("STRING", {"default": "hmr2_pose3d"}),
            }
        }

    RETURN_TYPES  = ("IMAGE", "IMAGE", "STRING")
    RETURN_NAMES  = ("pose_image", "skeleton_only", "pose_json")
    FUNCTION      = "estimate"
    CATEGORY      = "Slimy/Pose"
    OUTPUT_NODE   = True

    def estimate(self, image, person_index, output_filename):

        img_np = (image[0].cpu().numpy() * 255).astype(np.uint8)
        H, W   = img_np.shape[:2]

        # person_index から max_people を自動計算
        indices = [int(i.strip()) for i in person_index.split(",") if i.strip().isdigit()]
        if all(i == 0 for i in indices):
            max_people = 10  # 0=全員なので上限値で推論
        else:
            max_people = max(i for i in indices if i > 0)

        try:
            import folder_paths
            tmp_dir = Path(folder_paths.get_temp_directory())
            out_dir = Path(folder_paths.get_output_directory()) / "pose3d"
        except Exception:
            tmp_dir = Path(tempfile.gettempdir())
            out_dir = tmp_dir / "pose3d"

        tmp_dir.mkdir(parents=True, exist_ok=True)
        out_dir.mkdir(parents=True, exist_ok=True)

        tmp_img = tmp_dir / f"hmr2_input_{os.getpid()}.png"
        try:
            PILImage.fromarray(img_np).save(str(tmp_img))
        except Exception as e:
            return self._err(image, f"画像の一時保存に失敗: {e}")

        try:
            data = _run_wsl_infer(str(tmp_img), max_people)
        finally:
            tmp_img.unlink(missing_ok=True)

        if "error" in data:
            return self._err(image, data["error"])

        pil_orig     = PILImage.fromarray(img_np).convert("RGB")
        pil_skeleton = PILImage.new("RGB", (W, H), (0, 0, 0))

        people = data.get("people", [])

        # person_index: 0=全員、1始まりで番号指定（カンマ区切り複数可）
        if not all(i == 0 for i in indices):
            selected = [people[i - 1] for i in indices if i > 0 and i <= len(people)]
            people = selected

        for person in people:
            _draw_skeleton(pil_orig,     person, W, H)
            _draw_skeleton(pil_skeleton, person, W, H)

        # JSON は選択した人物分のみ出力
        out_data = {**data, "people": people}
        json_str = json.dumps(out_data, ensure_ascii=False, indent=2)
        ts        = datetime.now().strftime("%Y%m%d_%H%M%S")
        out_path  = out_dir / f"{output_filename}_{ts}.json"
        out_path.write_text(json_str, encoding="utf-8")

        n = len(data.get("people", []))
        print(f"[Slimy_HMR2] {n} 人検出。保存先 → {out_path}")

        return {
            "ui":     {"text": [json_str]},
            "result": (_to_tensor(pil_orig), _to_tensor(pil_skeleton), json_str),
        }

    @staticmethod
    def _err(image, msg: str):
        print(f"[Slimy_HMR2] ERROR: {msg}")
        err_json = json.dumps({"error": msg, "people": []}, ensure_ascii=False)
        B, H, W, C = image.shape
        black = torch.zeros(1, H, W, C)
        return {"ui": {"text": [err_json]}, "result": (image, black, err_json)}
