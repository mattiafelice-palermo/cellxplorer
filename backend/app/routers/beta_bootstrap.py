from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import beta_bootstrap
from ..services import scientific_preparation
from ..services.app_channel import resolve_app_channel
from ..services.lazy_module import LazyModule

router = APIRouter(prefix="/api/beta-bootstrap", tags=["beta-bootstrap"])


def _load_scanner():
    # Lazy so importing this router does not pull parsing -> pandas/NewareNDA
    # before uvicorn can bind (spec 031).
    from ..services import scanner

    return scanner


scanner = LazyModule(_load_scanner)


class DiscardStageRequest(BaseModel):
    token: str


class StageCopyRequest(BaseModel):
    confirm_replace_existing_beta: bool = Field(
        default=False,
        alias="confirmReplaceExistingBeta",
    )


def _require_beta_channel() -> None:
    if resolve_app_channel() != "beta":
        raise HTTPException(status_code=404)


@router.get("/status")
def beta_bootstrap_status(db: Session = Depends(get_db)):
    _require_beta_channel()
    try:
        return beta_bootstrap.build_status(db)
    except beta_bootstrap.BetaBootstrapValidation as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@router.get("/preparation-status")
def beta_bootstrap_preparation_status(db: Session = Depends(get_db)):
    _require_beta_channel()
    state = scientific_preparation.get_state(db)
    return {
        "pending": scientific_preparation.is_pending(state),
        "state": state,
    }


@router.post("/preparation-background")
def beta_bootstrap_preparation_background():
    _require_beta_channel()
    result = scanner.request_capacity_backfill_background()
    if result is None:
        raise HTTPException(
            status_code=409,
            detail="No copied-library scientific preparation is active.",
        )
    return result


@router.post("/stage-copy")
def beta_bootstrap_stage_copy(
    payload: StageCopyRequest,
    db: Session = Depends(get_db),
):
    _require_beta_channel()
    try:
        return beta_bootstrap.stage_stable_copy(
            db,
            confirm_replace_existing_beta=payload.confirm_replace_existing_beta,
        )
    except beta_bootstrap.BetaBootstrapConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except beta_bootstrap.BetaBootstrapValidation as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except beta_bootstrap.BetaBootstrapError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@router.post("/discard-stage")
def beta_bootstrap_discard_stage(payload: DiscardStageRequest):
    _require_beta_channel()
    try:
        return beta_bootstrap.discard_stage(payload.token)
    except beta_bootstrap.BetaBootstrapConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except beta_bootstrap.BetaBootstrapValidation as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except beta_bootstrap.BetaBootstrapError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@router.post("/start-empty")
def beta_bootstrap_start_empty(db: Session = Depends(get_db)):
    _require_beta_channel()
    try:
        return beta_bootstrap.start_empty_library(db)
    except beta_bootstrap.BetaBootstrapConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except beta_bootstrap.BetaBootstrapValidation as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post("/use-current")
def beta_bootstrap_use_current(db: Session = Depends(get_db)):
    _require_beta_channel()
    try:
        return beta_bootstrap.use_current_library(db)
    except beta_bootstrap.BetaBootstrapValidation as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
