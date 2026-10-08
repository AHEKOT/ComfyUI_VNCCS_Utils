import os
import json
import base64
import io
import shutil
import time
import hashlib
import tempfile
import uuid
import threading
import asyncio
from concurrent.futures import ThreadPoolExecutor, as_completed
from fractions import Fraction
from urllib.parse import unquote, urlparse
from aiohttp import web
from PIL import Image

DEFAULT_REPO_ID = "MIUProject/VNCCS_PoseLibrary_Main"
SECONDARY_DEFAULT_REPO_ID = "Totemistyk/General_Poses_PoseStudio"
LOCAL_USER_REPOSITORY = "local_user_poses"
DEFAULT_CATEGORY = "Uncategorized"
POSE_ASSET_TYPE = "pose"
ANIMATION_ASSET_TYPE = "animation"
ANIMATION_SYSTEM_TAG = "Animation"
LEGACY_GENERIC_REPOSITORY_TITLES = {"VNCCS Pose Library"}
RESERVED_LIBRARY_JSON = {"repositories.user.json", "pose_library.json"}
MAX_PREVIEW_BYTES = 16 * 1024 * 1024
MAX_VIDEO_PREVIEW_INPUT_BYTES = 40 * 1024 * 1024
MAX_VIDEO_PREVIEW_STORED_BYTES = 32 * 1024 * 1024
MAX_LIBRARY_SAVE_REQUEST_BYTES = 64 * 1024 * 1024
MAX_POSE_REPOSITORY_FILE_BYTES = 32 * 1024 * 1024
MAX_POSE_REPOSITORY_SYNC_BYTES = 256 * 1024 * 1024
POSE_REPOSITORY_LEGACY_GIT_CACHE_DIR = ".repository_git_cache"
_REPOSITORY_PROGRESS = {}
_REPOSITORY_PROGRESS_LOCK = threading.Lock()
_REPOSITORY_PROGRESS_MAX = 256
_REPOSITORY_PROGRESS_TTL_SECONDS = 60 * 60
_REPOSITORY_PROGRESS_RUNNING_TTL_SECONDS = 24 * 60 * 60
_BACKGROUND_REFRESH_STATE = {
    "running": False,
    "task_id": "",
    "last_started": 0,
    "last_finished": 0,
}
_BACKGROUND_REFRESH_LOCK = threading.Lock()

def _prune_repository_progress(now=None):
    now = time.time() if now is None else now
    expired = []
    for task_id, state in _REPOSITORY_PROGRESS.items():
        age = max(0.0, now - float(state.get("updated_at", now)))
        status = state.get("status")
        if (status != "running" and age > _REPOSITORY_PROGRESS_TTL_SECONDS) or age > _REPOSITORY_PROGRESS_RUNNING_TTL_SECONDS:
            expired.append(task_id)
    for task_id in expired:
        _REPOSITORY_PROGRESS.pop(task_id, None)
    if len(_REPOSITORY_PROGRESS) <= _REPOSITORY_PROGRESS_MAX:
        return
    ordered = sorted(
        _REPOSITORY_PROGRESS.items(),
        key=lambda item: (item[1].get("status") == "running", float(item[1].get("updated_at", 0))),
    )
    for task_id, _ in ordered[:len(_REPOSITORY_PROGRESS) - _REPOSITORY_PROGRESS_MAX]:
        _REPOSITORY_PROGRESS.pop(task_id, None)

def repository_progress_start(task_id, message="Starting repository operation..."):
    if not task_id:
        return
    with _REPOSITORY_PROGRESS_LOCK:
        _REPOSITORY_PROGRESS[task_id] = {
            "status": "running",
            "message": message,
            "progress": 0,
            "current_file": "",
            "file_index": 0,
            "total_files": 0,
            "bytes_done": 0,
            "bytes_total": 0,
            "updated_at": time.time(),
        }
        _prune_repository_progress()

def repository_progress_update(task_id, **kwargs):
    if not task_id:
        return
    with _REPOSITORY_PROGRESS_LOCK:
        state = _REPOSITORY_PROGRESS.setdefault(task_id, {"status": "running", "progress": 0})
        state.update(kwargs)
        state["updated_at"] = time.time()
        _prune_repository_progress()

def repository_progress_finish(task_id, message="Done."):
    if not task_id:
        return
    repository_progress_update(task_id, status="success", message=message, progress=100)

def repository_progress_fail(task_id, message):
    if not task_id:
        return
    repository_progress_update(task_id, status="error", message=str(message), progress=100)

def get_repository_progress(task_id):
    with _REPOSITORY_PROGRESS_LOCK:
        _prune_repository_progress()
        state = _REPOSITORY_PROGRESS.get(task_id)
        if not state:
            return {
                "status": "unknown",
                "message": "Waiting for repository operation...",
                "progress": 0,
            }
        return dict(state)

# Base path for PoseLibrary
def get_library_path():
    """Returns the path to PoseLibrary folder, creating it if needed."""
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    lib_path = os.path.join(base_dir, "PoseLibrary")
    os.makedirs(lib_path, exist_ok=True)
    return lib_path

def walk_pose_library(lib_path):
    """Walk user-visible pose data without exposing the internal Git cache."""
    for root, dirs, files in os.walk(lib_path):
        if os.path.abspath(root) == os.path.abspath(lib_path):
            dirs[:] = [directory for directory in dirs if directory != POSE_REPOSITORY_LEGACY_GIT_CACHE_DIR]
        yield root, dirs, files

def get_default_repositories_path():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base_dir, "config", "default_pose_repositories.json")

def get_user_repositories_path():
    return os.path.join(get_library_path(), "repositories.user.json")

def get_vnccs_user_config_path():
    try:
        import folder_paths
        base_path = getattr(folder_paths, "base_path", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    except Exception:
        base_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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

def save_vnccs_user_config(new_data):
    path = get_vnccs_user_config_path()
    data = get_vnccs_user_config()
    data.update(new_data)
    write_private_json(path, data)

def normalize_repo_id(repo_id):
    repo_id = str(repo_id or "").strip()
    if repo_id.lower().startswith(("https://", "http://")):
        try:
            parsed = urlparse(repo_id)
            if parsed.hostname not in {"huggingface.co", "www.huggingface.co"}:
                return ""
            parts = [unquote(part) for part in parsed.path.split("/") if part]
            if len(parts) < 2 or parts[0] in {"datasets", "spaces"}:
                return ""
            repo_id = "/".join(parts[:2])
        except Exception:
            return ""
    repo_id = repo_id.strip("/")
    if not repo_id or " " in repo_id or repo_id.count("/") != 1:
        return ""
    return repo_id

def repository_manifest_title(repo_id, title=""):
    """Return a stable, repository-specific title for generated manifests."""
    title = str(title or "").strip()
    if not title or title in LEGACY_GENERIC_REPOSITORY_TITLES:
        return repo_id
    return title

def load_default_repositories():
    path = get_default_repositories_path()
    fallbacks = [
        {
            "repo_id": DEFAULT_REPO_ID,
            "title": "VNCCS Pose Library Main",
            "description": "Default curated VNCCS Pose Studio pose library.",
            "manifest_path": "pose_library.json",
            "enabled": True,
            "builtin": True,
        },
        {
            "repo_id": SECONDARY_DEFAULT_REPO_ID,
            "title": "General Poses PoseStudio",
            "description": "Default community pose library by Totemistyk.",
            "manifest_path": "pose_library.json",
            "enabled": True,
            "builtin": True,
        },
    ]
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        repos = data.get("repositories") or []
    except Exception:
        repos = fallbacks
    out = []
    for repo in repos:
        repo_id = normalize_repo_id(repo.get("repo_id"))
        if not repo_id:
            continue
        out.append({
            "repo_id": repo_id,
            "title": repo.get("title") or repo_id,
            "description": repo.get("description") or "",
            "manifest_path": repo.get("manifest_path") or "pose_library.json",
            "enabled": bool(repo.get("enabled", True)),
            "builtin": True,
        })
    return out or fallbacks

def load_user_repositories():
    path = get_user_repositories_path()
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        repos = data.get("repositories") or []
    except Exception:
        return []
    out = []
    for repo in repos:
        repo_id = normalize_repo_id(repo.get("repo_id"))
        if not repo_id:
            continue
        out.append({
            **repo,
            "repo_id": repo_id,
            "title": repo.get("title") or repo_id,
            "description": repo.get("description") or "",
            "manifest_path": repo.get("manifest_path") or "pose_library.json",
            "enabled": bool(repo.get("enabled", True)),
            "builtin": False,
        })
    return out

def save_user_repositories(repositories):
    path = get_user_repositories_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    user_repos = [
        {k: v for k, v in repo.items() if k != "builtin"}
        for repo in repositories
        if not repo.get("builtin")
    ]
    write_private_json(path, {"schema_version": 1, "repositories": user_repos})

def load_pose_repositories():
    defaults = {repo["repo_id"]: repo for repo in load_default_repositories()}
    merged = {repo_id: dict(repo) for repo_id, repo in defaults.items()}
    for repo in load_user_repositories():
        repo_id = repo["repo_id"]
        merged[repo_id] = {**merged.get(repo_id, {}), **repo}
        if repo_id in defaults:
            merged[repo_id]["builtin"] = True
            if merged[repo_id].get("title") in LEGACY_GENERIC_REPOSITORY_TITLES:
                merged[repo_id]["title"] = defaults[repo_id]["title"]
        else:
            merged[repo_id]["title"] = repository_manifest_title(
                repo_id,
                merged[repo_id].get("title"),
            )
    return list(merged.values())

def refresh_pose_repository(repo, task_id=None):
    repo_id = repo["repo_id"]
    manifest_path = repo.get("manifest_path") or "pose_library.json"
    repository_progress_start(task_id, f"Checking {repo_id}...")
    result = {
        **repo,
        "status": "unknown",
        "pose_count": int(repo.get("pose_count") or 0),
        "animation_count": int(repo.get("animation_count") or 0),
        "asset_count": int(repo.get("asset_count") or repo.get("pose_count") or 0),
        "last_checked": time.time(),
        "last_error": "",
        "transport": "",
    }
    try:
        from huggingface_hub import HfApi
        token = False
        api = HfApi()
        repository_progress_update(task_id, message=f"Reading repository info for {repo_id}...", progress=2)
        info = api.repo_info(repo_id=repo_id, repo_type="model", token=token)
        result["sha"] = getattr(info, "sha", "") or ""
        repository_progress_update(task_id, message=f"Downloading manifest for {repo_id}...", progress=5, transport="http")
        manifest_file = None
        try:
            manifest_file = download_hf_file_with_progress(
                repo_id=repo_id, path_in_repo=manifest_path, token=token,
                task_id=task_id, file_index=0, total_files=1,
            )
            with open(manifest_file, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        finally:
            if manifest_file:
                os.remove(manifest_file)
        sync_result = sync_pose_repository_files(repo, manifest, token, task_id=task_id)
        transport = "http"
        poses = manifest.get("poses") or []
        result["animation_count"] = sum(
            1 for item in poses
            if isinstance(item, dict) and (
                normalize_asset_type(item.get("asset_type")) == ANIMATION_ASSET_TYPE
                or str(item.get("json_path") or "").replace("\\", "/").startswith("animations/")
            )
        )
        result["pose_count"] = len(poses) - result["animation_count"]
        result["asset_count"] = len(poses)
        result["downloaded_count"] = sync_result["downloaded_count"]
        result["skipped_count"] = sync_result["skipped_count"]
        result["removed_count"] = sync_result["removed_count"]
        result["transport"] = transport
        result["errors"] = sync_result["errors"]
        if sync_result["errors"]:
            raise ValueError("; ".join(sync_result["errors"]))
        manifest_title = manifest.get("title")
        result["title"] = (
            (result.get("title") or repo_id)
            if result.get("builtin")
            else repository_manifest_title(repo_id, manifest_title)
        )
        result["description"] = manifest.get("description") or result.get("description") or ""
        result["updated_at"] = manifest.get("updated_at") or ""
        result["status"] = "ok"
        repository_progress_finish(
            task_id,
            f"Repository sync complete via {transport}: {sync_result['downloaded_count']} downloaded, "
            f"{sync_result['skipped_count']} unchanged, {sync_result['removed_count']} removed.",
        )
        repository_progress_update(task_id, transport=transport)
    except Exception as exc:
        result["status"] = "error"
        result["last_error"] = str(exc)
        repository_progress_fail(task_id, exc)
    return result

def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def json_bytes(data):
    return json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")

def human_bytes(value):
    value = float(value or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024

def expected_content_length(request, max_chars):
    try:
        raw_length = request.headers.get("Content-Length")
        if raw_length is None:
            return not getattr(request, "can_read_body", False)
        length = int(raw_length)
    except Exception:
        return False
    return length <= int(max_chars or 0)

def verify_expected_sha(path, expected_sha):
    expected_sha = str(expected_sha or "").strip().lower()
    if not expected_sha:
        return
    actual_sha = sha256_file(path).lower()
    if actual_sha != expected_sha:
        raise ValueError(f"SHA256 mismatch for downloaded file: expected {expected_sha}, got {actual_sha}")


def _pose_download_temp_path(path_in_repo):
    directory = os.path.join(get_library_path(), ".downloads")
    os.makedirs(directory, exist_ok=True)
    fd, path = tempfile.mkstemp(
        prefix="vnccs_pose_repo_",
        suffix=os.path.splitext(path_in_repo)[1] or ".tmp",
        dir=directory,
    )
    os.close(fd)
    return path


def download_hf_file_with_progress(repo_id, path_in_repo, token=None, task_id=None, file_index=0, total_files=1):
    from huggingface_hub import hf_hub_download

    tmp_path = _pose_download_temp_path(path_in_repo)
    try:
        repository_progress_update(
            task_id,
            message=f"Downloading {path_in_repo}...",
            current_file=path_in_repo,
            file_index=file_index + 1,
            total_files=total_files,
            progress=(file_index / max(total_files, 1)) * 100,
        )
        cached_path = hf_hub_download(
            repo_id=repo_id,
            filename=path_in_repo,
            repo_type="model",
            token=False,
        )
        total_bytes = os.path.getsize(cached_path)
        if total_bytes > MAX_POSE_REPOSITORY_FILE_BYTES:
            raise ValueError(f"{path_in_repo} is too large ({human_bytes(total_bytes)} > {human_bytes(MAX_POSE_REPOSITORY_FILE_BYTES)})")
        shutil.copyfile(cached_path, tmp_path)
        repository_progress_update(
            task_id,
            message=f"Downloaded {path_in_repo} ({human_bytes(total_bytes)})",
            current_file=path_in_repo,
            file_index=file_index + 1,
            total_files=total_files,
            bytes_done=total_bytes,
            bytes_total=total_bytes,
            progress=((file_index + 1) / max(total_files, 1)) * 100,
        )
        return tmp_path
    except Exception:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        raise

def download_hf_file(repo_id, path_in_repo, token=None):
    from huggingface_hub import hf_hub_download

    tmp_path = _pose_download_temp_path(path_in_repo)
    try:
        cached_path = hf_hub_download(
            repo_id=repo_id,
            filename=path_in_repo,
            repo_type="model",
            token=False,
        )
        total_bytes = os.path.getsize(cached_path)
        if total_bytes > MAX_POSE_REPOSITORY_FILE_BYTES:
            raise ValueError(f"{path_in_repo} is too large ({human_bytes(total_bytes)} > {human_bytes(MAX_POSE_REPOSITORY_FILE_BYTES)})")
        shutil.copyfile(cached_path, tmp_path)
        return tmp_path
    except Exception:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        raise

def collect_local_pose_files():
    lib_path = get_library_path()
    local_root = os.path.join(lib_path, LOCAL_USER_REPOSITORY)
    if not os.path.exists(local_root):
        return []

    poses = []
    for root, _dirs, files in os.walk(local_root):
        for filename in files:
            if not filename.endswith(".json") or filename in RESERVED_LIBRARY_JSON:
                continue
            name = sanitize_pose_name(filename[:-5])
            if not name:
                continue
            path = os.path.join(root, filename)
            try:
                pose_data = read_pose_json(path)
            except Exception:
                continue
            meta = get_pose_meta(pose_data)
            _repository, category, asset_type = pose_file_location(path, pose_data, {LOCAL_USER_REPOSITORY: LOCAL_USER_REPOSITORY})
            preview_path, preview_type = find_preview(root, name)
            preview_ext = os.path.splitext(preview_path)[1].lower() if preview_path else ""
            category_dir = category_to_dir(category)
            safe_name = sanitize_pose_name(name)
            asset_root = "animations" if asset_type == ANIMATION_ASSET_TYPE else "poses"
            preview_root = "animation_previews" if asset_type == ANIMATION_ASSET_TYPE else "previews"
            poses.append({
                "name": name,
                "category": category,
                "tags": meta.get("tags") or [],
                "asset_type": asset_type,
                "json_path": path,
                "preview_path": preview_path,
                "preview_type": preview_type,
                "hub_json_path": f"{asset_root}/{category_dir}/{safe_name}.json",
                "hub_preview_path": f"{preview_root}/{category_dir}/{safe_name}{preview_ext}" if preview_path else "",
                "json_sha256": sha256_file(path),
                "preview_sha256": sha256_file(preview_path) if preview_path else "",
            })
    return sorted(poses, key=lambda item: (item["category"], item["name"]))

def get_local_repository_info():
    config = get_vnccs_user_config()
    poses = collect_local_pose_files()
    animation_count = sum(1 for item in poses if item.get("asset_type") == ANIMATION_ASSET_TYPE)
    return {
        "repo_id": LOCAL_USER_REPOSITORY,
        "title": "Local Pose Library",
        "description": "Poses and animations saved locally from Pose Studio.",
        "asset_count": len(poses),
        "pose_count": len(poses) - animation_count,
        "animation_count": animation_count,
        "publish_repo_id": config.get("pose_library_publish_repo_id") or "",
        "publishing_enabled": False,
        "last_publish": config.get("pose_library_last_publish") or None,
        "last_publish_result": config.get("pose_library_last_publish_result") or None,
    }

def load_remote_pose_manifest(repo_id, token=False):
    try:
        from huggingface_hub import hf_hub_download
        manifest_file = hf_hub_download(
            repo_id=repo_id,
            filename="pose_library.json",
            repo_type="model",
            token=False,
            local_files_only=False,
        )
        with open(manifest_file, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        if not isinstance(manifest, dict):
            return {}
        return manifest
    except Exception:
        return {}

def remote_file_sha256(repo_id, path_in_repo, token=False):
    try:
        from huggingface_hub import hf_hub_download
        path = hf_hub_download(
            repo_id=repo_id,
            filename=path_in_repo,
            repo_type="model",
            token=False,
            local_files_only=False,
        )
        return sha256_file(path)
    except Exception:
        return ""

def infer_category_from_hub_path(path_in_repo):
    parts = [part for part in str(path_in_repo or "").replace("\\", "/").split("/") if part]
    if len(parts) >= 3 and parts[0] in {"poses", "previews", "animations", "animation_previews"}:
        return parts[1]
    if len(parts) >= 2:
        return parts[-2]
    return DEFAULT_CATEGORY

def copy_if_changed(src_path, dst_path, expected_sha=""):
    verify_expected_sha(src_path, expected_sha)
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    if os.path.exists(dst_path):
        try:
            current_sha = sha256_file(dst_path)
            source_sha = expected_sha or sha256_file(src_path)
            if current_sha == source_sha:
                return False
        except Exception:
            pass
    fd, staged_path = tempfile.mkstemp(prefix=".vnccs_sync_", dir=os.path.dirname(dst_path))
    os.close(fd)
    try:
        shutil.copy2(src_path, staged_path)
        os.replace(staged_path, dst_path)
    finally:
        if os.path.exists(staged_path):
            os.remove(staged_path)
    return True

def local_file_matches(path, expected_sha):
    if not expected_sha or not os.path.exists(path):
        return False
    try:
        return sha256_file(path) == expected_sha
    except Exception:
        return False

def normalize_local_path(path):
    """Absolute path compared case-insensitively on case-insensitive filesystems (Windows)."""
    return os.path.normcase(os.path.abspath(path))

def cleanup_local_repository_cache(repo_id, expected_json_paths, expected_preview_paths, task_id=None):
    repo_root = os.path.join(get_library_path(), repository_to_dir(repo_id))
    if not os.path.exists(repo_root):
        return []

    expected_json_paths = {normalize_local_path(path) for path in expected_json_paths}
    expected_preview_paths = {normalize_local_path(path) for path in expected_preview_paths if path}
    removed = []
    preview_exts = {".webm", ".mp4", ".webp", ".jpg", ".jpeg", ".png"}

    for root, _dirs, files in os.walk(repo_root):
        for filename in files:
            path = os.path.join(root, filename)
            abs_path = normalize_local_path(path)
            ext = os.path.splitext(filename)[1].lower()
            should_remove = False
            if ext == ".json" and filename not in RESERVED_LIBRARY_JSON:
                should_remove = abs_path not in expected_json_paths
            elif ext in preview_exts:
                should_remove = abs_path not in expected_preview_paths
            if not should_remove:
                continue
            try:
                os.remove(path)
                removed.append(os.path.relpath(path, repo_root))
            except Exception:
                pass

    for root, _dirs, _files in os.walk(repo_root, topdown=False):
        if root == repo_root:
            continue
        try:
            is_empty = not os.listdir(root)
        except Exception:
            is_empty = False
        if is_empty:
            try:
                os.rmdir(root)
            except Exception:
                pass

    if removed:
        repository_progress_update(
            task_id,
            message=f"Removed {len(removed)} stale local pose files.",
            progress=98,
        )
    return removed

def remove_local_repository_cache(repo_id):
    if repo_id == LOCAL_USER_REPOSITORY:
        return 0
    lib_root = os.path.abspath(get_library_path())
    repo_root = os.path.abspath(os.path.join(lib_root, repository_to_dir(repo_id)))
    if repo_root == lib_root or not repo_root.startswith(lib_root + os.sep):
        return 0

    removed_count = 0
    if os.path.exists(repo_root):
        for _root, _dirs, files in os.walk(repo_root):
            removed_count += len(files)
        shutil.rmtree(repo_root, ignore_errors=True)
    return removed_count

def sync_pose_repository_files(repo, manifest, token, task_id=None):
    """Validate the complete manifest before importing public Hugging Face assets."""
    repo_id = repo["repo_id"]
    if not isinstance(manifest, dict) or not isinstance(manifest.get("poses"), list):
        raise ValueError("Repository manifest must contain a poses array")
    poses = manifest["poses"]
    destinations = {}
    pose_states = {}
    download_jobs = []
    expected_json_paths = set()
    expected_preview_paths = set()
    errors = []

    for index, pose in enumerate(poses):
        if not isinstance(pose, dict):
            raise ValueError(f"Invalid manifest entry {index}: expected an object")
        hub_json_path = pose.get("json_path") or pose.get("path")
        if not isinstance(hub_json_path, str) or not hub_json_path.lower().endswith(".json"):
            raise ValueError(f"Invalid manifest entry {index}: JSON path required")
        for field in ("json_path", "path", "preview_path", "name", "category", "asset_type", "json_sha256", "preview_sha256"):
            if field in pose and not isinstance(pose[field], str):
                raise ValueError(f"Invalid manifest entry {index}: {field} must be a string")
        for hub_path in (hub_json_path, pose.get("preview_path") or ""):
            if hub_path and (hub_path.startswith(("/", "\\")) or any(part in {"", ".", ".."} for part in hub_path.replace("\\", "/").split("/"))):
                raise ValueError(f"Unsafe repository path: {hub_path}")
        for field in ("json_sha256", "preview_sha256"):
            sha = pose.get(field) or ""
            if sha and (len(sha) != 64 or any(c not in "0123456789abcdefABCDEF" for c in sha)):
                raise ValueError(f"Invalid manifest entry {index}: {field}")
        name = sanitize_pose_name(pose.get("name") or os.path.splitext(os.path.basename(hub_json_path))[0])
        if not name:
            raise ValueError(f"Invalid manifest entry {index}: name required")
        category = str(pose.get("category") or infer_category_from_hub_path(hub_json_path) or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY
        if pose.get("asset_type") and pose["asset_type"] not in {POSE_ASSET_TYPE, ANIMATION_ASSET_TYPE}:
            raise ValueError(f"Invalid manifest entry {index}: asset_type")
        asset_type = ANIMATION_ASSET_TYPE if hub_json_path.replace("\\", "/").startswith("animations/") else normalize_asset_type(pose.get("asset_type"))
        pose_dir = get_pose_dir(repo_id, category, asset_type)
        target_json = os.path.join(pose_dir, f"{name}.json")
        preview_path = pose.get("preview_path") or ""
        targets = [(target_json, hub_json_path)]
        if preview_path:
            ext = os.path.splitext(preview_path)[1].lower()
            if ext not in {".webm", ".mp4", ".webp", ".jpg", ".jpeg", ".png"}:
                raise ValueError(f"Unsupported preview path: {preview_path}")
            targets.append((os.path.join(pose_dir, f"{name}{ext}"), preview_path))
        for target, source in targets:
            key = normalize_local_path(target).casefold()
            if key in destinations:
                raise ValueError(f"Conflicting manifest entries: {destinations[key]} and {source} target {os.path.relpath(target, get_library_path())}")
            destinations[key] = source
        if hub_json_path in pose_states:
            raise ValueError(f"Duplicate manifest JSON path: {hub_json_path}")
        pose_states[hub_json_path] = {"changed": False, "error": False}

        # Planned targets are always kept by cleanup so a failed download never
        # deletes a local file that is already present.
        expected_json_paths.add(target_json)
        try:
            if not local_file_matches(target_json, pose.get("json_sha256") or ""):
                download_jobs.append({
                    "pose_key": hub_json_path,
                    "hub_path": hub_json_path,
                    "target_path": target_json,
                    "expected_sha": pose.get("json_sha256") or "",
                    "expected_kind": "json",
                    "asset_type": asset_type,
                })

            hub_preview_path = pose.get("preview_path") or ""
            if hub_preview_path:
                try:
                    ext = os.path.splitext(hub_preview_path)[1].lower() or ".webp"
                    target_preview = os.path.join(pose_dir, f"{name}{ext}")
                    expected_preview_paths.add(target_preview)
                    if not local_file_matches(target_preview, pose.get("preview_sha256") or ""):
                        download_jobs.append({
                            "pose_key": hub_json_path,
                            "hub_path": hub_preview_path,
                            "target_path": target_preview,
                            "expected_sha": pose.get("preview_sha256") or "",
                            "expected_kind": "preview",
                            "asset_type": asset_type,
                        })
                except Exception as exc:
                    errors.append(f"{hub_preview_path}: {exc}")
                    pose_states[hub_json_path]["error"] = True
        except Exception as exc:
            errors.append(f"{hub_json_path}: {exc}")
            pose_states[hub_json_path]["error"] = True

    if download_jobs:
        downloaded_bytes = 0
        progress_start = 2
        progress_span = 94
        repository_progress_update(
            task_id,
            message=f"Downloading {len(download_jobs)} changed files...",
            current_file="",
            file_index=0,
            total_files=len(download_jobs),
            progress=progress_start,
        )
        for completed, job in enumerate(download_jobs, start=1):
            tmp_path = None
            try:
                tmp_path = download_hf_file(repo_id, job["hub_path"], token=token)
                if job["expected_kind"] == "json" and not isinstance(read_pose_json(tmp_path), dict):
                    raise ValueError("Library asset JSON must be an object")
                file_bytes = os.path.getsize(tmp_path)
                if downloaded_bytes + file_bytes > MAX_POSE_REPOSITORY_SYNC_BYTES:
                    raise ValueError(f"Repository sync exceeded the total download limit ({human_bytes(MAX_POSE_REPOSITORY_SYNC_BYTES)})")
                changed = copy_if_changed(tmp_path, job["target_path"], job.get("expected_sha") or "")
                downloaded_bytes += file_bytes
                if changed:
                    pose_states[job["pose_key"]]["changed"] = True
                if job.get("expected_kind") == "preview":
                    expected_preview_paths.add(job["target_path"])
                else:
                    expected_json_paths.add(job["target_path"])
            except Exception as exc:
                errors.append(f"{job['hub_path']}: {exc}")
                pose_states[job["pose_key"]]["error"] = True
            finally:
                if tmp_path:
                    try:
                        os.remove(tmp_path)
                    except Exception:
                        pass
            repository_progress_update(
                task_id,
                message=f"Downloaded {completed}/{len(download_jobs)} changed files...",
                current_file=job["hub_path"],
                file_index=completed,
                total_files=len(download_jobs),
                progress=progress_start + (completed / max(len(download_jobs), 1)) * progress_span,
            )
    else:
        repository_progress_update(task_id, message="All repository files are already up to date.", progress=96)

    downloaded = [
        pose_key
        for pose_key, state in pose_states.items()
        if state.get("changed") and not state.get("error")
    ]
    skipped = [
        pose_key
        for pose_key, state in pose_states.items()
        if not state.get("changed") and not state.get("error")
    ]

    removed = [] if errors else cleanup_local_repository_cache(repo_id, expected_json_paths, expected_preview_paths, task_id=task_id)

    return {
        "downloaded_count": len(downloaded),
        "skipped_count": len(skipped),
        "removed_count": len(removed),
        "downloaded": downloaded,
        "skipped": skipped,
        "removed": removed,
        "errors": errors,
    }

def publish_local_repository_to_hf(repo_id, token=None, create=False, private=False, task_id=None):
    repository_progress_fail(task_id, "Remote publishing is disabled by the VNCCS security policy")
    raise PermissionError("Remote publishing is disabled by the VNCCS security policy")


async def list_pose_repositories(request):
    return web.json_response({
        "local_repository": get_local_repository_info(),
        "repositories": load_pose_repositories(),
    })

async def repository_progress_status(request):
    return web.json_response(get_repository_progress(request.match_info.get("task_id")))

async def add_pose_repository(request):
    try:
        if not expected_content_length(request, 1024 * 1024):
            return web.json_response({"error": "Request body is too large"}, status=413)
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    repo_id = normalize_repo_id(data.get("repo_id"))
    task_id = str(data.get("task_id") or uuid.uuid4())
    if not repo_id:
        return web.json_response({"error": "Invalid Hugging Face repo id"}, status=400)
    repos = load_pose_repositories()
    if any(repo["repo_id"] == repo_id for repo in repos):
        return web.json_response({"error": "Repository already exists"}, status=400)
    user_repos = load_user_repositories()
    new_repository = {
        "repo_id": repo_id,
        "title": data.get("title") or repo_id,
        "description": data.get("description") or "",
        "manifest_path": data.get("manifest_path") or "pose_library.json",
        "enabled": True,
        "builtin": False,
        "asset_count": 0,
        "pose_count": 0,
        "animation_count": 0,
    }
    user_repos.append(new_repository)
    save_user_repositories(user_repos)

    # Add is a complete user action: registering a repository also downloads
    # its manifest, poses, and previews. The response is held until the cache is
    # ready, while the existing progress endpoint keeps the UI responsive.
    refreshed = await asyncio.to_thread(
        refresh_pose_repository,
        new_repository,
        task_id=task_id,
    )
    persist_refreshed_repositories([refreshed])
    return web.json_response({
        "success": True,
        "task_id": task_id,
        "repositories": load_pose_repositories(),
        "refreshed": refreshed,
    })

async def toggle_pose_repository(request):
    try:
        if not expected_content_length(request, 1024 * 1024):
            return web.json_response({"error": "Request body is too large"}, status=413)
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    repo_id = normalize_repo_id(data.get("repo_id"))
    enabled = bool(data.get("enabled"))
    task_id = str(data.get("task_id") or "")
    repository_progress_start(task_id, f"{'Enabling' if enabled else 'Disabling'} {repo_id}...")
    repository_progress_update(task_id, progress=20, message="Loading repository settings...")
    default_repos = load_default_repositories()
    user_repos = load_user_repositories()
    if any(repo["repo_id"] == repo_id for repo in default_repos):
        repository_progress_update(task_id, progress=45, message="Updating default repository override...")
        existing = next((repo for repo in user_repos if repo["repo_id"] == repo_id), None)
        if existing is None:
            base = next(repo for repo in default_repos if repo["repo_id"] == repo_id)
            existing = {**base, "builtin": False}
            user_repos.append(existing)
        existing["enabled"] = enabled
    else:
        repository_progress_update(task_id, progress=45, message="Updating user repository...")
        for repo in user_repos:
            if repo["repo_id"] == repo_id:
                repo["enabled"] = enabled
                break
        else:
            repository_progress_fail(task_id, "Repository not found")
            return web.json_response({"error": "Repository not found"}, status=404)
    repository_progress_update(task_id, progress=75, message="Saving repository settings...")
    save_user_repositories(user_repos)
    repository_progress_finish(task_id, f"{repo_id} {'enabled' if enabled else 'disabled'}.")
    return web.json_response({"success": True, "repositories": load_pose_repositories()})

async def delete_pose_repository(request):
    repo_id = normalize_repo_id(request.match_info.get("repo_id"))
    if not repo_id:
        return web.json_response({"error": "Repository required"}, status=400)
    if any(repo["repo_id"] == repo_id for repo in load_default_repositories()):
        return web.json_response({"error": "Default repositories can be disabled, not deleted"}, status=400)
    user_repos = [repo for repo in load_user_repositories() if repo["repo_id"] != repo_id]
    removed_count = remove_local_repository_cache(repo_id)
    save_user_repositories(user_repos)
    return web.json_response({"success": True, "repositories": load_pose_repositories(), "removed_count": removed_count})

def persist_refreshed_repositories(refreshed):
    user_repos = load_user_repositories()
    by_id = {repo["repo_id"]: repo for repo in user_repos}
    for repo in refreshed:
        if repo.get("builtin"):
            override = by_id.setdefault(repo["repo_id"], {**repo, "builtin": False})
            override.update({
                key: repo.get(key)
                for key in (
                    "enabled",
                    "asset_count",
                    "pose_count",
                    "animation_count",
                    "last_checked",
                    "last_error",
                    "status",
                    "sha",
                    "updated_at",
                    "downloaded_count",
                    "skipped_count",
                    "removed_count",
                    "transport",
                )
            })
        elif repo["repo_id"] in by_id:
            by_id[repo["repo_id"]].update(repo)
    save_user_repositories(list(by_id.values()))

def run_background_enabled_repository_refresh(task_id):
    try:
        repos = [repo for repo in load_pose_repositories() if repo.get("enabled", True)]
        if not repos:
            repository_progress_finish(task_id, "No enabled pose repositories to refresh.")
            return
        refreshed = []
        for index, repo in enumerate(repos):
            repository_progress_update(
                task_id,
                status="running",
                message=f"Refreshing {repo['repo_id']} ({index + 1}/{len(repos)})...",
                progress=(index / max(len(repos), 1)) * 100,
            )
            refreshed.append(refresh_pose_repository(repo, task_id=task_id))
        persist_refreshed_repositories(refreshed)
        failures = [f"{repo['repo_id']}: {repo['last_error']}" for repo in refreshed if repo.get("status") == "error"]
        if failures:
            repository_progress_fail(task_id, "; ".join(failures))
        else:
            repository_progress_finish(task_id, "Enabled pose repositories are up to date.")
    except Exception as exc:
        repository_progress_fail(task_id, exc)
    finally:
        with _BACKGROUND_REFRESH_LOCK:
            _BACKGROUND_REFRESH_STATE["running"] = False
            _BACKGROUND_REFRESH_STATE["last_finished"] = time.time()

async def auto_refresh_enabled_pose_repositories(request):
    now = time.time()
    try:
        if not expected_content_length(request, 1024 * 1024):
            return web.json_response({"error": "Request body is too large"}, status=413)
        data = await request.json()
    except Exception:
        data = {}
    force = bool(data.get("force"))
    with _BACKGROUND_REFRESH_LOCK:
        if _BACKGROUND_REFRESH_STATE["running"]:
            return web.json_response({
                "success": True,
                "started": False,
                "running": True,
                "task_id": _BACKGROUND_REFRESH_STATE["task_id"],
            })
        if not force and now - float(_BACKGROUND_REFRESH_STATE.get("last_started") or 0) < 300:
            return web.json_response({
                "success": True,
                "started": False,
                "running": False,
                "task_id": _BACKGROUND_REFRESH_STATE["task_id"],
            })
        task_id = f"repo-auto-{uuid.uuid4()}"
        _BACKGROUND_REFRESH_STATE.update({
            "running": True,
            "task_id": task_id,
            "last_started": now,
        })
    repository_progress_start(task_id, "Refreshing enabled pose repositories in background...")
    thread = threading.Thread(
        target=run_background_enabled_repository_refresh,
        args=(task_id,),
        daemon=True,
    )
    thread.start()
    return web.json_response({
        "success": True,
        "started": True,
        "running": True,
        "task_id": task_id,
    })

async def refresh_pose_repositories(request):
    try:
        if not expected_content_length(request, 1024 * 1024):
            return web.json_response({"error": "Request body is too large"}, status=413)
        data = await request.json()
    except Exception:
        data = {}
    repo_id = normalize_repo_id(data.get("repo_id"))
    task_id = str(data.get("task_id") or uuid.uuid4())
    repos = load_pose_repositories()
    targets = [repo for repo in repos if (not repo_id or repo["repo_id"] == repo_id)]
    refreshed = await asyncio.to_thread(
        lambda: [refresh_pose_repository(repo, task_id=task_id if len(targets) == 1 else f"{task_id}-{index}") for index, repo in enumerate(targets)]
    )
    persist_refreshed_repositories(refreshed)
    return web.json_response({"success": all(repo.get("status") != "error" for repo in refreshed), "task_id": task_id, "repositories": load_pose_repositories(), "refreshed": refreshed})

async def publish_local_pose_repository(request):
    return web.json_response(
        {"error": "Remote publishing is disabled by the VNCCS security policy"},
        status=403,
    )


def sanitize_pose_name(name):
    name = "".join(c for c in str(name or "") if c.isalnum() or c in "-_ ").strip()
    return name

def sanitize_path_segment(value, fallback):
    value = str(value or "").strip() or fallback
    value = value.replace("\\", "_").replace("/", "_")
    value = "".join(c for c in value if c.isalnum() or c in "-_ .").strip(" .")
    return value or fallback

def repository_to_dir(repository):
    repository = str(repository or LOCAL_USER_REPOSITORY).strip() or LOCAL_USER_REPOSITORY
    if repository == LOCAL_USER_REPOSITORY:
        return LOCAL_USER_REPOSITORY
    return sanitize_path_segment(repository.replace("/", "__"), LOCAL_USER_REPOSITORY)

def category_to_dir(category):
    return sanitize_path_segment(category or DEFAULT_CATEGORY, DEFAULT_CATEGORY)

def repository_dir_map():
    mapping = {LOCAL_USER_REPOSITORY: LOCAL_USER_REPOSITORY}
    for repo in load_pose_repositories():
        mapping[repository_to_dir(repo.get("repo_id"))] = repo.get("repo_id")
    return mapping

def get_pose_dir(repository, category, asset_type=POSE_ASSET_TYPE):
    lib_path = get_library_path()
    repo_dir = repository_to_dir(repository)
    category_dir = category_to_dir(category)
    return os.path.join(lib_path, repo_dir, asset_type_folder(asset_type), category_dir)

def asset_type_folder(asset_type):
    return "animations" if asset_type == ANIMATION_ASSET_TYPE else "poses"

def get_pose_path(repository, category, name, asset_type=POSE_ASSET_TYPE):
    return os.path.join(get_pose_dir(repository, category, asset_type), f"{name}.json")

def read_pose_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def get_raw_library_meta(pose_data):
    if not isinstance(pose_data, dict):
        return {}
    return pose_data.get("_library") if isinstance(pose_data.get("_library"), dict) else {}

def normalize_asset_type(value=None, pose_data=None):
    if isinstance(pose_data, dict) and isinstance(pose_data.get("animation"), dict):
        return ANIMATION_ASSET_TYPE
    normalized = str(value or "").strip().lower()
    return ANIMATION_ASSET_TYPE if normalized == ANIMATION_ASSET_TYPE else POSE_ASSET_TYPE

def normalize_library_tags(tags, asset_type=POSE_ASSET_TYPE):
    if isinstance(tags, str):
        tags = [tag.strip() for tag in tags.split(",")]
    normalized = []
    seen = set()
    for raw_tag in tags or []:
        tag = str(raw_tag).strip()
        if not tag:
            continue
        key = tag.casefold()
        if key == ANIMATION_SYSTEM_TAG.casefold():
            continue
        if key in seen:
            continue
        seen.add(key)
        normalized.append(tag)
    if asset_type == ANIMATION_ASSET_TYPE:
        normalized.insert(0, ANIMATION_SYSTEM_TAG)
    return normalized

def get_pose_meta(pose_data):
    if not isinstance(pose_data, dict):
        return {
            "repository": LOCAL_USER_REPOSITORY,
            "category": DEFAULT_CATEGORY,
            "tags": [],
            "asset_type": POSE_ASSET_TYPE,
        }
    meta = get_raw_library_meta(pose_data)
    repository = str(meta.get("repository") or LOCAL_USER_REPOSITORY).strip() or LOCAL_USER_REPOSITORY
    category = str(meta.get("category") or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY
    asset_type = normalize_asset_type(meta.get("asset_type"), pose_data)
    tags = normalize_library_tags(meta.get("tags") or [], asset_type)
    return {
        "repository": repository,
        "category": category,
        "tags": tags,
        "asset_type": asset_type,
    }

def set_pose_meta(pose_data, repository=None, category=None, tags=None, asset_type=None):
    if not isinstance(pose_data, dict):
        return pose_data
    meta = pose_data.get("_library") if isinstance(pose_data.get("_library"), dict) else {}
    resolved_asset_type = normalize_asset_type(asset_type or meta.get("asset_type"), pose_data)
    meta["asset_type"] = resolved_asset_type
    if repository is not None:
        meta["repository"] = str(repository or LOCAL_USER_REPOSITORY).strip() or LOCAL_USER_REPOSITORY
    if category is not None:
        meta["category"] = str(category or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY
    if tags is not None:
        meta["tags"] = normalize_library_tags(tags, resolved_asset_type)
    else:
        meta["tags"] = normalize_library_tags(meta.get("tags") or [], resolved_asset_type)
    pose_data["_library"] = meta
    return pose_data

def preview_candidates(folder_path, name):
    return [
        (os.path.join(folder_path, f"{name}.webm"), "video/webm"),
        (os.path.join(folder_path, f"{name}.mp4"), "video/mp4"),
        (os.path.join(folder_path, f"{name}.webp"), "image/webp"),
        (os.path.join(folder_path, f"{name}.jpg"), "image/jpeg"),
        (os.path.join(folder_path, f"{name}.jpeg"), "image/jpeg"),
        (os.path.join(folder_path, f"{name}.png"), "image/png"),
    ]

def find_preview(folder_path, name):
    for path, content_type in preview_candidates(folder_path, name):
        if os.path.exists(path):
            return path, content_type
    return None, None

def remove_previews(folder_path, name):
    for path, _ in preview_candidates(folder_path, name):
        if os.path.exists(path):
            os.remove(path)

def decode_preview_payload(preview_b64):
    if not preview_b64:
        return b"", ""
    mime_type = ""
    encoded = preview_b64
    if "," in preview_b64:
        header, encoded = preview_b64.split(",", 1)
        if header.startswith("data:"):
            mime_type = header[5:].split(";", 1)[0].strip().lower()
    try:
        return base64.b64decode(encoded, validate=True), mime_type
    except Exception as exc:
        raise ValueError("Preview payload is not valid base64") from exc

def prepare_image_preview_file(folder_path, raw):
    if len(raw) > MAX_PREVIEW_BYTES:
        raise ValueError("Preview image is too large")
    os.makedirs(folder_path, exist_ok=True)
    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
        image.thumbnail((768, 768), resample)
        fd, output_path = tempfile.mkstemp(prefix="vnccs_preview_", suffix=".webp", dir=folder_path)
        os.close(fd)
        image.save(output_path, "WEBP", quality=76, method=6)
        return output_path, ".webp"
    except Exception as exc:
        raise ValueError(f"Preview image could not be decoded: {exc}") from exc

def transcode_animation_preview(folder_path, raw, mime_type=""):
    if len(raw) > MAX_VIDEO_PREVIEW_INPUT_BYTES:
        raise ValueError("Animation preview video is too large")
    try:
        import av
    except ImportError as exc:
        raise ValueError("Animation preview transcoding requires ComfyUI's PyAV video support") from exc

    suffix_by_mime = {
        "video/webm": ".webm",
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
        "video/x-matroska": ".mkv",
        "video/ogg": ".ogv",
    }
    input_suffix = suffix_by_mime.get(mime_type, ".video")
    os.makedirs(folder_path, exist_ok=True)
    input_fd, input_path = tempfile.mkstemp(prefix="vnccs_preview_source_", suffix=input_suffix, dir=folder_path)
    os.close(input_fd)
    with open(input_path, "wb") as f:
        f.write(raw)

    codec_candidates = (
        ("libsvtav1", {"crf": "40", "preset": "8"}),
        ("libaom-av1", {"crf": "42", "cpu-used": "6", "row-mt": "1"}),
        ("librav1e", {"speed": "8", "quantizer": "120"}),
        ("libvpx-vp9", {"crf": "38", "b": "0", "deadline": "good", "cpu-used": "4", "row-mt": "1"}),
    )
    errors = []
    try:
        for codec_name, codec_options in codec_candidates:
            output_fd, output_path = tempfile.mkstemp(prefix="vnccs_preview_", suffix=".webm", dir=folder_path)
            os.close(output_fd)
            try:
                with av.open(input_path, mode="r") as source:
                    if not source.streams.video:
                        raise ValueError("Preview file contains no video stream")
                    source_stream = source.streams.video[0]
                    source_stream.thread_type = "AUTO"
                    source_rate = (
                        source_stream.average_rate
                        or getattr(source_stream, "base_rate", None)
                        or Fraction(24, 1)
                    )
                    try:
                        source_rate = Fraction(source_rate).limit_denominator(1001)
                    except Exception:
                        source_rate = Fraction(24, 1)
                    target_rate = min(source_rate, Fraction(24, 1))
                    if target_rate <= 0:
                        target_rate = Fraction(24, 1)

                    source_width = max(2, int(source_stream.width or 2))
                    source_height = max(2, int(source_stream.height or 2))
                    scale = min(1.0, 768.0 / max(source_width, source_height))
                    target_width = max(2, int(source_width * scale) // 2 * 2)
                    target_height = max(2, int(source_height * scale) // 2 * 2)

                    with av.open(output_path, mode="w", format="webm") as target:
                        output_stream = target.add_stream(codec_name, rate=target_rate)
                        output_stream.width = target_width
                        output_stream.height = target_height
                        output_stream.pix_fmt = "yuv420p"
                        output_stream.options = codec_options

                        output_index = 0
                        source_index = 0
                        next_time = 0.0
                        frame_interval = 1.0 / float(target_rate)
                        source_interval = 1.0 / max(float(source_rate), 1.0)
                        for frame in source.decode(source_stream):
                            frame_time = float(frame.time) if frame.time is not None else source_index * source_interval
                            source_index += 1
                            if frame_time + 1e-7 < next_time:
                                continue
                            while next_time <= frame_time + 1e-7:
                                next_time += frame_interval
                            encoded_frame = frame.reformat(
                                width=target_width,
                                height=target_height,
                                format="yuv420p",
                            )
                            encoded_frame.pts = output_index
                            encoded_frame.time_base = Fraction(target_rate.denominator, target_rate.numerator)
                            output_index += 1
                            for packet in output_stream.encode(encoded_frame):
                                target.mux(packet)
                        if output_index == 0:
                            raise ValueError("Preview file contains no decodable video frames")
                        for packet in output_stream.encode(None):
                            target.mux(packet)

                if os.path.getsize(output_path) > MAX_VIDEO_PREVIEW_STORED_BYTES:
                    raise ValueError("Encoded animation preview exceeds the repository file limit")
                return output_path, ".webm"
            except Exception as exc:
                errors.append(f"{codec_name}: {exc}")
                try:
                    os.remove(output_path)
                except Exception:
                    pass
        raise ValueError("No AV1/VP9 preview encoder is available: " + "; ".join(errors))
    finally:
        try:
            os.remove(input_path)
        except Exception:
            pass

def prepare_preview_file(folder_path, preview_b64, asset_type=POSE_ASSET_TYPE):
    if not preview_b64:
        return None
    raw, mime_type = decode_preview_payload(preview_b64)
    is_video = mime_type.startswith("video/")
    if asset_type == ANIMATION_ASSET_TYPE and is_video:
        return transcode_animation_preview(folder_path, raw, mime_type)
    if is_video:
        raise ValueError("Video previews are only supported for animation library items")
    return prepare_image_preview_file(folder_path, raw)

def install_prepared_preview(folder_path, name, prepared_preview):
    if not prepared_preview:
        return
    tmp_path, ext = prepared_preview
    target = os.path.join(folder_path, f"{name}{ext}")
    os.replace(tmp_path, target)
    for path, _ in preview_candidates(folder_path, name):
        if path != target and os.path.exists(path):
            os.remove(path)

def normalize_request_repository(value):
    return str(value or LOCAL_USER_REPOSITORY).strip() or LOCAL_USER_REPOSITORY

def normalize_request_category(value):
    return str(value or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY

def pose_file_location(path, pose_data, repo_map):
    parts = os.path.relpath(os.path.dirname(path), get_library_path()).split(os.sep)
    if parts == ["."]:
        parts = []
    meta = get_raw_library_meta(pose_data)
    typed = len(parts) >= 3 and parts[1] in {"poses", "animations"}
    repository = repo_map.get(parts[0], parts[0]) if parts else meta.get("repository") or LOCAL_USER_REPOSITORY
    category = meta.get("category") or (parts[2] if typed else parts[1] if len(parts) > 1 else DEFAULT_CATEGORY)
    asset_type = (ANIMATION_ASSET_TYPE if parts[1] == "animations" else POSE_ASSET_TYPE) if typed else get_pose_meta(pose_data)["asset_type"]
    return repository, category, asset_type

def build_pose_record(name, path, pose_data, full_details=False, repository=None, category=None, asset_type=None):
    meta = get_pose_meta(pose_data)
    repository = repository or meta.get("repository") or LOCAL_USER_REPOSITORY
    category = category or meta.get("category") or DEFAULT_CATEGORY
    asset_type = asset_type or meta["asset_type"]
    preview_path, preview_type = find_preview(os.path.dirname(path), name)
    return {
        "id": f"{repository_to_dir(repository)}/{asset_type_folder(asset_type)}/{category_to_dir(category)}/{name}",
        "name": name,
        "repository": repository,
        "repository_path": repository_to_dir(repository),
        "category": category,
        "category_path": category_to_dir(category),
        "tags": normalize_library_tags(meta["tags"], asset_type),
        "asset_type": asset_type,
        "is_animation": asset_type == ANIMATION_ASSET_TYPE,
        "has_preview": preview_path is not None,
        "preview_type": preview_type,
        "preview_mtime": int(os.path.getmtime(preview_path)) if preview_path else 0,
        "data": pose_data if full_details else None,
    }

def find_pose_file(name, repository=None, category=None, asset_type=None):
    name = sanitize_pose_name(name)
    if not name:
        return None, None, None
    if asset_type and asset_type not in {POSE_ASSET_TYPE, ANIMATION_ASSET_TYPE}:
        raise ValueError("Unknown library asset type")
    repo_map = repository_dir_map()
    matches = []
    for root, _dirs, files in walk_pose_library(get_library_path()):
        if f"{name}.json" not in files:
            continue
        path = os.path.join(root, f"{name}.json")
        try:
            data = read_pose_json(path)
        except Exception:
            continue
        found_repo, found_category, found_type = pose_file_location(path, data, repo_map)
        if repository and found_repo != repository or category and found_category != category or asset_type and found_type != asset_type:
            continue
        matches.append((path, found_repo, found_category))
    # New files take precedence over the same entity in the legacy layout.
    if repository and category and asset_type:
        target = get_pose_path(repository, category, name, asset_type)
        for match in matches:
            if match[0] == target:
                return match
    if len(matches) > 1:
        raise ValueError("Ambiguous library asset; specify repository, category and asset_type")
    return matches[0] if matches else (None, None, None)

def scan_poses(full_details=False):
    poses = {}
    repo_map = repository_dir_map()
    states = {repo["repo_id"]: bool(repo.get("enabled", True)) for repo in load_pose_repositories()}
    states[LOCAL_USER_REPOSITORY] = True
    for root, _dirs, files in walk_pose_library(get_library_path()):
        for filename in files:
            if not filename.endswith(".json") or filename in RESERVED_LIBRARY_JSON:
                continue
            name = sanitize_pose_name(filename[:-5])
            if not name:
                continue
            path = os.path.join(root, filename)
            try:
                data = read_pose_json(path)
            except Exception:
                continue
            repository, category, asset_type = pose_file_location(path, data, repo_map)
            if not states.get(repository, False):
                continue
            record = build_pose_record(name, path, data, full_details, repository, category, asset_type)
            canonical = get_pose_path(repository, category, name, asset_type)
            if record["id"] not in poses or path == canonical:
                poses[record["id"]] = record
    return sorted(poses.values(), key=lambda x: (x["repository"], x["category"], x["name"], x["asset_type"]))

async def list_poses(request):
    full_details = request.query.get("full") == "true"
    return await asyncio.to_thread(lambda: web.json_response({"poses": scan_poses(full_details)}))

async def get_pose(request):
    """GET /vnccs/pose_library/get/{name} - Returns pose data and preview."""
    name = sanitize_pose_name(request.match_info.get("name"))
    if not name:
        return web.json_response({"error": "Name required"}, status=400)

    repository = request.query.get("repository")
    category = request.query.get("category")
    try:
        pose_path, found_repository, found_category = find_pose_file(name, repository, category, request.query.get("asset_type"))
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    if not pose_path or not os.path.exists(pose_path):
        return web.json_response({"error": "Pose not found"}, status=404)

    pose_data = read_pose_json(pose_path)
    preview_path, preview_type = find_preview(os.path.dirname(pose_path), name)

    preview_b64 = None
    if preview_path and os.path.exists(preview_path) and not str(preview_type or "").startswith("video/"):
        with open(preview_path, "rb") as f:
            preview_b64 = base64.b64encode(f.read()).decode("utf-8")

    meta = get_pose_meta(pose_data)
    return web.json_response({
        "name": name,
        "repository": found_repository or meta.get("repository") or LOCAL_USER_REPOSITORY,
        "category": found_category or meta.get("category") or DEFAULT_CATEGORY,
        "pose": pose_data,
        "preview": preview_b64,
        "preview_type": preview_type,
        "tags": meta["tags"],
        "asset_type": pose_file_location(pose_path, pose_data, repository_dir_map())[2],
    })

async def save_pose(request):
    """POST /vnccs/pose_library/save - Saves a pose with optional preview."""
    try:
        if not expected_content_length(request, MAX_LIBRARY_SAVE_REQUEST_BYTES):
            return web.json_response({"error": "Request body is too large"}, status=413)
        data = await request.json()
    except:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    
    if not isinstance(data, dict):
        return web.json_response({"error": "Request must be an object"}, status=400)
    name = data.get("name")
    old_name = sanitize_pose_name(data.get("old_name") or "")
    pose = data.get("pose")
    preview_b64 = data.get("preview")  # Optional base64 PNG
    repository = normalize_request_repository(data.get("repository") or LOCAL_USER_REPOSITORY)
    old_repository = data.get("old_repository") or repository
    category = normalize_request_category(data.get("category"))
    old_category = data.get("old_category") or category
    tags = data.get("tags")
    asset_type = normalize_asset_type(data.get("asset_type"), pose)
    
    if not name or not isinstance(pose, dict) or not pose:
        return web.json_response({"error": "Name and pose required"}, status=400)
    if asset_type == ANIMATION_ASSET_TYPE and not isinstance(pose.get("animation"), dict):
        return web.json_response({"error": "Animation library items require a complete animation state"}, status=400)
    
    # Sanitize name
    name = sanitize_pose_name(name)
    if not name:
        return web.json_response({"error": "Invalid name"}, status=400)
    
    pose_dir = get_pose_dir(repository, category, asset_type)
    os.makedirs(pose_dir, exist_ok=True)
    pose_path = os.path.join(pose_dir, f"{name}.json")
    old_pose_path = None
    old_pose_dir = None
    old_name = old_name or name
    try:
        old_pose_path, _found_repo, _found_category = find_pose_file(old_name, old_repository, old_category, data.get("old_asset_type") or asset_type)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    old_pose_dir = os.path.dirname(old_pose_path) if old_pose_path else None

    pose = set_pose_meta(
        pose,
        repository=repository,
        category=category,
        tags=tags,
        asset_type=asset_type,
    )
    old_preview_path = None
    prepared_preview = None
    pose_tmp_path = None

    try:
        if preview_b64:
            prepared_preview = await asyncio.to_thread(
                prepare_preview_file,
                pose_dir,
                preview_b64,
                asset_type,
            )

        fd, pose_tmp_path = tempfile.mkstemp(prefix="vnccs_pose_", suffix=".json", dir=pose_dir)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(pose, f, indent=2)

        if old_pose_path and os.path.abspath(old_pose_path) != os.path.abspath(pose_path):
            old_preview_path, _ = find_preview(old_pose_dir, old_name)

        os.replace(pose_tmp_path, pose_path)
        pose_tmp_path = None

        if prepared_preview:
            install_prepared_preview(pose_dir, name, prepared_preview)
            prepared_preview = None
        elif old_preview_path:
            ext = os.path.splitext(old_preview_path)[1].lower() or ".webp"
            remove_previews(pose_dir, name)
            shutil.move(old_preview_path, os.path.join(pose_dir, f"{name}{ext}"))
        elif old_pose_path and old_pose_dir and os.path.abspath(old_pose_path) != os.path.abspath(pose_path):
            remove_previews(old_pose_dir, old_name)

        if old_pose_path and os.path.abspath(old_pose_path) != os.path.abspath(pose_path) and os.path.exists(old_pose_path):
            os.remove(old_pose_path)
    except ValueError as exc:
        message = str(exc)
        status = 413 if "too large" in message.lower() or "exceeds" in message.lower() else 400
        return web.json_response({"error": message}, status=status)
    except Exception as exc:
        return web.json_response({"error": f"Failed to save pose: {exc}"}, status=400)
    finally:
        leftovers = [pose_tmp_path]
        if prepared_preview:
            leftovers.append(prepared_preview[0])
        for leftover in leftovers:
            if leftover:
                try:
                    os.remove(leftover)
                except Exception:
                    pass

    return web.json_response({
        "success": True,
        "name": name,
        "repository": repository,
        "category": category,
        "asset_type": asset_type,
        "id": f"{repository_to_dir(repository)}/{asset_type_folder(asset_type)}/{category_to_dir(category)}/{name}",
        "path": os.path.relpath(pose_path, get_library_path()),
    })

async def delete_pose(request):
    """DELETE /vnccs/pose_library/delete/{name} - Deletes a pose."""
    name = sanitize_pose_name(request.match_info.get("name"))
    if not name:
        return web.json_response({"error": "Name required"}, status=400)

    try:
        pose_path, _repository, _category = find_pose_file(
            name, request.query.get("repository"), request.query.get("category"), request.query.get("asset_type"),
        )
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    if not pose_path or not os.path.exists(pose_path):
        return web.json_response({"error": "Pose not found"}, status=404)

    os.remove(pose_path)
    remove_previews(os.path.dirname(pose_path), name)

    return web.json_response({"success": True})

async def get_preview(request):
    """GET /vnccs/pose_library/preview/{name} - Returns preview image."""
    name = sanitize_pose_name(request.match_info.get("name"))
    if not name:
        return web.Response(status=400)

    try:
        pose_path, _repository, _category = find_pose_file(
            name, request.query.get("repository"), request.query.get("category"), request.query.get("asset_type"),
        )
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    if not pose_path:
        return web.Response(status=404)
    preview_path, content_type = find_preview(os.path.dirname(pose_path), name)

    if not preview_path or not os.path.exists(preview_path):
        return web.Response(status=404)

    with open(preview_path, "rb") as f:
        return web.Response(body=f.read(), content_type=content_type)

def register_routes(app):
    """Register Pose Library API routes."""
    app.router.add_get("/vnccs/pose_library/list", list_poses)
    app.router.add_get("/vnccs/pose_library/get/{name}", get_pose)
    app.router.add_post("/vnccs/pose_library/save", save_pose)
    app.router.add_delete("/vnccs/pose_library/delete/{name}", delete_pose)
    app.router.add_get("/vnccs/pose_library/preview/{name}", get_preview)
    app.router.add_get("/vnccs/pose_library/repositories", list_pose_repositories)
    app.router.add_get("/vnccs/pose_library/repositories/progress/{task_id}", repository_progress_status)
    app.router.add_post("/vnccs/pose_library/repositories/add", add_pose_repository)
    app.router.add_post("/vnccs/pose_library/repositories/toggle", toggle_pose_repository)
    app.router.add_delete("/vnccs/pose_library/repositories/delete/{repo_id:.+}", delete_pose_repository)
    app.router.add_post("/vnccs/pose_library/repositories/refresh", refresh_pose_repositories)
    app.router.add_post("/vnccs/pose_library/repositories/auto_refresh", auto_refresh_enabled_pose_repositories)
    app.router.add_post("/vnccs/pose_library/repositories/local/publish", publish_local_pose_repository)
