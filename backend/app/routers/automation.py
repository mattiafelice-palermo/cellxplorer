from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import automation

router = APIRouter(prefix="/api/automation", tags=["automation"])


class PauseRequest(BaseModel):
    minutes: int | None = Field(
        default=None,
        description="Pause duration in minutes; null or 0 resumes immediately.",
    )


@router.get("/pause")
def get_automation_pause(db: Session = Depends(get_db)):
    return automation.pause_state(db)


@router.post("/pause")
def set_automation_pause(req: PauseRequest, db: Session = Depends(get_db)):
    if req.minutes is not None and req.minutes != 0:
        if req.minutes < 1 or req.minutes > automation.MAX_PAUSE_MINUTES:
            raise HTTPException(
                422,
                f"minutes must be between 1 and {automation.MAX_PAUSE_MINUTES}, or null/0 to resume",
            )
    return automation.set_pause(db, req.minutes)
