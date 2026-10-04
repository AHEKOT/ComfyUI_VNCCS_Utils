# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Registry of model names and Hugging Face repo IDs for Kimodo and TMR.

Canonical source of truth is the list of repo IDs. Short keys (e.g. soma-rp) and metadata (dataset,
skeleton, version, display name) are derived by parsing.
"""

import re
from dataclasses import dataclass
from typing import Optional

# Canonical list: repo IDs in the same syntax as Hugging Face (org/Model-Name-v1).
# Parser expects: org/Family-SKELETON-DATASET-version (e.g. Kimodo-SOMA-RP-v1).
KIMODO_REPO_IDS = [
    "nvidia/Kimodo-SOMA-RP-v1",
    "nvidia/Kimodo-SOMA-RP-v1.1",
    "nvidia/Kimodo-SMPLX-RP-v1",
    "nvidia/Kimodo-G1-RP-v1",
    "nvidia/Kimodo-SOMA-SEED-v1",
    "nvidia/Kimodo-SOMA-SEED-v1.1",
    "nvidia/Kimodo-G1-SEED-v1",
]
TMR_REPO_IDS = [
    "nvidia/TMR-SOMA-RP-v1",
]

# Repo ID without org, for display (e.g. Kimodo-SOMA-RP-v1).
_REPO_NAME_PATTERN = re.compile(r"^(Kimodo|TMR)-([A-Za-z0-9]+)-(RP|SEED)-v(\d+(?:\.\d+)*)$")


@dataclass
class ModelInfo:
    """Structured metadata for one model, derived from its repo ID."""

    repo_id: str
    short_key: str
    family: str
    skeleton: str
    dataset: str
    version: str
    display_name: str

    @property
    def dataset_ui_label(self) -> str:
        return "Rigplay" if self.dataset == "RP" else "SEED"


def _parse_repo_id(repo_id: str) -> Optional[ModelInfo]:
    """Parse a repo ID into ModelInfo.

    Returns None if format is unrecognized.
    """
    # repo_id is "org/Model-Name-v1"
    if "/" in repo_id:
        _, name = repo_id.split("/", 1)
    else:
        name = repo_id
    m = _REPO_NAME_PATTERN.match(name)
    if not m:
        return None
    family, skeleton, dataset, ver = m.groups()
    # Normalize skeleton for display (as is for now)
    skeleton_display = skeleton
    # Include family so Kimodo-SOMA-RP and TMR-SOMA-RP have distinct keys.
    short_key = f"{family.lower()}-{skeleton.lower()}-{dataset.lower()}"
    return ModelInfo(
        repo_id=repo_id,
        short_key=short_key,
        family=family,
        skeleton=skeleton_display,
        dataset=dataset,
        version=f"v{ver}",
        display_name=name,
    )


def _version_tuple(v: str) -> tuple[int, ...]:
    """Parse 'vN' or 'vN.M' into a comparable tuple of ints."""
    if v.startswith("v"):
        parts = v[1:].split(".")
        if all(p.isdigit() for p in parts):
            return tuple(int(p) for p in parts)
    return (0,)


def _version_key(info: ModelInfo) -> tuple[int, ...]:
    return _version_tuple(info.version)


def _build_registry() -> tuple[list[ModelInfo], dict[str, str], list[str]]:
    """Build model infos, short_key -> repo_id map, and list of short keys.

    When multiple versions exist for the same (family, skeleton, dataset), each ModelInfo gets a
    version-specific short_key (e.g. kimodo-soma-rp-v1, kimodo-soma-rp-v2) and a versionless alias
    (kimodo-soma-rp) is added to MODEL_NAMES pointing to the latest version.  When only one version
    exists, the short_key stays versionless (e.g. kimodo-smplx-rp).
    """
    all_repos = KIMODO_REPO_IDS + TMR_REPO_IDS
    infos: list[ModelInfo] = []
    for repo_id in all_repos:
        info = _parse_repo_id(repo_id)
        if info is None:
            raise ValueError(f"Registry repo ID does not match expected pattern: {repo_id}")
        infos.append(info)

    # Group by base short_key to detect multi-version families.
    base_groups: dict[str, list[ModelInfo]] = {}
    for info in infos:
        base_groups.setdefault(info.short_key, []).append(info)

    # For groups with multiple versions, make each short_key version-specific.
    for base_key, group in base_groups.items():
        if len(group) > 1:
            for info in group:
                info.short_key = f"{base_key}-{info.version}"

    # Map each (now unique) short_key to its repo_id.
    model_names: dict[str, str] = {}
    for info in infos:
        model_names[info.short_key] = info.repo_id

    # Add versionless aliases for multi-version groups, pointing to the latest.
    for base_key, group in base_groups.items():
        if len(group) > 1:
            latest = max(group, key=_version_key)
            model_names[base_key] = latest.repo_id

    return infos, model_names, list(model_names.keys())


MODEL_INFOS, MODEL_NAMES, _SHORT_KEYS = _build_registry()
AVAILABLE_MODELS = _SHORT_KEYS

# Short-key lists for Kimodo vs TMR (load_model uses TMR_MODELS to branch).
KIMODO_MODELS = [info.short_key for info in MODEL_INFOS if info.family == "Kimodo"]
TMR_MODELS = [info.short_key for info in MODEL_INFOS if info.family == "TMR"]

# Backward compatibility: FRIENDLY_NAMES for any code that still expects it.
# Includes versioned short_keys and versionless aliases (latest display name).
FRIENDLY_NAMES = {info.short_key: info.display_name for info in MODEL_INFOS}
for _key, _repo_id in MODEL_NAMES.items():
    if _key not in FRIENDLY_NAMES:
        for _info in MODEL_INFOS:
            if _info.repo_id == _repo_id:
                FRIENDLY_NAMES[_key] = _info.display_name
                break

DEFAULT_MODEL = "kimodo-soma-rp"
DEFAULT_TEXT_ENCODER_URL = "http://127.0.0.1:9550/"

# Friendly names for skeleton dropdown (key -> label).
SKELETON_DISPLAY_NAMES = {
    "SOMA": "SOMA Human Body",
    "SMPLX": "SMPLX Human Body",
    "G1": "Unitree G1 Humanoid Robot",
}

# Order for skeleton dropdown: SOMA, SMPLX, G1.
SKELETON_ORDER = ("SOMA", "SMPLX", "G1")


def get_skeleton_display_name(skeleton_key: str) -> str:
    """Return the UI label for a skeleton key (e.g. SOMA -> SOMA Human Body)."""
    return SKELETON_DISPLAY_NAMES.get(skeleton_key, skeleton_key)


def get_skeleton_key_from_display_name(display_name: str) -> Optional[str]:
    """Return the skeleton key for a UI label, or None."""
    for key, label in SKELETON_DISPLAY_NAMES.items():
        if label == display_name:
            return key
    return None


def get_skeleton_display_names_for_dataset(dataset_ui_label: str, family: Optional[str] = None) -> list[str]:
    """Return skeleton UI labels for the given dataset.

    If family is set (e.g. "Kimodo"), only skeletons with a model of that family are included.
    """
    keys = get_skeletons_for_dataset(dataset_ui_label, family=family)
    return [get_skeleton_display_name(k) for k in keys]


def get_short_key(repo_id: str) -> Optional[str]:
    """Return the short key for a repo ID, or None if not in registry."""
    for info in MODEL_INFOS:
        if info.repo_id == repo_id:
            return info.short_key
    return None


def get_model_info(short_key: str) -> Optional[ModelInfo]:
    """Return ModelInfo for a short key, or None if not found.

    When multiple versions share the same short_key, returns the one used for loading (the latest
    version), so CHECKPOINT_DIR and HF use the same version.
    """
    repo_id = MODEL_NAMES.get(short_key)
    if repo_id is None:
        return None
    for info in MODEL_INFOS:
        if info.repo_id == repo_id:
            return info
    return None


def get_short_key_from_display_name(display_name: str) -> Optional[str]:
    """Return short_key for a display name (e.g. Kimodo-SOMA-RP-v1), or None."""
    for info in MODEL_INFOS:
        if info.display_name == display_name:
            return info.short_key
    return None


def get_models_for_demo() -> list[ModelInfo]:
    """Return all model infos in registry order (for demo model list)."""
    return list(MODEL_INFOS)


def get_datasets(family: Optional[str] = None) -> list[str]:
    """Return unique dataset UI labels (Rigplay, SEED) present in registry.

    If family is set (e.g. "Kimodo"), only datasets that have a model of that family are included.
    """
    infos = MODEL_INFOS
    if family is not None:
        infos = [i for i in infos if i.family == family]
    labels = set()
    for info in infos:
        labels.add(info.dataset_ui_label)
    return sorted(labels)


def get_skeletons_for_dataset(dataset_ui_label: str, family: Optional[str] = None) -> list[str]:
    """Return skeleton names that have a model for the given dataset.

    Order: SOMA, SMPLX, G1 (only those present for the dataset).
    If family is set (e.g. "Kimodo"), only skeletons with a model of that
    family are included.
    """
    dataset = "RP" if dataset_ui_label == "Rigplay" else "SEED"
    infos = MODEL_INFOS
    if family is not None:
        infos = [i for i in infos if i.family == family]
    skeletons = set()
    for info in infos:
        if info.dataset == dataset:
            skeletons.add(info.skeleton)
    return [s for s in SKELETON_ORDER if s in skeletons]


def get_versions_for_dataset_skeleton(dataset_ui_label: str, skeleton: str) -> list[str]:
    """Return version strings (e.g. v1) for the given dataset/skeleton.

    Sorted by version number so the last element is the highest (e.g. v1, v2).
    """
    dataset = "RP" if dataset_ui_label == "Rigplay" else "SEED"
    versions = []
    for info in MODEL_INFOS:
        if info.dataset == dataset and info.skeleton == skeleton:
            versions.append(info.version)

    return sorted(set(versions), key=_version_tuple)


def get_models_for_dataset_skeleton(
    dataset_ui_label: str, skeleton: str, family: Optional[str] = None
) -> list[ModelInfo]:
    """Return model infos for the given dataset/skeleton, sorted by version (max first).

    Used to build the Version dropdown (options = full display names, one per model). If family is
    set (e.g. "Kimodo"), only models of that family are returned.
    """
    dataset = "RP" if dataset_ui_label == "Rigplay" else "SEED"
    infos = [info for info in MODEL_INFOS if info.dataset == dataset and info.skeleton == skeleton]
    if family is not None:
        infos = [i for i in infos if i.family == family]

    return sorted(infos, key=_version_key, reverse=True)


def resolve_to_short_key(dataset_ui_label: str, skeleton: str, version: str) -> Optional[str]:
    """Return the short key for (dataset, skeleton, version), or None."""
    for info in MODEL_INFOS:
        if info.dataset_ui_label == dataset_ui_label and info.skeleton == skeleton and info.version == version:
            return info.short_key
    return None


# -----------------------------------------------------------------------------
# Flexible model name resolution (partial names, case-insensitive, defaults)
# -----------------------------------------------------------------------------

_FAMILY_ALIASES = {"kimodo": "Kimodo", "tmr": "TMR"}
_DATASET_ALIASES = {"rp": "RP", "rigplay": "RP", "seed": "SEED"}
_SKELETON_ALIASES = {
    "soma": "SOMA",
    "smplx": "SMPLX",
    "g1": "G1",
}


def _normalize_family(s: str) -> Optional[str]:
    """Return canonical family (Kimodo/TMR) or None if unknown."""
    return _FAMILY_ALIASES.get(s.strip().lower())


def _normalize_dataset(s: str) -> Optional[str]:
    """Return canonical dataset (RP/SEED) or None if unknown."""
    return _DATASET_ALIASES.get(s.strip().lower())


def _normalize_skeleton(s: str) -> Optional[str]:
    """Return canonical skeleton (SOMA/SMPLX/G1) or None if unknown."""
    return _SKELETON_ALIASES.get(s.strip().lower())


def _get_latest_for_family_skeleton_dataset(family: str, skeleton: str, dataset: str) -> Optional[ModelInfo]:
    """Return the model info with the highest version for (family, skeleton, dataset)."""
    candidates = [
        info for info in MODEL_INFOS if info.family == family and info.skeleton == skeleton and info.dataset == dataset
    ]
    if not candidates:
        return None
    return max(candidates, key=_version_key)


def kimodo_short_key_for_skeleton_dataset(skeleton: str, dataset: str) -> Optional[str]:
    """Return the latest Kimodo model short_key for ``skeleton`` and ``dataset`` (RP/SEED), or
    None."""
    info = _get_latest_for_family_skeleton_dataset("Kimodo", skeleton, dataset)
    return info.short_key if info is not None else None


def registry_skeleton_for_joint_count(nb_joints: int) -> str:
    """Map motion joint count to registry skeleton key (SOMA / SMPLX / G1)."""
    if nb_joints == 34:
        return "G1"
    if nb_joints == 22:
        return "SMPLX"
    if nb_joints in (77, 30):
        return "SOMA"
    raise ValueError(f"No Kimodo model registered for motion with J={nb_joints}")


# Optional version: Family-Skeleton-Dataset-vN or Family-Skeleton-Dataset
_RESOLVE_FULL_PATTERN = re.compile(
    r"^(Kimodo|TMR|kimodo|tmr)[\-_]" r"([A-Za-z0-9]+)[\-_]" r"(RP|SEED|rp|seed)" r"(?:[\-_]v(\d+(?:\.\d+)*))?$",
    re.IGNORECASE,
)
# Partial: Skeleton-Dataset or Skeleton or Dataset (no family)
_RESOLVE_PARTIAL_PATTERN = re.compile(
    r"^([A-Za-z0-9]+)(?:[\-_](RP|SEED|rp|seed))?(?:[\-_]v(\d+(?:\.\d+)*))?$",
    re.IGNORECASE,
)


def resolve_model_name(name: Optional[str], default_family: Optional[str] = None) -> str:
    """Resolve a user-facing model name to a short_key.

    Accepts full names (e.g. Kimodo-SOMA-RP-v1), case-insensitive matching,
    and partial names with defaults: dataset=RP, skeleton=SOMA, family from
    default_family (Kimodo for demo/generation, TMR for embed script).
    Omitted version resolves to the latest for that model.

    Args:
        name: User-provided name (can be None or empty).
        default_family: "Kimodo" or "TMR" when name is empty or omits family.

    Returns:
        Short key (e.g. kimodo-soma-rp) for use with load_model / MODEL_NAMES.

    Raises:
        ValueError: If name cannot be resolved or default_family is missing when needed.
    """
    if name is not None:
        name = name.strip()
    if not name:
        if default_family is None:
            raise ValueError('Model name is empty; provide a name or set default_family ("Kimodo" or "TMR").')
        fam = _normalize_family(default_family)
        if fam is None:
            raise ValueError(f"default_family must be 'Kimodo' or 'TMR', got {default_family!r}")
        info = _get_latest_for_family_skeleton_dataset(fam, "SOMA", "RP")
        if info is None:
            raise ValueError(f"No model found for {fam}-SOMA-RP. Available: {list(MODEL_NAMES.keys())}")
        return info.short_key

    # Exact short_key
    if name in MODEL_NAMES:
        return name

    # Case-insensitive match against short_key or display_name
    name_lower = name.lower()
    matches = []
    for info in MODEL_INFOS:
        if name_lower == info.short_key.lower():
            matches.append(info)
        disp = info.display_name.lower()
        if name_lower == disp or name_lower == ("nvidia/" + disp):
            matches.append(info)
    if len(matches) == 1:
        return matches[0].short_key
    if len(matches) > 1:
        return matches[0].short_key

    # Parsed full form: Family-Skeleton-Dataset or Family-Skeleton-Dataset-vN
    m = _RESOLVE_FULL_PATTERN.match(name)
    if m:
        fam_raw, skel_raw, ds_raw, ver_num = m.groups()
        fam = _normalize_family(fam_raw)
        skel = _normalize_skeleton(skel_raw)
        ds = _normalize_dataset(ds_raw)
        if fam is not None and skel is not None and ds is not None:
            if ver_num is not None:
                version = f"v{ver_num}"
                for info in MODEL_INFOS:
                    if info.family == fam and info.skeleton == skel and info.dataset == ds and info.version == version:
                        return info.short_key
            else:
                info = _get_latest_for_family_skeleton_dataset(fam, skel, ds)
                if info is not None:
                    return info.short_key

    # Parsed partial: Skeleton-Dataset, Skeleton, or Dataset (use default_family)
    if default_family is not None:
        m = _RESOLVE_PARTIAL_PATTERN.match(name)
        if m:
            tok1, ds_raw, ver_num = m.groups()
            fam = _normalize_family(default_family)
            if fam is not None:
                skel = _normalize_skeleton(tok1)
                ds_candidate = _normalize_dataset(ds_raw) if ds_raw else None
                if skel is not None and ds_candidate is not None:
                    ds = ds_candidate
                elif skel is not None:
                    ds = "RP"
                else:
                    skel = "SOMA"
                    ds = _normalize_dataset(tok1) if tok1 else "RP"
                    if ds is None:
                        ds = "RP"
                if ver_num is not None:
                    version = f"v{ver_num}"
                    for info in MODEL_INFOS:
                        if (
                            info.family == fam
                            and info.skeleton == skel
                            and info.dataset == ds
                            and info.version == version
                        ):
                            return info.short_key
                else:
                    info = _get_latest_for_family_skeleton_dataset(fam, skel, ds)
                    if info is not None:
                        return info.short_key

        # Single token: skeleton or dataset
        fam = _normalize_family(default_family)
        if fam is not None:
            skel = _normalize_skeleton(name)
            if skel is not None:
                info = _get_latest_for_family_skeleton_dataset(fam, skel, "RP")
                if info is not None:
                    return info.short_key
            ds = _normalize_dataset(name)
            if ds is not None:
                info = _get_latest_for_family_skeleton_dataset(fam, "SOMA", ds)
                if info is not None:
                    return info.short_key

    raise ValueError(
        f"Model name {name!r} could not be resolved. "
        f"Use a short key (e.g. {list(MODEL_NAMES.keys())[:3]}...), "
        "a full name (e.g. Kimodo-SOMA-RP-v1), or a partial (e.g. SOMA-RP, SOMA) "
        "with default_family set."
    )
