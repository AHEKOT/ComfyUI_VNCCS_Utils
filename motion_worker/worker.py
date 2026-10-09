"""Compatibility entry point for the standalone ARDY worker."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "nodes" / "posestudio"))
from ttm.worker import main

if __name__ == "__main__":
    main(default_root=Path(__file__).resolve().parents[3] / "models" / "text_to_motion")
