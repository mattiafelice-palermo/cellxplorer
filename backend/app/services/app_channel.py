"""Packaged application channel and data-root resolution."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal, Mapping

AppChannel = Literal["stable", "beta", "alpha"]

DEEP_LINK_IMPORT_BASE = {
    "stable": "cellxplorer://import-analysis",
    "beta": "cellxplorer-beta://import-analysis",
    "alpha": "cellxplorer-alpha://import-analysis",
}

STABLE_DATA_DIR_NAME = ".cellxplorer"
BETA_DATA_DIR_NAME = ".cellxplorer-beta"
ALPHA_DATA_DIR_NAME = ".cellxplorer-alpha"

DATA_DIR_NAMES: Mapping[AppChannel, str] = {
    "stable": STABLE_DATA_DIR_NAME,
    "beta": BETA_DATA_DIR_NAME,
    "alpha": ALPHA_DATA_DIR_NAME,
}


def is_packaged_application() -> bool:
    return os.environ.get("CELLXPLORER_STARTUP_MODE") in {"manual", "startup"}


def resolve_app_channel(env: Mapping[str, str] | None = None) -> AppChannel:
    source = os.environ if env is None else env
    raw = source.get("CELLXPLORER_CHANNEL", "").strip().lower()
    if not raw:
        if source.get("CELLXPLORER_STARTUP_MODE") in {"manual", "startup"}:
            raise RuntimeError("CELLXPLORER_CHANNEL is required in packaged mode.")
        return "stable"
    if raw not in DEEP_LINK_IMPORT_BASE:
        raise RuntimeError(f"Unsupported CELLXPLORER_CHANNEL: {raw}")
    return raw  # type: ignore[return-value]


def app_channel() -> AppChannel:
    return resolve_app_channel()


def default_data_root(channel: AppChannel, home: Path) -> Path:
    return home / DATA_DIR_NAMES[channel]


def stable_default_data_root(home: Path) -> Path:
    return default_data_root("stable", home)


def beta_default_data_root(home: Path) -> Path:
    return default_data_root("beta", home)


def alpha_default_data_root(home: Path) -> Path:
    return default_data_root("alpha", home)


def resolve_data_root(env: Mapping[str, str], home: Path) -> Path:
    override = env.get("CELLXPLORER_DATA", "").strip()
    if override:
        return Path(override)
    return default_data_root(resolve_app_channel(env), home)


def deep_link_import_base() -> str:
    return DEEP_LINK_IMPORT_BASE[resolve_app_channel()]


def validate_packaged_channel_at_startup() -> None:
    """Fail fast when a packaged sidecar is misconfigured."""
    if is_packaged_application():
        resolve_app_channel()
