import os
import json
import base64
import io
import shutil
from aiohttp import web
from PIL import Image

# Base path for PoseLibrary
def get_library_path():
    """Returns the path to PoseLibrary folder, creating it if needed."""
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    lib_path = os.path.join(base_dir, "PoseLibrary")
    os.makedirs(lib_path, exist_ok=True)
    return lib_path

def sanitize_pose_name(name):
    name = "".join(c for c in str(name or "") if c.isalnum() or c in "-_ ").strip()
    return name

def get_pose_meta(pose_data):
    if not isinstance(pose_data, dict):
        return {"category": "Uncategorized", "tags": []}
    meta = pose_data.get("_library") if isinstance(pose_data.get("_library"), dict) else {}
    category = str(meta.get("category") or "Uncategorized").strip() or "Uncategorized"
    tags = meta.get("tags") or []
    if isinstance(tags, str):
        tags = [tag.strip() for tag in tags.split(",")]
    tags = [str(tag).strip() for tag in tags if str(tag).strip()]
    return {"category": category, "tags": tags}

def set_pose_meta(pose_data, category=None, tags=None):
    if not isinstance(pose_data, dict):
        return pose_data
    meta = pose_data.get("_library") if isinstance(pose_data.get("_library"), dict) else {}
    if category is not None:
        meta["category"] = str(category or "Uncategorized").strip() or "Uncategorized"
    if tags is not None:
        if isinstance(tags, str):
            tags = [tag.strip() for tag in tags.split(",")]
        meta["tags"] = [str(tag).strip() for tag in (tags or []) if str(tag).strip()]
    pose_data["_library"] = meta
    return pose_data

def preview_candidates(lib_path, name):
    return [
        (os.path.join(lib_path, f"{name}.webp"), "image/webp"),
        (os.path.join(lib_path, f"{name}.jpg"), "image/jpeg"),
        (os.path.join(lib_path, f"{name}.jpeg"), "image/jpeg"),
        (os.path.join(lib_path, f"{name}.png"), "image/png"),
    ]

def find_preview(lib_path, name):
    for path, content_type in preview_candidates(lib_path, name):
        if os.path.exists(path):
            return path, content_type
    return None, None

def remove_previews(lib_path, name):
    for path, _ in preview_candidates(lib_path, name):
        if os.path.exists(path):
            os.remove(path)

def save_preview(lib_path, name, preview_b64):
    if not preview_b64:
        return
    if "," in preview_b64:
        preview_b64 = preview_b64.split(",", 1)[1]
    raw = base64.b64decode(preview_b64)
    remove_previews(lib_path, name)
    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
        image.thumbnail((768, 768), resample)
        output_path = os.path.join(lib_path, f"{name}.webp")
        image.save(output_path, "WEBP", quality=76, method=6)
    except Exception:
        output_path = os.path.join(lib_path, f"{name}.jpg")
        with open(output_path, "wb") as f:
            f.write(raw)

async def list_poses(request):
    """GET /vnccs/pose_library/list - Returns list of saved poses."""
    full_details = request.query.get("full") == "true"
    lib_path = get_library_path()
    poses = []
    
    # Optimistic listing: only read file stats if possible
    try:
        filenames = os.listdir(lib_path)
    except FileNotFoundError:
        return web.json_response({"poses": []})

    for filename in filenames:
        if filename.endswith(".json"):
            name = filename[:-5]  # Remove .json
            preview_path, preview_type = find_preview(lib_path, name)
            has_preview = preview_path is not None
            
            pose_data = None
            if full_details:
                try:
                    with open(os.path.join(lib_path, filename), "r") as f:
                        pose_data = json.load(f)
                except:
                    pass

            meta = get_pose_meta(pose_data) if pose_data is not None else {"category": "Uncategorized", "tags": []}
            poses.append({
                "name": name,
                "has_preview": has_preview,
                "preview_type": preview_type,
                "category": meta["category"],
                "tags": meta["tags"],
                "data": pose_data
            })
    
    return web.json_response({"poses": sorted(poses, key=lambda x: x["name"])})

async def get_pose(request):
    """GET /vnccs/pose_library/get/{name} - Returns pose data and preview."""
    name = sanitize_pose_name(request.match_info.get("name"))
    if not name:
        return web.json_response({"error": "Name required"}, status=400)
    
    lib_path = get_library_path()
    pose_path = os.path.join(lib_path, f"{name}.json")
    preview_path, preview_type = find_preview(lib_path, name)
    
    if not os.path.exists(pose_path):
        return web.json_response({"error": "Pose not found"}, status=404)
    
    with open(pose_path, "r") as f:
        pose_data = json.load(f)
    
    preview_b64 = None
    if preview_path and os.path.exists(preview_path):
        with open(preview_path, "rb") as f:
            preview_b64 = base64.b64encode(f.read()).decode("utf-8")
    
    return web.json_response({
        "name": name,
        "pose": pose_data,
        "preview": preview_b64,
        "preview_type": preview_type,
        **get_pose_meta(pose_data),
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
    category = data.get("category")
    tags = data.get("tags")
    
    if not name or not pose:
        return web.json_response({"error": "Name and pose required"}, status=400)
    
    # Sanitize name
    name = sanitize_pose_name(name)
    if not name:
        return web.json_response({"error": "Invalid name"}, status=400)
    
    lib_path = get_library_path()
    pose_path = os.path.join(lib_path, f"{name}.json")
    if old_name and old_name != name:
        old_pose_path = os.path.join(lib_path, f"{old_name}.json")
        if os.path.exists(old_pose_path):
            os.remove(old_pose_path)
        old_preview_path, _ = find_preview(lib_path, old_name)
        if old_preview_path and not preview_b64:
            ext = os.path.splitext(old_preview_path)[1].lower() or ".webp"
            remove_previews(lib_path, name)
            shutil.move(old_preview_path, os.path.join(lib_path, f"{name}{ext}"))
        else:
            remove_previews(lib_path, old_name)

    pose = set_pose_meta(pose, category=category, tags=tags)
    
    # Save pose data
    with open(pose_path, "w") as f:
        json.dump(pose, f, indent=2)
    
    # Save preview if provided
    if preview_b64:
        try:
            save_preview(lib_path, name, preview_b64)
        except:
            pass  # Ignore preview errors
    
    return web.json_response({"success": True, "name": name})

async def delete_pose(request):
    """DELETE /vnccs/pose_library/delete/{name} - Deletes a pose."""
    name = sanitize_pose_name(request.match_info.get("name"))
    if not name:
        return web.json_response({"error": "Name required"}, status=400)
    
    lib_path = get_library_path()
    pose_path = os.path.join(lib_path, f"{name}.json")
    
    if not os.path.exists(pose_path):
        return web.json_response({"error": "Pose not found"}, status=404)
    
    os.remove(pose_path)
    remove_previews(lib_path, name)
    
    return web.json_response({"success": True})

async def get_preview(request):
    """GET /vnccs/pose_library/preview/{name} - Returns preview image."""
    name = sanitize_pose_name(request.match_info.get("name"))
    if not name:
        return web.Response(status=400)
    
    lib_path = get_library_path()
    preview_path, content_type = find_preview(lib_path, name)
    
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
    app.router.add_post("/vnccs/pose_sync/upload_capture", upload_pose_sync)
    app.router.add_post("/vnccs/debug/upload_capture", upload_pose_sync)  # Aliased for backward compatibility
