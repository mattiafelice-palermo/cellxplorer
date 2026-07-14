from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import CALC_VERSION, FRONTEND_DIST
from .db import Base, engine, ensure_runtime_schema
from . import models  # noqa: F401 — register tables
from .routers import activity, analyses, files, library, replicates, settings, tree
from .services import calc, parsing, scanner

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="CellXplorer", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

Base.metadata.create_all(engine)
ensure_runtime_schema()
app.add_event_handler("startup", scanner.start_capacity_summary_backfill)

app.include_router(files.router)
app.include_router(library.router)
app.include_router(tree.router)
app.include_router(analyses.router)
app.include_router(replicates.router)
app.include_router(activity.router)
app.include_router(settings.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/meta")
def meta():
    return {
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
