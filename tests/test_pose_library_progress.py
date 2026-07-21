import importlib.util
import sys
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _load_pose_library():
    aiohttp_module = types.ModuleType("aiohttp")
    aiohttp_module.web = types.SimpleNamespace()
    previous = sys.modules.get("aiohttp")
    sys.modules["aiohttp"] = aiohttp_module
    try:
        spec = importlib.util.spec_from_file_location("vnccs_pose_library_progress_test", ROOT / "api" / "pose_library.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if previous is None:
            sys.modules.pop("aiohttp", None)
        else:
            sys.modules["aiohttp"] = previous


POSE_LIBRARY = _load_pose_library()


class PoseLibraryProgressTests(unittest.TestCase):
    def test_progress_registry_is_bounded(self):
        POSE_LIBRARY._REPOSITORY_PROGRESS.clear()
        now = 10_000.0
        for index in range(POSE_LIBRARY._REPOSITORY_PROGRESS_MAX + 20):
            POSE_LIBRARY._REPOSITORY_PROGRESS[str(index)] = {
                "status": "running",
                "updated_at": now + index,
            }

        POSE_LIBRARY._prune_repository_progress(now + POSE_LIBRARY._REPOSITORY_PROGRESS_MAX + 20)

        self.assertEqual(len(POSE_LIBRARY._REPOSITORY_PROGRESS), POSE_LIBRARY._REPOSITORY_PROGRESS_MAX)

    def test_completed_progress_expires(self):
        POSE_LIBRARY._REPOSITORY_PROGRESS.clear()
        POSE_LIBRARY._REPOSITORY_PROGRESS["finished"] = {
            "status": "success",
            "updated_at": 1.0,
        }

        POSE_LIBRARY._prune_repository_progress(1.0 + POSE_LIBRARY._REPOSITORY_PROGRESS_TTL_SECONDS + 1)

        self.assertNotIn("finished", POSE_LIBRARY._REPOSITORY_PROGRESS)


if __name__ == "__main__":
    unittest.main()
