"""
Slimy_MeTRAbs3DPose — MeTRAbs absolute-3D pose estimator for ComfyUI

Model placement:
    ComfyUI/models/metrabs/<folder>/
        ckpt.pt                    ← checkpoint (state dict)
        config.yaml
        joint_info.npz
        skeleton_infos.pkl
        joint_transform_matrix.npy

Auto-download (set download_if_missing=True):
    Fetches tar.gz directly from omnomnom.vision.rwth-aachen.de.

metrabs_pytorch dependency:
    Installed automatically on first run via pip from GitHub.
    Requires git in PATH. Manual install order:
        pip install git+https://github.com/isarandi/simplepyutils.git
        pip install git+https://github.com/isarandi/cameralib.git
        pip install git+https://github.com/isarandi/posepile.git
        pip install git+https://github.com/isarandi/metrabs.git
"""

import json
import os
import subprocess
import sys
import tarfile
import traceback
import urllib.request
from datetime import datetime
from pathlib import Path

import numpy as np
import torch

# ── Constants ──────────────────────────────────────────────────────────────────

_MODEL_MARKER      = "ckpt.pt"   # checkpoint style (current download)
_TORCHSCRIPT_MARKER = "model.pt"  # TorchScript style (legacy)

_BASE_URL = "https://omnomnom.vision.rwth-aachen.de/data/metrabs"

_DOWNLOADABLE: dict[str, dict] = {
    "[↓ large ~440MB] metrabs_eff2l_384px": {
        "url":             f"{_BASE_URL}/metrabs_eff2l_384px_800k_28ds_pytorch.tar.gz",
        "expected_folder": "metrabs_eff2l_384px_800k_28ds_pytorch",
    },
    "[↓ small ~95MB] metrabs_eff2s_256px": {
        "url":             f"{_BASE_URL}/metrabs_eff2s_256px_800k_28ds_pytorch.tar.gz",
        "expected_folder": "metrabs_eff2s_256px_800k_28ds_pytorch",
    },
}

# ── Paths ──────────────────────────────────────────────────────────────────────

def _metrabs_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "models" / "metrabs"


def _scan_installed(base: Path) -> list[str]:
    if not base.exists():
        return []
    return sorted(
        sub.name for sub in base.iterdir()
        if sub.is_dir() and (
            (sub / _MODEL_MARKER).exists() or (sub / _TORCHSCRIPT_MARKER).exists()
        )
    )


def _list_model_choices() -> list[str]:
    installed = _scan_installed(_metrabs_dir())
    dl_keys   = list(_DOWNLOADABLE.keys())
    return (installed + dl_keys) if installed else dl_keys


# ── Vendor infrastructure (no pip / no git needed) ────────────────────────────

# metrabs source is extracted here so sys.path picks it up across restarts
_VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor"


def _restore_vendor_paths() -> None:
    """Re-add already-extracted vendor packages to sys.path (called at import time)."""
    if not _VENDOR_DIR.exists():
        return
    for d in _VENDOR_DIR.iterdir():
        if d.is_dir() and (d / "metrabs_pytorch").is_dir():
            if str(d) not in sys.path:
                sys.path.insert(0, str(d))

_restore_vendor_paths()   # runs once when ComfyUI loads this module


def _inject_helper_stubs() -> None:
    """
    simplepyutils / cameralib / posepile は pip でインストール済みのため stub 不要。
    残るのは:
      - poseviz / xtcocotools 等 metrabs が任意でインポートする不要パッケージ
      - ultralytics (YOLO) — ComfyUI 環境で COCO スキャンを起こすため stub
      - person_detector  — estimate_poses() は detector を呼ばないので NullDetector
    """
    import types
    import importlib.abc
    import importlib.machinery

    # catch-all: これらの名前空間の任意 sub-module を空 stub で受け流す
    _STUB_ROOTS = {
        # posepile data-loading deps we don't need
        "barecat", "rlemasklib", "deflatedict", "bodycompress", "bvhtoolbox",
        "cameravision", "ezc3d", "humcentr_cli", "lz4", "mathutils",
        "metrabs_tf", "poseviz", "pyransac3d", "renderer_pyrd",
        "smpl", "smplfitter", "smplx", "spacepy", "tensorflow_inputs",
        "aspset510", "bpy", "cachetools", "spu",
        # metrabs optional deps
        "xtcocotools", "transforms3d", "trimesh",
        # YOLO — triggers COCO dataset scan in ComfyUI environment
        "ultralytics",
    }

    _already = any(getattr(f, "_is_slimy_stub_finder", False) for f in sys.meta_path)
    if not _already:

        class _StubFinderClass(importlib.abc.MetaPathFinder):
            _is_slimy_stub_finder = True

            def find_spec(self, fullname, path, target=None):
                if fullname.split(".")[0] in _STUB_ROOTS:
                    if fullname not in sys.modules:
                        return importlib.machinery.ModuleSpec(
                            fullname, _StubLoader(), is_package=True
                        )
                return None

        class _StubLoader(importlib.abc.Loader):
            def create_module(self, spec): return None
            def exec_module(self, module): module.__path__ = []

        sys.meta_path.append(_StubFinderClass())

    # ── posepile.paths / posepile.datasets3d ──────────────────────────────────
    # posepile/paths.py は DATA_ROOT 環境変数がなければ module load 時に KeyError。
    # sys.modules stub より先に環境変数を設定するのが確実。
    import os as _os
    _os.environ.setdefault("DATA_ROOT", "")

    # util.py は `import posepile.datasets3d as ds3d` をトップレベルで持つ。
    # 実モジュールは tensorflow/datasets を必要とするので空 stub にする。
    import types as _types
    for _mod in ("posepile.datasets3d", "posepile.datasets2d",
                 "posepile.pose3d_dataset", "posepile.dataset"):
        if _mod not in sys.modules:
            _m = _types.ModuleType(_mod); _m.__path__ = []
            sys.modules[_mod] = _m

    # ── person_detector ───────────────────────────────────────────────────────
    # ultralytics.YOLO は ComfyUI 環境で COCO データセットスキャンを起こしてハング。
    # estimate_poses() は self.detector を呼ばないので NullDetector で十分。
    if "metrabs_pytorch.multiperson.person_detector" not in sys.modules:
        import torch as _torch
        _pd = types.ModuleType("metrabs_pytorch.multiperson.person_detector")
        _pd.__path__ = []

        class _NullDetector(_torch.nn.Module):
            def __init__(self): super().__init__()
            def forward(self, *a, **kw): return []

        _pd.PersonDetector = _NullDetector
        _pd.scale_boxes    = lambda *a, **kw: None
        sys.modules["metrabs_pytorch.multiperson.person_detector"] = _pd


def _fetch_metrabs_zip() -> str | None:
    """
    Download metrabs source zip and add metrabs_pytorch to sys.path.
    Returns None on success, or an error string describing what failed.
    """
    import ssl, zipfile

    try:
        import metrabs_pytorch; return None  # noqa: F401,E702
    except ImportError:
        pass

    # Already extracted from a previous run?
    if _VENDOR_DIR.exists():
        for d in _VENDOR_DIR.iterdir():
            if d.is_dir() and (d / "metrabs_pytorch").is_dir():
                if str(d) not in sys.path:
                    sys.path.insert(0, str(d))
                try:
                    import metrabs_pytorch; return None  # noqa: F401,E702
                except ImportError as e:
                    return f"Vendor dir exists but import failed: {e}"

    _VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    url = "https://github.com/isarandi/metrabs/archive/refs/heads/master.zip"
    tmp = _VENDOR_DIR / "metrabs_tmp.zip"

    print("[Slimy_MeTRAbs] Downloading metrabs source zip (~7 MB) …")
    try:
        # SSL bypass for environments with certificate issues
        ctx = ssl._create_unverified_context()
        with urllib.request.urlopen(url, context=ctx) as resp:
            tmp.write_bytes(resp.read())
    except Exception as e:
        tmp.unlink(missing_ok=True)
        return f"Download failed: {e}"

    print("[Slimy_MeTRAbs] Extracting …")
    try:
        with zipfile.ZipFile(str(tmp)) as zf:
            zf.extractall(str(_VENDOR_DIR))
    except Exception as e:
        tmp.unlink(missing_ok=True)
        return f"Extraction failed: {e}"
    tmp.unlink(missing_ok=True)

    for d in _VENDOR_DIR.iterdir():
        if d.is_dir() and (d / "metrabs_pytorch").is_dir():
            if str(d) not in sys.path:
                sys.path.insert(0, str(d))
            try:
                import metrabs_pytorch
                print(f"[Slimy_MeTRAbs] metrabs_pytorch on path ({d.name})")
                return None   # success
            except ImportError as e:
                return f"Import failed after extraction: {e}"

    return "metrabs_pytorch/ not found inside extracted zip"


# ── metrabs_pytorch setup ──────────────────────────────────────────────────────

_metrabs_checked = False


def _ensure_metrabs_packages() -> str | None:
    """
    Make metrabs_pytorch importable without pip or git.
    Returns None on success, or a descriptive error string on failure.
    Steps:
      1. Stubs for simplepyutils / cameralib / posepile  (instant, no download)
      2. metrabs zip  → vendor dir → sys.path
      3. Any remaining PyPI deps (einops, etc.)  → pip install one-by-one
    """
    global _metrabs_checked
    if _metrabs_checked:
        return None

    # Inject stubs FIRST — required by _load_checkpoint_model even if
    # metrabs_pytorch is already on sys.path (e.g. restored from vendor dir).
    _inject_helper_stubs()

    try:
        import metrabs_pytorch  # noqa: F401
        _metrabs_checked = True
        return None
    except ImportError:
        pass

    print("[Slimy_MeTRAbs] Setting up metrabs_pytorch …")

    err = _fetch_metrabs_zip()
    if err:
        return err

    # Verify critical submodules; auto-install any missing standard PyPI packages
    _CRITICAL = [
        "metrabs_pytorch.backbones.efficientnet",
        "metrabs_pytorch.models.metrabs",
        "metrabs_pytorch.multiperson.multiperson_model",
        "metrabs_pytorch.util",
    ]
    for attempt in range(6):
        missing_pkg = None
        for mod_name in _CRITICAL:
            try:
                __import__(mod_name)
            except ImportError as e:
                raw = str(e).replace("No module named ", "").strip("'\" ")
                missing_pkg = raw.split(".")[0]
                print(f"[Slimy_MeTRAbs] Missing: {raw} — pip install {missing_pkg}")
                break
        if missing_pkg is None:
            break
        r = subprocess.run(
            [sys.executable, "-m", "pip", "install", missing_pkg],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            return f"pip install {missing_pkg} failed: {r.stderr[-300:]}"
        print(f"[Slimy_MeTRAbs] Installed {missing_pkg}.")
    else:
        return "Too many missing sub-dependencies"

    _metrabs_checked = True
    print("[Slimy_MeTRAbs] metrabs_pytorch ready.")
    return None


# ── Model loading ──────────────────────────────────────────────────────────────

_model_cache: dict[str, object] = {}


def _load_model(model_dir: Path, device: str):
    key = str(model_dir)
    if key in _model_cache:
        return _model_cache[key]

    ts_path = model_dir / _TORCHSCRIPT_MARKER
    ck_path = model_dir / _MODEL_MARKER

    # ── TorchScript (model.pt) — no external package needed ──────────────────
    if ts_path.exists():
        print(f"[Slimy_MeTRAbs] Loading TorchScript model from {model_dir.name} …")
        try:
            model = torch.jit.load(str(ts_path), map_location=device)
        except Exception as e:
            print(f"[Slimy_MeTRAbs] jit.load failed ({e}), trying torch.load …")
            model = torch.load(str(ts_path), map_location=device, weights_only=False)
        _model_cache[key] = ("torchscript", model)
        print("[Slimy_MeTRAbs] TorchScript model ready.")
        return _model_cache[key]

    # ── Checkpoint (ckpt.pt) — needs metrabs_pytorch package ─────────────────
    if not ck_path.exists():
        raise FileNotFoundError(f"No ckpt.pt or model.pt found in {model_dir}")

    setup_err = _ensure_metrabs_packages()
    if setup_err:
        raise RuntimeError(f"metrabs_pytorch setup failed: {setup_err}")

    print(f"[Slimy_MeTRAbs] Loading checkpoint model from {model_dir.name} …")
    model = _load_checkpoint_model(model_dir, device)
    _model_cache[key] = ("metrabs_pytorch", model)
    print("[Slimy_MeTRAbs] Checkpoint model ready.")
    return _model_cache[key]


def _load_checkpoint_model(model_dir: Path, device: str) -> dict:
    """
    Load Metrabs as a Pose3dEstimator (no YOLO).
    person_detector is pre-stubbed in _inject_helper_stubs so YOLO is never loaded.
    Returns a dict with keys: model (Pose3dEstimator), proc_side, joint_names.
    """
    import simplepyutils as spu
    import metrabs_pytorch.backbones.efficientnet as effnet_pt
    import metrabs_pytorch.models.metrabs as metrabs_model
    from metrabs_pytorch.util import get_config
    from metrabs_pytorch.multiperson.multiperson_model import Pose3dEstimator
    import posepile.joint_info

    spu.FLAGS.model_dir = str(model_dir)
    get_config(str(model_dir / "config.yaml"))
    cfg = get_config()

    ji_np = np.load(str(model_dir / "joint_info.npz"))
    ji    = posepile.joint_info.JointInfo(ji_np["joint_names"], ji_np["joint_edges"])

    backbone_raw = getattr(effnet_pt, f"efficientnet_v2_{cfg.efficientnet_size}")()
    preproc      = effnet_pt.PreprocLayer()
    backbone     = torch.nn.Sequential(preproc, backbone_raw.features)

    crop_model = metrabs_model.Metrabs(backbone, ji)
    crop_model.eval()

    with torch.no_grad():
        dummy_img  = torch.zeros((1, 3, cfg.proc_side, cfg.proc_side))
        dummy_intr = torch.eye(3)[None]
        crop_model((dummy_img, dummy_intr))

    state = torch.load(str(model_dir / "ckpt.pt"), map_location="cpu", weights_only=False)
    crop_model.load_state_dict(state)
    crop_model = crop_model.to(device)

    skeleton_infos         = spu.load_pickle(str(model_dir / "skeleton_infos.pkl"))
    joint_transform_matrix = np.load(str(model_dir / "joint_transform_matrix.npy"))

    estimator = Pose3dEstimator(crop_model, skeleton_infos, joint_transform_matrix)
    # PersonDetector (YOLO) is initialised inside Pose3dEstimator.__init__.
    estimator.eval()
    estimator = estimator.to(device)

    # Plain tensor / list / numpy attributes are NOT moved by .to(device).
    # Move them all here so CUDA index_select / matmul don't fail.
    def _to(x):
        if isinstance(x, torch.Tensor):   return x.to(device)
        if isinstance(x, np.ndarray):     return torch.tensor(x, dtype=torch.long, device=device)
        if isinstance(x, list):           return torch.tensor(x, dtype=torch.long, device=device)
        return x

    if estimator.joint_transform_matrix is not None:
        estimator.joint_transform_matrix = estimator.joint_transform_matrix.to(device)

    mm = estimator.joint_info.mirror_mapping
    estimator.joint_info.mirror_mapping = _to(mm)

    estimator.skeleton_joint_indices_table = {
        k: _to(v) for k, v in estimator.skeleton_joint_indices_table.items()
    }

    return {
        "model":       estimator,
        "proc_side":   cfg.proc_side,
        "joint_names": list(ji_np["joint_names"]),
    }


# ── Inference ──────────────────────────────────────────────────────────────────

def _run_inference(model_kind: str, model, img_np: np.ndarray,
                   skeleton: str, device: str, max_people: int = 10) -> dict:
    """Run pose inference. Returns dict with at least 'poses3d' key."""
    H, W = img_np.shape[:2]

    # ── metrabs_pytorch checkpoint model ─────────────────────────────────────
    if model_kind == "metrabs_pytorch":
        estimator = model["model"]   # Pose3dEstimator (NullDetector stub)

        # estimate_poses with a full-image box — bypasses YOLO entirely.
        # boxes format: [x, y, w, h]
        img_tensor = torch.from_numpy(img_np.transpose(2, 0, 1)).to(device)
        boxes = torch.tensor([[0, 0, W, H]], dtype=torch.float32).to(device)

        with torch.inference_mode():
            pred = estimator.estimate_poses(
                img_tensor, boxes=boxes,
                default_fov_degrees=55, skeleton=skeleton,
            )

        return {"poses3d": pred["poses3d"], "poses2d": pred.get("poses2d")}

    # ── TorchScript model (legacy) ────────────────────────────────────────────
    if model_kind == "torchscript":
        img_tensor = torch.from_numpy(img_np).to(device)
        return model.detect_poses(img_tensor, skeleton=skeleton)

    # ── Unknown model kind ────────────────────────────────────────────────────
    raise RuntimeError(f"Unknown model_kind: {model_kind!r}")


# ── Download / extract ─────────────────────────────────────────────────────────

def _http_get_stream(url: str, dest: Path) -> None:
    try:
        import requests
        with requests.get(url, stream=True, allow_redirects=True, timeout=60) as r:
            r.raise_for_status()
            total = int(r.headers.get("content-length", 0))
            done  = 0
            with open(dest, "wb") as f:
                for chunk in r.iter_content(chunk_size=131072):
                    f.write(chunk)
                    done += len(chunk)
                    if total:
                        print(f"\r  {done*100//total:3d}%  {done/1_048_576:.0f}/{total/1_048_576:.0f} MB",
                              end="", flush=True)
        print()
        return
    except ImportError:
        pass

    def _rep(blk, blk_sz, total):
        done = blk * blk_sz
        if total > 0:
            print(f"\r  {min(100,done*100//total):3d}%  {done/1_048_576:.0f} MB",
                  end="", flush=True)
    urllib.request.urlretrieve(url, str(dest), _rep)
    print()


def _download_and_install(dl_key: str, base: Path) -> Path | None:
    info = _DOWNLOADABLE[dl_key]
    url, expected_folder = info["url"], info["expected_folder"]

    base.mkdir(parents=True, exist_ok=True)
    tmp = base / "_download_tmp.tar.gz"

    print(f"[Slimy_MeTRAbs] Downloading {expected_folder} …")
    try:
        _http_get_stream(url, tmp)
    except Exception as e:
        print(f"\n[Slimy_MeTRAbs] Download failed: {e}")
        tmp.unlink(missing_ok=True)
        return None

    print("[Slimy_MeTRAbs] Extracting …")
    try:
        with tarfile.open(str(tmp)) as tf:
            tf.extractall(str(base))
    except Exception as e:
        print(f"[Slimy_MeTRAbs] Extraction failed: {e}")
        tmp.unlink(missing_ok=True)
        return None

    tmp.unlink(missing_ok=True)

    for marker in (_MODEL_MARKER, _TORCHSCRIPT_MARKER):
        p = base / expected_folder / marker
        if p.exists():
            print(f"[Slimy_MeTRAbs] Installed: {p.parent.name}")
            return p.parent

    found = next(
        (p.parent for p in sorted(base.rglob("ckpt.pt")) if p.parent != base), None,
    ) or next(
        (p.parent for p in sorted(base.rglob("model.pt")) if p.parent != base), None,
    )
    if found:
        print(f"[Slimy_MeTRAbs] Installed (found at): {found.name}")
        return found

    print("[Slimy_MeTRAbs] ckpt.pt / model.pt not found after extraction.")
    return None


# ── Joint name normalization ───────────────────────────────────────────────────

_CANONICAL: dict[str, str] = {
    "nose": "nose", "neck": "neck", "head": "head", "head_top": "head_top",
    "pelvis": "pelvis", "pelv": "pelvis", "mid_hip": "pelvis",
    "bell": "belly", "thor": "thorax", "spin": "spine",
    "left_shoulder":  "left_shoulder",  "lsho": "left_shoulder",
    "right_shoulder": "right_shoulder", "rsho": "right_shoulder",
    "left_elbow":  "left_elbow",  "lelb": "left_elbow",
    "right_elbow": "right_elbow", "relb": "right_elbow",
    "left_wrist":  "left_wrist",  "lwri": "left_wrist",
    "right_wrist": "right_wrist", "rwri": "right_wrist",
    "left_hip":  "left_hip",  "lhip": "left_hip",
    "right_hip": "right_hip", "rhip": "right_hip",
    "left_knee":  "left_knee",  "lkne": "left_knee",
    "right_knee": "right_knee", "rkne": "right_knee",
    "left_ankle":  "left_ankle",  "lank": "left_ankle",
    "right_ankle": "right_ankle", "rank": "right_ankle",
    "left_eye":  "left_eye",  "leye": "left_eye",
    "right_eye": "right_eye", "reye": "right_eye",
    "left_ear":  "left_ear",  "lear": "left_ear",
    "right_ear": "right_ear", "rear": "right_ear",
    "left_toe":  "left_toe",  "ltoe": "left_toe",
    "right_toe": "right_toe", "rtoe": "right_toe",
    "left_hand":  "left_hand",  "lhan": "left_hand",
    "right_hand": "right_hand", "rhan": "right_hand",
}

_METRABS_SHORT: dict[str, str] = {
    "lsho": "left_shoulder",  "rsho": "right_shoulder",
    "lelb": "left_elbow",     "relb": "right_elbow",
    "lwri": "left_wrist",     "rwri": "right_wrist",
    "lhip": "left_hip",       "rhip": "right_hip",
    "lkne": "left_knee",      "rkne": "right_knee",
    "lank": "left_ankle",     "rank": "right_ankle",
    "ltoe": "left_toe",       "rtoe": "right_toe",
    "lhan": "left_hand",      "rhan": "right_hand",
    "leye": "left_eye",       "reye": "right_eye",
    "lear": "left_ear",       "rear": "right_ear",
    "neck": "neck",            "head": "head",
    "pelv": "pelvis",          "bell": "belly",
    "thor": "thorax",          "spin": "spine",
    "nose": "nose",
}

def _normalize(name: str) -> str:
    key = name.lower().replace("-", "_")
    return _CANONICAL.get(key, key)

def _canon_name(raw: str) -> str:
    """Convert raw joint name (e.g. 'lsho_coco' or 'left_shoulder') to canonical."""
    base = raw.split("_")[0] if "_" in raw else raw
    return _METRABS_SHORT.get(base, _normalize(raw))


_RTMW_IDX: dict[int, str] = {
    0:  "nose",
    5:  "left_shoulder",  6:  "right_shoulder",
    7:  "left_elbow",     8:  "right_elbow",
    9:  "left_wrist",     10: "right_wrist",
    11: "left_hip",       12: "right_hip",
    13: "left_knee",      14: "right_knee",
    15: "left_ankle",     16: "right_ankle",
}


# ── Node ──────────────────────────────────────────────────────────────────────

class VNCCS_MeTRAbs3DPose:
    """
    MeTRAbs absolute-3D pose estimator.
    Outputs joint positions in mm (camera space) as JSON.

    First use: set download_if_missing=True to auto-fetch the model.
    The metrabs_pytorch package is installed automatically on first inference.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image":               ("IMAGE",),
                "model":               (_list_model_choices(),),
                "skeleton":            (["coco_19", "smpl+head_30", "h36m_17", "mpii_16"],),
                "device":              (["cuda", "cpu"],),
                "max_people":          ("INT",    {"default": 1, "min": 1, "max": 10}),
                "output_filename":     ("STRING", {"default": "metrabs_pose3d"}),
                "download_if_missing": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES  = ("IMAGE", "STRING")
    RETURN_NAMES  = ("image", "pose_json")
    FUNCTION      = "estimate"
    CATEGORY      = "Slimy/Pose"
    OUTPUT_NODE   = True

    def estimate(self, image, model, skeleton, device, max_people,
                 output_filename, download_if_missing):

        base = _metrabs_dir()

        # ── Resolve model directory ───────────────────────────────────────────
        if model in _DOWNLOADABLE:
            if not download_if_missing:
                return self._err(image,
                    f"'{model}' is not downloaded yet.\n"
                    "Set  download_if_missing = True  to auto-download.")
            model_dir = _download_and_install(model, base)
            if model_dir is None:
                return self._err(image, "Download failed — see console.")
        else:
            model_dir = base / model
            if not model_dir.exists() or not (
                (model_dir / _MODEL_MARKER).exists() or
                (model_dir / _TORCHSCRIPT_MARKER).exists()
            ):
                if download_if_missing:
                    matched = next(
                        (k for k, v in _DOWNLOADABLE.items()
                         if model[:15] in v["expected_folder"]),
                        None,
                    )
                    if matched:
                        model_dir = _download_and_install(matched, base)
                if not model_dir:
                    return self._err(image,
                        f"Model not found: {base / model}\n"
                        "Set download_if_missing=True or place files manually.")

        # ── Load model ────────────────────────────────────────────────────────
        try:
            model_kind, metrabs = _load_model(model_dir, device)
        except Exception as e:
            traceback.print_exc()
            return self._err(image, str(e))

        # ── Prepare image ─────────────────────────────────────────────────────
        img_np = (image[0].cpu().numpy() * 255).astype(np.uint8)  # [H, W, 3] uint8
        H, W   = img_np.shape[:2]

        # ── Inference ─────────────────────────────────────────────────────────
        try:
            pred = _run_inference(model_kind, metrabs, img_np, skeleton, device, max_people)
        except Exception as e:
            traceback.print_exc()
            return self._err(image, str(e))

        # ── Parse output ──────────────────────────────────────────────────────
        poses3d = self._to_numpy(pred.get("poses3d"))
        poses2d = self._to_numpy(pred.get("poses2d"))  # may be None for metrabs_pytorch

        if poses3d is None or len(poses3d) == 0:
            return self._err(image, "No people detected.")

        # Get joint names: prefer per_skeleton_joint_names from the model
        joint_names_raw = self._resolve_joint_names(
            metrabs, model_kind, pred, model_dir, skeleton, poses3d.shape[1])

        canon_to_idx: dict[str, int] = {}
        for i, n in enumerate(joint_names_raw):
            c = _canon_name(n)
            if c not in canon_to_idx:
                canon_to_idx[c] = i

        # ── Build JSON ────────────────────────────────────────────────────────
        people = []
        for pid in range(min(max_people, len(poses3d))):
            p3d = poses3d[pid]

            kpts_3d = {
                _canon_name(n): [round(float(p3d[i, 0]), 2),
                                  round(float(p3d[i, 1]), 2),
                                  round(float(p3d[i, 2]), 2)]
                for i, n in enumerate(joint_names_raw)
            }
            kpts_2d: dict = {}
            if poses2d is not None and pid < len(poses2d):
                p2d = poses2d[pid]
                kpts_2d = {
                    _canon_name(n): [round(float(p2d[i, 0]), 2),
                                      round(float(p2d[i, 1]), 2)]
                    for i, n in enumerate(joint_names_raw)
                }

            ik_targets: dict[str, list[float]] = {}
            for rtmw_idx, canon in _RTMW_IDX.items():
                j = canon_to_idx.get(canon)
                if j is not None:
                    ik_targets[str(rtmw_idx)] = [
                        round(float(p3d[j, 0]), 2),
                        round(float(p3d[j, 1]), 2),
                        round(float(p3d[j, 2]), 2),
                    ]
            j_pelvis = canon_to_idx.get("pelvis")
            if j_pelvis is not None:
                ik_targets["pelvis"] = [
                    round(float(p3d[j_pelvis, 0]), 2),
                    round(float(p3d[j_pelvis, 1]), 2),
                    round(float(p3d[j_pelvis, 2]), 2),
                ]

            people.append({
                "person_id":        pid,
                "keypoints_3d":     kpts_3d,
                "keypoints_2d":     kpts_2d,
                "vnccs_ik_targets": ik_targets,
            })

        result = {
            "version":           "metrabs_3d_v1",
            "skeleton":          skeleton,
            "source_image_size": [W, H],
            "camera_space":      "mm",
            "joint_names":       [_canon_name(n) for n in joint_names_raw],
            "people":            people,
        }

        # ── Save ──────────────────────────────────────────────────────────────
        try:
            import folder_paths
            out_dir = Path(folder_paths.get_output_directory()) / "pose3d"
        except Exception:
            out_dir = Path(__file__).resolve().parents[3] / "output" / "pose3d"

        out_dir.mkdir(parents=True, exist_ok=True)
        ts       = datetime.now().strftime("%Y%m%d_%H%M%S")
        out_path = out_dir / f"{output_filename}_{ts}.json"
        json_str = json.dumps(result, ensure_ascii=False, indent=2)
        out_path.write_text(json_str, encoding="utf-8")
        print(f"[Slimy_MeTRAbs] {len(people)} person(s). Saved → {out_path}")

        return {"ui": {"text": [json_str]}, "result": (image, json_str)}

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _err(image, msg: str):
        print(f"[Slimy_MeTRAbs] ERROR: {msg}")
        err = json.dumps({"error": msg, "people": []}, ensure_ascii=False)
        return {"ui": {"text": [err]}, "result": (image, err)}

    @staticmethod
    def _to_numpy(t) -> np.ndarray | None:
        if t is None:
            return None
        if isinstance(t, torch.Tensor):
            return t.cpu().numpy()
        if isinstance(t, np.ndarray):
            return t
        return None

    @staticmethod
    def _resolve_joint_names(model, model_kind: str, pred: dict,
                              model_dir: Path, skeleton: str, n_joints: int) -> list[str]:
        # 1. From Pose3dEstimator.per_skeleton_joint_names (most reliable)
        if model_kind == "metrabs_pytorch":
            inner = model.get("model") if isinstance(model, dict) else model
            psn = getattr(inner, "per_skeleton_joint_names", None)
            if psn is not None:
                names = list(psn.get(skeleton, []))
                if len(names) == n_joints:
                    return names

        # 2. From pred dict
        for key in ("joint_names", "skeleton_joint_names", "names"):
            v = pred.get(key)
            if v is not None:
                names = list(v)
                if len(names) == n_joints:
                    return names

        # 3. From joint_info.npz in model dir
        ji = model_dir / "joint_info.npz"
        if ji.exists():
            try:
                d = np.load(str(ji), allow_pickle=True)
                names = list(d["joint_names"])
                if len(names) == n_joints:
                    return names
                if len(names) > n_joints:
                    return names[:n_joints]
            except Exception:
                pass

        return [f"joint_{i}" for i in range(n_joints)]
