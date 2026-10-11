"""Catalog persistence and HTTP contracts without importing ComfyUI or model code."""
import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from aiohttp import web

from helpers.runtime_caches import load_runtime_caches


class Request:
    def __init__(self, payload=None, *, canvas_id=None, raw=None, length=None):
        self.raw = json.dumps(payload).encode() if raw is None else raw
        self.headers = {"Content-Length": str(len(self.raw) if length is None else length)}
        self.match_info = {"canvas_id": canvas_id}
        self.offset = 0
        self.content = self

    async def read(self, size):
        # Exercise the body bound across partial network reads.
        end = self.offset + min(size, 17)
        value = self.raw[self.offset:end]
        self.offset += len(value)
        return value

    async def json(self):
        return json.loads(self.raw)


class UniCanvasDocumentTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.runtime = load_runtime_caches(self.root)
        self.cache = self.runtime["canvas_service"]
        self.documents = self.runtime["documents"]
        self.adapter = self.runtime["documents_adapter"]
        routes = web.RouteTableDef()
        self.adapter.register_routes(routes)
        self.handlers = {(route.method, route.path): route.handler for route in routes}

    def save(self, state_id, *, count=1, panorama=False, revision=1):
        state = {"version": 3 if panorama else 2,
                 "layers": [{"dataURL": f"pixels-{index}"} for index in range(count)],
                 "size": {"width": 1024, "height": 768},
                 "panorama": {"width": 4096} if panorama else None}
        self.cache._vnccs_write_unicanvas_state_cache_file(state_id, {"state": state, "revision": revision})
        return state

    def path(self, state_id):
        return Path(self.cache._vnccs_unicanvas_state_cache_path(state_id))

    def document(self, state_id="first", **kwargs):
        self.save(state_id, **kwargs)
        return self.documents.register_document(state_id)

    def call(self, method, path="/vnccs/unicanvas/documents", payload=None, **kwargs):
        return asyncio.run(self.handlers[method, path](Request(payload, **kwargs)))

    def upload(self, payload):
        handler = self.runtime["routes"]["/vnccs/unicanvas_state_upload"]
        return asyncio.run(handler(Request(payload)))

    def test_legacy_registration_is_idempotent_and_preserves_original_bytes(self):
        legacy = Path(self.cache._UNICANVAS_LEGACY_STATE_CACHE_DIR)
        legacy.mkdir(parents=True)
        source = legacy / "vnccs_unicanvas_standalone_tab.json"
        original = b'{ "revision": 7, "state": { "version": 1, "layers": [] } }\n'
        source.write_bytes(original)
        first = self.documents.register_document(source.stem, " Legacy canvas ")
        self.assertEqual(first["name"], "Legacy canvas")
        self.assertEqual(first["layer_count"], 0)
        self.assertEqual(self.documents.register_document(source.stem), first)
        self.assertEqual(source.read_bytes(), original)
        self.assertFalse(self.path(source.stem).exists(), "registration must not migrate or rewrite cache bytes")
        listing = self.documents.list_documents()
        self.assertEqual(listing["documents"], [first])
        self.assertEqual(listing["active_canvas_id"], first["canvas_id"])
        self.assertFalse((Path(self.documents._directory()) / "active.json").exists())

    def test_multiple_documents_keep_their_snapshots_after_pointer_changes_and_delete(self):
        first = self.document()
        second = self.document("second", count=2, panorama=True)
        self.save("first_out")
        snapshots = {self.path(name): self.path(name).read_bytes() for name in ("first", "first_out", "second")}
        self.documents.set_active_document(first["canvas_id"])
        self.save("first_snapshot", count=3)
        updated = self.documents.update_document(first["canvas_id"], name="Work A", state_id="first_snapshot",
                                                 expected_state_id="first")
        self.assertEqual(updated["created_at"], first["created_at"])
        self.assertEqual((updated["name"], updated["state_id"], updated["layer_count"]), ("Work A", "first_snapshot", 3))
        self.assertEqual(self.documents.list_documents()["active_canvas_id"], first["canvas_id"])
        self.documents.delete_document(first["canvas_id"], "first_snapshot")
        self.assertEqual(self.documents.list_documents(), {"documents": [second], "active_canvas_id": second["canvas_id"]})
        for path, original in snapshots.items():
            self.assertEqual(path.read_bytes(), original)
        self.assertTrue(self.path("first_snapshot").is_file())
        self.assertEqual(self.documents.get_document(second["canvas_id"])["panorama"], True)

    def test_listing_uses_manifest_summaries_without_decoding_cached_pixels(self):
        first = self.document(count=2, panorama=True)
        self.path("first").write_bytes(b"not JSON: a large unavailable image cache")
        self.cache.VNCCS_UNICANVAS_STATE_CACHE.clear()
        with mock.patch.object(self.documents, "_cached_summary", side_effect=AssertionError("decoded pixels")):
            listing = self.documents.list_documents()
        size = self.path("first").stat().st_size
        self.assertEqual(listing["documents"], [{**first, "cache_bytes": size, "current_cache_bytes": size}])
        self.assertEqual((first["layer_count"], first["width"], first["height"], first["panorama"]), (2, 1024, 768, True))

    def test_cache_usage_counts_owned_snapshots_outputs_and_legacy_copies_without_reading_images(self):
        first = self.document()
        self.save("first_out")
        self.save("current", count=3)
        self.save("current_out")
        self.save("unrelated", count=10)
        self.documents.update_document(first["canvas_id"], state_id="current", expected_state_id="first")
        legacy = Path(self.cache._UNICANVAS_LEGACY_STATE_CACHE_DIR)
        legacy.mkdir(parents=True)
        legacy_copy = legacy / "first.json"
        legacy_copy.write_bytes(b"retained legacy bytes")
        paths = [self.path(state_id) for state_id in ("first", "first_out", "current", "current_out")]
        originals = {path: path.read_bytes() for path in [*paths, legacy_copy]}
        with mock.patch.object(self.documents, "_cached_summary", side_effect=AssertionError("decoded pixels")):
            actual = self.documents.list_documents()["documents"][0]
        self.assertEqual(actual["cache_bytes"], sum(path.stat().st_size for path in originals))
        self.assertEqual(actual["current_cache_bytes"], sum(path.stat().st_size for path in paths[2:]))
        self.assertEqual(actual["snapshot_count"], 2)
        for path, original in originals.items():
            self.assertEqual(path.read_bytes(), original)
        self.assertNotIn("cache_bytes", json.loads(Path(self.documents._path(first["canvas_id"])).read_text()))

    def test_cache_usage_skips_missing_files_and_symlinks_but_reports_io_errors(self):
        first = self.document()
        self.path("first_out").symlink_to(self.path("first"))
        self.assertEqual(self.documents.get_document(first["canvas_id"])["cache_bytes"], self.path("first").stat().st_size)
        self.path("first").unlink()
        self.assertEqual(self.documents.get_document(first["canvas_id"])["cache_bytes"], 0)
        with mock.patch.object(self.documents.os, "stat", side_effect=PermissionError("unreadable cache")):
            with self.assertRaises(PermissionError):
                self.documents.get_document(first["canvas_id"])

    def test_stale_owners_foreign_targets_and_deleted_documents_are_blocked(self):
        first = self.document()
        other = self.document("other")
        new_state = self.save("snapshot")
        self.documents.note_state_saved(first["canvas_id"], "snapshot", new_state, "first")
        for operation in (
            lambda: self.documents.update_document(first["canvas_id"], name="stale", expected_state_id="first"),
            lambda: self.documents.delete_document(first["canvas_id"], "first"),
            lambda: self.documents.note_state_saved(first["canvas_id"], "first", new_state, "first"),
            lambda: self.documents.validate_state_owner(first["canvas_id"], "snapshot", other["state_id"]),
        ):
            with self.assertRaises(self.documents.CanvasConflict):
                operation()
        self.documents.delete_document(first["canvas_id"], "snapshot")
        with self.assertRaises(self.documents.CanvasConflict):
            self.documents.register_document("snapshot")
        with self.assertRaises(self.documents.CanvasConflict):
            self.documents.note_state_saved(first["canvas_id"], "snapshot", new_state, "snapshot")
        with self.assertRaises(FileNotFoundError):
            self.documents.get_document(first["canvas_id"])
        primary = Path(self.documents._path(first["canvas_id"]))
        primary.write_text("broken tombstone", encoding="utf-8")
        with self.assertRaises(FileNotFoundError):
            self.documents.get_document(first["canvas_id"])
        self.assertEqual(self.documents.list_documents()["documents"], [other])

    def test_retired_snapshot_ownership_survives_pointer_changes_and_deletion(self):
        first = self.document()
        first_bytes = self.path("first").read_bytes()
        snapshot = self.save("snapshot")
        self.documents.note_state_saved(first["canvas_id"], "snapshot", snapshot, "first")
        self.save("latest")
        self.documents.update_document(first["canvas_id"], state_id="latest", expected_state_id="snapshot")
        manifest_path = Path(self.documents._path(first["canvas_id"]))
        self.assertEqual(json.loads(manifest_path.read_text())["state_ids"], ["first", "snapshot", "latest"])
        other = self.document("other")
        foreign = {"state_id": "first", "state": {**snapshot, "canvas_id": other["canvas_id"], "layers": []},
                   "revision": 2, "base_revision": 1, "canvas_base_state_id": "other"}
        self.assertEqual(self.upload(foreign).status, 409)
        self.assertEqual(self.path("first").read_bytes(), first_bytes)
        for state_id in ("first", "snapshot"):
            with self.subTest(state_id=state_id), self.assertRaises(self.documents.CanvasConflict):
                self.documents.register_document(state_id)
        self.documents.delete_document(first["canvas_id"], "latest")
        for state_id in ("first", "snapshot", "latest"):
            with self.subTest(deleted_state_id=state_id), self.assertRaises(self.documents.CanvasConflict):
                self.documents.register_document(state_id)
        self.assertEqual(json.loads(manifest_path.read_text())["state_ids"], ["first", "snapshot", "latest"])

    def test_old_manifests_upgrade_ownership_history_and_invalid_histories_are_rejected(self):
        first = self.document()
        path = Path(self.documents._path(first["canvas_id"]))
        manifest = json.loads(path.read_text())
        del manifest["state_ids"]
        path.write_text(json.dumps(manifest))
        self.assertEqual(self.documents.register_document("first"), first)
        self.save("snapshot")
        self.documents.update_document(first["canvas_id"], state_id="snapshot", expected_state_id="first")
        self.assertEqual(json.loads(path.read_text())["state_ids"], ["first", "snapshot"])
        for state_ids in (None, [], ["snapshot", "snapshot"], ["first"], ["snapshot", "../bad"]):
            with self.subTest(state_ids=state_ids), self.assertRaises(ValueError):
                self.documents._validate_manifest({**json.loads(path.read_text()), "state_ids": state_ids})

    def test_validated_backup_recovers_manifest_and_preserves_corrupt_bytes(self):
        first = self.document()
        self.documents.update_document(first["canvas_id"], name="Newest", expected_state_id="first")
        primary = Path(self.documents._path(first["canvas_id"]))
        for damaged in (b'{"unfinished":', json.dumps({**first, "deleted": False, "layer_count": -1}).encode()):
            with self.subTest(damaged=damaged):
                primary.write_bytes(damaged)
                self.assertEqual(self.documents.get_document(first["canvas_id"]), first)
                self.assertEqual(primary.read_bytes(), damaged, "read-only recovery preserves damaged bytes")
                self.documents.update_document(first["canvas_id"], name="Recovered", expected_state_id="first")
                archives = list(primary.parent.glob(primary.name + ".corrupt.*"))
                self.assertIn(damaged, [path.read_bytes() for path in archives])
                self.assertEqual(self.documents.get_document(first["canvas_id"])["name"], "Recovered")

    def test_without_valid_backup_corruption_blocks_writes_and_preserves_files(self):
        first = self.document()
        primary = Path(self.documents._path(first["canvas_id"]))
        primary.write_bytes(b"corrupt primary")
        backup = Path(str(primary) + ".bak")
        backup.write_bytes(b"corrupt backup")
        for operation in (
            self.documents.list_documents,
            lambda: self.documents.register_document("first"),
            lambda: self.documents.update_document(first["canvas_id"], name="Overwrite", expected_state_id="first"),
        ):
            with self.assertRaisesRegex(OSError, "without a valid backup"):
                operation()
        self.assertEqual(primary.read_bytes(), b"corrupt primary")
        self.assertEqual(backup.read_bytes(), b"corrupt backup")
        self.assertEqual(self.call("GET").status, 500)

    def test_active_pointer_backup_and_fallback_do_not_overwrite_corrupt_file(self):
        first = self.document()
        second = self.document("second")
        self.documents.set_active_document(first["canvas_id"])
        self.documents.set_active_document(second["canvas_id"])
        active = Path(self.documents._directory()) / "active.json"
        active.write_bytes(b"corrupt active")
        self.assertEqual(self.documents.list_documents()["active_canvas_id"], first["canvas_id"])
        self.assertEqual(active.read_bytes(), b"corrupt active")
        Path(str(active) + ".bak").write_bytes(b"also corrupt")
        with self.assertRaises(OSError):
            self.documents.set_active_document(first["canvas_id"])
        self.assertEqual(active.read_bytes(), b"corrupt active")

    def test_catalog_validates_names_ids_and_cached_state_schema(self):
        self.save("valid")
        for state_id in (None, "", "../valid", "bad/name", "x" * 129, "has space", "valid\n"):
            with self.subTest(state_id=state_id), self.assertRaises(ValueError):
                self.documents.register_document(state_id)
        for name in ("", "  ", "x" * 161, [], 3):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.documents.register_document("valid", name)
        for canvas_id in (None, "", "../valid", "g" * 32, "a" * 31, "A" * 32):
            with self.subTest(canvas_id=canvas_id), self.assertRaises(ValueError):
                self.documents.get_document(canvas_id)
        for state in ({"version": 0, "layers": []}, {"version": True, "layers": []}, {"version": 4, "layers": []},
                      {"version": 2, "layers": {}}, {"version": 2, "layers": [], "size": {"width": -1}},
                      {"version": 2, "layers": [], "size": {"height": True}}):
            with self.subTest(state=state):
                self.cache._vnccs_write_unicanvas_state_cache_file("invalid", {"state": state})
                with self.assertRaises(ValueError):
                    self.documents.register_document("invalid")
        with self.assertRaises(FileNotFoundError):
            self.documents.register_document("missing")

    def test_document_ids_cannot_alias_another_cache_or_its_output(self):
        first = self.document("valid")
        self.save("valid_out")
        self.save("a" * 125)
        self.save("a" * 128)
        before = {path: path.read_bytes() for path in Path(self.cache._UNICANVAS_STATE_CACHE_DIR).glob("*.json")}
        for state_id in ("_valid", "valid_", "__valid__", "valid_out", "a" * 125, "a" * 128):
            with self.subTest(state_id=state_id), self.assertRaises(ValueError):
                self.documents.register_document(state_id)
        self.assertEqual(self.documents.list_documents()["documents"][0]["canvas_id"], first["canvas_id"])
        for path, original in before.items():
            self.assertEqual(path.read_bytes(), original, "invalid identities leave every snapshot byte intact")

    def test_legacy_alias_manifest_remains_readable_and_protects_its_physical_cache(self):
        first = self.document("valid")
        path = Path(self.documents._path(first["canvas_id"]))
        manifest = json.loads(path.read_text())
        manifest.update(state_id="_valid", state_ids=["_valid"])
        path.write_text(json.dumps(manifest))
        original = self.path("valid").read_bytes()
        legacy = self.documents.get_document(first["canvas_id"])
        self.assertEqual(legacy["state_id"], "_valid")
        self.assertEqual(legacy["cache_bytes"], len(original))
        self.assertEqual(len(self.documents.list_documents()["documents"]), 1)
        state = self.save("replacement")
        self.assertEqual(self.upload({"state_id": "valid", "state": state, "revision": 2}).status, 409)
        output = {"state_id": "valid_out", "state": state, "revision": 2}
        self.assertEqual(self.upload(output).status, 200)
        self.assertEqual(self.upload({**output, "revision": 3, "state": {**state, "layers": []}}).status, 409)
        self.assertEqual(self.path("valid").read_bytes(), original)
        self.documents.note_state_saved(first["canvas_id"], "replacement", state, "_valid")
        self.assertEqual(self.documents.get_document(first["canvas_id"])["state_id"], "replacement")
        self.assertEqual(self.path("valid").read_bytes(), original, "moving away from an old alias retains workflow pixels")

    def test_http_catalog_round_trip_and_conflict_statuses(self):
        self.save("first")
        created = self.call("POST", payload={"state_id": "first", "name": "A"})
        self.assertEqual(created.status, 200)
        first = json.loads(created.body)["document"]
        canvas_id = first["canvas_id"]
        item = "/vnccs/unicanvas/documents/{canvas_id}"
        self.assertEqual(len(self.handlers), 6)
        self.assertEqual(json.loads(self.call("GET").body)["documents"], [first])
        self.assertEqual(json.loads(self.call("GET", item, canvas_id=canvas_id).body)["document"], first)
        active = self.call("POST", "/vnccs/unicanvas/documents/active", {"canvas_id": canvas_id})
        self.assertEqual(json.loads(active.body)["active_canvas_id"], canvas_id)
        renamed = self.call("PATCH", item, {"name": "B", "expected_state_id": "first"}, canvas_id=canvas_id)
        self.assertEqual(json.loads(renamed.body)["document"]["name"], "B")
        self.assertEqual(self.call("PATCH", item, {"name": "C", "expected_state_id": "stale"}, canvas_id=canvas_id).status, 409)
        self.assertEqual(self.call("DELETE", item, {"expected_state_id": "first"}, canvas_id=canvas_id).status, 200)
        self.assertEqual(self.call("GET", item, canvas_id=canvas_id).status, 404)
        self.assertEqual(self.call("POST", payload={"state_id": "first"}).status, 409)
        self.assertEqual(self.call("GET").headers["Cache-Control"], "no-store")

    def test_http_rejects_invalid_json_fields_and_bounded_body(self):
        self.save("valid")
        for payload in (None, [], {"state_id": "../valid"}, {"state_id": "valid", "name": None},
                        {"state_id": "valid", "name": "x" * 161}):
            with self.subTest(payload=payload):
                self.assertEqual(self.call("POST", payload=payload).status, 400)
        self.assertEqual(self.call("POST", raw=b"{broken").status, 400)
        self.assertEqual(self.call("POST", payload={}, length=-1).status, 413)
        self.assertEqual(self.call("POST", payload={}, length=4097).status, 413)
        self.assertEqual(self.call("POST", raw=b" " * 4097, length=100).status, 413)
        self.assertEqual(self.call("POST", payload={"state_id": "missing"}).status, 404)

    def test_http_storage_work_runs_off_the_event_loop_thread(self):
        self.save("first")
        caller = threading.get_ident()
        threads = []
        original = self.documents.register_document
        def register(*args, **kwargs):
            threads.append(threading.get_ident())
            return original(*args, **kwargs)
        with mock.patch.object(self.documents, "register_document", side_effect=register):
            self.assertEqual(self.call("POST", payload={"state_id": "first"}).status, 200)
        self.assertEqual(len(threads), 1)
        self.assertNotEqual(threads[0], caller)

    def test_managed_upload_moves_pointer_and_rejects_stale_or_deleted_owner_before_write(self):
        first = self.document()
        state = {**self.save("template", count=3), "canvas_id": first["canvas_id"]}
        payload = {"state_id": "snapshot", "state": state, "revision": 2, "base_revision": -1,
                   "canvas_base_state_id": "first"}
        self.assertEqual(self.upload(payload).status, 200)
        current = self.documents.get_document(first["canvas_id"])
        self.assertEqual((current["state_id"], current["layer_count"]), ("snapshot", 3))
        self.assertEqual(self.upload(payload).status, 200, "exact lost-acknowledgement retries remain safe")
        stored = self.path("snapshot").read_bytes()
        stale = {**payload, "revision": 3, "base_revision": 2, "state": {**state, "layers": []}}
        self.assertEqual(self.upload(stale).status, 409)
        self.assertEqual(self.path("snapshot").read_bytes(), stored)
        other = self.document("other")
        foreign = {**payload, "state_id": other["state_id"], "canvas_base_state_id": "snapshot"}
        foreign_bytes = self.path("other").read_bytes()
        self.assertEqual(self.upload(foreign).status, 409)
        self.assertEqual(self.path("other").read_bytes(), foreign_bytes)
        self.documents.delete_document(first["canvas_id"], "snapshot")
        self.assertEqual(self.upload({**stale, "canvas_base_state_id": "snapshot"}).status, 409)
        self.assertEqual(self.path("snapshot").read_bytes(), stored)
        self.assertTrue(self.path("first").is_file())

    def test_invalid_managed_state_cannot_replace_acknowledged_cache_bytes(self):
        first = self.document()
        original = self.path("first").read_bytes()
        for change in ({"version": 4}, {"size": {"width": -1}}, {"size": {"height": True}}):
            with self.subTest(change=change):
                state = {**self.save("template"), **change, "canvas_id": first["canvas_id"]}
                payload = {"state_id": "first", "state": state, "revision": 2, "base_revision": 1,
                           "canvas_base_state_id": "first"}
                self.assertEqual(self.upload(payload).status, 400)
                self.assertEqual(self.path("first").read_bytes(), original)
        state = {**self.save("template"), "canvas_id": first["canvas_id"]}
        self.assertEqual(self.upload({"state_id": "bad/first", "state": state, "revision": 2,
                                     "base_revision": -1, "canvas_base_state_id": "first"}).status, 400)

    def test_legacy_upload_and_clear_cannot_overwrite_owned_workflow_snapshots(self):
        first = self.document()
        before = self.path("first").read_bytes()
        state = self.save("template", count=2)
        self.assertEqual(self.upload({"state_id": "first", "state": state, "revision": 2}).status, 409)
        for canvas_id in (None, "", False, "../bad"):
            with self.subTest(canvas_id=canvas_id):
                managed = {**state, "canvas_id": canvas_id}
                self.assertEqual(self.upload({"state_id": "first", "state": managed, "revision": 2,
                                             "base_revision": 1, "canvas_base_state_id": "first"}).status, 400)
        handler = self.runtime["routes"]["/vnccs/unicanvas_state_delete"]
        for state_id in ("first", "first_out"):
            response = asyncio.run(handler(Request({"state_id": state_id, "revision": 3})))
            self.assertEqual(response.status, 409)
        self.assertEqual(self.path("first").read_bytes(), before)
        self.documents.delete_document(first["canvas_id"], "first")
        self.assertEqual(self.upload({"state_id": "first", "state": state, "revision": 4}).status, 409)

    def test_retry_finishes_publication_after_manifest_write_failure(self):
        first = self.document()
        state = {**self.save("template"), "canvas_id": first["canvas_id"]}
        payload = {"state_id": "snapshot", "state": state, "revision": 2, "base_revision": -1,
                   "canvas_base_state_id": "first"}
        with mock.patch.object(self.documents, "note_state_saved", side_effect=OSError("disk full")):
            self.assertEqual(self.upload(payload).status, 500)
        self.assertEqual(self.documents.get_document(first["canvas_id"])["state_id"], "first")
        self.assertEqual(self.upload(payload).status, 200)
        self.assertEqual(self.documents.get_document(first["canvas_id"])["state_id"], "snapshot")

    def test_owned_outputs_allow_first_write_and_retry_but_never_changed_pixels(self):
        first = self.document()
        output = self.save("output_template")
        payload = {"state_id": "first_out", "state": output, "revision": 2}
        self.assertEqual(self.upload(payload).status, 200)
        original = self.path("first_out").read_bytes()
        self.assertEqual(self.upload(payload).status, 200)
        self.assertEqual(self.path("first_out").read_bytes(), original)
        changed = {**payload, "revision": 3, "state": {**output, "layers": []}}
        self.assertEqual(self.upload(changed).status, 409)
        self.assertEqual(self.path("first_out").read_bytes(), original)
        latest = self.save("latest")
        self.documents.note_state_saved(first["canvas_id"], "latest", latest, "first")
        self.assertEqual(self.upload(changed).status, 409, "retired output snapshots remain immutable")
        self.documents.delete_document(first["canvas_id"], "latest")
        for upload in (payload, changed, {**payload, "state_id": "latest_out"}):
            with self.subTest(state_id=upload["state_id"]):
                self.assertEqual(self.upload(upload).status, 409, "late outputs cannot write into deleted documents")
        self.assertEqual(self.path("first_out").read_bytes(), original)
        self.assertFalse(self.path("latest_out").exists())
        self.assertEqual(self.upload({**changed, "state_id": "unmanaged_out"}).status, 200)
        self.assertEqual(self.upload({**payload, "state_id": "unmanaged_out", "revision": 4}).status, 200)

    def test_backup_recovery_keeps_ownership_of_the_newest_snapshot(self):
        first = self.document()
        state = self.save("newest")
        self.documents.note_state_saved(first["canvas_id"], "newest", state, "first")
        primary = Path(self.documents._path(first["canvas_id"]))
        primary.write_bytes(b"corrupt newest manifest")
        self.assertEqual(self.documents.get_document(first["canvas_id"])["state_id"], "first")
        with self.assertRaises(self.documents.CanvasConflict):
            self.documents.register_document("newest")
        with self.assertRaises(self.documents.CanvasConflict):
            self.documents.validate_unmanaged_state("newest")
        self.assertEqual(primary.read_bytes(), b"corrupt newest manifest")

    def test_unaccepted_results_cannot_enter_the_state_cache(self):
        original = self.save("first")
        before = self.path("first").read_bytes()
        for key in ("staging", "stagingItems", "staging_items", "activeStagingIndex"):
            with self.subTest(key=key):
                state = {**original, key: []}
                with self.assertRaisesRegex(ValueError, "Unaccepted generation results"):
                    self.cache._vnccs_validate_unicanvas_state_payload({"state": state})
                self.assertEqual(self.upload({"state_id": "first", "state": state, "revision": 2}).status, 413)
                self.assertEqual(self.path("first").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
