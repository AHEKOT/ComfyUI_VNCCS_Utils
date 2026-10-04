# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Model registry: map nicknames to released model folders / Hugging Face repos.

Released models are organized by skeleton and generation horizon (in frames).
``load_model`` accepts:

- a skeleton nickname (``"core"``, ``"g1"``, ``"soma"``) — resolves to that
  skeleton's default horizon (see ``DEFAULT_HORIZON``),
- a skeleton+horizon nickname (``"core8"``, ``"g152"``, ``"soma60"``),
- the full folder / repo name (``"ARDY-SOMA-RP-30FPS-Horizon60"``).
"""

import os
import re

# Hugging Face org that hosts the released models.
HF_ORG = "nvidia"

# skeleton -> generation horizon (frames) -> released folder name
# (the folder name is also the HF repo name under HF_ORG).
MODELS_BY_SKELETON = {
    "core": {
        40: "ARDY-Core-RP-20FPS-Horizon40",
        8: "ARDY-Core-RP-20FPS-Horizon8",
    },
    "g1": {
        52: "ARDY-G1-RP-25FPS-Horizon52",
        8: "ARDY-G1-RP-25FPS-Horizon8",
    },
}

# Horizon a bare skeleton nickname resolves to ("core" -> "core40").
DEFAULT_HORIZON = {"core": 40, "g1": 52, "soma": 60}

# nickname -> released folder name: "core8"/"core40"/... plus the bare
# skeleton names, which map to their DEFAULT_HORIZON variant.
MODELS = {
    f"{skeleton}{horizon}": folder
    for skeleton, by_horizon in MODELS_BY_SKELETON.items()
    for horizon, folder in by_horizon.items()
}
MODELS.update({skeleton: MODELS_BY_SKELETON[skeleton][DEFAULT_HORIZON[skeleton]] for skeleton in MODELS_BY_SKELETON})

DEFAULT_MODEL = "core"
DEFAULT_TEXT_ENCODER_URL = "http://127.0.0.1:9550/"

# --- Aliases kept for imports elsewhere (ardy.model.loading re-exports these) --
# nickname -> HF repo id ("org/name")
MODEL_NAMES = {key: f"{HF_ORG}/{name}" for key, name in MODELS.items()}
# a modelname is valid if it is a nickname or a full folder name
AVAILABLE_MODELS = list(MODELS) + list(dict.fromkeys(MODELS.values()))
ARDY_MODELS = list(MODELS)
TMR_MODELS: list[str] = []

# Released-style folder name, e.g. "ARDY-Core-RP-20FPS-Horizon40".
_NAME_PATTERN = re.compile(r"ardy-(core|g1|soma)-.*horizon(\d+)$", re.IGNORECASE)


def parse_model_name(folder: str):
    """``(skeleton, horizon)`` parsed from a released-style folder name.

    Returns e.g. ``("core", 40)`` for ``"ARDY-Core-RP-20FPS-Horizon40"`` (case-insensitive), or
    ``None`` when the name does not follow the released naming scheme (e.g. a local training-run
    folder).
    """
    m = _NAME_PATTERN.match(folder)
    if not m:
        return None
    return m.group(1).lower(), int(m.group(2))


def resolve_model_name(name: str, default_family=None, checkpoints_dir=None) -> str:
    """Return the released folder / repo name for a nickname or full name.

    Accepts a nickname (``"soma"``, ``"core8"``), the full folder name (``"ARDY-SOMA-RP-30FPS-
    Horizon60"``, case-insensitive), or a full HF repo id (``"nvidia/ARDY-SOMA-RP-30FPS-
    Horizon60"``). ``default_family`` is ignored (kept for call-site compatibility).

    When ``checkpoints_dir`` is given, the valid model set is whatever folders live there — not just
    the released models — so a name matching a folder in it is accepted as-is (nicknames still
    resolve via the registry).
    """
    if name in MODELS:
        return MODELS[name]
    # Full folder name, optionally HF-org-prefixed; match case-insensitively
    # and return the canonical casing (HF resolves either way, but local
    # folder lookups are case-sensitive).
    bare = name.split("/", 1)[1] if "/" in name else name
    canonical = {folder.lower(): folder for folder in MODELS.values()}
    if bare.lower() in canonical:
        return canonical[bare.lower()]
    if checkpoints_dir and os.path.isdir(os.path.join(checkpoints_dir, name)):
        return name
    raise ValueError(
        f"Unknown model {name!r}. Choose a nickname {list(MODELS)} "
        f"or a full name {list(dict.fromkeys(MODELS.values()))}."
    )


def hf_repo_id(full_name: str) -> str:
    """Hugging Face repo id for a resolved full model name."""
    return f"{HF_ORG}/{full_name}"
