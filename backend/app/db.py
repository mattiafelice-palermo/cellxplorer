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
        if source_columns and "total_charge_capacity_mah" not in source_columns:
            conn.exec_driver_sql(
                "ALTER TABLE source_files "
                "ADD COLUMN total_charge_capacity_mah FLOAT"
            )
        if source_columns and "total_discharge_capacity_mah" not in source_columns:
            conn.exec_driver_sql(
                "ALTER TABLE source_files "
                "ADD COLUMN total_discharge_capacity_mah FLOAT"
            )
        if source_columns and "capacity_summary_status" not in source_columns:
            conn.exec_driver_sql(
                "ALTER TABLE source_files "
                "ADD COLUMN capacity_summary_status VARCHAR(20) "
                "NOT NULL DEFAULT 'pending'"
            )
        if source_columns and "observed_size" not in source_columns:
            conn.exec_driver_sql(
                "ALTER TABLE source_files ADD COLUMN observed_size INTEGER"
            )
        if source_columns and "observed_mtime_ns" not in source_columns:
            conn.exec_driver_sql(
                "ALTER TABLE source_files ADD COLUMN observed_mtime_ns INTEGER"
            )
        if source_columns and "last_source_check_at" not in source_columns:
            conn.exec_driver_sql(
                "ALTER TABLE source_files ADD COLUMN last_source_check_at DATETIME"
            )
        activity_columns = {
            row[1]
            for row in conn.exec_driver_sql("PRAGMA table_info(activity_events)").fetchall()
        }
        if activity_columns and "started_at" not in activity_columns:
            conn.exec_driver_sql("ALTER TABLE activity_events ADD COLUMN started_at DATETIME")
            conn.exec_driver_sql(
                "UPDATE activity_events SET started_at = created_at WHERE started_at IS NULL"
            )
        if activity_columns and "finished_at" not in activity_columns:
            conn.exec_driver_sql("ALTER TABLE activity_events ADD COLUMN finished_at DATETIME")
            conn.exec_driver_sql(
                "UPDATE activity_events SET finished_at = created_at WHERE finished_at IS NULL"
            )


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
