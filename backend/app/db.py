from __future__ import annotations

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import DB_PATH, DB_URL


class Base(DeclarativeBase):
    pass


engine = create_engine(DB_URL, connect_args={"check_same_thread": False})


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

_database_status = None


def initialize_database():
    """Inspect, back up, migrate, and validate the production database."""
    global _database_status
    from .services.database_migrations import migrate_database

    _database_status = migrate_database(engine, DB_PATH)
    return _database_status


def get_database_status():
    return _database_status


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
