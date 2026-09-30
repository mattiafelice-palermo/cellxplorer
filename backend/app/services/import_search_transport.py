"""Bounded, atomic local IPC survives terminating a blocked network reader."""
import json
import os
import queue
import time
from pathlib import Path


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
        os.replace(temporary, destination)
        self.sequence += 1

    def get(self, timeout: float):
        end = time.monotonic() + timeout
        while True:
            paths = sorted(self.directory.glob("*.json"))
            if paths:
                # Only complete, atomically renamed files are visible. A killed
                # producer can leave a .tmp, never a partially readable message.
                path = paths[0]
                message = json.loads(path.read_text(encoding="utf-8"))
                path.unlink()
                return message
            if time.monotonic() >= end:
                raise queue.Empty
            time.sleep(0.01)
