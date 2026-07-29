from __future__ import annotations

import os
import platform
import zlib
import shutil
import threading
import time
import ctypes
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import APP_DATA_DIR, CACHE_DIR, DB_PATH, LOG_DIR
from ..db import SessionLocal, get_database_status, get_db
from ..models import AppSession
from ..services import background_jobs, sessions

router = APIRouter(prefix="/api", tags=["diagnostics"])

_resource_lock = threading.Lock()
_previous_cpu_sample: tuple[float, float] | None = None


def _windows_process_tree() -> tuple[list[dict], int]:
    from ctypes import wintypes

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    class FILETIME(ctypes.Structure):
        _fields_ = [("low", wintypes.DWORD), ("high", wintypes.DWORD)]

        def seconds(self) -> float:
            return ((self.high << 32) | self.low) / 10_000_000

    class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
            ("PrivateUsage", ctypes.c_size_t),
        ]

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    kernel32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    psapi.GetProcessMemoryInfo.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(PROCESS_MEMORY_COUNTERS_EX),
        wintypes.DWORD,
    ]
    kernel32.GetProcessIoCounters.argtypes = [ctypes.c_void_p, ctypes.POINTER(IO_COUNTERS)]
    kernel32.GetProcessTimes.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(FILETIME),
        ctypes.POINTER(FILETIME),
        ctypes.POINTER(FILETIME),
        ctypes.POINTER(FILETIME),
    ]
    snapshot = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        return [], 0
    entries: dict[int, tuple[int, str]] = {}
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(entry)
    try:
        ok = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while ok:
            entries[int(entry.th32ProcessID)] = (
                int(entry.th32ParentProcessID),
                entry.szExeFile,
            )
            ok = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)

    backend_pid = os.getpid()
    parent_pid = entries.get(backend_pid, (0, ""))[0]
    packaged = os.environ.get("CELLXPLORER_STARTUP_MODE") in {"manual", "startup"}
    root_pid = parent_pid if packaged and parent_pid in entries else backend_pid
    included = {root_pid}
    while True:
        before = len(included)
        included.update(pid for pid, (parent, _) in entries.items() if parent in included)
        if len(included) == before:
            break

    processes = []
    total_cpu_seconds = 0.0
    for pid in included:
        handle = kernel32.OpenProcess(0x1000 | 0x0010, False, pid)
        if not handle:
            continue
        try:
            memory = PROCESS_MEMORY_COUNTERS_EX()
            memory.cb = ctypes.sizeof(memory)
            io = IO_COUNTERS()
            creation, exit_time, kernel, user = FILETIME(), FILETIME(), FILETIME(), FILETIME()
            memory_ok = psapi.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb)
            io_ok = kernel32.GetProcessIoCounters(handle, ctypes.byref(io))
            cpu_ok = kernel32.GetProcessTimes(
                handle,
                ctypes.byref(creation),
                ctypes.byref(exit_time),
                ctypes.byref(kernel),
                ctypes.byref(user),
            )
            cpu_seconds = kernel.seconds() + user.seconds() if cpu_ok else 0.0
            total_cpu_seconds += cpu_seconds
            processes.append(
                {
                    "pid": pid,
                    "name": entries.get(pid, (0, f"Process {pid}"))[1],
                    "memory_bytes": int(memory.WorkingSetSize) if memory_ok else 0,
                    "read_bytes": int(io.ReadTransferCount) if io_ok else 0,
                    "written_bytes": int(io.WriteTransferCount) if io_ok else 0,
                    "cpu_seconds": cpu_seconds,
                }
            )
        finally:
            kernel32.CloseHandle(handle)
    processes.sort(key=lambda row: row["memory_bytes"], reverse=True)
    return processes, total_cpu_seconds


def _resource_snapshot() -> dict:
    global _previous_cpu_sample
    sampled_at = time.perf_counter()
    if os.name == "nt":
        processes, total_cpu_seconds = _windows_process_tree()
    else:
        processes = [
            {
                "pid": os.getpid(),
                "name": "cellxplorer-backend",
                "memory_bytes": 0,
                "read_bytes": 0,
                "written_bytes": 0,
                "cpu_seconds": time.process_time(),
            }
        ]
        total_cpu_seconds = processes[0]["cpu_seconds"]

    with _resource_lock:
        previous = _previous_cpu_sample
        _previous_cpu_sample = (sampled_at, total_cpu_seconds)
    cpu_percent = 0.0
    if previous and sampled_at > previous[0]:
        cpu_percent = max(
            0.0,
            min(
                100.0,
                (total_cpu_seconds - previous[1])
                / (sampled_at - previous[0])
                / max(1, os.cpu_count() or 1)
                * 100,
            ),
        )
    for process in processes:
        process.pop("cpu_seconds", None)
    current_started = None
    current_id = sessions.current_session_id()
    if current_id is not None:
        db = SessionLocal()
        try:
            row = db.get(AppSession, current_id)
            current_started = row.started_at if row else None
        finally:
            db.close()
    uptime = (
        max(0.0, (datetime.now(timezone.utc) - current_started.replace(tzinfo=timezone.utc)).total_seconds())
        if current_started
        else 0.0
    )
    return {
        "sampled_at": datetime.now(timezone.utc).isoformat(),
        "process_count": len(processes),
        "cpu_percent": cpu_percent,
        "memory_bytes": sum(row["memory_bytes"] for row in processes),
        "read_bytes": sum(row["read_bytes"] for row in processes),
        "written_bytes": sum(row["written_bytes"] for row in processes),
        "uptime_seconds": uptime,
        "processes": processes,
    }


def _directory_size(path: Path) -> int:
    total = 0
    try:
        for entry in path.rglob("*"):
            if entry.is_file():
                try:
                    total += entry.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _writable(path: Path) -> bool:
    return path.exists() and path.is_dir() and os.access(path, os.W_OK)


def _session_dict(row: AppSession) -> dict:
    return {
        "id": row.id,
        "startup_mode": row.startup_mode,
        "status": row.status,
        "app_version": row.app_version,
        "backend_pid": row.backend_pid,
        "exit_reason": row.exit_reason,
        "started_at": row.started_at.isoformat(),
        "finished_at": row.finished_at.isoformat() if row.finished_at else None,
    }


@router.get("/sessions")
def list_sessions(limit: int = Query(50, ge=1, le=300), db: Session = Depends(get_db)):
    rows = db.query(AppSession).order_by(AppSession.started_at.desc(), AppSession.id.desc()).limit(limit).all()
    return [_session_dict(row) for row in rows]


@router.post("/session/finish")
def finish_current_session():
    row = sessions.finish_runtime_session("quit")
    return {"finished": row is not None, "session": _session_dict(row) if row else None}


@router.get("/diagnostics/health")
def diagnostics_health():
    database_status = get_database_status()
    database_ok = bool(database_status and database_status.compatible)
    db = SessionLocal() if database_ok else None
    if db is not None:
        try:
            db.execute(text("SELECT 1"))
        except Exception:
            database_ok = False
    disk = shutil.disk_usage(APP_DATA_DIR)
    current_id = sessions.current_session_id()
    current = (
        db.get(AppSession, current_id)
        if db is not None and current_id is not None
        else None
    )
    jobs = background_jobs.list_jobs(limit=30)
    try:
        return {
            "sampled_at": datetime.now(timezone.utc).isoformat(),
            "backend": {
                "status": "ok",
                "pid": os.getpid(),
                "database_ok": database_ok,
                # Build-environment facts about the *running* sidecar. The packaged
                # backend crash loop was a build problem, so being able to see which
                # interpreter an install actually froze is worth the two lines. zlib
                # is here because CPython only links zlib-ng on Windows from 3.14,
                # and that is a ~1.5x difference in .ndax inflate speed.
                "python_version": platform.python_version(),
                "zlib_version": zlib.ZLIB_RUNTIME_VERSION,
            },
            "database": database_status.as_dict() if database_status else None,
            "storage": {
                "data_path": str(APP_DATA_DIR),
                "log_path": str(LOG_DIR),
                "database_bytes": DB_PATH.stat().st_size if DB_PATH.exists() else 0,
                "cache_bytes": _directory_size(CACHE_DIR),
                "free_bytes": disk.free,
                "total_bytes": disk.total,
                "data_writable": _writable(APP_DATA_DIR),
                "cache_writable": _writable(CACHE_DIR),
                "logs_writable": _writable(LOG_DIR),
            },
            "jobs": {
                "running": sum(job["status"] == "running" for job in jobs),
                "failed": sum(job["status"] == "failed" for job in jobs),
            },
            "session": _session_dict(current) if current else None,
        }
    finally:
        if db is not None:
            db.close()


@router.get("/diagnostics/resources")
def diagnostics_resources():
    return _resource_snapshot()


def _tail(path: Path, limit: int) -> list[str]:
    if not path.exists():
        return []
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 512 * 1024))
            text_value = handle.read().decode("utf-8", errors="replace")
        return text_value.splitlines()[-limit:]
    except OSError as exc:
        return [f"Could not read {path.name}: {exc}"]


@router.get("/diagnostics/logs")
def diagnostics_logs(limit: int = Query(200, ge=1, le=1000)):
    return {
        "backend": _tail(LOG_DIR / "backend.log", limit),
        "crash": _tail(LOG_DIR / "backend-crash.log", limit),
    }
