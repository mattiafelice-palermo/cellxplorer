"""Small read-only header I/O surface; retain every source fingerprint checkpoint."""
from __future__ import annotations

from functools import lru_cache
import io
import os
from pathlib import Path
from typing import NamedTuple


class Fingerprint(NamedTuple):
    st_size: int
    st_mtime_ns: int


class UnsafeSourceError(OSError):
    pass


def _regular(attributes):
    if attributes & (0x10 | 0x400):
        raise UnsafeSourceError("Header source is a directory or reparse point")


class _WindowsInfo:
    def __init__(self):
        import ctypes as c
        from ctypes import wintypes as w
        import msvcrt

        class Basic(c.Structure):
            _fields_ = [(name, c.c_int64) for name in ('created', 'accessed', 'written', 'changed')] + [('attributes', w.DWORD)]

        class Standard(c.Structure):
            _fields_ = [('allocation', c.c_int64), ('end', c.c_int64), ('links', w.DWORD), ('deleted', w.BYTE), ('directory', w.BYTE)]

        class FT(c.Structure):
            _fields_ = [('low', w.DWORD), ('high', w.DWORD)]

        class Attributes(c.Structure):
            _fields_ = [('attributes', w.DWORD), ('created', FT), ('accessed', FT), ('written', FT), ('high', w.DWORD), ('low', w.DWORD)]

        if (c.sizeof(Basic), c.sizeof(Standard), c.sizeof(Attributes)) != (40, 24, 36):
            raise RuntimeError("Unsupported Windows file-information ABI")
        kernel = c.WinDLL('kernel32', use_last_error=True)
        kernel.GetFileInformationByHandleEx.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
        kernel.GetFileInformationByHandleEx.restype = w.BOOL
        kernel.GetFileAttributesExW.argtypes = [w.LPCWSTR, c.c_int, c.c_void_p]
        kernel.GetFileAttributesExW.restype = w.BOOL
        self.c, self.kernel, self.handle = c, kernel, msvcrt.get_osfhandle
        self.Basic, self.Standard, self.Attributes = Basic, Standard, Attributes

    def _check(self, success):
        if not success:
            raise self.c.WinError(self.c.get_last_error())

    def fstat(self, fd):
        basic, standard = self.Basic(), self.Standard()
        handle = self.handle(fd)
        self._check(self.kernel.GetFileInformationByHandleEx(handle, 0, self.c.byref(basic), self.c.sizeof(basic)))
        self._check(self.kernel.GetFileInformationByHandleEx(handle, 1, self.c.byref(standard), self.c.sizeof(standard)))
        _regular(basic.attributes)
        return Fingerprint(standard.end, (basic.written - 116444736000000000) * 100)

    def stat(self, path):
        value = self.Attributes()
        path = os.path.abspath(os.fspath(path))
        if not path.startswith('\\\\?\\'):
            path = '\\\\?\\UNC\\' + path[2:] if path.startswith('\\\\') else '\\\\?\\' + path
        self._check(self.kernel.GetFileAttributesExW(path, 0, self.c.byref(value)))
        _regular(value.attributes)
        written = (value.written.high << 32) | value.written.low
        return Fingerprint((value.high << 32) | value.low, (written - 116444736000000000) * 100)


@lru_cache(maxsize=1)
def _api():
    if os.name == 'nt':
        try:
            return _WindowsInfo()
        except (OSError, AttributeError, RuntimeError):
            pass
    return None


class _RawFD(io.RawIOBase):
    def __init__(self, fd, name):
        super().__init__()
        self.fd, self.name = fd, os.fspath(name)

    def fileno(self):
        if self.closed:
            raise ValueError("Closed header source")
        return self.fd

    def readinto(self, buffer):
        value = os.read(self.fileno(), len(buffer))
        buffer[:len(value)] = value
        return len(value)

    def seek(self, offset, whence=0):
        return os.lseek(self.fileno(), offset, whence)

    def tell(self):
        return self.seek(0, 1)

    def readable(self):
        return True

    def seekable(self):
        return True

    def close(self):
        if not self.closed:
            try:
                os.close(self.fd)
            finally:
                super().close()


def open_header(path):
    if os.name != 'nt' or _api() is None:
        return Path(path).open('rb')
    fd = os.open(path, os.O_RDONLY | os.O_BINARY | os.O_NOINHERIT)
    raw = _RawFD(fd, path)
    try:
        return io.BufferedReader(raw)
    except BaseException:
        raw.close()
        raise


def handle_fingerprint(fd):
    api = _api()
    if api is not None:
        try:
            return api.fstat(fd)
        except UnsafeSourceError:
            raise
        except OSError:
            pass  # Older filesystems may not implement these information classes.
    return os.fstat(fd)


def path_fingerprint(path):
    api = _api()
    if api is not None:
        try:
            return api.stat(path)
        except UnsafeSourceError:
            raise
        except OSError:
            pass
    value = os.stat(path, follow_symlinks=False)
    _regular(getattr(value, 'st_file_attributes', 0))
    import stat
    if stat.S_ISLNK(value.st_mode) or stat.S_ISDIR(value.st_mode):
        raise UnsafeSourceError("Header source is a link or directory")
    return value
