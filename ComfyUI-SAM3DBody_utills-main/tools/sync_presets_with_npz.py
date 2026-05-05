"""Sync everything that depends on the FBX blend-shape set:

    presets/face_blendshapes.npz  (produced by extract_face_blendshapes.py)
           │
           ├─► chara_settings_presets/*.json
           │       Adds missing blend-shape keys (value = 0.0), removes
           │       keys that are no longer in the FBX.
           │
           └─► nodes/processing/process.py  _UI_BLENDSHAPE_ORDER
                   Rewrites the tuple so it matches the npz's shape
                   list. New shapes are inserted at the END of their
                   prefix-inferred category block (face / neck / chest
                   / shoulder / waist / limbs / other) so the UI stays
                   grouped by body region.

`tools/extract_face_blendshapes.py` calls `sync_all()` at the end of
its run, so manual invocation is only needed if you touched presets or
process.py between FBX updates.
"""

import json
import os
import re
import sys
from pathlib import Path

import numpy as np


_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent


def _active_pack_dir() -> Path:
    """Read active_preset.ini to find the active preset pack (stdlib only
    so this works from Blender's bundled Python, too)."""
    import configparser
    ini = _REPO_ROOT / "active_preset.ini"
    name = "default"
    if ini.exists():
        try:
            cp = configparser.ConfigParser()
            cp.read(ini, encoding="utf-8")
            name = cp.get("active", "pack", fallback="default").strip() or "default"
        except Exception:
            pass
    pack_dir = _REPO_ROOT / "presets" / name
    if not pack_dir.is_dir():
        pack_dir = _REPO_ROOT / "presets" / "default"
    return pack_dir


_PACK_DIR = _active_pack_dir()
_NPZ_PATH = _PACK_DIR / "face_blendshapes.npz"
_PRESETS_DIR = _PACK_DIR / "chara_settings_presets"
_PROCESS_PY = _REPO_ROOT / "nodes" / "processing" / "process.py"


# (category name, prefixes that map to it) — order here determines the
# section order in the rewritten _UI_BLENDSHAPE_ORDER tuple.
_CATEGORIES = [
    ("face",     ("face_", "chin_")),
    ("neck",     ("neck_",)),
    ("chest",    ("breast_", "chest_")),
    ("shoulder", ("shoulder_",)),
    ("waist",    ("waist_", "hip_")),
    ("limbs",    ("limb_", "hand_", "foot_")),
]


def _categorize(name: str) -> str:
    for cat, prefixes in _CATEGORIES:
        if any(name.startswith(p) for p in prefixes):
            return cat
    return "other"


def load_npz_shape_names(npz_path: Path = _NPZ_PATH) -> list:
    """Ordered list of blend-shape names stored in the npz's
    `meta_shapes` entry (empty list if missing)."""
    if not npz_path.exists():
        return []
    with np.load(npz_path) as npz:
        if "meta_shapes" in npz.files:
            return [str(s) for s in np.asarray(npz["meta_shapes"])]
    return []


# --------------------------------------------------------------------
# Preset JSON sync
# --------------------------------------------------------------------

def sync_preset_file(path: Path, valid_shapes: list) -> tuple:
    """Update a single preset JSON in place. Returns (added, removed)."""
    d = json.loads(path.read_text(encoding="utf-8"))
    bs = d.get("blendshapes", {}) if isinstance(d.get("blendshapes"), dict) else {}

    valid_set = set(valid_shapes)
    added = [n for n in valid_shapes if n not in bs]
    removed = [n for n in list(bs.keys()) if n not in valid_set]

    if not added and not removed:
        return [], []

    new_bs = {name: float(bs.get(name, 0.0)) for name in valid_shapes}
    d["blendshapes"] = new_bs

    path.write_text(
        json.dumps(d, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return added, removed


def sync_presets(valid_shapes: list,
                 presets_dir: Path = _PRESETS_DIR) -> None:
    if not presets_dir.is_dir():
        print(f"[sync] skip presets — {presets_dir} missing")
        return
    for fn in sorted(os.listdir(presets_dir)):
        if not fn.endswith(".json"):
            continue
        path = presets_dir / fn
        added, removed = sync_preset_file(path, valid_shapes)
        if added or removed:
            parts = []
            if added:
                parts.append(f"+{added}")
            if removed:
                parts.append(f"-{removed}")
            print(f"[sync] presets/{fn}: " + " ".join(parts))


# --------------------------------------------------------------------
# UI (_UI_BLENDSHAPE_ORDER) sync
# --------------------------------------------------------------------

_UI_TUPLE_RE = re.compile(
    r"(_UI_BLENDSHAPE_ORDER\s*=\s*)\((.*?)\)",
    re.DOTALL,
)


def _rebuild_ui_tuple_body(ordered_shapes: list) -> str:
    """Group `ordered_shapes` by category (preserving the order inside
    each category) and emit the tuple body with `# category` comments."""
    cat_to_items = {cat: [] for cat, _ in _CATEGORIES}
    cat_to_items["other"] = []
    for n in ordered_shapes:
        cat_to_items.setdefault(_categorize(n), []).append(n)

    lines = ["("]
    for cat, _ in _CATEGORIES:
        items = cat_to_items.get(cat, [])
        if not items:
            continue
        lines.append(f"    # {cat}")
        lines.append("    " + ", ".join(f'"{n}"' for n in items) + ",")
    if cat_to_items.get("other"):
        lines.append("    # other")
        lines.append("    " + ", ".join(f'"{n}"' for n in cat_to_items["other"]) + ",")
    lines.append(")")
    return "\n".join(lines)


def sync_ui_order(valid_shapes: list,
                  process_py: Path = _PROCESS_PY) -> None:
    if not process_py.exists():
        print(f"[sync] skip UI — {process_py} missing")
        return
    text = process_py.read_text(encoding="utf-8")
    match = _UI_TUPLE_RE.search(text)
    if not match:
        print(f"[sync] skip UI — _UI_BLENDSHAPE_ORDER not found in {process_py}")
        return

    existing = re.findall(r'"([^"]+)"', match.group(2))
    valid_set = set(valid_shapes)

    # Step 1: drop stale entries (preserving original order of survivors)
    filtered = [n for n in existing if n in valid_set]

    # Step 2: insert new entries at the END of their category block
    existing_set = set(existing)
    new_shapes = [n for n in valid_shapes if n not in existing_set]
    added = list(new_shapes)
    removed = [n for n in existing if n not in valid_set]

    for n in new_shapes:
        cat = _categorize(n)
        insert_at = len(filtered)
        for i in range(len(filtered) - 1, -1, -1):
            if _categorize(filtered[i]) == cat:
                insert_at = i + 1
                break
        else:
            # No existing entry in this category — place before the next
            # defined category, or at the end.
            cat_order = {c: i for i, (c, _) in enumerate(_CATEGORIES)}
            cat_order["other"] = len(_CATEGORIES)
            my_rank = cat_order.get(cat, len(_CATEGORIES))
            for i, item in enumerate(filtered):
                if cat_order.get(_categorize(item), len(_CATEGORIES)) > my_rank:
                    insert_at = i
                    break
            else:
                insert_at = len(filtered)
        filtered.insert(insert_at, n)

    if filtered == existing:
        return  # no change

    new_body = _rebuild_ui_tuple_body(filtered)
    new_text = text[:match.start()] + match.group(1) + new_body + text[match.end():]

    if new_text != text:
        process_py.write_text(new_text, encoding="utf-8")
        parts = []
        if added:
            parts.append(f"+{added}")
        if removed:
            parts.append(f"-{removed}")
        print("[sync] process.py _UI_BLENDSHAPE_ORDER: " + " ".join(parts))


# --------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------

def sync_all() -> None:
    valid = load_npz_shape_names()
    if not valid:
        print(f"[sync] skip — no shape names in {_NPZ_PATH}")
        return
    print(f"[sync] {len(valid)} shapes in npz")
    sync_presets(valid)
    sync_ui_order(valid)


def main():
    if not _NPZ_PATH.exists():
        print(f"ERROR: {_NPZ_PATH} not found. "
              f"Run tools/extract_face_blendshapes.py first.")
        sys.exit(1)
    sync_all()


if __name__ == "__main__":
    main()
