"""Bounded, atomic local IPC survives terminating a blocked network reader."""
import json
import os
import queue
import time
import tempfile
from contextlib import contextmanager
from pathlib import Path

from .import_search_diagnostics import trace, trace_message

PUBLISH_RETRY_SECONDS = 5.0


@contextmanager
def scan_spool(prefix):
    """Keep disposable IPC out of synced/redirected application data folders."""
    temporary = tempfile.TemporaryDirectory(prefix=f"cellxplorer-{prefix}")
    try:
        yield temporary.name
    finally:
        try:
            temporary.cleanup()
        except OSError as exc:
            # Cleanup must never turn successful indexing into a recovery scan.
            trace("spool_cleanup_deferred", directory=temporary.name, error=repr(exc))


def receive(messages, *, last_message, silence_timeout, timeout=0.1):
    """Yield to cancellation between locked polls without renewing the watchdog."""
    try:
        return messages.get(timeout=timeout)
    except PermissionError as exc:
        if time.monotonic() - last_message >= silence_timeout:
            raise
        trace("spool_access_retry", error=repr(exc))
        raise queue.Empty from exc


def _retry_access(operation, deadline: float):
    """Retry transient spool locks within the caller's existing wait budget."""
    while True:
        try:
            return operation()
        except PermissionError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise
            time.sleep(min(0.01, remaining))
            if time.monotonic() >= deadline:
                # Preserve the access error, not queue.Empty or a new timeout.
                raise


class BatchSpool:
    def __init__(self, directory: str):
        self.directory = Path(directory)
        self.sequence = 0
        self.pending_ack = None

    def put(self, message: dict):
        while len(list(self.directory.glob("*.json"))) >= 8:
            time.sleep(0.02)
        temporary = self.directory / f"{self.sequence:012d}.tmp"
        destination = temporary.with_suffix(".json")
        temporary.write_text(json.dumps(message, ensure_ascii=False), encoding="utf-8")
        # Closing our writer does not exclude a scanner briefly opening the
        # temporary file without FILE_SHARE_DELETE on Windows. Publish the same
        # complete frame, never rewrite it or advance sequence on failure. This
        # local retry does not renew the coordinator's existing worker watchdog.
        _retry_access(lambda: os.replace(temporary, destination),
                      time.monotonic() + PUBLISH_RETRY_SECONDS)
        trace_message("worker_message", message, self.directory)
        self.sequence += 1

    def get(self, timeout: float):
        end = time.monotonic() + timeout
        while True:
            paths = [self.pending_ack[0]] if self.pending_ack else sorted(self.directory.glob("*.json"))
            if paths:
                # Only complete, atomically renamed files are visible. A killed
                # producer can leave a .tmp, never a partially readable message.
                path = paths[0]
                if self.pending_ack is None:
                    message = json.loads(_retry_access(lambda: path.read_text(encoding="utf-8"), end))
                    self.pending_ack = (path, message)
                else:
                    message = self.pending_ack[1]
                # Do not deliver a message until its acknowledgement succeeds.
                # Retrying unlink must not reread/reparse or deliver duplicates.
                _retry_access(path.unlink, end)
                self.pending_ack = None
                return message
            remaining = end - time.monotonic()
            if remaining <= 0:
                raise queue.Empty
            time.sleep(min(0.01, remaining))
