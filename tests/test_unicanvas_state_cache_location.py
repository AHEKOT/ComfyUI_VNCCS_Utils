import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = (ROOT / "__init__.py").read_text(encoding="utf-8")


def test_state_cache_survives_restarts():
    # ComfyUI empties its temp directory at startup, which used to drop every canvas ("State cache missing").
    match = re.search(r"^_UNICANVAS_STATE_CACHE_DIR = (.+)$", SOURCE, re.M)
    assert match and "_vnccs_user_data_root()" in match.group(1) and "temp" not in match.group(1)
    legacy = re.search(r"^_UNICANVAS_LEGACY_STATE_CACHE_DIR = (.+)$", SOURCE, re.M)
    assert legacy and "_vnccs_runtime_temp_root()" in legacy.group(1)


def test_reads_fall_back_to_the_old_temp_cache():
    read = SOURCE[SOURCE.index("def _vnccs_read_unicanvas_state_cache_file"):SOURCE.index("def _vnccs_unicanvas_build_info")]
    assert "_UNICANVAS_LEGACY_STATE_CACHE_DIR" in read
