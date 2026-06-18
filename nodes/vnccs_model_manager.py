import os
import json
import aiohttp
from aiohttp import web
import server
import folder_paths
from huggingface_hub import hf_hub_download, hf_hub_url
import threading
import traceback
import asyncio
import requests
import queue
import urllib.parse
import time
import ipaddress
import socket

# Cache for model_updater.json to prevent excessive HEAD requests
# Structure: { repo_id: { "timestamp": float, "remote_timestamp": float, "path": str } }
_CONFIG_CACHE = {}
MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024 * 1024  # 100 GiB safety cap
REQUEST_TIMEOUT = (10, 60)

# Universal Type to force connections
class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False

# Instance for usage
any_type = AnyType("*")

# Helper to resolve paths relative to ComfyUI root
def resolve_path(relative_path):
    if not relative_path:
        return ""
    # Expand user (~)
    expanded = os.path.expanduser(relative_path)
    if os.path.isabs(expanded):
        return os.path.abspath(expanded)
    
    # Ensure folder_paths.base_path is valid
    base = getattr(folder_paths, "base_path", os.getcwd())
    return os.path.abspath(os.path.join(base, relative_path))

def _is_relative_safe_path(path):
    if not path:
        return False
    path = str(path).replace("\\", "/")
    if path.startswith(("~", "/", "\\")) or "://" in path:
        return False
    parts = [part for part in path.split("/") if part not in ("", ".")]
    return bool(parts) and ".." not in parts

def resolve_model_local_path(relative_path):
    """Resolve a model manifest path while preventing writes outside models/."""
    if not _is_relative_safe_path(relative_path):
        raise ValueError(f"Unsafe local_path: {relative_path!r}")

    base = os.path.abspath(getattr(folder_paths, "base_path", os.getcwd()))
    models_dir = os.path.abspath(getattr(folder_paths, "models_dir", os.path.join(base, "models")))
    normalized = str(relative_path).replace("\\", "/")
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if not parts or parts[0] != "models" or len(parts) < 2:
        raise ValueError("local_path must start with models/ and include a file path")

    target_abs = os.path.abspath(os.path.join(models_dir, *parts[1:]))

    if target_abs == models_dir or not target_abs.startswith(models_dir + os.sep):
        raise ValueError("local_path must stay inside the ComfyUI models directory")
    return target_abs

def _reject_local_download_ip(ip_text):
    ip = ipaddress.ip_address(ip_text)
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
        raise ValueError("Private or local download hosts are not allowed")

def validate_download_url(url):
    parsed = urllib.parse.urlparse(str(url or ""))
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("Only https download URLs are allowed")
    host = parsed.hostname or ""
    lowered = host.lower()
    if lowered in {"localhost", "localdomain"} or lowered.endswith(".localhost"):
        raise ValueError("Local download hosts are not allowed")
    try:
        _reject_local_download_ip(lowered)
    except ValueError as exc:
        if "download hosts" in str(exc):
            raise
    try:
        for family, _socktype, _proto, _canonname, sockaddr in socket.getaddrinfo(host, parsed.port or 443):
            if family in (socket.AF_INET, socket.AF_INET6):
                _reject_local_download_ip(sockaddr[0])
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve download host: {host}") from exc
    return urllib.parse.urlunparse(parsed)

def get_cached_config_path(repo_id, force_refresh=False):
    now = time.time()
    UI_CACHE_TTL = 300      # 5 minutes (return what we have quickly)
    UPDATE_CHECK_TTL = 3600 # 60 minutes (actually check for remote updates)

    cached = _CONFIG_CACHE.get(repo_id)

    # Tier 1: Return memory cache if very fresh
    if not force_refresh and cached and (now - cached.get("timestamp", 0) < UI_CACHE_TTL):
        if os.path.exists(cached["path"]):
            return cached["path"]

    # Tier 2: Check remote if enough time passed or forced
    needs_remote = force_refresh or not cached or (now - cached.get("remote_timestamp", 0) > UPDATE_CHECK_TTL)
    
    # Load user config for tokens
    user_config = get_vnccs_config()
    hf_token = user_config.get("hf_token")

    if needs_remote:
        try:
            print(f"[VNCCS] Checking for updates on HF: {repo_id}...")
            path = hf_hub_download(
                repo_id=repo_id, 
                filename="model_updater.json", 
                local_files_only=False,
                token=hf_token
            )
            _CONFIG_CACHE[repo_id] = {
                "timestamp": now, 
                "remote_timestamp": now, 
                "path": path
            }
            return path
        except Exception as e:
            err_str = str(e)
            print(f"[VNCCS] Remote config check failed: {err_str}")
            
            # Back-off on 429
            if "429" in err_str:
                print("[VNCCS] Rate limited (429). Will retry in 10 minutes.")
                if cached:
                    cached["remote_timestamp"] = now - (UPDATE_CHECK_TTL - 600)
            
            # Fallback to local
            if cached and os.path.exists(cached["path"]):
                return cached["path"]

    # Tier 3: Try local-only fallback
    try:
        path = hf_hub_download(
            repo_id=repo_id, 
            filename="model_updater.json", 
            local_files_only=True,
            token=hf_token
        )
        _CONFIG_CACHE[repo_id] = {
            "timestamp": now, 
            "remote_timestamp": cached.get("remote_timestamp", 0) if cached else 0, 
            "path": path
        }
        return path
    except Exception:
        if cached and os.path.exists(cached["path"]):
            return cached["path"]
        raise Exception(f"Config for {repo_id} not found locally or on hub.")


# --- Global Download Worker ---
# To prevent thread starvation and bandwidth contention, we serialize all large downloads
download_queue = queue.Queue()
download_status = {}

def worker_loop():
    while True:
        task = download_queue.get()
        if task is None:
            break
        
        repo_id, model_name, target_model = task
        
        # Support per-model repository override
        download_repo_id = target_model.get("hf_repo", repo_id)
        
        temp_path = None
        try:
            download_status[model_name] = {"status": "downloading", "message": "Initializing..."}
            
            url = ""
            headers = {}
            
            if "url" in target_model and target_model["url"]:
                # Direct URL (Civitai, etc.)
                url = target_model["url"]
                
                # --- Auto-Conversion for Civitai Web Links ---
                if "civitai.com/models/" in url and "api/download" not in url:
                    parsed = urllib.parse.urlparse(url)
                    qs = urllib.parse.parse_qs(parsed.query)
                    if "modelVersionId" in qs:
                        ver_id = qs["modelVersionId"][0]
                        url = f"https://civitai.com/api/download/models/{ver_id}"
                        print(f"[VNCCS] Auto-converted Civitai Web Link to API: {url}")

                url = validate_download_url(url)

                print(f"[VNCCS] Starting download from URL: {url}...")
                
                # Civitai specific: Add API key
                if "civitai.com" in url:
                    # Load token from user config
                    user_config = get_vnccs_config()
                    civitai_token = user_config.get("civitai_token", "")
                    
                    if civitai_token:
                        headers = {"Authorization": f"Bearer {civitai_token}"}
            else:
                # HuggingFace Logic
                # 1. Prepare filename (sanitize)
                filename = target_model["hf_path"]
                if filename.startswith(f"{download_repo_id}/"):
                    filename = filename[len(download_repo_id) + 1:]

                # Resolve URL and Token
                url = hf_hub_url(download_repo_id, filename)
                user_config = get_vnccs_config()
                token = user_config.get("hf_token")
                headers = {"Authorization": f"Bearer {token}"} if token else {}

            # Use requests for streaming download
            with getattr(requests, "request")("GET", url, headers=headers, stream=True, allow_redirects=True, timeout=REQUEST_TIMEOUT) as response:
                response.raise_for_status()

                total_size = int(response.headers.get('content-length', 0))
                if total_size > MAX_DOWNLOAD_BYTES:
                    raise ValueError("Download is larger than the allowed safety limit")
                downloadStart = 0

                # Temp file approach
                import tempfile
                temp_dir = os.path.join(folder_paths.base_path, "temp")
                os.makedirs(temp_dir, exist_ok=True)

                # Generate shorter temp name
                sanitized_name = "".join(x for x in model_name if x.isalnum()) or "model"
                fd, temp_path = tempfile.mkstemp(prefix=f"vnccs_{sanitized_name}_", suffix=".tmp", dir=temp_dir)
                os.close(fd)

                with open(temp_path, 'wb') as f:
                    for chunk in response.iter_content(chunk_size=1024 * 256):
                        if chunk:
                            f.write(chunk)
                            downloadStart += len(chunk)
                            if downloadStart > MAX_DOWNLOAD_BYTES:
                                raise ValueError("Download exceeded the allowed safety limit")
                            # Update status every chunk; assignment is atomic enough for UI polling.
                            if total_size > 0:
                                percent = (downloadStart / total_size) * 100
                                mb_done = downloadStart / (1024 * 1024)
                                mb_total = total_size / (1024 * 1024)
                                msg = f"{mb_done:.1f}/{mb_total:.1f} MB"
                                download_status[model_name] = {
                                    "status": "downloading",
                                    "message": msg,
                                    "progress": percent
                                }
                            else:
                                 mb_done = downloadStart / (1024 * 1024)
                                 download_status[model_name] = {
                                    "status": "downloading",
                                    "message": f"{mb_done:.1f} MB",
                                    "progress": 0
                                 }

            # 3. Install
            download_status[model_name]["message"] = "Installing..."
            target_abs_path = resolve_model_local_path(target_model["local_path"])
            target_dir = os.path.dirname(target_abs_path)
            os.makedirs(target_dir, exist_ok=True)
            
            import shutil
            shutil.move(temp_path, target_abs_path) # Move is instant usually
            temp_path = None
            
            # 4. Update registry
            update_installed_version(model_name, target_model["version"])
            print(f"[VNCCS] Successfully installed {model_name} to {target_abs_path}")
            download_status[model_name] = {"status": "success", "message": "Installed"}

        except Exception as e:
            print(f"[VNCCS] Failed to download {model_name}:")
            # Check for 401 specifically in the exception (requests raises HTTPError)
            is_auth_error = False
            if isinstance(e, requests.exceptions.HTTPError):
                if e.response.status_code == 401:
                    is_auth_error = True

            err_msg = str(e)
            status_code = "error"
            
            if is_auth_error:
                status_code = "auth_required"
                err_msg = "API Key Required"
            elif "404" in err_msg or "EntryNotFoundError" in err_msg:
                err_msg = "File not found (404)"
            
            download_status[model_name] = {"status": status_code, "message": err_msg}
            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except Exception:
                    pass
        finally:
            download_queue.task_done()

# Start background worker daemon
threading.Thread(target=worker_loop, daemon=True).start()

class VNCCS_ModelManager:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "repo_id": ("STRING", {"default": "MIUProject/VNCCS", "multiline": False}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("repo_id",)
    FUNCTION = "process"
    CATEGORY = "VNCCS/manager"

    def process(self, repo_id):
        # Simply pass through the repo_id so it can be used by other nodes
        return (repo_id,)


# --- API Endpoints ---

# Removed local download_status declaration as it is now global
@server.PromptServer.instance.routes.get("/vnccs/manager/status")
async def get_download_status(request):
    return web.json_response(download_status, headers={
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
    })

@server.PromptServer.instance.routes.get("/vnccs/utils/manager/status")
async def get_utils_download_status(request):
    return web.json_response(download_status, headers={
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
    })

def get_installed_version_info():
    # We'll store a local JSON file to track installed versions
    registry_path = resolve_path("vnccs_installed_models.json")
    if os.path.exists(registry_path):
        try:
            with open(registry_path, 'r') as f:
                return json.load(f)
        except:
            return {}
    return {}

def update_installed_version(model_name, version):
    registry_path = resolve_path("vnccs_installed_models.json")
    data = get_installed_version_info()
    data[model_name] = version
    with open(registry_path, 'w') as f:
        json.dump(data, f, indent=4)

# --- Configuration Management (User Settings) ---
def get_vnccs_config():
    config_path = resolve_path("vnccs_user_config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r') as f:
                return json.load(f)
        except:
            return {}
    return {}

def write_private_json(path, data):
    tmp_path = f"{path}.tmp.{os.getpid()}.{threading.get_ident()}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(tmp_path, flags, 0o600)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, indent=4)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        raise

def save_vnccs_config(new_data):
    config_path = resolve_path("vnccs_user_config.json")
    data = get_vnccs_config()
    data.update(new_data)
    write_private_json(config_path, data)

@server.PromptServer.instance.routes.post("/vnccs/manager/save_token")
async def save_api_token(request):
    try:
        data = await request.json()
        tokens = {}
        if "token" in data: # Legacy single token (Civitai)
            tokens["civitai_token"] = data["token"]
        if "civitai_token" in data:
            tokens["civitai_token"] = data["civitai_token"]
        if "hf_token" in data:
            tokens["hf_token"] = data["hf_token"]
            
        save_vnccs_config(tokens)
        return web.json_response({"status": "saved"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

@server.PromptServer.instance.routes.post("/vnccs/manager/set_active")
async def set_active_version(request):
    try:
        data = await request.json()
        model_name = data.get("model_name")
        version = data.get("version")
        
        if not model_name or not version:
            return web.json_response({"error": "Missing parameters"}, status=400)
            
        update_installed_version(model_name, version)
        return web.json_response({"status": "updated", "message": f"Set active version for {model_name} to {version}"})
        
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

@server.PromptServer.instance.routes.get("/vnccs/manager/check")
async def check_models(request):
    repo_id = request.rel_url.query.get("repo_id", "")
    if not repo_id:
        return web.json_response({"error": "No repo_id provided"}, status=400)

    # Validate Repo ID to prevent internal errors
    if " " in repo_id or repo_id.strip() == "":
         return web.json_response({"error": f"Invalid Repo ID format: '{repo_id}'"}, status=400)

    try:
        # Force refresh parameter from query string (default: use cache)
        force_refresh = request.rel_url.query.get("force_refresh", "").lower() == "true"

        def fetch_config():
            # Use cached config to prevent excessive HEAD requests
            path = get_cached_config_path(repo_id, force_refresh=force_refresh)
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = asyncio.get_event_loop()
            
        config = await loop.run_in_executor(None, fetch_config)
        
        # This file now acts as the "Active Version" registry
        active_registry = get_installed_version_info()
        
        # Group by name
        grouped_models = {}
        for model in config.get("models", []):
            name = model["name"]
            if name not in grouped_models:
                grouped_models[name] = []
            grouped_models[name].append(model)
            
        models_status = []
        for name, variants in grouped_models.items():
            # Sort variants by version desc
            try:
                from packaging import version
                variants.sort(key=lambda x: version.parse(x["version"]), reverse=True)
            except ImportError:
                variants.sort(key=lambda x: x["version"], reverse=True)
                
            latest = variants[0]
            
            # 1. Determine Active Version (User Selection)
            active_ver = active_registry.get(name, None)
            
            # 2. Determine ALL Installed Versions (Scan Disk)
            installed_versions = []
            for v in variants:
                try:
                    full_path = resolve_model_local_path(v["local_path"])
                    exists = os.path.exists(full_path)
                except ValueError:
                    full_path = ""
                    exists = False
                if force_refresh:
                    print(f"[VNCCS] Check: {name} v{v['version']} -> {full_path} [{'EXISTS' if exists else 'MISSING'}]")
                if exists:
                    installed_versions.append(v["version"])
            
            # Validate Active Version still exists
            if active_ver and active_ver not in installed_versions:
                 active_ver = None # Resets if file deleted
            
            # If no active version set, but we have installed versions, default to latest installed
            if not active_ver and installed_versions:
                # Find matching version object later, for now just pick the highest version string that is installed
                # Since variants is sorted desc, the first one that is in installed_versions is the "latest installed"
                for v in variants:
                    if v["version"] in installed_versions:
                        active_ver = v["version"]
                        # Auto-heal registry? optionally
                        break

            # Simplified status for the UI
            status = "missing"
            if active_ver:
                if active_ver == latest["version"]:
                    status = "installed"
                else:
                    status = "outdated"
            elif installed_versions:
                 status = "outdated" # Installed but not latest and not active?
            
            models_status.append({
                "name": name,
                "status": status,
                "active_version": active_ver,         # The currently selected/active version
                "installed_versions": installed_versions, # List of all versions physically present
                "version": latest["version"],        # Latest available
                "versions": variants,
                "description": latest.get("description", "")
            })
            
        return web.json_response({"models": models_status})
        
    except Exception as e:
        err_msg = str(e)
        if "HFValidationError" in err_msg or "Repo id" in err_msg:
             return web.json_response({"error": f"Invalid Repo ID: {repo_id}"}, status=400)
        elif "404" in err_msg or "NotFound" in err_msg:
             return web.json_response({"error": "Repository or Config not found"}, status=404)

        traceback.print_exc() # Print full stack trace to console
        return web.json_response({"error": f"{str(e)}"}, status=500)

@server.PromptServer.instance.routes.post("/vnccs/manager/download")
async def download_model(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
        
    repo_id = data.get("repo_id")
    model_name = data.get("model_name")
    target_version = data.get("version") # New field
    
    if not repo_id or " " in repo_id:
         return web.json_response({"error": "Invalid Repo ID"}, status=400)
    if model_name:
        download_status[model_name] = {
            "status": "queued",
            "message": f"Preparing v{target_version or 'latest'}..."
        }
    
    try:
        def fetch_config_sync():
            # Use cached config to avoid excessive HEAD requests
            path = get_cached_config_path(repo_id)
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = asyncio.get_event_loop()

        config = await loop.run_in_executor(None, fetch_config_sync)
        
        # Find specific version
        target_model = next((m for m in config["models"] if m["name"] == model_name and m["version"] == target_version), None)
        
        if not target_model:
            # Fallback for old clients or mistakes: pick latest
             target_model = next((m for m in config["models"] if m["name"] == model_name), None)
             
        if not target_model:
            return web.json_response({"error": f"Model '{model_name}' (v{target_version}) not found in config"}, status=404)

        try:
            resolve_model_local_path(target_model.get("local_path"))
            if target_model.get("url"):
                validate_download_url(target_model.get("url"))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
            
        # Add to Global Queue instead of spawning new thread directly
        # If queue is empty, it starts immediately. If busy, it waits.
        download_status[model_name] = {"status": "queued", "message": "Queued in backend..."} 
        download_queue.put((repo_id, model_name, target_model))
        
        return web.json_response({"status": "queued", "message": f"Download queued for {model_name}"})
        
    except Exception as e:
        if "HFValidationError" in str(e):
             return web.json_response({"error": "Invalid Repo ID"}, status=400)
        traceback.print_exc()
        return web.json_response({"error": str(e)}, status=500)
        

class VNCCS_ModelSelector:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "repo_id": ("STRING", {"default": "MIUProject/VNCCS", "multiline": False}),
            },
            "hidden": {
                "model_name": ("STRING", {"default": ""}), 
                "version": ("STRING", {"default": "auto"}),
            }
        }

    # Validator to allow dynamic values from frontend
    @classmethod
    def VALIDATE_INPUTS(cls, input_types):
        return True

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("model_path",)
    FUNCTION = "get_path"
    CATEGORY = "VNCCS/manager"

    def get_path(self, repo_id, model_name="", version="auto"):
        try:
            # 1. Fetch config and normalize inputs
            # Ensure we get fresh config if possible, but allow local for performance in workflow
            path = get_cached_config_path(repo_id)
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            models = data.get("models", [])
            target_name = str(model_name).strip()
            
            # 2. Determine Version
            # Priority: explicit input > registry > latest
            
            active_ver = None
            
            # Check explicit input "version" first (from frontend cache busting)
            if version and version != "auto" and version.strip():
                 active_ver = version.strip()
            else:
                # Fallback to backend registry
                registry = get_installed_version_info()
                active_ver = registry.get(target_name)
                if active_ver is None:
                    # Try case-insensitive search in registry
                    for k, v in registry.items():
                        if k.strip().lower() == target_name.lower():
                            active_ver = v
                            break
            
            def normalize_ver(v):
                return str(v).lower().lstrip('v').strip()

            found = None
            if active_ver:
                t_ver = normalize_ver(active_ver)
                # Filter models by name first (case-insensitive)
                matching_names = [m for m in models if m["name"].strip().lower() == target_name.lower()]
                
                # Search within those for the specific version
                for m in matching_names:
                    if normalize_ver(m["version"]) == t_ver:
                        found = m
                        break
                
                if found:
                    print(f"[VNCCS] ModelSelector: Found exact match for '{target_name}' v{found['version']} -> {found['local_path']}")
            
            # 3. Fallback to default (pick the latest version based on sorting) if active not found or not set
            if found is None:
                # Get all models with this name
                matching_names = [m for m in models if m["name"].strip().lower() == target_name.lower()]
                if matching_names:
                    # Sort them to get the latest (same logic as in check_models)
                    try:
                        from packaging import version
                        matching_names.sort(key=lambda x: version.parse(x["version"]), reverse=True)
                    except:
                        matching_names.sort(key=lambda x: str(x["version"]), reverse=True)
                    
                    found = matching_names[0]
                    if active_ver:
                        print(f"[VNCCS] ModelSelector: Requested version '{active_ver}' not found for '{target_name}'. Using latest: v{found['version']}")
                    else:
                        print(f"[VNCCS] ModelSelector: no preference. Using latest: v{found['version']} -> {found['local_path']}")

            if found:
                local_path = found["local_path"]
                try:
                    resolve_model_local_path(local_path)
                except ValueError as exc:
                    print(f"[VNCCS] ModelSelector: invalid local_path for '{model_name}': {exc}")
                    return ("",)
                # Normalize slashes to forward slash for processing
                norm_path = local_path.replace("\\", "/")
                
                # Intelligent relative path resolution for standard loaders
                # We strip standard prefixes to make it compatible with LoraLoader, CheckpointLoader, etc.
                
                standard_prefixes = [
                    "models/loras/", 
                    "models/checkpoints/", 
                    "models/vae/", 
                    "models/controlnet/", 
                    "models/style_models/",
                    "models/upscale_models/",
                    "models/clip/",
                    "models/unet/",
                    "models/diffusers/",
                    "models/configs/"
                ]
                
                relative_path = norm_path
                
                for prefix in standard_prefixes:
                    if norm_path.startswith(prefix):
                        # Strip prefix
                        relative_path = norm_path[len(prefix):]
                        break
                
                # Ensure relative path uses forward slashes (standard for ComfyUI keys)
                relative_path = relative_path.replace("\\", "/")
                
                print(f"[VNCCS] ModelSelector Result: {relative_path}")
                return (relative_path,)
            
            # Fallback
            print(f"[VNCCS] ModelSelector: Model '{model_name}' not found.")
            return ("",)
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"[VNCCS] ModelSelector Error: {e}")
            return ("",)
