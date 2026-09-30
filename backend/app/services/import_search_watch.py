"""Stoppable native subscriptions. No catalog, parser or source writes here."""
from __future__ import annotations

import os
import queue
import struct
import time

BUFFER_SIZE = 60 * 1024  # SMB rejects notification buffers larger than 64 KiB.


def decode_notifications(data: bytes) -> list[str]:
    paths = []
    offset = 0
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError("Incomplete notification")
        following, action, length = struct.unpack_from("<III", data, offset)
        if action not in (1, 2, 3, 4, 5) or length % 2 or offset + 12 + length > len(data):
            raise ValueError("Invalid notification")
        name = data[offset + 12:offset + 12 + length].decode("utf-16-le")
        # Native data is still input: never let a relative event escape its root.
        import ntpath
        if not name or name.startswith(("\\", "/")) or ntpath.isabs(name) or ntpath.splitdrive(name)[0] or ".." in name.replace("/", "\\").split("\\"):
            raise ValueError("Invalid notification path")
        paths.append(name)
        if not following:
            break
        if following < 12 + length or following % 4 or offset + following >= len(data):
            raise ValueError("Invalid notification offset")
        offset += following
    return paths


ROOT_CHECK_SECONDS = 30


def watch_root(path: str, messages, stop, overflow, root_check_seconds=ROOT_CHECK_SECONDS) -> None:
    """One recursive handle per chosen root, isolated from potentially hung SMB calls."""
    def emit(kind, **values):
        try:
            messages.put_nowait(dict(kind=kind, **values))
        except queue.Full:
            overflow.set()  # A separate flag cannot be lost to a full queue.

    if os.name != "nt":
        emit("unsupported", message="Live monitoring is available on Windows only.")
        return
    import ctypes
    from ctypes import wintypes as w

    class Overlapped(ctypes.Structure):
        _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                    ("Offset", w.DWORD), ("OffsetHigh", w.DWORD), ("hEvent", w.HANDLE)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
    kernel.CreateFileW.restype = w.HANDLE
    kernel.CreateEventW.argtypes = [ctypes.c_void_p, w.BOOL, w.BOOL, w.LPCWSTR]
    kernel.CreateEventW.restype = w.HANDLE
    kernel.ReadDirectoryChangesW.argtypes = [w.HANDLE, ctypes.c_void_p, w.DWORD, w.BOOL, w.DWORD,
                                           ctypes.c_void_p, ctypes.POINTER(Overlapped), ctypes.c_void_p]
    kernel.ReadDirectoryChangesW.restype = w.BOOL
    kernel.GetOverlappedResult.argtypes = [w.HANDLE, ctypes.POINTER(Overlapped), ctypes.POINTER(w.DWORD), w.BOOL]
    kernel.GetOverlappedResult.restype = w.BOOL
    kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
    kernel.WaitForSingleObject.restype = w.DWORD
    kernel.CancelIoEx.argtypes = [w.HANDLE, ctypes.POINTER(Overlapped)]
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.ResetEvent.argtypes = [w.HANDLE]
    # Windows notifications exclude rename/replacement of the watched directory
    # itself. A single bounded metadata probe (not traversal) detects that gap.
    # Network stat can block too, so it stays inside this stoppable process.
    try:
        info = os.stat(path, follow_symlinks=False)
        identity = (info.st_dev, info.st_ino)
        if not info.st_ino or getattr(info, "st_file_attributes", 0) & 0x400:
            emit("unsupported", message="The location cannot provide a stable directory identity.")
            return
    except OSError:
        emit("failed")
        return
    handle = kernel.CreateFileW(path, 1, 7, None, 3, 0x02000000 | 0x40000000, None)
    if handle == ctypes.c_void_p(-1).value:
        error = ctypes.get_last_error()
        emit("unsupported" if error in (1, 50) else "failed", error=error)
        return
    event = kernel.CreateEventW(None, True, False, None)
    if not event:
        kernel.CloseHandle(handle)
        emit("failed", error=ctypes.get_last_error())
        return
    buffer = ctypes.create_string_buffer(BUFFER_SIZE)
    operation = Overlapped(hEvent=event)
    connected = False
    heartbeat = time.monotonic()
    checked = heartbeat
    try:
        while not stop.is_set():
            kernel.ResetEvent(event)
            # File/dir name and last-write events; coalescing happens in the parent.
            if not kernel.ReadDirectoryChangesW(handle, buffer, BUFFER_SIZE, True, 1 | 2 | 16, None,
                                                ctypes.byref(operation), None):
                error = ctypes.get_last_error()
                emit("unsupported" if error in (1, 50, 87) else "failed", error=error)
                return
            if not connected:
                emit("connected")  # Subscription is armed BEFORE enumeration starts.
                connected = True
            while not stop.is_set():
                result = kernel.WaitForSingleObject(event, 250)
                if time.monotonic() - heartbeat >= 2:
                    emit("heartbeat")
                    heartbeat = time.monotonic()
                if time.monotonic() - checked >= root_check_seconds:
                    try:
                        info = os.stat(path, follow_symlinks=False)
                        if (info.st_dev, info.st_ino) != identity or getattr(info, "st_file_attributes", 0) & 0x400:
                            emit("failed")
                            return
                    except OSError:
                        emit("failed")
                        return
                    checked = time.monotonic()
                if result == 0:
                    break
                if result != 258:
                    emit("failed", error=ctypes.get_last_error())
                    return
            if stop.is_set():
                return
            count = w.DWORD()
            if not kernel.GetOverlappedResult(handle, ctypes.byref(operation), ctypes.byref(count), False):
                error = ctypes.get_last_error()
                if error == 1022:  # ERROR_NOTIFY_ENUM_DIR: changes were lost.
                    overflow.set()
                    continue
                emit("unsupported" if error in (1, 50, 87) else "failed", error=error)
                return
            if not count.value:
                overflow.set()
                continue
            try:
                emit("changes", paths=decode_notifications(buffer.raw[:count.value]))
            except (ValueError, UnicodeError):
                overflow.set()
    finally:
        kernel.CancelIoEx(handle, ctypes.byref(operation))
        # Await cancellation before freeing the OVERLAPPED/output buffer.
        kernel.GetOverlappedResult(handle, ctypes.byref(operation), ctypes.byref(w.DWORD()), True)
        kernel.CloseHandle(event)
        kernel.CloseHandle(handle)
