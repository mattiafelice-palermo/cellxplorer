"""Foreground-first admission for disposable source indexing, never request blocking."""
from __future__ import annotations

import threading
import time
from contextlib import contextmanager

STARTUP_GRACE_SECONDS = 10.0
FOREGROUND_QUIET_SECONDS = 1.0


class IndexAdmission:
    def __init__(self, *, clock=time.monotonic, setup_ready=lambda: True,
                 startup_grace=STARTUP_GRACE_SECONDS, quiet=FOREGROUND_QUIET_SECONDS):
        self.clock = clock
        self.setup_ready = setup_ready
        self.quiet = quiet
        self.start_at = clock() + startup_grace
        self.last_finished = float("-inf")
        self.active = 0
        self.setup_complete = False
        self.next_setup_check = 0.0
        self.lock = threading.Lock()

    @contextmanager
    def foreground(self):
        with self.lock:
            self.active += 1
        try:
            yield
        finally:
            with self.lock:
                self.active -= 1
                self.last_finished = self.clock()

    def allowed(self):
        with self.lock:
            if self.active or self.clock() < max(self.start_at, self.last_finished + self.quiet):
                return False
            if self.setup_complete:
                return True
            if self.clock() < self.next_setup_check:
                return False
            self.next_setup_check = self.clock() + 0.5
        # Marker reads happen only on background coordinator threads, at most
        # twice per second until resolved, and never again during this runtime.
        ready = self.setup_ready()
        with self.lock:
            self.setup_complete = ready
        return ready


def foreground_request(path):
    if not path.startswith("/api/"):
        return False
    return not (path.startswith(("/api/automation/", "/api/source-check-jobs/")) or path in {
        "/api/health", "/api/database/status", "/api/meta", "/api/background-jobs",
        "/api/activity", "/api/analysis-updates", "/api/analysis-updates/summary",
        "/api/import-search/settings", "/api/import-search/presets",
    })


_runtime = None


def start_runtime():
    global _runtime
    from .beta_bootstrap import indexing_setup_ready
    _runtime = IndexAdmission(setup_ready=indexing_setup_ready)


def allowed():
    return _runtime is None or _runtime.allowed()


@contextmanager
def foreground_request_scope(path):
    runtime = _runtime
    if runtime is not None and foreground_request(path):
        with runtime.foreground():
            yield
    else:
        yield
