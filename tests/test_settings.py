import os
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path

from fastapi import HTTPException, UploadFile
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ["CELLXPLORER_DATA"] = str(ROOT / ".test-cellxplorer")
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.routers import settings


class SettingsTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_download_settings_default_to_ask_and_persist_folder(self):
        db = self.make_session()
        self.assertEqual(settings.get_settings(db=db).download_mode, "ask")

        with tempfile.TemporaryDirectory() as folder:
            saved = settings.update_settings(
                settings.DownloadSettings(download_mode="folder", download_folder=folder),
                db=db,
            )
            self.assertEqual(saved.download_mode, "folder")
            self.assertEqual(saved.download_folder, str(Path(folder).resolve()))

    def test_missing_default_folder_is_rejected(self):
        db = self.make_session()
        with self.assertRaises(HTTPException) as raised:
            settings.update_settings(
                settings.DownloadSettings(
                    download_mode="folder",
                    download_folder=str(ROOT / "folder-that-does-not-exist"),
                ),
                db=db,
            )
        self.assertEqual(raised.exception.status_code, 422)

    def test_download_uses_safe_unique_filename(self):
        db = self.make_session()
        with tempfile.TemporaryDirectory() as folder:
            settings.update_settings(
                settings.DownloadSettings(download_mode="folder", download_folder=folder),
                db=db,
            )
            first = settings.save_download(
                UploadFile(filename="../plot.csv", file=BytesIO(b"a,b\n1,2\n")),
                db=db,
            )
            second = settings.save_download(
                UploadFile(filename="plot.csv", file=BytesIO(b"new")),
                db=db,
            )

            self.assertEqual(first["filename"], "plot.csv")
            self.assertEqual(second["filename"], "plot (2).csv")
            self.assertEqual(Path(first["path"]).read_bytes(), b"a,b\n1,2\n")
            self.assertEqual(Path(second["path"]).read_bytes(), b"new")


if __name__ == "__main__":
    unittest.main()
