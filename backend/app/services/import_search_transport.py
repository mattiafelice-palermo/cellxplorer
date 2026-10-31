"""Bounded, atomic local IPC survives terminating a blocked network reader."""
import json
import os
import queue
import time
from pathlib import Path

PUBLISH_RETRY_SECONDS = 0.1


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
        self.sequence += 1

    def get(self, timeout: float):
        end = time.monotonic() + timeout
        while True:
            paths = sorted(self.directory.glob("*.json"))
            if paths:
                # Only complete, atomically renamed files are visible. A killed
                # producer can leave a .tmp, never a partially readable message.
                path = paths[0]
                message = json.loads(_retry_access(lambda: path.read_text(encoding="utf-8"), end))
                # Do not deliver a message until its acknowledgement succeeds.
                # Retrying unlink must not reread/reparse or deliver duplicates.
                _retry_access(path.unlink, end)
                return message
            remaining = end - time.monotonic()
            if remaining <= 0:
                raise queue.Empty
            time.sleep(min(0.01, remaining))
