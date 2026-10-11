"""Shared scene lock and active jobs; no node or HTTP imports."""
import threading
from typing import Any

_STATE_LOCK = threading.RLock()

_JOBS: dict[str, dict[str, Any]] = {}
