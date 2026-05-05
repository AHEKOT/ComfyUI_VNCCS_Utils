"""
Hand Pose Library API for Slimy_PoseStudio
Follows the same pattern as api/pose_library.py

Place this file at: api/hand_pose_library.py
"""

import os
import json
import base64
from pathlib import Path
from aiohttp import web

# HandPoseLibrary folder under plugin root
PLUGIN_ROOT = Path(os.path.dirname(os.path.abspath(__file__))).parent
LIBRARY_DIR = PLUGIN_ROOT / 'HandPoseLibrary'
LIBRARY_DIR.mkdir(exist_ok=True)


def register_routes(app):

    async def list_hand_poses(request):
        poses = []
        for json_file in sorted(LIBRARY_DIR.glob('*.json'), key=lambda f: f.stat().st_mtime, reverse=True):
            name = json_file.stem
            has_preview = (LIBRARY_DIR / f'{name}.png').exists()
            poses.append({'name': name, 'has_preview': has_preview})
        return web.json_response({'poses': poses})

    async def get_preview(request):
        name = request.match_info['name']
        png_path = LIBRARY_DIR / f'{name}.png'
        if not png_path.exists():
            return web.Response(status=404)
        return web.FileResponse(png_path)

    async def get_hand_pose(request):
        name = request.match_info['name']
        json_path = LIBRARY_DIR / f'{name}.json'
        if not json_path.exists():
            return web.json_response({'error': 'Not found'}, status=404)
        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return web.json_response(data)

    async def save_hand_pose(request):
        try:
            body = await request.json()
            name = body.get('name', '').strip()
            preset = body.get('preset')
            preview_b64 = body.get('preview')

            if not name or not preset:
                return web.json_response({'error': 'Missing name or preset'}, status=400)

            # Save JSON
            json_path = LIBRARY_DIR / f'{name}.json'
            with open(json_path, 'w', encoding='utf-8') as f:
                json.dump({'name': name, 'preset': preset}, f, ensure_ascii=False, indent=2)

            # Save PNG preview if provided
            if preview_b64:
                png_path = LIBRARY_DIR / f'{name}.png'
                if ',' in preview_b64:
                    preview_b64 = preview_b64.split(',', 1)[1]
                with open(png_path, 'wb') as f:
                    f.write(base64.b64decode(preview_b64))

            return web.json_response({'ok': True})
        except Exception as e:
            return web.json_response({'error': str(e)}, status=500)

    async def delete_hand_pose(request):
        name = request.match_info['name']
        json_path = LIBRARY_DIR / f'{name}.json'
        png_path = LIBRARY_DIR / f'{name}.png'
        if json_path.exists():
            json_path.unlink()
        if png_path.exists():
            png_path.unlink()
        return web.json_response({'ok': True})

    app.router.add_get('/vnccs/hand_pose_library/list', list_hand_poses)
    app.router.add_get('/vnccs/hand_pose_library/preview/{name}', get_preview)
    app.router.add_get('/vnccs/hand_pose_library/get/{name}', get_hand_pose)
    app.router.add_post('/vnccs/hand_pose_library/save', save_hand_pose)
    app.router.add_delete('/vnccs/hand_pose_library/delete/{name}', delete_hand_pose)
