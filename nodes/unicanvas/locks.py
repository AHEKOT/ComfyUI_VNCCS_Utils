"""Process-wide locks shared by every UniCanvas model operation.

Factory 3D reuses ``_COMFY_MODEL_OP_LOCK`` (see ``api/factory3d.py``) so the two
editors never move or release model weights under each other.
"""

from __future__ import annotations

import threading


_MODEL_CACHE_LOCK = threading.Lock()
_COMFY_MODEL_OP_LOCK = threading.RLock()
