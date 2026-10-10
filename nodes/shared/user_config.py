"""Read-only user configuration and private repository settings writer."""
import os
import json
import threading
from .paths import _EXTENSION_ROOT

def get_vnccs_user_config_path():
    try:
        import folder_paths
        base_path = getattr(folder_paths, "base_path", _EXTENSION_ROOT)
    except Exception:
        base_path = _EXTENSION_ROOT
    return os.path.join(base_path, "vnccs_user_config.json")


def get_vnccs_user_config():
    path = get_vnccs_user_config_path()
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def write_private_json(path, data):
    tmp_path = f"{path}.tmp.{os.getpid()}.{threading.get_ident()}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(tmp_path, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        raise
