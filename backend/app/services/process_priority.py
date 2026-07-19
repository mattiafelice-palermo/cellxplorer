from __future__ import annotations

import contextlib
import os


@contextlib.contextmanager
def background_thread_priority(enabled: bool):
    """Temporarily lower only the current worker thread on Windows."""
    if not enabled or os.name != "nt":
        yield
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        thread = kernel32.GetCurrentThread()
        previous = kernel32.GetThreadPriority(thread)
        configured = bool(kernel32.SetThreadPriority(thread, -1))
    except Exception:
        configured = False
        kernel32 = thread = previous = None
    if not configured:
        yield
        return
    try:
        yield
    finally:
        kernel32.SetThreadPriority(thread, previous)
