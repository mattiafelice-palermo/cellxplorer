from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from shutil import copyfileobj
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AppSetting
from ..services import download_registry, source_monitor

router = APIRouter(prefix="/api", tags=["settings"])

DOWNLOAD_MODE_KEY = "download_mode"
DOWNLOAD_FOLDER_KEY = "download_folder"
VALID_DOWNLOAD_MODES = {"ask", "folder"}
AREA_PRESETS_KEY = "electrode_area_presets"
MATERIAL_PRESETS_KEY = "active_material_presets"
PLOT_STYLE_PRESETS_KEY = "plot_style_presets"
COLOR_PALETTES_KEY = "color_palettes"
EXPORT_FILENAME_TEMPLATE_KEY = "export_filename_template"


class DownloadSettings(BaseModel):
    download_mode: str = "ask"
    download_folder: str | None = None
    export_filename_template: str = "{analysis} - {plot_title}"


class SourceMonitoringSettings(BaseModel):
    enabled: bool = False
    schedule_mode: Literal["interval", "daily"] = "interval"
    interval_value: int = 6
    interval_unit: Literal["minutes", "hours", "days"] = "hours"
    daily_every_days: int = 1
    daily_time: str = "02:00"
    auto_update: bool = False
    scan_batch_size: int = 100
    stability_value: int = 5
    stability_unit: Literal["seconds", "minutes"] = "seconds"
    retry_count: int = 3
    retry_delay_minutes: int = 5
    next_run_at: str | None = None
    last_started_at: str | None = None
    last_finished_at: str | None = None
    last_status: str | None = None


class ElectrodeAreaPreset(BaseModel):
    id: str
    name: str
    area_cm2: float
    description: str | None = None
    is_default: bool = False


class ElectrodeAreaPresetSettings(BaseModel):
    presets: list[ElectrodeAreaPreset]


class ActiveMaterialPreset(BaseModel):
    id: str
    name: str
    specific_capacity_mah_g: float
    description: str | None = None
    is_default: bool = False


class ActiveMaterialPresetSettings(BaseModel):
    presets: list[ActiveMaterialPreset]


class PlotStylePreset(BaseModel):
    id: str
    name: str
    plot_family: Literal["all", "cycles", "time_capacity"] = "all"
    style: dict
    is_default: bool = False


class PlotStylePresetSettings(BaseModel):
    presets: list[PlotStylePreset]


class ColorPalette(BaseModel):
    id: str
    name: str
    kind: Literal["categorical", "sequential"] = "categorical"
    colors: list[str]


class ColorPaletteSettings(BaseModel):
    palettes: list[ColorPalette]


DEFAULT_AREA_PRESETS = [
    ElectrodeAreaPreset(
        id="coin-14mm",
        name="14 mm circular electrode",
        area_cm2=1.539,
        description="Common coin-cell electrode diameter.",
        is_default=True,
    ),
    ElectrodeAreaPreset(
        id="coin-15mm",
        name="15 mm circular electrode",
        area_cm2=1.767,
        description="Common coin-cell electrode diameter.",
    ),
]

DEFAULT_MATERIAL_PRESETS = [
    ActiveMaterialPreset(
        id="lfp-reference",
        name="LFP",
        specific_capacity_mah_g=170,
        description="Editable reference value; confirm the convention used by your laboratory.",
        is_default=True,
    ),
    ActiveMaterialPreset(
        id="nmc-reference",
        name="NMC",
        specific_capacity_mah_g=200,
        description="Editable reference value; confirm the convention used by your laboratory.",
    ),
]


def _setting(db: Session, key: str) -> str | None:
    row = db.get(AppSetting, key)
    return row.value if row else None


def _set_setting(db: Session, key: str, value: str | None) -> None:
    row = db.get(AppSetting, key)
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))


def _area_presets(db: Session) -> ElectrodeAreaPresetSettings:
    raw = _setting(db, AREA_PRESETS_KEY)
    if not raw:
        return ElectrodeAreaPresetSettings(presets=DEFAULT_AREA_PRESETS)
    try:
        payload = json.loads(raw)
        return ElectrodeAreaPresetSettings.model_validate({"presets": payload})
    except (ValueError, TypeError):
        return ElectrodeAreaPresetSettings(presets=DEFAULT_AREA_PRESETS)


def _material_presets(db: Session) -> ActiveMaterialPresetSettings:
    raw = _setting(db, MATERIAL_PRESETS_KEY)
    if not raw:
        return ActiveMaterialPresetSettings(presets=DEFAULT_MATERIAL_PRESETS)
    try:
        payload = json.loads(raw)
        return ActiveMaterialPresetSettings.model_validate({"presets": payload})
    except (ValueError, TypeError):
        return ActiveMaterialPresetSettings(presets=DEFAULT_MATERIAL_PRESETS)


def _plot_style_presets(db: Session) -> PlotStylePresetSettings:
    raw = _setting(db, PLOT_STYLE_PRESETS_KEY)
    if not raw:
        return PlotStylePresetSettings(presets=[])
    try:
        return PlotStylePresetSettings.model_validate({"presets": json.loads(raw)})
    except (ValueError, TypeError):
        return PlotStylePresetSettings(presets=[])


def _color_palettes(db: Session) -> ColorPaletteSettings:
    raw = _setting(db, COLOR_PALETTES_KEY)
    if not raw:
        return ColorPaletteSettings(palettes=[])
    try:
        return ColorPaletteSettings.model_validate({"palettes": json.loads(raw)})
    except (ValueError, TypeError):
        return ColorPaletteSettings(palettes=[])


def _current_settings(db: Session) -> DownloadSettings:
    mode = _setting(db, DOWNLOAD_MODE_KEY) or "ask"
    if mode not in VALID_DOWNLOAD_MODES:
        mode = "ask"
    return DownloadSettings(
        download_mode=mode,
        download_folder=_setting(db, DOWNLOAD_FOLDER_KEY),
        export_filename_template=(
            _setting(db, EXPORT_FILENAME_TEMPLATE_KEY)
            or "{analysis} - {plot_title}"
        ),
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
    template = payload.export_filename_template.strip()
    _set_setting(
        db,
        EXPORT_FILENAME_TEMPLATE_KEY,
        template or "{analysis} - {plot_title}",
    )
    db.commit()
    return _current_settings(db)


@router.get("/settings/electrode-area-presets", response_model=ElectrodeAreaPresetSettings)
def get_electrode_area_presets(db: Session = Depends(get_db)):
    return _area_presets(db)


@router.put("/settings/electrode-area-presets", response_model=ElectrodeAreaPresetSettings)
def update_electrode_area_presets(
    payload: ElectrodeAreaPresetSettings,
    db: Session = Depends(get_db),
):
    names: set[str] = set()
    normalized: list[ElectrodeAreaPreset] = []
    default_seen = False
    for preset in payload.presets:
        name = preset.name.strip()
        if not name:
            raise HTTPException(422, "Every area preset needs a name.")
        if name.casefold() in names:
            raise HTTPException(409, f"Duplicate area preset name: {name}")
        if preset.area_cm2 <= 0:
            raise HTTPException(422, f"{name} must have a positive area.")
        names.add(name.casefold())
        is_default = bool(preset.is_default and not default_seen)
        default_seen = default_seen or is_default
        normalized.append(
            ElectrodeAreaPreset(
                id=preset.id.strip() or uuid.uuid4().hex,
                name=name,
                area_cm2=round(float(preset.area_cm2), 8),
                description=(preset.description or "").strip() or None,
                is_default=is_default,
            )
        )
    _set_setting(
        db,
        AREA_PRESETS_KEY,
        json.dumps([preset.model_dump() for preset in normalized]),
    )
    db.commit()
    return ElectrodeAreaPresetSettings(presets=normalized)


@router.get("/settings/active-material-presets", response_model=ActiveMaterialPresetSettings)
def get_active_material_presets(db: Session = Depends(get_db)):
    return _material_presets(db)


@router.put("/settings/active-material-presets", response_model=ActiveMaterialPresetSettings)
def update_active_material_presets(
    payload: ActiveMaterialPresetSettings,
    db: Session = Depends(get_db),
):
    names: set[str] = set()
    normalized: list[ActiveMaterialPreset] = []
    default_seen = False
    for preset in payload.presets:
        name = preset.name.strip()
        if not name:
            raise HTTPException(422, "Every material preset needs a name.")
        if name.casefold() in names:
            raise HTTPException(409, f"Duplicate material preset name: {name}")
        if preset.specific_capacity_mah_g <= 0:
            raise HTTPException(422, f"{name} must have a positive specific capacity.")
        names.add(name.casefold())
        is_default = bool(preset.is_default and not default_seen)
        default_seen = default_seen or is_default
        normalized.append(
            ActiveMaterialPreset(
                id=preset.id.strip() or uuid.uuid4().hex,
                name=name,
                specific_capacity_mah_g=round(float(preset.specific_capacity_mah_g), 8),
                description=(preset.description or "").strip() or None,
                is_default=is_default,
            )
        )
    _set_setting(
        db,
        MATERIAL_PRESETS_KEY,
        json.dumps([preset.model_dump() for preset in normalized]),
    )
    db.commit()
    return ActiveMaterialPresetSettings(presets=normalized)


@router.get("/settings/plot-style-presets", response_model=PlotStylePresetSettings)
def get_plot_style_presets(db: Session = Depends(get_db)):
    return _plot_style_presets(db)


@router.put("/settings/plot-style-presets", response_model=PlotStylePresetSettings)
def update_plot_style_presets(
    payload: PlotStylePresetSettings,
    db: Session = Depends(get_db),
):
    names: set[str] = set()
    normalized: list[PlotStylePreset] = []
    defaults: set[str] = set()
    for preset in payload.presets:
        name = preset.name.strip()
        if not name:
            raise HTTPException(422, "Every plot-style preset needs a name.")
        key = f"{preset.plot_family}:{name.casefold()}"
        if key in names:
            raise HTTPException(409, f"Duplicate plot-style preset name: {name}")
        names.add(key)
        is_default = bool(preset.is_default and preset.plot_family not in defaults)
        if is_default:
            defaults.add(preset.plot_family)
        normalized.append(
            PlotStylePreset(
                id=preset.id.strip() or uuid.uuid4().hex,
                name=name,
                plot_family=preset.plot_family,
                style=preset.style,
                is_default=is_default,
            )
        )
    _set_setting(
        db,
        PLOT_STYLE_PRESETS_KEY,
        json.dumps([preset.model_dump() for preset in normalized]),
    )
    db.commit()
    return PlotStylePresetSettings(presets=normalized)


@router.get("/settings/color-palettes", response_model=ColorPaletteSettings)
def get_color_palettes(db: Session = Depends(get_db)):
    return _color_palettes(db)


@router.put("/settings/color-palettes", response_model=ColorPaletteSettings)
def update_color_palettes(
    payload: ColorPaletteSettings,
    db: Session = Depends(get_db),
):
    names: set[str] = set()
    normalized: list[ColorPalette] = []
    for palette in payload.palettes:
        name = palette.name.strip()
        if not name:
            raise HTTPException(422, "Every color palette needs a name.")
        if name.casefold() in names:
            raise HTTPException(409, f"Duplicate color palette name: {name}")
        colors = [color.strip() for color in palette.colors if color.strip()]
        if not colors:
            raise HTTPException(422, f"{name} needs at least one color.")
        if any(
            len(color) != 7
            or not color.startswith("#")
            or any(char not in "0123456789abcdefABCDEF" for char in color[1:])
            for color in colors
        ):
            raise HTTPException(422, f"{name} contains an invalid hex color.")
        names.add(name.casefold())
        normalized.append(
            ColorPalette(
                id=palette.id.strip() or uuid.uuid4().hex,
                name=name,
                kind=palette.kind,
                colors=colors,
            )
        )
    _set_setting(
        db,
        COLOR_PALETTES_KEY,
        json.dumps([palette.model_dump() for palette in normalized]),
    )
    db.commit()
    return ColorPaletteSettings(palettes=normalized)


@router.get("/source-monitor/settings", response_model=SourceMonitoringSettings)
def get_source_monitor_settings(db: Session = Depends(get_db)):
    return source_monitor.monitoring_state(db)


@router.put("/source-monitor/settings", response_model=SourceMonitoringSettings)
def update_source_monitor_settings(
    payload: SourceMonitoringSettings,
    db: Session = Depends(get_db),
):
    if not 1 <= payload.interval_value <= 10_000:
        raise HTTPException(status_code=422, detail="Interval must be between 1 and 10,000.")
    if not 1 <= payload.daily_every_days <= 365:
        raise HTTPException(status_code=422, detail="Scheduled days must be between 1 and 365.")
    try:
        hour_text, minute_text = payload.daily_time.split(":", 1)
        hour, minute = int(hour_text), int(minute_text)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=422, detail="Scheduled time must use HH:MM.")
    if not 0 <= hour <= 23 or not 0 <= minute <= 59:
        raise HTTPException(status_code=422, detail="Scheduled time must use HH:MM.")
    if not 10 <= payload.scan_batch_size <= 5_000:
        raise HTTPException(status_code=422, detail="Scan batch size must be between 10 and 5,000.")
    stability_seconds = payload.stability_value * (
        60 if payload.stability_unit == "minutes" else 1
    )
    if payload.stability_value < 1 or stability_seconds > 3_600:
        raise HTTPException(
            status_code=422,
            detail="Stability window must be between 1 second and 60 minutes.",
        )
    if not 2 <= payload.retry_count <= 10:
        raise HTTPException(status_code=422, detail="Retry attempts must be between 2 and 10.")
    if not 1 <= payload.retry_delay_minutes <= 1_440:
        raise HTTPException(status_code=422, detail="Retry delay must be between 1 and 1,440 minutes.")
    config = payload.model_dump(
        exclude={"next_run_at", "last_started_at", "last_finished_at", "last_status"}
    )
    config["daily_time"] = f"{hour:02d}:{minute:02d}"
    return source_monitor.save_config(db, config)


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
    entry = download_registry.record(
        filename=destination.name,
        path=str(destination),
        bytes_=destination.stat().st_size if destination.is_file() else None,
    )
    return {
        "saved": True,
        "filename": destination.name,
        "path": str(destination),
        "entry": entry,
    }


class DownloadRegistration(BaseModel):
    filename: str
    path: str
    bytes: int | None = None


@router.post("/downloads/history")
def register_download(payload: DownloadRegistration):
    """Record a download the client wrote itself (native save dialog)."""
    size = payload.bytes
    if size is None:
        try:
            candidate = Path(payload.path)
            size = candidate.stat().st_size if candidate.is_file() else None
        except OSError:
            size = None
    return download_registry.record(
        filename=_safe_filename(payload.filename),
        path=payload.path,
        bytes_=size,
    )


@router.get("/downloads/history")
def list_downloads():
    return download_registry.list_entries()


@router.delete("/downloads/history/{entry_id}")
def delete_download(entry_id: str, delete_file: bool = False):
    result = download_registry.delete_entry(entry_id, delete_file=delete_file)
    if not result["removed"]:
        raise HTTPException(status_code=404, detail="No such download entry")
    return result


@router.delete("/downloads/history")
def clear_downloads():
    download_registry.clear()
    return {"cleared": True}
