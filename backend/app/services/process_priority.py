from __future__ import annotations

import contextlib
import os
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor

# Windows scheduling classes. These only nudge background work aside; they do
# not change scientific results or correctness.
THREAD_PRIORITY_BELOW_NORMAL = -1
BELOW_NORMAL_PRIORITY_CLASS = 0x00004000


def apply_background_thread_priority() -> bool:
    """Lower only the current thread on Windows."""
    if os.name != "nt":
        return False
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        thread = kernel32.GetCurrentThread()
        return bool(kernel32.SetThreadPriority(thread, THREAD_PRIORITY_BELOW_NORMAL))
    except Exception:
        return False


def apply_background_process_priority() -> bool:
    """Lower the whole worker process on Windows."""
    if os.name != "nt":
        return False
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        process = kernel32.GetCurrentProcess()
        return bool(kernel32.SetPriorityClass(process, BELOW_NORMAL_PRIORITY_CLASS))
    except Exception:
        return False


def background_pool_initializer() -> None:
    """ProcessPoolExecutor worker entry hook."""
    apply_background_process_priority()


def process_pool_executor(max_workers: int) -> ProcessPoolExecutor:
    kwargs: dict = {"max_workers": max_workers}
    if os.name == "nt":
        kwargs["initializer"] = background_pool_initializer
    return ProcessPoolExecutor(**kwargs)


def thread_pool_executor(max_workers: int, **kwargs) -> ThreadPoolExecutor:
    if os.name == "nt":
        kwargs.setdefault("initializer", apply_background_thread_priority)
    return ThreadPoolExecutor(max_workers=max_workers, **kwargs)


@contextlib.contextmanager
def background_thread_priority(enabled: bool = True):
    """Temporarily lower only the current worker thread on Windows."""
    if not enabled or os.name != "nt":
        yield
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        thread = kernel32.GetCurrentThread()
        previous = kernel32.GetThreadPriority(thread)
        configured = bool(kernel32.SetThreadPriority(thread, THREAD_PRIORITY_BELOW_NORMAL))
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
