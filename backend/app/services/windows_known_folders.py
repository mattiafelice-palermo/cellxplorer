"""Resolve Windows user folders without adding a platform dependency."""

from __future__ import annotations

import ctypes
import sys
from pathlib import Path
from uuid import UUID

from ctypes import wintypes


class _Guid(ctypes.Structure):
    _fields_ = [
        ("data1", wintypes.DWORD),
        ("data2", wintypes.WORD),
        ("data3", wintypes.WORD),
        ("data4", wintypes.BYTE * 8),
    ]


KNOWN_FOLDER_IDS = {
    "desktop": "B4BFCC3A-DB2C-424C-B029-7FE99A87C641",
    "documents": "FDD39AD0-238F-46AF-ADB4-6C85480369C7",
    "downloads": "374DE290-123F-4565-9164-39C4925E467B",
}


def _fallback_folders(home: Path) -> dict[str, Path]:
    return {
        "home": home,
        "desktop": home / "Desktop",
        "documents": home / "Documents",
        "downloads": home / "Downloads",
    }


def _guid_from_text(value: str) -> _Guid:
    return _Guid.from_buffer_copy(UUID(value).bytes_le)


def _windows_api():
    win_dll = getattr(ctypes, "WinDLL", None)
    if win_dll is None:
        return None
    try:
        shell32 = win_dll("shell32", use_last_error=True)
        ole32 = win_dll("ole32", use_last_error=True)
    except (OSError, AttributeError):
        return None

    try:
        get_known_folder_path = shell32.SHGetKnownFolderPath
        get_known_folder_path.argtypes = [
            ctypes.POINTER(_Guid),
            wintypes.DWORD,
            wintypes.HANDLE,
            ctypes.POINTER(ctypes.c_wchar_p),
        ]
        get_known_folder_path.restype = wintypes.HRESULT
        ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
        ole32.CoTaskMemFree.restype = None
    except (AttributeError, TypeError, ValueError):
        return None
    return get_known_folder_path, ole32.CoTaskMemFree


def _resolve_known_folder(folder_id: str) -> Path | None:
    api = _windows_api()
    if api is None:
        return None
    get_known_folder_path, free = api
    guid = _guid_from_text(folder_id)
    allocated_path = ctypes.c_wchar_p()
    try:
        result = get_known_folder_path(
            ctypes.byref(guid),
            0,
            None,
            ctypes.byref(allocated_path),
        )
        if result != 0 or not allocated_path.value:
            return None
        return Path(allocated_path.value)
    finally:
        free(ctypes.cast(allocated_path, ctypes.c_void_p))


def known_user_folders(home: Path | None = None) -> dict[str, Path]:
    """Return Home/Desktop/Documents/Downloads, honoring Windows redirection."""

    resolved_home = home if home is not None else Path.home()
    folders = _fallback_folders(resolved_home)
    if sys.platform != "win32":
        return folders

    for key, folder_id in KNOWN_FOLDER_IDS.items():
        try:
            resolved = _resolve_known_folder(folder_id)
        except (AttributeError, OSError, RuntimeError, ValueError, ctypes.ArgumentError):
            resolved = None
        if resolved is not None:
            folders[key] = resolved
    return folders
