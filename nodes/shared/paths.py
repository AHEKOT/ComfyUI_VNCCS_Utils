"""ComfyUI-managed runtime roots shared by node services."""
import os
import re

_EXTENSION_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]+")

def _vnccs_runtime_temp_root():
    try:
        import folder_paths

        root = folder_paths.get_temp_directory()
    except Exception:
        root = os.path.join(_EXTENSION_ROOT, ".runtime_cache")
    os.makedirs(root, exist_ok=True)
    return root


def _vnccs_user_data_root():
    # ComfyUI wipes its temp directory on every start, so anything that must survive a restart
    # lives in the user directory instead.
    try:
        import folder_paths

        root = folder_paths.get_user_directory()
    except Exception:
        root = os.path.join(_EXTENSION_ROOT, ".runtime_cache", "user")
    root = os.path.join(root, "vnccs")
    os.makedirs(root, exist_ok=True)
    return root


def _vnccs_safe_id(value, fallback="item"):
    cleaned = _SAFE_ID_RE.sub("_", str(value or "")).strip("_")
    return cleaned[:128].rstrip("_") or fallback
