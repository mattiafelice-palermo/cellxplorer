"""Bounded Windows cleanup for explicitly owned disposable trees.

Callers retain ownership/path validation. Never use this to remove original
sources or to bypass product deletion consent. Persistent errors still raise.
"""
from __future__ import annotations

import os
import shutil
import stat
import tempfile
import time

CLEANUP_TIMEOUT = 2.0


def remove_tree(path, *, ignore_errors=False, timeout=CLEANUP_TIMEOUT):
    target = os.path.abspath(os.fspath(path))
    if os.path.dirname(target) == target:
        raise ValueError("Refusing to remove a filesystem root")
    deadline = time.monotonic() + timeout

    def on_error(function, failed_path, error):
        # Another handle can finish deleting a child during enumeration.
        if isinstance(error, FileNotFoundError):
            return
        if os.name == "nt" and getattr(error, "winerror", None) == 5:
            failed = os.path.abspath(os.fspath(failed_path))
            if os.path.commonpath((target, failed)) != target:
                raise error
            try:
                info = os.lstat(failed)
                attributes = getattr(info, "st_file_attributes", 0)
                # copytree/copystat can copy readonly directory attributes.
                # Never chmod a junction/symlink or a path outside this tree.
                if attributes & stat.FILE_ATTRIBUTE_READONLY and not attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    os.chmod(failed, stat.S_IMODE(info.st_mode) | stat.S_IWRITE)
            except FileNotFoundError:
                return
        raise error  # Retry the entire remaining tree, never pretend it was deleted.

    while True:
        try:
            shutil.rmtree(target, onexc=on_error)
            return
        except OSError as error:
            transient = os.name == "nt" and getattr(error, "winerror", None) in (5, 32, 145)
            remaining = deadline - time.monotonic()
            if not transient or remaining <= 0:
                if ignore_errors:
                    return
                raise
            time.sleep(min(0.02, remaining))


class TemporaryDirectory(tempfile.TemporaryDirectory):
    """Owned temporary workspace with strict, bounded Windows cleanup."""

    @classmethod
    def _rmtree(cls, name, ignore_errors=False, repeated=False):
        if os.name != "nt":
            return super()._rmtree(name, ignore_errors=ignore_errors, repeated=repeated)
        remove_tree(name, ignore_errors=ignore_errors)
