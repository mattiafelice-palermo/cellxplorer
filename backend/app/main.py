from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import CALC_VERSION, FRONTEND_DIST
from .db import Base, engine, ensure_runtime_schema
from . import models  # noqa: F401 — register tables
from .routers import analyses, files, library, replicates, tree
from .services import calc, parsing

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Cellxplorer", version="1.0.0")

Base.metadata.create_all(engine)
ensure_runtime_schema()

app.include_router(files.router)
app.include_router(library.router)
app.include_router(tree.router)
app.include_router(analyses.router)
app.include_router(replicates.router)


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

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        target = FRONTEND_DIST / full_path
        if full_path and target.is_file():
            return FileResponse(target)
        return FileResponse(FRONTEND_DIST / "index.html")
