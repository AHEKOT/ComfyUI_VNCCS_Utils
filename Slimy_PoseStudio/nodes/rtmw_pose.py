import json
import numpy as np
from PIL import Image, ImageDraw
import torch

# ── Colors (3D viewer palette) ────────────────────────────────────────────────

_C = {
    'body':  (204, 204, 204),
    'left':  ( 68, 136, 255),
    'right': (255,  68,  68),
    'face':  (255, 221,   0),
    'feet':  (255, 136,   0),
    'lhand': (102, 187, 255),
    'rhand': (255, 102, 102),
}

# ── Keypoint names (133pt COCO-Wholebody) ─────────────────────────────────────

_BODY_NAMES = [
    "nose","left_eye","right_eye","left_ear","right_ear",
    "left_shoulder","right_shoulder","left_elbow","right_elbow",
    "left_wrist","right_wrist","left_hip","right_hip",
    "left_knee","right_knee","left_ankle","right_ankle",
]
_FEET_NAMES = [
    "left_big_toe","left_small_toe","left_heel",
    "right_big_toe","right_small_toe","right_heel",
]
_FACE_NAMES = [f"face_{i}" for i in range(68)]
_LH_NAMES = [
    "lh_wrist",
    "lh_thumb_cmc","lh_thumb_mcp","lh_thumb_ip","lh_thumb_tip",
    "lh_index_mcp","lh_index_pip","lh_index_dip","lh_index_tip",
    "lh_middle_mcp","lh_middle_pip","lh_middle_dip","lh_middle_tip",
    "lh_ring_mcp","lh_ring_pip","lh_ring_dip","lh_ring_tip",
    "lh_pinky_mcp","lh_pinky_pip","lh_pinky_dip","lh_pinky_tip",
]
_RH_NAMES = [n.replace("lh_", "rh_") for n in _LH_NAMES]
KEYPOINT_NAMES = _BODY_NAMES + _FEET_NAMES + _FACE_NAMES + _LH_NAMES + _RH_NAMES
assert len(KEYPOINT_NAMES) == 133

# ── Skeleton connections ──────────────────────────────────────────────────────

_BODY_CONNS = [
    (0, 1,'body'),(0, 2,'body'),(1, 3,'left'),(2, 4,'right'),
    (5, 6,'body'),
    (5, 7,'left'),(7, 9,'left'),
    (6, 8,'right'),(8,10,'right'),
    (5,11,'left'),(6,12,'right'),(11,12,'body'),
    (11,13,'left'),(13,15,'left'),
    (12,14,'right'),(14,16,'right'),
]

_FEET_CONNS = [
    (15,17,'left'),(15,18,'left'),(17,19,'feet'),(18,19,'feet'),
    (16,20,'right'),(16,21,'right'),(20,22,'feet'),(21,22,'feet'),
]

_LHAND_CONNS = (
    [(9, 91,'lhand')] +
    [(91+i, 92+i,'lhand') for i in range(4)] +
    [(91, 96,'lhand')] + [(96+i, 97+i,'lhand') for i in range(3)] +
    [(91,100,'lhand')] + [(100+i,101+i,'lhand') for i in range(3)] +
    [(91,104,'lhand')] + [(104+i,105+i,'lhand') for i in range(3)] +
    [(91,108,'lhand')] + [(108+i,109+i,'lhand') for i in range(3)]
)

_RHAND_CONNS = (
    [(10,112,'rhand')] +
    [(112+i,113+i,'rhand') for i in range(4)] +
    [(112,117,'rhand')] + [(117+i,118+i,'rhand') for i in range(3)] +
    [(112,121,'rhand')] + [(121+i,122+i,'rhand') for i in range(3)] +
    [(112,125,'rhand')] + [(125+i,126+i,'rhand') for i in range(3)] +
    [(112,129,'rhand')] + [(129+i,130+i,'rhand') for i in range(3)]
)

def _face_connections():
    c = []
    for i in range(16): c.append((23+i, 24+i,'face'))
    for i in range(4):  c.append((40+i, 41+i,'face'))
    for i in range(4):  c.append((45+i, 46+i,'face'))
    for i in range(3):  c.append((50+i, 51+i,'face'))
    for i in range(4):  c.append((54+i, 55+i,'face'))
    c.append((53, 56,'face'))
    for i in range(5):  c.append((59+i, 60+i,'face'))
    c.append((64, 59,'face'))
    for i in range(5):  c.append((65+i, 66+i,'face'))
    c.append((70, 65,'face'))
    for i in range(11): c.append((71+i, 72+i,'face'))
    c.append((82, 71,'face'))
    for i in range(7):  c.append((83+i, 84+i,'face'))
    c.append((90, 83,'face'))
    return c

_FACE_CONNS = _face_connections()

def _joint_color(i):
    if   i in (1,3,5,7,9,11,13,15,17,18,19):  return 'left'
    elif i in (2,4,6,8,10,12,14,16,20,21,22): return 'right'
    elif 23 <= i <= 90:                         return 'face'
    elif 91 <= i <= 111:                        return 'lhand'
    elif 112 <= i <= 132:                       return 'rhand'
    return 'body'

# ── Model cache ───────────────────────────────────────────────────────────────

_detector_cache: dict = {}

def _get_detector(device: str):
    if device not in _detector_cache:
        from rtmlib import Wholebody3d
        print(f"[Slimy_RTMWPose] Loading Wholebody3d on {device} …")
        _detector_cache[device] = Wholebody3d(backend="onnxruntime", device=device)
        print("[Slimy_RTMWPose] Model ready.")
    return _detector_cache[device]

# ── Drawing ───────────────────────────────────────────────────────────────────

def _draw_persons(canvas, persons, draw_face, draw_hands, draw_feet):
    W, H = canvas.size
    draw = ImageDraw.Draw(canvas)
    lw = max(2, min(W, H) // 200)
    jr = max(3, min(W, H) // 150)

    for person in persons:
        kpts = person['keypoints']

        def pt(i):
            if i < len(kpts) and kpts[i].get('valid', False):
                return (int(round(kpts[i]['px'])), int(round(kpts[i]['py'])))
            return None

        conns = list(_BODY_CONNS)
        if draw_feet:  conns += _FEET_CONNS
        if draw_hands: conns += _LHAND_CONNS + _RHAND_CONNS
        if draw_face:  conns += _FACE_CONNS

        for a, b, ck in conns:
            pa, pb = pt(a), pt(b)
            if pa and pb:
                draw.line([pa, pb], fill=_C[ck], width=lw)

        ranges = list(range(17))
        if draw_feet:  ranges += list(range(17, 23))
        if draw_face:  ranges += list(range(23, 91))
        if draw_hands: ranges += list(range(91, 133))

        for i in ranges:
            p = pt(i)
            if p:
                x, y = p
                c = _C[_joint_color(i)]
                draw.ellipse([x - jr, y - jr, x + jr, y + jr], fill=c)

# ── Node ──────────────────────────────────────────────────────────────────────

class VNCCS_RTMWPose:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image":           ("IMAGE",),
                "device":          (["cuda", "cpu"],),
                "score_threshold": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.05}),
                "draw_face":       ("BOOLEAN", {"default": True}),
                "draw_hands":      ("BOOLEAN", {"default": True}),
                "draw_feet":       ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES  = ("IMAGE", "IMAGE")
    RETURN_NAMES  = ("pose_image", "skeleton_only")
    FUNCTION      = "detect_and_draw"
    CATEGORY      = "Slimy/Pose"
    OUTPUT_NODE   = True

    def detect_and_draw(self, image, device, score_threshold,
                        draw_face, draw_hands, draw_feet):
        img_np  = (image[0].cpu().numpy() * 255).astype(np.uint8)
        img_bgr = img_np[:, :, ::-1].copy()
        H, W    = img_bgr.shape[:2]

        detector = _get_detector(device)
        keypoints, scores, _, keypoints_2d = detector(img_bgr)

        persons = []
        for pid in range(len(keypoints)):
            kpts_3d = keypoints[pid]
            scrs    = scores[pid]
            kp2d    = keypoints_2d[pid]
            persons.append({"id": pid, "keypoints": [
                {
                    "id":    kid,
                    "name":  KEYPOINT_NAMES[kid],
                    "x":     round(float(kpts_3d[kid, 0]), 4),
                    "y":     round(float(kpts_3d[kid, 1]), 4),
                    "z":     round(float(kpts_3d[kid, 2]), 4),
                    "px":    round(float(kp2d[kid, 0]), 2),
                    "py":    round(float(kp2d[kid, 1]), 2),
                    "score": round(float(scrs[kid]), 4),
                    "valid": float(scrs[kid]) >= score_threshold,
                }
                for kid in range(133)
            ]})

        json_str = json.dumps(
            {"width": W, "height": H, "model": "rtmw3d-x", "persons": persons},
            ensure_ascii=False, indent=2
        )
        print(f"[Slimy_RTMWPose] {len(persons)} person(s) detected.")

        canvas = Image.fromarray(img_np).convert("RGB")
        _draw_persons(canvas, persons, draw_face, draw_hands, draw_feet)

        skeleton = Image.new("RGB", (W, H), (0, 0, 0))
        _draw_persons(skeleton, persons, draw_face, draw_hands, draw_feet)

        return {
            "ui": {"text": [json_str]},
            "result": (self._to_tensor(canvas), self._to_tensor(skeleton)),
        }

    @staticmethod
    def _to_tensor(img: Image.Image):
        arr = np.array(img.convert("RGB")).astype(np.float32) / 255.0
        return torch.from_numpy(arr).unsqueeze(0)
