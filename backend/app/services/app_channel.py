"""Packaged application channel resolution for backend-generated links."""

from __future__ import annotations

import os
from typing import Literal

AppChannel = Literal["stable", "beta"]

DEEP_LINK_IMPORT_BASE = {
    "stable": "cellxplorer://import-analysis",
    "beta": "cellxplorer-beta://import-analysis",
}


def is_packaged_application() -> bool:
    return os.environ.get("CELLXPLORER_STARTUP_MODE") in {"manual", "startup"}


def resolve_app_channel() -> AppChannel:
    raw = os.environ.get("CELLXPLORER_CHANNEL", "").strip().lower()
    if not raw:
        if is_packaged_application():
            raise RuntimeError("CELLXPLORER_CHANNEL is required in packaged mode.")
        return "stable"
    if raw not in DEEP_LINK_IMPORT_BASE:
        raise RuntimeError(f"Unsupported CELLXPLORER_CHANNEL: {raw}")
    return raw  # type: ignore[return-value]


def deep_link_import_base() -> str:
    return DEEP_LINK_IMPORT_BASE[resolve_app_channel()]


def validate_packaged_channel_at_startup() -> None:
    """Fail fast when a packaged sidecar is misconfigured."""
    if is_packaged_application():
        resolve_app_channel()
