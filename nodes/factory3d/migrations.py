"""Pure migrations; storage owns copying scene assets before activation."""
from __future__ import annotations

import copy
from typing import Any

SCENE_VERSION = 12


def migrate_scene_11_to_12(scene: dict[str, Any]) -> dict[str, Any]:
    version = scene.get("schema_version", 11)
    if version not in (11, 12):
        raise ValueError("Normalize legacy scenes to version 11 before upgrading; future versions are unsupported")
    result = copy.deepcopy(scene)
    if version == 12:
        return result
    result["schema_version"] = SCENE_VERSION
    # Legacy transforms and capture contracts stay explicit until their own
    # migrations are activated. Version 12 first enables procedural recipes.
    result["features"] = {"transforms": 1, "captures": 1, "procedural_geometry": 1}
    result["coordinate_system"] = "right-handed-y-up"
    result["units"] = "m"
    return result
