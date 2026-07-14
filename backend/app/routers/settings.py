from __future__ import annotations

import os
from pathlib import Path
from shutil import copyfileobj

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AppSetting

router = APIRouter(prefix="/api", tags=["settings"])

DOWNLOAD_MODE_KEY = "download_mode"
DOWNLOAD_FOLDER_KEY = "download_folder"
VALID_DOWNLOAD_MODES = {"ask", "folder"}


class DownloadSettings(BaseModel):
    download_mode: str = "ask"
    download_folder: str | None = None


def _setting(db: Session, key: str) -> str | None:
    row = db.get(AppSetting, key)
    return row.value if row else None


def _set_setting(db: Session, key: str, value: str | None) -> None:
    row = db.get(AppSetting, key)
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))


def _current_settings(db: Session) -> DownloadSettings:
    mode = _setting(db, DOWNLOAD_MODE_KEY) or "ask"
    if mode not in VALID_DOWNLOAD_MODES:
        mode = "ask"
    return DownloadSettings(
        download_mode=mode,
        download_folder=_setting(db, DOWNLOAD_FOLDER_KEY),
    )


def _validated_folder(raw_path: str | None) -> Path:
    if not raw_path or not raw_path.strip():
        raise HTTPException(status_code=422, detail="Choose a default download folder.")
    try:
        folder = Path(raw_path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=422, detail="The selected folder does not exist.")
    if not folder.is_dir():
        raise HTTPException(status_code=422, detail="The selected path is not a folder.")
    if not os.access(folder, os.W_OK):
        raise HTTPException(status_code=422, detail="The selected folder is not writable.")
    return folder


def _safe_filename(filename: str | None) -> str:
    name = (filename or "download").replace("\\", "/").split("/")[-1].strip()
    if not name or name in {".", ".."}:
        raise HTTPException(status_code=422, detail="The download filename is invalid.")
    return name


def _available_path(folder: Path, filename: str) -> Path:
    candidate = folder / filename
    if not candidate.exists():
        return candidate
    stem, suffix = candidate.stem, candidate.suffix
    counter = 2
    while True:
        candidate = folder / f"{stem} ({counter}){suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


@router.get("/settings", response_model=DownloadSettings)
def get_settings(db: Session = Depends(get_db)):
    return _current_settings(db)


@router.put("/settings", response_model=DownloadSettings)
def update_settings(payload: DownloadSettings, db: Session = Depends(get_db)):
    if payload.download_mode not in VALID_DOWNLOAD_MODES:
        raise HTTPException(status_code=422, detail="Unknown download behavior.")

    folder_value = payload.download_folder
    if payload.download_mode == "folder":
        folder_value = str(_validated_folder(folder_value))
    elif folder_value and folder_value.strip():
        folder_value = str(_validated_folder(folder_value))
    else:
        folder_value = None

    _set_setting(db, DOWNLOAD_MODE_KEY, payload.download_mode)
    _set_setting(db, DOWNLOAD_FOLDER_KEY, folder_value)
    db.commit()
    return _current_settings(db)


@router.post("/downloads")
def save_download(file: UploadFile = File(...), db: Session = Depends(get_db)):
    settings = _current_settings(db)
    if settings.download_mode != "folder":
        raise HTTPException(status_code=409, detail="No default download folder is enabled.")
    folder = _validated_folder(settings.download_folder)
    destination = _available_path(folder, _safe_filename(file.filename))
    try:
        with destination.open("xb") as output:
            copyfileobj(file.file, output, length=1024 * 1024)
    except OSError as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Could not save the download: {exc}")
    finally:
        file.file.close()
    return {
        "saved": True,
        "filename": destination.name,
        "path": str(destination),
    }
