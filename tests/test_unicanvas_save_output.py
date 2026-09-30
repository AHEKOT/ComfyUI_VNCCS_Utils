import pathlib
import sys
import types

# Pytest derives the repository-root package name from the checkout directory name
# and falls back to importing __init__.py under the literal name "__init__" when
# that name is not a valid identifier (e.g. a "...-p2" worktree), which crashes on
# the file's relative imports. Register the same package shell that
# tests/conftest.py registers for normally named checkouts so this suite runs in
# any worktree name.
if "__init__" not in sys.modules:
    _root_package_shell = types.ModuleType("__init__")
    _root_package_shell.__path__ = [str(pathlib.Path(__file__).resolve().parent.parent)]
    sys.modules["__init__"] = _root_package_shell

import base64
import io
import os
import re

import pytest
from PIL import Image

from nodes.unicanvas import register_unicanvas_routes
from nodes.unicanvas.save_output import _run_unicanvas_save_output, _unicanvas_save_output_image



@pytest.fixture()
def output_dir(tmp_path, monkeypatch):
    folder_paths = sys.modules["folder_paths"]
    monkeypatch.setattr(folder_paths, "get_output_directory", lambda: str(tmp_path))
    return tmp_path


def _data_url(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


COMPOSITE_NAME_RE = re.compile(r"^unicanvas-\d+-\d+\.png$")


def test_composite_save_returns_ok_json_and_unique_names(output_dir):
    image = Image.new("RGBA", (4, 4), (10, 20, 30, 255))

    first = _run_unicanvas_save_output({"image": _data_url(image)})
    second = _run_unicanvas_save_output({"image": _data_url(image)})

    assert first["ok"] is True
    assert set(first) == {"ok", "path", "width", "height"}
    assert (first["width"], first["height"]) == (4, 4)
    first_name = os.path.basename(first["path"])
    second_name = os.path.basename(second["path"])
    assert first_name != second_name
    for entry, name in ((first, first_name), (second, second_name)):
        assert COMPOSITE_NAME_RE.match(name), name
        assert os.path.dirname(entry["path"]) == str(output_dir)
        with Image.open(entry["path"]) as saved:
            assert saved.format == "PNG"
            assert saved.size == (4, 4)


def test_output_path_reservation_skips_taken_names(output_dir, monkeypatch):
    import nodes.unicanvas.save_output as unicanvas_module

    monkeypatch.setattr(unicanvas_module.time, "time", lambda: 1234.5)
    timestamp = 1234500
    seq = unicanvas_module._UNICANVAS_SAVE_OUTPUT_SEQ
    taken = []
    for offset in (1, 2):
        name = os.path.join(str(output_dir), f"unicanvas-{timestamp}-{seq + offset}.png")
        with open(name, "wb") as handle:
            handle.write(b"taken")
        taken.append(name)

    reserved = unicanvas_module._unicanvas_reserve_output_path(str(output_dir))

    assert reserved not in taken
    assert os.path.exists(reserved)
    for name in taken:
        with open(name, "rb") as handle:
            assert handle.read() == b"taken"


def test_layer_id_save_keeps_layer_alpha(output_dir):
    layer = Image.new("RGBA", (3, 3), (200, 40, 60, 128))

    result = _run_unicanvas_save_output({"image": _data_url(layer), "layer_id": "layer-1"})

    assert result["ok"] is True
    with Image.open(result["path"]) as saved:
        assert saved.mode == "RGBA"
        assert saved.getpixel((1, 1))[3] == 128


def test_layer_id_save_extracts_only_that_layer_from_state(output_dir):
    red = Image.new("RGBA", (2, 2), (255, 0, 0, 255))
    blue = Image.new("RGBA", (2, 2), (0, 0, 255, 33))
    state = {
        "version": 2,
        "layers": [
            {"id": "keep", "type": "raster", "dataURL": _data_url(blue)},
            {"id": "other", "type": "raster", "dataURL": _data_url(red)},
        ],
    }

    result = _run_unicanvas_save_output({"state": state, "layer_id": "keep"})

    with Image.open(result["path"]) as saved:
        assert saved.mode == "RGBA"
        assert saved.getpixel((0, 0)) == (0, 0, 255, 33)


def test_state_save_renders_flattened_composite(output_dir):
    top = Image.new("RGBA", (1, 1), (255, 0, 0, 255))
    bottom = Image.new("RGBA", (1, 1), (0, 0, 255, 255))
    crop = {"x": 0, "y": 0, "width": 1, "height": 1}
    state = {
        "origin": {"x": 0, "y": 0, "width": 1, "height": 1},
        "bbox": {"x": 0, "y": 0, "width": 1, "height": 1},
        "layers": [
            {"type": "raster", "visible": True, "opacity": 1, "blendMode": "source-over", "crop": crop, "dataURL": _data_url(top)},
            {"type": "raster", "visible": True, "opacity": 1, "blendMode": "source-over", "crop": crop, "dataURL": _data_url(bottom)},
        ],
    }

    result = _run_unicanvas_save_output({"state": state})

    assert result["ok"] is True
    with Image.open(result["path"]) as saved:
        assert saved.mode == "RGBA"
        assert saved.getpixel((0, 0))[:3] == (255, 0, 0)


def test_failed_save_unlinks_the_reserved_file(output_dir, monkeypatch):
    def failing_save(self, *args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(Image.Image, "save", failing_save)

    with pytest.raises(OSError, match="disk full"):
        _unicanvas_save_output_image(Image.new("RGBA", (2, 2), (0, 0, 0, 0)))

    # The O_EXCL reservation created the file: a failed save must not leave a
    # zero-byte PNG behind in output/.
    assert list(pathlib.Path(str(output_dir)).glob("unicanvas-*.png")) == []


def test_save_output_requires_image_or_state(output_dir):
    with pytest.raises(ValueError, match=r"\[VNCCS UniCanvas\] save_output needs an image or a canvas state\."):
        _run_unicanvas_save_output({})


def test_layer_id_without_pixels_reports_vnccs_error(output_dir):
    state = {"version": 2, "layers": [{"id": "empty", "type": "raster", "dataURL": None}]}

    with pytest.raises(ValueError, match=r"\[VNCCS UniCanvas\] Layer 'empty' has no stored pixels to save\."):
        _run_unicanvas_save_output({"state": state, "layer_id": "empty"})


def test_save_output_route_registered_with_existing_routes(monkeypatch):
    registered = []

    class _Routes:
        def get(self, path):
            def decorator(fn):
                registered.append(("GET", path))
                return fn

            return decorator

        def post(self, path):
            def decorator(fn):
                registered.append(("POST", path))
                return fn

            return decorator

    fake_server = types.ModuleType("server")
    fake_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=_Routes()))
    monkeypatch.setitem(sys.modules, "server", fake_server)
    try:
        import aiohttp  # noqa: F401
    except ImportError:
        fake_aiohttp = types.ModuleType("aiohttp")
        fake_aiohttp.web = types.SimpleNamespace(json_response=lambda *args, **kwargs: None)
        monkeypatch.setitem(sys.modules, "aiohttp", fake_aiohttp)

    register_unicanvas_routes()

    assert ("POST", "/vnccs/unicanvas/save_output") in registered
    assert ("POST", "/vnccs/unicanvas/draw") in registered
