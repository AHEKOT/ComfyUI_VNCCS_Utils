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
from datetime import datetime, timezone
from aiohttp import web
from PIL import Image

DEFAULT_REPO_ID = "MIUProject/VNCCS_PoseLibrary_Main"
LOCAL_USER_REPOSITORY = "local_user_poses"
DEFAULT_CATEGORY = "Uncategorized"
RESERVED_LIBRARY_JSON = {"repositories.user.json", "pose_library.json"}
_REPOSITORY_PROGRESS = {}
_BACKGROUND_REFRESH_STATE = {
    "running": False,
    "task_id": "",
    "last_started": 0,
    "last_finished": 0,
}
_BACKGROUND_REFRESH_LOCK = threading.Lock()

def repository_progress_start(task_id, message="Starting repository operation..."):
    if not task_id:
        return
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

def repository_progress_update(task_id, **kwargs):
    if not task_id:
        return
    state = _REPOSITORY_PROGRESS.setdefault(task_id, {"status": "running", "progress": 0})
    state.update(kwargs)
    state["updated_at"] = time.time()

def repository_progress_finish(task_id, message="Done."):
    if not task_id:
        return
    repository_progress_update(task_id, status="success", message=message, progress=100)

def repository_progress_fail(task_id, message):
    if not task_id:
        return
    repository_progress_update(task_id, status="error", message=str(message), progress=100)

def get_repository_progress(task_id):
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

def save_vnccs_user_config(new_data):
    path = get_vnccs_user_config_path()
    data = get_vnccs_user_config()
    data.update(new_data)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)

def normalize_repo_id(repo_id):
    repo_id = str(repo_id or "").strip()
    if not repo_id or " " in repo_id or repo_id.count("/") != 1:
        return ""
    return repo_id

def load_default_repositories():
    path = get_default_repositories_path()
    fallback = {
        "repo_id": DEFAULT_REPO_ID,
        "title": "VNCCS Pose Library Main",
        "description": "Default curated VNCCS Pose Studio pose library.",
        "manifest_path": "pose_library.json",
        "enabled": True,
        "builtin": True,
    }
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        repos = data.get("repositories") or []
    except Exception:
        repos = [fallback]
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
    return out or [fallback]

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
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"schema_version": 1, "repositories": user_repos}, f, indent=2)

def load_pose_repositories():
    defaults = {repo["repo_id"]: repo for repo in load_default_repositories()}
    merged = {repo_id: dict(repo) for repo_id, repo in defaults.items()}
    for repo in load_user_repositories():
        repo_id = repo["repo_id"]
        merged[repo_id] = {**merged.get(repo_id, {}), **repo}
        if repo_id in defaults:
            merged[repo_id]["builtin"] = True
    return list(merged.values())

def get_hf_token():
    token = None
    try:
        user_config = get_vnccs_user_config()
        token = user_config.get("hf_token") or token
    except Exception:
        pass
    try:
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        config_path = os.path.join(base_dir, "vnccs_config.json")
        if os.path.exists(config_path):
            with open(config_path, "r", encoding="utf-8") as f:
                token = token or json.load(f).get("hf_token")
    except Exception:
        pass
    return token

def refresh_pose_repository(repo, task_id=None):
    repo_id = repo["repo_id"]
    manifest_path = repo.get("manifest_path") or "pose_library.json"
    repository_progress_start(task_id, f"Checking {repo_id}...")
    result = {
        **repo,
        "status": "unknown",
        "pose_count": int(repo.get("pose_count") or 0),
        "last_checked": time.time(),
        "last_error": "",
    }
    try:
        from huggingface_hub import HfApi
        token = get_hf_token()
        api = HfApi()
        repository_progress_update(task_id, message=f"Reading repository info for {repo_id}...", progress=2)
        info = api.repo_info(repo_id=repo_id, repo_type="model", token=token)
        result["sha"] = getattr(info, "sha", "") or ""
        try:
            manifest_file = download_hf_file_with_progress(
                repo_id=repo_id,
                path_in_repo=manifest_path,
                token=token,
                task_id=task_id,
                file_index=0,
                total_files=1,
            )
            with open(manifest_file, "r", encoding="utf-8") as f:
                manifest = json.load(f)
            try:
                os.remove(manifest_file)
            except Exception:
                pass
            poses = manifest.get("poses") or []
            sync_result = sync_pose_repository_files(repo, manifest, token, task_id=task_id)
            result["pose_count"] = len(poses)
            result["downloaded_count"] = sync_result["downloaded_count"]
            result["skipped_count"] = sync_result["skipped_count"]
            result["removed_count"] = sync_result["removed_count"]
            result["title"] = manifest.get("title") or result.get("title") or repo_id
            result["description"] = manifest.get("description") or result.get("description") or ""
            result["updated_at"] = manifest.get("updated_at") or ""
            result["status"] = "ok"
            repository_progress_finish(task_id, f"Repository sync complete: {sync_result['downloaded_count']} downloaded, {sync_result['skipped_count']} unchanged, {sync_result['removed_count']} removed.")
        except Exception:
            repository_progress_update(task_id, message=f"Manifest not found. Counting files in {repo_id}...", progress=50)
            files = api.list_repo_files(repo_id=repo_id, repo_type="model", token=token)
            result["pose_count"] = len([
                file for file in files
                if file.lower().endswith(".json") and os.path.basename(file) != manifest_path
            ])
            result["status"] = "ok"
            repository_progress_finish(task_id, f"Repository checked: {result['pose_count']} JSON files found, no pose manifest to sync.")
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

def download_hf_file_with_progress(repo_id, path_in_repo, token=None, task_id=None, file_index=0, total_files=1):
    from huggingface_hub import hf_hub_url
    import requests

    url = hf_hub_url(repo_id=repo_id, filename=path_in_repo, repo_type="model")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    fd, tmp_path = tempfile.mkstemp(prefix="vnccs_pose_repo_", suffix=os.path.splitext(path_in_repo)[1] or ".tmp")
    os.close(fd)
    bytes_done = 0
    total_bytes = 0
    try:
        with getattr(requests, "request")("GET", url, headers=headers, stream=True, allow_redirects=True, timeout=60) as response:
            response.raise_for_status()
            total_bytes = int(response.headers.get("content-length") or 0)
            repository_progress_update(
                task_id,
                message=f"Downloading {path_in_repo}...",
                current_file=path_in_repo,
                file_index=file_index + 1,
                total_files=total_files,
                bytes_done=0,
                bytes_total=total_bytes,
                progress=(file_index / max(total_files, 1)) * 100,
            )
            with open(tmp_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=1024 * 256):
                    if not chunk:
                        continue
                    f.write(chunk)
                    bytes_done += len(chunk)
                    file_fraction = (bytes_done / total_bytes) if total_bytes else 0
                    overall = ((file_index + file_fraction) / max(total_files, 1)) * 100
                    byte_msg = human_bytes(bytes_done)
                    if total_bytes:
                        byte_msg = f"{byte_msg}/{human_bytes(total_bytes)}"
                    repository_progress_update(
                        task_id,
                        message=f"Downloading {path_in_repo} ({byte_msg})",
                        current_file=path_in_repo,
                        file_index=file_index + 1,
                        total_files=total_files,
                        bytes_done=bytes_done,
                        bytes_total=total_bytes,
                        progress=overall,
                    )
        return tmp_path
    except Exception:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        raise

def download_hf_file(repo_id, path_in_repo, token=None):
    from huggingface_hub import hf_hub_url
    import requests

    url = hf_hub_url(repo_id=repo_id, filename=path_in_repo, repo_type="model")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    fd, tmp_path = tempfile.mkstemp(prefix="vnccs_pose_repo_", suffix=os.path.splitext(path_in_repo)[1] or ".tmp")
    os.close(fd)
    try:
        with getattr(requests, "request")("GET", url, headers=headers, stream=True, allow_redirects=True, timeout=60) as response:
            response.raise_for_status()
            with open(tmp_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=1024 * 256):
                    if chunk:
                        f.write(chunk)
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
            category = meta.get("category") or DEFAULT_CATEGORY
            preview_path, preview_type = find_preview(root, name)
            preview_ext = os.path.splitext(preview_path)[1].lower() if preview_path else ""
            category_dir = category_to_dir(category)
            safe_name = sanitize_pose_name(name)
            poses.append({
                "name": name,
                "category": category,
                "tags": meta.get("tags") or [],
                "json_path": path,
                "preview_path": preview_path,
                "preview_type": preview_type,
                "hub_json_path": f"poses/{category_dir}/{safe_name}.json",
                "hub_preview_path": f"previews/{category_dir}/{safe_name}{preview_ext}" if preview_path else "",
                "json_sha256": sha256_file(path),
                "preview_sha256": sha256_file(preview_path) if preview_path else "",
            })
    return sorted(poses, key=lambda item: (item["category"], item["name"]))

def get_local_repository_info():
    config = get_vnccs_user_config()
    poses = collect_local_pose_files()
    return {
        "repo_id": LOCAL_USER_REPOSITORY,
        "title": "Local User Poses",
        "description": "Poses saved locally from Pose Studio.",
        "pose_count": len(poses),
        "publish_repo_id": config.get("pose_library_publish_repo_id") or "",
        "has_hf_token": bool(get_hf_token()),
        "last_publish": config.get("pose_library_last_publish") or None,
        "last_publish_result": config.get("pose_library_last_publish_result") or None,
    }

def load_remote_pose_manifest(repo_id, token):
    try:
        from huggingface_hub import hf_hub_download
        manifest_file = hf_hub_download(
            repo_id=repo_id,
            filename="pose_library.json",
            repo_type="model",
            token=token,
            local_files_only=False,
        )
        with open(manifest_file, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        if not isinstance(manifest, dict):
            return {}
        return manifest
    except Exception:
        return {}

def remote_file_sha256(repo_id, path_in_repo, token):
    try:
        from huggingface_hub import hf_hub_download
        path = hf_hub_download(
            repo_id=repo_id,
            filename=path_in_repo,
            repo_type="model",
            token=token,
            local_files_only=False,
        )
        return sha256_file(path)
    except Exception:
        return ""

def infer_category_from_hub_path(path_in_repo):
    parts = [part for part in str(path_in_repo or "").replace("\\", "/").split("/") if part]
    if len(parts) >= 3 and parts[0] in {"poses", "previews"}:
        return parts[1]
    if len(parts) >= 2:
        return parts[-2]
    return DEFAULT_CATEGORY

def copy_if_changed(src_path, dst_path, expected_sha=""):
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    if os.path.exists(dst_path):
        try:
            current_sha = sha256_file(dst_path)
            source_sha = expected_sha or sha256_file(src_path)
            if current_sha == source_sha:
                return False
        except Exception:
            pass
    shutil.copy2(src_path, dst_path)
    return True

def local_file_matches(path, expected_sha):
    if not expected_sha or not os.path.exists(path):
        return False
    try:
        return sha256_file(path) == expected_sha
    except Exception:
        return False

def cleanup_local_repository_cache(repo_id, expected_json_paths, expected_preview_paths, task_id=None):
    repo_root = os.path.join(get_library_path(), repository_to_dir(repo_id))
    if not os.path.exists(repo_root):
        return []

    expected_json_paths = {os.path.abspath(path) for path in expected_json_paths}
    expected_preview_paths = {os.path.abspath(path) for path in expected_preview_paths if path}
    removed = []
    preview_exts = {".webp", ".jpg", ".jpeg", ".png"}

    for root, _dirs, files in os.walk(repo_root):
        for filename in files:
            path = os.path.join(root, filename)
            abs_path = os.path.abspath(path)
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
    if not os.path.exists(repo_root):
        return 0

    removed_count = 0
    for _root, _dirs, files in os.walk(repo_root):
        removed_count += len(files)
    shutil.rmtree(repo_root, ignore_errors=True)
    return removed_count

def download_pose_repository_file_job(repo_id, token, job):
    tmp_path = download_hf_file(repo_id, job["hub_path"], token=token)
    try:
        changed = copy_if_changed(tmp_path, job["target_path"], job.get("expected_sha") or "")
        return {**job, "changed": changed}
    finally:
        try:
            os.remove(tmp_path)
        except Exception:
            pass

def sync_pose_repository_files(repo, manifest, token, task_id=None):
    """Download new/changed pose files from a Hugging Face pose repository."""
    repo_id = repo["repo_id"]
    poses = manifest.get("poses") or []
    pose_states = {}
    download_jobs = []
    expected_json_paths = set()
    expected_preview_paths = set()
    errors = []

    for pose in poses:
        if not isinstance(pose, dict):
            continue
        hub_json_path = pose.get("json_path") or pose.get("path")
        if not hub_json_path:
            continue
        name = sanitize_pose_name(pose.get("name") or os.path.splitext(os.path.basename(hub_json_path))[0])
        if not name:
            continue
        category = str(pose.get("category") or infer_category_from_hub_path(hub_json_path) or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY
        pose_dir = get_pose_dir(repo_id, category)
        target_json = os.path.join(pose_dir, f"{name}.json")
        expected_json_paths.add(target_json)
        pose_states[hub_json_path] = {"changed": False, "error": False}

        try:
            if local_file_matches(target_json, pose.get("json_sha256") or ""):
                pass
            else:
                download_jobs.append({
                    "pose_key": hub_json_path,
                    "hub_path": hub_json_path,
                    "target_path": target_json,
                    "expected_sha": pose.get("json_sha256") or "",
                })

            hub_preview_path = pose.get("preview_path") or ""
            if hub_preview_path:
                try:
                    ext = os.path.splitext(hub_preview_path)[1].lower() or ".webp"
                    target_preview = os.path.join(pose_dir, f"{name}{ext}")
                    expected_preview_paths.add(target_preview)
                    if local_file_matches(target_preview, pose.get("preview_sha256") or ""):
                        pass
                    else:
                        download_jobs.append({
                            "pose_key": hub_json_path,
                            "hub_path": hub_preview_path,
                            "target_path": target_preview,
                            "expected_sha": pose.get("preview_sha256") or "",
                        })
                except Exception as exc:
                    errors.append(f"{hub_preview_path}: {exc}")
                    pose_states[hub_json_path]["error"] = True
        except Exception as exc:
            errors.append(f"{hub_json_path}: {exc}")
            pose_states[hub_json_path]["error"] = True

    if download_jobs:
        max_workers = min(8, max(2, len(download_jobs)))
        repository_progress_update(
            task_id,
            message=f"Downloading {len(download_jobs)} changed files with {max_workers} workers...",
            current_file="",
            file_index=0,
            total_files=len(download_jobs),
            progress=2,
        )
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(download_pose_repository_file_job, repo_id, token, job): job
                for job in download_jobs
            }
            for completed, future in enumerate(as_completed(futures), start=1):
                job = futures[future]
                try:
                    result = future.result()
                    if result.get("changed"):
                        pose_states[job["pose_key"]]["changed"] = True
                except Exception as exc:
                    errors.append(f"{job['hub_path']}: {exc}")
                    pose_states[job["pose_key"]]["error"] = True
                repository_progress_update(
                    task_id,
                    message=f"Downloaded {completed}/{len(download_jobs)} changed files...",
                    current_file=job["hub_path"],
                    file_index=completed,
                    total_files=len(download_jobs),
                    progress=2 + (completed / max(len(download_jobs), 1)) * 94,
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

    removed = cleanup_local_repository_cache(repo_id, expected_json_paths, expected_preview_paths, task_id=task_id)

    return {
        "downloaded_count": len(downloaded),
        "skipped_count": len(skipped),
        "removed_count": len(removed),
        "downloaded": downloaded,
        "skipped": skipped,
        "removed": removed,
        "errors": errors,
    }

def build_pose_manifest(repo_id, remote_manifest, local_poses, changed_paths):
    remote_poses = remote_manifest.get("poses") if isinstance(remote_manifest, dict) else []
    remote_by_json = {}
    for pose in remote_poses or []:
        if isinstance(pose, dict) and pose.get("json_path"):
            remote_by_json[pose["json_path"]] = pose

    now = datetime.now(timezone.utc).isoformat()
    manifest_poses = []
    for pose in local_poses:
        entry = {
            "name": pose["name"],
            "category": pose["category"],
            "tags": pose["tags"],
            "json_path": pose["hub_json_path"],
            "preview_path": pose["hub_preview_path"],
            "preview_type": pose["preview_type"],
            "json_sha256": pose["json_sha256"],
            "preview_sha256": pose["preview_sha256"],
            "updated_at": now,
        }
        previous = remote_by_json.get(pose["hub_json_path"])
        if previous and pose["hub_json_path"] not in changed_paths and pose["hub_preview_path"] not in changed_paths:
            entry["updated_at"] = previous.get("updated_at") or now
        manifest_poses.append(entry)

    title = remote_manifest.get("title") if isinstance(remote_manifest, dict) else ""
    return {
        "schema_version": 1,
        "title": title or "VNCCS Pose Library",
        "repo_id": repo_id,
        "updated_at": now,
        "poses": sorted(manifest_poses, key=lambda item: (item.get("category") or "", item.get("name") or "")),
    }

def collect_remote_pose_paths_to_delete(remote_manifest, local_poses, remote_files):
    local_paths = set()
    for pose in local_poses:
        local_paths.add(pose["hub_json_path"])
        if pose.get("hub_preview_path"):
            local_paths.add(pose["hub_preview_path"])

    delete_paths = set()
    remote_poses = remote_manifest.get("poses") if isinstance(remote_manifest, dict) else []
    for pose in remote_poses or []:
        if not isinstance(pose, dict):
            continue
        for key in ("json_path", "path", "preview_path"):
            path = str(pose.get(key) or "").strip()
            if path and path not in local_paths:
                delete_paths.add(path)

    if remote_manifest and remote_files:
        for path in remote_files:
            normalized = str(path or "").replace("\\", "/")
            if normalized.startswith(("poses/", "previews/")) and normalized not in local_paths:
                delete_paths.add(normalized)

    return sorted(path for path in delete_paths if path and path != "pose_library.json")

def delete_remote_pose_files(api, repo_id, token, paths, task_id=None):
    deleted = []
    errors = []
    for index, path in enumerate(paths):
        repository_progress_update(
            task_id,
            progress=min(86 + (index / max(len(paths), 1)) * 6, 92),
            message=f"Deleting {path}...",
            current_file=path,
            file_index=index + 1,
            total_files=len(paths),
        )
        try:
            delete_file = getattr(api, "delete_file", None)
            if callable(delete_file):
                delete_file(
                    path_in_repo=path,
                    repo_id=repo_id,
                    repo_type="model",
                    token=token,
                    commit_message=f"Delete stale pose file {path}",
                )
            else:
                from huggingface_hub import CommitOperationDelete
                api.create_commit(
                    repo_id=repo_id,
                    repo_type="model",
                    operations=[CommitOperationDelete(path_in_repo=path)],
                    token=token,
                    commit_message=f"Delete stale pose file {path}",
                )
            deleted.append(path)
        except Exception as exc:
            if "404" in str(exc) or "not found" in str(exc).lower():
                deleted.append(path)
            else:
                errors.append(f"{path}: {exc}")
    return deleted, errors

def upload_pose_repository_file_job(repo_id, token, job):
    from huggingface_hub import HfApi

    api = HfApi(token=token)
    api.upload_file(
        path_or_fileobj=job["local_path"],
        path_in_repo=job["hub_path"],
        repo_id=repo_id,
        repo_type="model",
        token=token,
        commit_message=job["commit_message"],
    )
    return job["hub_path"]

def publish_local_repository_to_hf(repo_id, token=None, create=False, private=False, task_id=None):
    repo_id = normalize_repo_id(repo_id)
    if not repo_id:
        raise ValueError("Invalid Hugging Face repo id")

    repository_progress_start(task_id, f"Publishing local poses to {repo_id}...")
    token = token or get_hf_token()
    if not token:
        repository_progress_fail(task_id, "Hugging Face token is required")
        raise ValueError("Hugging Face token is required")

    try:
        from huggingface_hub import HfApi
        api = HfApi(token=token)
        repository_progress_update(task_id, progress=2, message=f"Checking {repo_id}...")
        if create:
            api.create_repo(repo_id=repo_id, repo_type="model", private=bool(private), exist_ok=True)
        else:
            api.repo_info(repo_id=repo_id, repo_type="model", token=token)

        repository_progress_update(task_id, progress=8, message="Reading local poses...")
        local_poses = collect_local_pose_files()
        repository_progress_update(task_id, progress=12, message="Reading remote manifest...")
        remote_manifest = load_remote_pose_manifest(repo_id, token)
        remote_by_json = {
            pose.get("json_path"): pose
            for pose in (remote_manifest.get("poses") or [])
            if isinstance(pose, dict) and pose.get("json_path")
        }
        try:
            repository_progress_update(task_id, progress=16, message="Listing remote files...")
            remote_files = set(api.list_repo_files(repo_id=repo_id, repo_type="model", token=token))
        except Exception:
            remote_files = set()

        changed_paths = set()
        uploaded = []
        upload_jobs = []
        upload_errors = []
        deleted = []
        delete_errors = []
        skipped = []
        manifest_changed = not bool(remote_manifest)
        total_poses = max(len(local_poses), 1)
        for index, pose in enumerate(local_poses):
            base_progress = 18 + (index / total_poses) * 72
            repository_progress_update(
                task_id,
                progress=base_progress,
                message=f"Checking {pose['name']} ({index + 1}/{len(local_poses)})...",
                current_file=pose["hub_json_path"],
                file_index=index + 1,
                total_files=len(local_poses),
            )
            remote_pose = remote_by_json.get(pose["hub_json_path"]) or {}
            remote_json_sha = remote_pose.get("json_sha256")
            remote_preview_sha = remote_pose.get("preview_sha256")
            if not remote_json_sha and pose["hub_json_path"] in remote_files:
                remote_json_sha = remote_file_sha256(repo_id, pose["hub_json_path"], token)
            if not remote_preview_sha and pose["hub_preview_path"] in remote_files:
                remote_preview_sha = remote_file_sha256(repo_id, pose["hub_preview_path"], token)

            json_changed = remote_json_sha != pose["json_sha256"]
            preview_changed = bool(pose["hub_preview_path"]) and remote_preview_sha != pose["preview_sha256"]

            if json_changed:
                upload_jobs.append({
                    "local_path": pose["json_path"],
                    "hub_path": pose["hub_json_path"],
                    "commit_message": f"Update pose {pose['name']}",
                })
            if preview_changed:
                upload_jobs.append({
                    "local_path": pose["preview_path"],
                    "hub_path": pose["hub_preview_path"],
                    "commit_message": f"Update pose preview {pose['name']}",
                })
            if not json_changed and not preview_changed:
                skipped.append(pose["hub_json_path"])
            if (
                remote_pose.get("name") != pose["name"]
                or remote_pose.get("category") != pose["category"]
                or remote_pose.get("tags") != pose["tags"]
                or remote_pose.get("preview_path", "") != pose["hub_preview_path"]
                or remote_pose.get("preview_sha256", "") != pose["preview_sha256"]
                or remote_pose.get("json_sha256") != pose["json_sha256"]
            ):
                manifest_changed = True

        if upload_jobs:
            max_workers = min(8, max(2, len(upload_jobs)))
            repository_progress_update(
                task_id,
                progress=18,
                message=f"Uploading {len(upload_jobs)} changed files with {max_workers} workers...",
                current_file="",
                file_index=0,
                total_files=len(upload_jobs),
            )
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = {
                    executor.submit(upload_pose_repository_file_job, repo_id, token, job): job
                    for job in upload_jobs
                }
                for completed, future in enumerate(as_completed(futures), start=1):
                    job = futures[future]
                    try:
                        hub_path = future.result()
                        changed_paths.add(hub_path)
                        uploaded.append(hub_path)
                    except Exception as exc:
                        upload_errors.append(f"{job['hub_path']}: {exc}")
                    repository_progress_update(
                        task_id,
                        progress=18 + (completed / max(len(upload_jobs), 1)) * 64,
                        message=f"Uploaded {completed}/{len(upload_jobs)} changed files...",
                        current_file=job["hub_path"],
                        file_index=completed,
                        total_files=len(upload_jobs),
                    )
            if upload_errors:
                raise RuntimeError("Failed to upload changed pose files: " + "; ".join(upload_errors))

        stale_paths = collect_remote_pose_paths_to_delete(remote_manifest, local_poses, remote_files)
        if stale_paths:
            repository_progress_update(task_id, progress=86, message=f"Deleting {len(stale_paths)} stale remote files...")
            deleted, delete_errors = delete_remote_pose_files(api, repo_id, token, stale_paths, task_id=task_id)
            manifest_changed = True
            changed_paths.update(deleted)
            if delete_errors:
                raise RuntimeError("Failed to delete stale remote pose files: " + "; ".join(delete_errors))

        repository_progress_update(task_id, progress=92, message="Building pose manifest...")
        manifest = build_pose_manifest(repo_id, remote_manifest, local_poses, changed_paths)
        with tempfile.NamedTemporaryFile("wb", suffix=".json", delete=False) as f:
            f.write(json_bytes(manifest))
            manifest_tmp = f.name
        try:
            if changed_paths or manifest_changed:
                repository_progress_update(task_id, progress=96, message="Uploading pose_library.json...")
                api.upload_file(
                    path_or_fileobj=manifest_tmp,
                    path_in_repo="pose_library.json",
                    repo_id=repo_id,
                    repo_type="model",
                    token=token,
                    commit_message="Update VNCCS pose library manifest",
                )
                uploaded.append("pose_library.json")
        finally:
            try:
                os.remove(manifest_tmp)
            except Exception:
                pass
    except Exception as exc:
        repository_progress_fail(task_id, exc)
        raise

    result = {
        "repo_id": repo_id,
        "pose_count": len(local_poses),
        "uploaded_count": len(uploaded),
        "deleted_count": len(deleted),
        "skipped_count": len(skipped),
        "uploaded": uploaded,
        "deleted": deleted,
        "skipped": skipped,
        "changed": sorted(changed_paths),
        "manifest_pose_count": len(manifest.get("poses") or []),
    }
    save_vnccs_user_config({
        "hf_token": token,
        "pose_library_publish_repo_id": repo_id,
        "pose_library_last_publish": time.time(),
        "pose_library_last_publish_result": result,
    })
    repository_progress_finish(task_id, f"Published {len(uploaded)} files. Deleted {len(deleted)} stale files. {len(skipped)} poses unchanged.")
    return result

async def list_pose_repositories(request):
    return web.json_response({
        "local_repository": get_local_repository_info(),
        "repositories": load_pose_repositories(),
    })

async def repository_progress_status(request):
    return web.json_response(get_repository_progress(request.match_info.get("task_id")))

async def add_pose_repository(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    repo_id = normalize_repo_id(data.get("repo_id"))
    if not repo_id:
        return web.json_response({"error": "Invalid Hugging Face repo id"}, status=400)
    repos = load_pose_repositories()
    if any(repo["repo_id"] == repo_id for repo in repos):
        return web.json_response({"error": "Repository already exists"}, status=400)
    user_repos = load_user_repositories()
    user_repos.append({
        "repo_id": repo_id,
        "title": data.get("title") or repo_id,
        "description": data.get("description") or "",
        "manifest_path": data.get("manifest_path") or "pose_library.json",
        "enabled": True,
        "builtin": False,
        "pose_count": 0,
    })
    save_user_repositories(user_repos)
    return web.json_response({"success": True, "repositories": load_pose_repositories()})

async def toggle_pose_repository(request):
    try:
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
            override.update({k: repo.get(k) for k in ("enabled", "pose_count", "last_checked", "last_error", "status", "sha", "updated_at", "downloaded_count", "skipped_count", "removed_count")})
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
    return web.json_response({"success": True, "task_id": task_id, "repositories": load_pose_repositories(), "refreshed": refreshed})

async def publish_local_pose_repository(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    repo_id = normalize_repo_id(data.get("repo_id") or get_vnccs_user_config().get("pose_library_publish_repo_id"))
    token = data.get("hf_token") or get_hf_token()
    create = bool(data.get("create"))
    private = bool(data.get("private", False))
    task_id = str(data.get("task_id") or uuid.uuid4())
    if not repo_id:
        return web.json_response({"error": "Repository id is required"}, status=400)
    if not token:
        return web.json_response({"error": "Hugging Face token is required"}, status=401)

    try:
        result = await asyncio.to_thread(
            publish_local_repository_to_hf,
            repo_id,
            token=token,
            create=create,
            private=private,
            task_id=task_id,
        )
        return web.json_response({
            "success": True,
            "task_id": task_id,
            "local_repository": get_local_repository_info(),
            "result": result,
        })
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)

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

def get_pose_dir(repository, category):
    lib_path = get_library_path()
    repo_dir = repository_to_dir(repository)
    category_dir = category_to_dir(category)
    return os.path.join(lib_path, repo_dir, category_dir)

def get_pose_path(repository, category, name):
    return os.path.join(get_pose_dir(repository, category), f"{name}.json")

def read_pose_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def get_raw_library_meta(pose_data):
    if not isinstance(pose_data, dict):
        return {}
    return pose_data.get("_library") if isinstance(pose_data.get("_library"), dict) else {}

def get_pose_meta(pose_data):
    if not isinstance(pose_data, dict):
        return {"repository": LOCAL_USER_REPOSITORY, "category": DEFAULT_CATEGORY, "tags": []}
    meta = get_raw_library_meta(pose_data)
    repository = str(meta.get("repository") or LOCAL_USER_REPOSITORY).strip() or LOCAL_USER_REPOSITORY
    category = str(meta.get("category") or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY
    tags = meta.get("tags") or []
    if isinstance(tags, str):
        tags = [tag.strip() for tag in tags.split(",")]
    tags = [str(tag).strip() for tag in tags if str(tag).strip()]
    return {"repository": repository, "category": category, "tags": tags}

def set_pose_meta(pose_data, repository=None, category=None, tags=None):
    if not isinstance(pose_data, dict):
        return pose_data
    meta = pose_data.get("_library") if isinstance(pose_data.get("_library"), dict) else {}
    if repository is not None:
        meta["repository"] = str(repository or LOCAL_USER_REPOSITORY).strip() or LOCAL_USER_REPOSITORY
    if category is not None:
        meta["category"] = str(category or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY
    if tags is not None:
        if isinstance(tags, str):
            tags = [tag.strip() for tag in tags.split(",")]
        meta["tags"] = [str(tag).strip() for tag in (tags or []) if str(tag).strip()]
    pose_data["_library"] = meta
    return pose_data

def preview_candidates(folder_path, name):
    return [
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

def save_preview(folder_path, name, preview_b64):
    if not preview_b64:
        return
    if "," in preview_b64:
        preview_b64 = preview_b64.split(",", 1)[1]
    raw = base64.b64decode(preview_b64)
    os.makedirs(folder_path, exist_ok=True)
    remove_previews(folder_path, name)
    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
        image.thumbnail((768, 768), resample)
        output_path = os.path.join(folder_path, f"{name}.webp")
        image.save(output_path, "WEBP", quality=76, method=6)
    except Exception:
        output_path = os.path.join(folder_path, f"{name}.jpg")
        with open(output_path, "wb") as f:
            f.write(raw)

def normalize_request_repository(value):
    return str(value or LOCAL_USER_REPOSITORY).strip() or LOCAL_USER_REPOSITORY

def normalize_request_category(value):
    return str(value or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY

def build_pose_record(name, path, pose_data, full_details=False, repository=None, category=None):
    folder_path = os.path.dirname(path)
    meta = get_pose_meta(pose_data)
    repository = repository or meta.get("repository") or LOCAL_USER_REPOSITORY
    category = category or meta.get("category") or DEFAULT_CATEGORY
    preview_path, preview_type = find_preview(folder_path, name)
    preview_mtime = int(os.path.getmtime(preview_path)) if preview_path and os.path.exists(preview_path) else 0
    return {
        "id": f"{repository_to_dir(repository)}/{category_to_dir(category)}/{name}",
        "name": name,
        "repository": repository,
        "repository_path": repository_to_dir(repository),
        "category": category,
        "category_path": category_to_dir(category),
        "tags": meta["tags"],
        "has_preview": preview_path is not None,
        "preview_type": preview_type,
        "preview_mtime": preview_mtime,
        "data": pose_data if full_details else None,
    }

def find_pose_file(name, repository=None, category=None):
    name = sanitize_pose_name(name)
    if not name:
        return None, None, None

    lib_path = get_library_path()
    repository = str(repository or "").strip()
    category = str(category or "").strip()

    if repository and category:
        path = get_pose_path(repository, category, name)
        if os.path.exists(path):
            return path, repository, category

    legacy_path = os.path.join(lib_path, f"{name}.json")
    if os.path.exists(legacy_path):
        return legacy_path, LOCAL_USER_REPOSITORY, ""

    repo_map = repository_dir_map()
    for root, _dirs, files in os.walk(lib_path):
        filename = f"{name}.json"
        if filename not in files:
            continue
        path = os.path.join(root, filename)
        rel = os.path.relpath(root, lib_path)
        parts = [] if rel == "." else rel.split(os.sep)
        pose_data = None
        try:
            pose_data = read_pose_json(path)
        except Exception:
            pass
        raw_meta = get_raw_library_meta(pose_data)
        found_repo = repo_map.get(parts[0], parts[0]) if parts else (raw_meta.get("repository") or LOCAL_USER_REPOSITORY)
        found_category = raw_meta.get("category") or (parts[1] if len(parts) > 1 else DEFAULT_CATEGORY)
        if repository and found_repo != repository:
            continue
        if category and found_category != category:
            continue
        return path, found_repo, found_category
    return None, None, None

async def list_poses(request):
    """GET /vnccs/pose_library/list - Returns list of saved poses."""
    full_details = request.query.get("full") == "true"
    lib_path = get_library_path()
    poses = []

    repo_map = repository_dir_map()
    repository_states = {
        repo["repo_id"]: bool(repo.get("enabled", True))
        for repo in load_pose_repositories()
    }
    repository_states[LOCAL_USER_REPOSITORY] = True
    try:
        walker = os.walk(lib_path)
    except FileNotFoundError:
        return web.json_response({"poses": []})

    for root, _dirs, files in walker:
        rel = os.path.relpath(root, lib_path)
        parts = [] if rel == "." else rel.split(os.sep)
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
                pose_data = {}
            raw_meta = get_raw_library_meta(pose_data)
            repository = repo_map.get(parts[0], parts[0]) if parts else raw_meta.get("repository")
            category = raw_meta.get("category")
            if not repository:
                repository = repo_map.get(parts[0], parts[0]) if parts else LOCAL_USER_REPOSITORY
            if repository != LOCAL_USER_REPOSITORY and not repository_states.get(repository, False):
                continue
            if not category:
                category = parts[1] if len(parts) > 1 else DEFAULT_CATEGORY
            poses.append(build_pose_record(
                name,
                path,
                pose_data,
                full_details=full_details,
                repository=repository,
                category=category,
            ))

    return web.json_response({"poses": sorted(poses, key=lambda x: (x["repository"], x["category"], x["name"]))})

async def get_pose(request):
    """GET /vnccs/pose_library/get/{name} - Returns pose data and preview."""
    name = sanitize_pose_name(request.match_info.get("name"))
    if not name:
        return web.json_response({"error": "Name required"}, status=400)

    repository = request.query.get("repository")
    category = request.query.get("category")
    pose_path, found_repository, found_category = find_pose_file(name, repository, category)
    if not pose_path or not os.path.exists(pose_path):
        return web.json_response({"error": "Pose not found"}, status=404)

    pose_data = read_pose_json(pose_path)
    preview_path, preview_type = find_preview(os.path.dirname(pose_path), name)

    preview_b64 = None
    if preview_path and os.path.exists(preview_path):
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
    })

async def save_pose(request):
    """POST /vnccs/pose_library/save - Saves a pose with optional preview."""
    try:
        data = await request.json()
    except:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    
    name = data.get("name")
    old_name = sanitize_pose_name(data.get("old_name") or "")
    pose = data.get("pose")
    preview_b64 = data.get("preview")  # Optional base64 PNG
    repository = normalize_request_repository(data.get("repository") or LOCAL_USER_REPOSITORY)
    old_repository = data.get("old_repository") or repository
    category = normalize_request_category(data.get("category"))
    old_category = data.get("old_category") or category
    tags = data.get("tags")
    
    if not name or not pose:
        return web.json_response({"error": "Name and pose required"}, status=400)
    
    # Sanitize name
    name = sanitize_pose_name(name)
    if not name:
        return web.json_response({"error": "Invalid name"}, status=400)
    
    pose_dir = get_pose_dir(repository, category)
    os.makedirs(pose_dir, exist_ok=True)
    pose_path = os.path.join(pose_dir, f"{name}.json")
    old_pose_path = None
    old_pose_dir = None
    if old_name:
        old_pose_path, _found_repo, _found_category = find_pose_file(old_name, old_repository, old_category)
        old_pose_dir = os.path.dirname(old_pose_path) if old_pose_path else None

    if old_pose_path and os.path.abspath(old_pose_path) != os.path.abspath(pose_path):
        old_preview_path, _ = find_preview(old_pose_dir, old_name)
        if old_preview_path and not preview_b64:
            ext = os.path.splitext(old_preview_path)[1].lower() or ".webp"
            remove_previews(pose_dir, name)
            shutil.move(old_preview_path, os.path.join(pose_dir, f"{name}{ext}"))
        elif old_pose_dir:
            remove_previews(old_pose_dir, old_name)
        os.remove(old_pose_path)

    pose = set_pose_meta(pose, repository=repository, category=category, tags=tags)

    # Save pose data
    with open(pose_path, "w", encoding="utf-8") as f:
        json.dump(pose, f, indent=2)

    # Save preview if provided
    if preview_b64:
        try:
            save_preview(pose_dir, name, preview_b64)
        except:
            pass  # Ignore preview errors

    return web.json_response({
        "success": True,
        "name": name,
        "repository": repository,
        "category": category,
        "id": f"{repository_to_dir(repository)}/{category_to_dir(category)}/{name}",
        "path": os.path.relpath(pose_path, get_library_path()),
    })

async def delete_pose(request):
    """DELETE /vnccs/pose_library/delete/{name} - Deletes a pose."""
    name = sanitize_pose_name(request.match_info.get("name"))
    if not name:
        return web.json_response({"error": "Name required"}, status=400)

    pose_path, _repository, _category = find_pose_file(
        name,
        request.query.get("repository"),
        request.query.get("category"),
    )
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

    pose_path, _repository, _category = find_pose_file(
        name,
        request.query.get("repository"),
        request.query.get("category"),
    )
    if not pose_path:
        return web.Response(status=404)
    preview_path, content_type = find_preview(os.path.dirname(pose_path), name)

    if not preview_path or not os.path.exists(preview_path):
        return web.Response(status=404)

    with open(preview_path, "rb") as f:
        return web.Response(body=f.read(), content_type=content_type)

async def upload_pose_sync(request):
    """POST /vnccs/pose_sync/upload_capture - Saves synchronized capture for execution."""
    try:
        data = await request.json()
        node_id = data.get("node_id")
        if not node_id:
             return web.json_response({"error": "No node_id"}, status=400)
             
        import folder_paths
        temp_dir = folder_paths.get_temp_directory()
        # Note: we use 'debug' in the filename for backwards compatibility with the backend check
        filepath = os.path.join(temp_dir, f"vnccs_debug_{node_id}.json")
        
        with open(filepath, "w") as f:
            json.dump(data, f)
            
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

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
    app.router.add_post("/vnccs/pose_sync/upload_capture", upload_pose_sync)
    app.router.add_post("/vnccs/debug/upload_capture", upload_pose_sync)  # Aliased for backward compatibility
