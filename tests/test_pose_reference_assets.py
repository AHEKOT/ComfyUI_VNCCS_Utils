"""Durable reference layer images: validation, atomic storage and the HTTP contract."""
import asyncio
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest
from PIL import Image

from helpers.backend_package import service_package, stub_imports


def image_bytes(kind="WEBP", size=(32, 16), color=(200, 40, 40)):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, kind)
    return buffer.getvalue()


def load_service(user_dir, name="vnccs_reference_assets_test"):
    """A fresh package instance over the same user directory behaves like a restart."""
    load = service_package(name)
    with stub_imports({"folder_paths": SimpleNamespace(get_user_directory=lambda: str(user_dir))}):
        service = load("nodes.posestudio.reference_assets")
    service.__dict__["_vnccs_user_data_root"] = lambda: str(Path(user_dir) / "vnccs")
    return service, load


def test_store_is_content_addressed_and_deduplicated(tmp_path):
    service, _ = load_service(tmp_path)
    raw = image_bytes()
    first = service.store_reference_asset(raw)
    second = service.store_reference_asset(raw)
    assert first == second
    assert first["width"] == 32 and first["height"] == 16
    assert service.is_reference_asset_name(first["asset"])
    assert first["asset"].endswith(".webp")
    stored = tmp_path / "vnccs" / "pose_reference_layers"
    assert [item.name for item in stored.iterdir()] == [first["asset"]]
    assert (stored / first["asset"]).read_bytes() == raw


def test_extension_follows_the_decoded_format_not_the_client(tmp_path):
    service, _ = load_service(tmp_path)
    assert service.store_reference_asset(image_bytes("PNG"))["asset"].endswith(".png")
    assert service.store_reference_asset(image_bytes("JPEG"))["asset"].endswith(".jpg")


def test_assets_survive_a_restart(tmp_path):
    service, _ = load_service(tmp_path, "vnccs_reference_assets_first")
    raw = image_bytes()
    asset = service.store_reference_asset(raw)["asset"]
    restarted, _ = load_service(tmp_path, "vnccs_reference_assets_second")
    path, content_type = restarted.reference_asset_file(asset)
    assert Path(path).read_bytes() == raw
    assert content_type == "image/webp"


@pytest.mark.parametrize("payload", [
    b"",
    b"not an image",
    b"<svg xmlns='http://www.w3.org/2000/svg'/>",
    image_bytes("PNG")[:40],
    image_bytes("GIF"),
])
def test_uploads_must_decode_as_an_accepted_image(tmp_path, payload):
    service, _ = load_service(tmp_path)
    with pytest.raises(service.ReferenceAssetRejected):
        service.store_reference_asset(payload)
    stored = tmp_path / "vnccs" / "pose_reference_layers"
    assert not stored.exists() or not list(stored.iterdir())


def test_size_limits(tmp_path):
    service, _ = load_service(tmp_path)
    with pytest.raises(service.ReferenceAssetRejected, match="4096"):
        service.store_reference_asset(image_bytes("PNG", size=(4097, 1)))
    with pytest.raises(service.ReferenceAssetRejected, match="too large"):
        service.store_reference_asset(b"x" * (service.REFERENCE_ASSET_MAX_BYTES + 1))


@pytest.mark.parametrize("name", [
    "../../secret.webp",
    "..\\secret.webp",
    "a" * 63 + ".webp",
    "A" * 64 + ".webp",
    "a" * 64,
    "a" * 64 + ".svg",
    "a" * 64 + ".webp/../x",
    "a" * 64 + ".webp\n",
    "",
    None,
])
def test_asset_names_are_strict(tmp_path, name):
    service, _ = load_service(tmp_path)
    with pytest.raises(service.ReferenceAssetRejected):
        service.reference_asset_file(name)


def test_unknown_asset_is_absent(tmp_path):
    service, _ = load_service(tmp_path)
    assert service.reference_asset_file("0" * 64 + ".webp") is None


def test_failed_write_keeps_existing_files_and_leaves_no_partial_file(tmp_path):
    service, _ = load_service(tmp_path)
    kept = service.store_reference_asset(image_bytes())["asset"]
    stored = tmp_path / "vnccs" / "pose_reference_layers"
    with mock.patch.object(service.os, "replace", side_effect=OSError(28, "No space left on device")):
        with pytest.raises(service.ReferenceAssetStorageError, match="No space left"):
            service.store_reference_asset(image_bytes(color=(1, 2, 3)))
    assert [item.name for item in stored.iterdir()] == [kept]


class Request:
    def __init__(self, body=b"", asset_id=None, length=None):
        self.body = body
        self.match_info = {"asset_id": asset_id}
        self.can_read_body = bool(body)
        self.headers = {"Content-Length": str(len(body) if length is None else length)}

    async def read(self):
        return self.body


def load_routes(tmp_path):
    handlers = {}

    class Routes:
        def post(self, path):
            return lambda handler: handlers.setdefault(("POST", path), handler)

        def get(self, path):
            return lambda handler: handlers.setdefault(("GET", path), handler)

    web = SimpleNamespace(
        json_response=lambda data, status=200, **_kw: SimpleNamespace(data=data, status=status),
        FileResponse=lambda path, headers=None: SimpleNamespace(path=path, headers=headers, status=200),
    )
    load = service_package("vnccs_reference_routes_" + tmp_path.name.replace("-", "_"))
    with stub_imports({
        "aiohttp": SimpleNamespace(web=web),
        "folder_paths": SimpleNamespace(get_user_directory=lambda: str(tmp_path / "user")),
    }):
        api = load("api.pose_reference_assets")
    service = load("nodes.posestudio.reference_assets")
    service.__dict__["_vnccs_user_data_root"] = lambda: str(tmp_path / "user" / "vnccs")
    api.register_routes(Routes())
    return handlers[("POST", "/vnccs/pose_reference_asset")], handlers[("GET", "/vnccs/pose_reference_asset/{asset_id}")], service


def test_http_round_trip_and_error_statuses(tmp_path):
    upload, get, service = load_routes(tmp_path)
    raw = image_bytes()
    stored = asyncio.run(upload(Request(raw)))
    assert stored.status == 200
    asset = stored.data["asset"]
    # A workflow reference is compact: name plus transforms, no bytes.
    assert len(json.dumps({"asset": asset})) < 100

    served = asyncio.run(get(Request(asset_id=asset)))
    assert Path(served.path).read_bytes() == raw
    assert served.headers["Content-Type"] == "image/webp"
    assert "immutable" in served.headers["Cache-Control"]
    assert served.headers["X-Content-Type-Options"] == "nosniff"

    assert asyncio.run(get(Request(asset_id="0" * 64 + ".webp"))).status == 404
    traversal = asyncio.run(get(Request(asset_id="../../secret.webp")))
    assert traversal.status == 400 and "error" in traversal.data

    not_image = asyncio.run(upload(Request(b"not an image")))
    assert not_image.status == 400 and "error" in not_image.data
    too_large = asyncio.run(upload(Request(b"x", length=service.REFERENCE_ASSET_MAX_BYTES + 1)))
    assert too_large.status == 413 and "error" in too_large.data

    with mock.patch.object(service.os, "replace", side_effect=OSError(28, "No space left on device")):
        failed = asyncio.run(upload(Request(image_bytes(color=(9, 9, 9)))))
    assert failed.status == 500
    assert "No space left" in failed.data["error"]


def test_decode_and_storage_run_outside_the_http_thread(tmp_path):
    upload, _get, service = load_routes(tmp_path)
    import threading
    loop_thread = threading.get_ident()
    worker = []
    original = service.store_reference_asset

    def spy(raw):
        worker.append(threading.get_ident())
        return original(raw)

    with mock.patch.object(service, "store_reference_asset", spy):
        assert asyncio.run(upload(Request(image_bytes()))).status == 200
    assert worker and worker[0] != loop_thread


def test_no_import_side_effects_outside_the_user_directory(tmp_path):
    service, _ = load_service(tmp_path)
    assert not os.path.exists(tmp_path / "vnccs" / "pose_reference_layers")
    assert service.reference_asset_file("0" * 64 + ".png") is None
