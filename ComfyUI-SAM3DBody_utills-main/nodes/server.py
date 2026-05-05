# Copyright (c) 2025 Andrea Pozzetti
# SPDX-License-Identifier: MIT
"""Server routes for the SAM 3D Body custom nodes.

Provides the REST endpoints the frontend extension uses to read
autosave / preset JSON from chara_settings_presets/.
"""

import os
import json
from aiohttp import web
from server import PromptServer

from .preset_pack import chara_settings_dir


routes = PromptServer.instance.routes


def _chara_dir() -> str:
    """Resolved lazily so edits to active_preset.ini take effect on the
    next HTTP request, no server restart needed."""
    return str(chara_settings_dir())


@routes.get('/sam3d/autosave')
async def get_autosave(request):
    """Return the contents of the active pack's chara_settings_presets/
    autosave.json, or an empty object if the file is missing / unreadable."""
    path = os.path.join(_chara_dir(), 'autosave.json')
    if not os.path.exists(path):
        return web.json_response({})
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return web.json_response(json.load(f))
    except Exception as exc:
        return web.json_response({'error': str(exc)}, status=500)


@routes.get('/sam3d/preset/{name}')
async def get_preset(request):
    """Return the contents of chara_settings_presets/{name}.json. Used
    by the frontend extension to apply preset values to slider widgets
    as soon as the user selects a preset in the dropdown. `autosave`
    is a first-class preset and is served through this route just like
    any other."""
    name = request.match_info.get('name', '')
    if not name or '/' in name or '\\' in name or '..' in name:
        return web.json_response({'error': 'invalid preset name'}, status=400)
    path = os.path.join(_chara_dir(), f'{name}.json')
    if not os.path.isfile(path):
        return web.json_response({'error': 'not found'}, status=404)
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return web.json_response(json.load(f))
    except Exception as exc:
        return web.json_response({'error': str(exc)}, status=500)


print("[SAM3DBody] Registered server routes:")
print("[SAM3DBody]   GET  /sam3d/autosave")
print("[SAM3DBody]   GET  /sam3d/preset/{name}")
