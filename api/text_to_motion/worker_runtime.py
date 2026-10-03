"""The isolated motion worker: runs motion backends outside ComfyUI's Python.

Started by ``motion_worker/worker.py`` inside its own venv or Docker container (see
``worker_protocol`` for the job files). It advertises the models whose backends are
usable in its environment, runs one job at a time, keeps one model loaded and frees
it after a while without jobs so the GPU is shared fairly with ComfyUI.
"""

from __future__ import annotations

import os
import platform
import threading
import time
import traceback
from pathlib import Path

from . import registry
from .base import BackendUnavailable
from .worker_protocol import (
    HEARTBEAT_SECONDS,
    PROTOCOL_VERSION,
    job_dir,
    motion_to_dict,
    read_json,
    request_from_dict,
    safe_name,
    write_heartbeat,
    write_json,
)


class MotionWorker:
    def __init__(self, root, name: str, model_ids=None, idle_unload: float = 600.0, specs=None, make_backend=None):
        self.root = Path(root)
        self.name = safe_name(name)
        self.idle_unload = float(idle_unload)
        all_specs = specs if specs is not None else registry.load_specs()
        wanted = set(model_ids or all_specs)
        self.specs = {key: spec for key, spec in all_specs.items() if key in wanted}
        self._make = make_backend or (lambda spec: registry.backend_class(spec.backend)(spec, self.root))
        self.ready, self.unavailable = {}, {}
        self.loaded = None  # (model id, backend)
        self.last_job = time.time()
        self.state = "starting"
        self._stop = threading.Event()
        self._lock = threading.Lock()

    # --- capabilities ----------------------------------------------------------------

    def probe(self) -> None:
        """Which of the requested models can run in this environment."""
        self.ready, self.unavailable = {}, {}
        for key, spec in self.specs.items():
            try:
                self._make(spec).check_available()
                self.ready[key] = spec
            except BackendUnavailable as exc:
                self.unavailable[key] = {"reason": str(exc), "hint": exc.hint}
            except Exception as exc:
                self.unavailable[key] = {"reason": str(exc), "hint": ""}

    def heartbeat(self) -> None:
        with self._lock:
            loaded = self.loaded[0] if self.loaded else None
            state = self.state
        write_heartbeat(
            self.root, self.name, sorted(self.ready), state=state, loaded=loaded,
            unavailable=self.unavailable, python=platform.python_version(),
        )

    def _heartbeat_loop(self) -> None:
        while not self._stop.wait(HEARTBEAT_SECONDS):
            try:
                self.heartbeat()
            except OSError:
                pass

    # --- jobs ------------------------------------------------------------------------

    def _backend(self, spec, report):
        if self.loaded and self.loaded[0] == spec.id:
            return self.loaded[1]
        self.unload()
        backend = self._make(spec)
        backend.check_available()
        backend.load(report)
        with self._lock:
            self.loaded = (spec.id, backend)
        return backend

    def unload(self) -> None:
        with self._lock:
            loaded, self.loaded = self.loaded, None
        if loaded:
            loaded[1].unload()

    def next_job(self):
        inbox = job_dir(self.root, self.name, "inbox")
        jobs = sorted(inbox.glob("*.json"), key=lambda p: p.stat().st_mtime) if inbox.is_dir() else []
        return jobs[0] if jobs else None

    def process(self, path: Path) -> None:
        processing = job_dir(self.root, self.name, "processing")
        processing.mkdir(parents=True, exist_ok=True)
        claimed = processing / path.name
        try:
            os.replace(path, claimed)  # ComfyUI may have withdrawn it meanwhile
        except OSError:
            return
        job_id = path.stem
        status = job_dir(self.root, self.name, "status") / f"{job_id}.json"
        outbox = job_dir(self.root, self.name, "outbox") / f"{job_id}.json"

        def report(message, progress):
            write_json(status, {"message": str(message), "progress": float(progress)})

        with self._lock:
            self.state = "busy"
        try:
            job = read_json(claimed) or {}
            if job.get("protocol") != PROTOCOL_VERSION:
                raise ValueError("the job was written by a different Pose Studio version")
            spec = self.ready.get(str(job.get("model")))
            if spec is None:
                info = self.unavailable.get(str(job.get("model")), {})
                raise BackendUnavailable(info.get("reason") or f"this worker does not run {job.get('model')}", info.get("hint", ""))
            backend = self._backend(spec, report)
            motion = backend.generate(request_from_dict(job["request"]), report)
            write_json(outbox, {"ok": True, "motion": motion_to_dict(motion)})
        except BackendUnavailable as exc:
            write_json(outbox, {"ok": False, "error": str(exc), "hint": exc.hint, "unavailable": True})
        except Exception as exc:
            traceback.print_exc()
            write_json(outbox, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        finally:
            self.last_job = time.time()
            with self._lock:
                self.state = "idle"
            try:
                claimed.unlink()
            except OSError:
                pass

    def step(self) -> bool:
        """Run one waiting job, or free the model when idle. Returns True if a job ran."""
        job = self.next_job()
        if job is not None:
            self.process(job)
            return True
        if self.loaded and self.idle_unload > 0 and time.time() - self.last_job > self.idle_unload:
            print(f"[motion-worker] idle for {int(self.idle_unload)} s, freeing {self.loaded[0]}")
            self.unload()
        return False

    def run(self, poll: float = 0.2) -> None:
        self.probe()
        for key in self.ready:
            print(f"[motion-worker] {self.name}: serving {key}")
        for key, info in self.unavailable.items():
            print(f"[motion-worker] {self.name}: cannot run {key}: {info['reason']}")
        with self._lock:
            self.state = "idle"
        self.heartbeat()
        beat = threading.Thread(target=self._heartbeat_loop, daemon=True)
        beat.start()
        try:
            while not self._stop.is_set():
                if not self.step():
                    time.sleep(poll)
        finally:
            self._stop.set()
            self.unload()
            try:
                (self.root / "workers" / f"{self.name}.json").unlink()
            except OSError:
                pass

    def stop(self) -> None:
        self._stop.set()
