from __future__ import annotations

import logging

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import DB_PATH, DB_URL


class Base(DeclarativeBase):
    pass


logger = logging.getLogger(__name__)

engine = create_engine(
    DB_URL,
    connect_args={"check_same_thread": False, "timeout": 5.0},
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


def _enable_write_ahead_logging(target_engine: Engine) -> None:
    """Set the persistent journal mode once before concurrent requests begin."""
    with target_engine.connect() as connection:
        mode = connection.exec_driver_sql("PRAGMA journal_mode=WAL").scalar_one()
    if str(mode).lower() != "wal":
        logger.warning("SQLite did not enable WAL mode; current mode is %s", mode)


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

_database_status = None


def initialize_database():
    """Inspect, back up, migrate, and validate the production database."""
    global _database_status
    from .services.database_migrations import migrate_database

    _database_status = migrate_database(engine, DB_PATH)
    if _database_status.compatible:
        _enable_write_ahead_logging(engine)
    return _database_status


def get_database_status():
    return _database_status


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
