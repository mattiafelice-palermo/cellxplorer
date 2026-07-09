from __future__ import annotations

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import DB_URL


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


def ensure_runtime_schema() -> None:
    """Apply tiny SQLite migrations for the local desktop database."""
    with engine.begin() as conn:
        if engine.dialect.name != "sqlite":
            return
        columns = {
            row[1]
            for row in conn.exec_driver_sql("PRAGMA table_info(cells)").fetchall()
        }
        if columns and "cycling_status" not in columns:
            conn.exec_driver_sql(
                "ALTER TABLE cells "
                "ADD COLUMN cycling_status VARCHAR(20) NOT NULL DEFAULT 'active'"
            )
        source_columns = {
            row[1]
            for row in conn.exec_driver_sql("PRAGMA table_info(source_files)").fetchall()
        }
        if source_columns and "nominal_capacity_mah" not in source_columns:
            conn.exec_driver_sql(
                "ALTER TABLE source_files "
                "ADD COLUMN nominal_capacity_mah FLOAT"
            )


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
