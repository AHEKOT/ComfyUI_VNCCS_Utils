import os
import json
import base64
from aiohttp import web

# Base path for PoseLibrary
def get_library_path():
    """Returns the path to PoseLibrary folder, creating it if needed."""
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    lib_path = os.path.join(base_dir, "PoseLibrary")
    os.makedirs(lib_path, exist_ok=True)
    return lib_path

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
            preview_path = os.path.join(lib_path, f"{name}.png")
            has_preview = os.path.exists(preview_path)
            
            pose_data = None
            if full_details:
                try:
                    with open(os.path.join(lib_path, filename), "r") as f:
                        pose_data = json.load(f)
                except:
                    pass

            poses.append({
                "name": name,
                "has_preview": has_preview,
                "data": pose_data
            })
    
    return web.json_response({"poses": sorted(poses, key=lambda x: x["name"])})

async def get_pose(request):
    """GET /vnccs/pose_library/get/{name} - Returns pose data and preview."""
    name = request.match_info.get("name")
    if not name:
        return web.json_response({"error": "Name required"}, status=400)
    
    lib_path = get_library_path()
    pose_path = os.path.join(lib_path, f"{name}.json")
    preview_path = os.path.join(lib_path, f"{name}.png")
    
    if not os.path.exists(pose_path):
        return web.json_response({"error": "Pose not found"}, status=404)
    
    with open(pose_path, "r") as f:
        pose_data = json.load(f)
    
    preview_b64 = None
    if os.path.exists(preview_path):
        with open(preview_path, "rb") as f:
            preview_b64 = base64.b64encode(f.read()).decode("utf-8")
    
    return web.json_response({
        "name": name,
        "pose": pose_data,
        "preview": preview_b64
    })

async def save_pose(request):
    """POST /vnccs/pose_library/save - Saves a pose with optional preview."""
    try:
        data = await request.json()
    except:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    
    name = data.get("name")
    pose = data.get("pose")
    preview_b64 = data.get("preview")  # Optional base64 PNG
    
    if not name or not pose:
        return web.json_response({"error": "Name and pose required"}, status=400)
    
    # Sanitize name
    name = "".join(c for c in name if c.isalnum() or c in "-_ ").strip()
    if not name:
        return web.json_response({"error": "Invalid name"}, status=400)
    
    lib_path = get_library_path()
    pose_path = os.path.join(lib_path, f"{name}.json")
    
    # Save pose data
    with open(pose_path, "w") as f:
        json.dump(pose, f, indent=2)
    
    # Save preview if provided
    if preview_b64:
        preview_path = os.path.join(lib_path, f"{name}.png")
        # Remove data URL prefix if present
        if "," in preview_b64:
            preview_b64 = preview_b64.split(",", 1)[1]
        try:
            with open(preview_path, "wb") as f:
                f.write(base64.b64decode(preview_b64))
        except:
            pass  # Ignore preview errors
    
    return web.json_response({"success": True, "name": name})

async def delete_pose(request):
    """DELETE /vnccs/pose_library/delete/{name} - Deletes a pose."""
    name = request.match_info.get("name")
    if not name:
        return web.json_response({"error": "Name required"}, status=400)
    
    lib_path = get_library_path()
    pose_path = os.path.join(lib_path, f"{name}.json")
    preview_path = os.path.join(lib_path, f"{name}.png")
    
    if not os.path.exists(pose_path):
        return web.json_response({"error": "Pose not found"}, status=404)
    
    os.remove(pose_path)
    if os.path.exists(preview_path):
        os.remove(preview_path)
    
    return web.json_response({"success": True})

async def get_preview(request):
    """GET /vnccs/pose_library/preview/{name} - Returns preview image."""
    name = request.match_info.get("name")
    if not name:
        return web.Response(status=400)
    
    lib_path = get_library_path()
    preview_path = os.path.join(lib_path, f"{name}.png")
    
    if not os.path.exists(preview_path):
        return web.Response(status=404)
    
    with open(preview_path, "rb") as f:
        return web.Response(body=f.read(), content_type="image/png")

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
