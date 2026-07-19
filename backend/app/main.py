from __future__ import annotations

import logging
import threading

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import APP_VERSION, CALC_VERSION, FRONTEND_DIST
from .db import SessionLocal, initialize_database
from . import models  # noqa: F401 — register tables
from .routers import activity, analyses, cache_management, diagnostics, files, library, replicates, settings, tree
from .services.activity_log import record_activity
from .services import cache_maintenance, database_identity, sessions, source_monitor

logging.basicConfig(level=logging.INFO)

DATABASE_STATUS = initialize_database()


def _load_database_instance_id() -> str | None:
    if not DATABASE_STATUS.compatible:
        return None
    db = SessionLocal()
    try:
        return database_identity.ensure_database_instance_id(db)
    except Exception:
        db.rollback()
        logging.getLogger(__name__).exception("Could not load database instance identity")
        return None
    finally:
        db.close()


DATABASE_INSTANCE_ID = _load_database_instance_id()

app = FastAPI(title="CellXplorer", version=APP_VERSION)
app.add_middleware(GZipMiddleware, minimum_size=4096, compresslevel=5)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_COMPATIBILITY_API_PATHS = {
    "/api/health",
    "/api/meta",
    "/api/database/status",
    "/api/diagnostics/health",
    "/api/diagnostics/resources",
    "/api/diagnostics/logs",
}


@app.middleware("http")
async def database_compatibility_guard(request: Request, call_next):
    if (
        not DATABASE_STATUS.compatible
        and request.url.path.startswith("/api/")
        and request.url.path not in _COMPATIBILITY_API_PATHS
    ):
        return JSONResponse(
            status_code=503,
            content={
                "detail": DATABASE_STATUS.message,
                "database": DATABASE_STATUS.as_dict(),
            },
        )
    return await call_next(request)


def _record_migration_activity() -> None:
    if not DATABASE_STATUS.migration_performed:
        return
    db = SessionLocal()
    try:
        action = (
            "database_initialized"
            if DATABASE_STATUS.backup_path is None
            else "database_migrated"
        )
        record_activity(
            db,
            category="system",
            action=action,
            message=DATABASE_STATUS.message,
            details={
                "from_revision": DATABASE_STATUS.previous_revision,
                "to_revision": DATABASE_STATUS.schema_revision,
                "legacy_database": DATABASE_STATUS.legacy_database,
                "backup_created": DATABASE_STATUS.backup_path is not None,
            },
        )
        db.commit()
    except Exception:
        db.rollback()
        logging.getLogger(__name__).exception(
            "Could not record database migration activity"
        )
    finally:
        db.close()


def _warm_scientific_services() -> None:
    """Warm the data stack after the API is listening, then start backfills."""
    try:
        import pandas  # noqa: F401
        import NewareNDA  # noqa: F401
        import pyarrow  # noqa: F401

        from .services import scanner

        scanner.start_capacity_summary_backfill()
    except Exception:
        # The real import site will still surface a failure with full context.
        logging.getLogger(__name__).exception("Scientific service warm-up failed")


def _start_scientific_service_warmup() -> None:
    threading.Thread(
        target=_warm_scientific_services,
        name="scientific-service-warmup",
        daemon=True,
    ).start()


if DATABASE_STATUS.compatible:
    _record_migration_activity()
    app.add_event_handler("startup", sessions.start_runtime_session)
    app.add_event_handler("startup", _start_scientific_service_warmup)
    app.add_event_handler("startup", source_monitor.start_source_monitor)
    app.add_event_handler("startup", cache_maintenance.start_cache_maintenance)
    app.add_event_handler("shutdown", source_monitor.stop_source_monitor)
    app.add_event_handler("shutdown", cache_maintenance.stop_cache_maintenance)
    app.add_event_handler(
        "shutdown",
        lambda: sessions.finish_runtime_session("backend_shutdown"),
    )

app.include_router(files.router)
app.include_router(library.router)
app.include_router(tree.router)
app.include_router(analyses.router)
app.include_router(replicates.router)
app.include_router(activity.router)
app.include_router(settings.router)
app.include_router(cache_management.router)
app.include_router(diagnostics.router)


@app.get("/api/health")
def health():
    return {
        "status": "ok" if DATABASE_STATUS.compatible else "degraded",
        "database": DATABASE_STATUS.as_dict(),
    }


@app.get("/api/database/status")
def database_status():
    return {
        **DATABASE_STATUS.as_dict(),
        "database_instance_id": DATABASE_INSTANCE_ID,
    }


@app.get("/api/meta")
def meta():
    from .services import calc, parsing

    return {
        "app_version": APP_VERSION,
        "database_schema_revision": DATABASE_STATUS.schema_revision,
        "supported_database_schema_revision": DATABASE_STATUS.supported_revision,
        "parser_version": parsing.PARSER_VERSION,
        "calc_version": CALC_VERSION,
        "quantities": [
            {"value": key, "label": label} for key, (_, label) in calc.QUANTITIES.items()
        ],
    }


# serve the built frontend (clean seam for a Tauri wrapper later)
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    # index.html must never be cached: it references content-hashed bundles
    # that stop existing after a rebuild, and a cached shell then 404s on
    # its own script (blank page until a hard reload). Hashed assets under
    # /assets are immutable and safe to cache.
    _NO_CACHE = {"Cache-Control": "no-cache, must-revalidate"}

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        target = FRONTEND_DIST / full_path
        if full_path and target.is_file():
            if target.suffix in (".html", ""):
                return FileResponse(target, headers=_NO_CACHE)
            return FileResponse(target)
        return FileResponse(FRONTEND_DIST / "index.html", headers=_NO_CACHE)
