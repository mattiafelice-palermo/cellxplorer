import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from uuid import UUID

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.routers import files
from app.services import windows_known_folders as known_folders


class WindowsKnownFolderServiceTests(unittest.TestCase):
    def make_resolver(self, paths: list[str | None], failures: set[int] | None = None):
        shell32 = MagicMock()
        ole32 = MagicMock()
        calls: list[int] = []
        failures = failures or set()

        def get_known_folder_path(_guid, _flags, _token, output):
            index = len(calls)
            calls.append(index)
            if index in failures:
                return 1
            output._obj.value = paths[index]
            return 0

        shell32.SHGetKnownFolderPath.side_effect = get_known_folder_path

        def load_library(name: str, **_kwargs):
            return shell32 if name == "shell32" else ole32

        return shell32, ole32, calls, load_library

    def test_guid_is_encoded_in_windows_little_endian_layout(self):
        value = "B4BFCC3A-DB2C-424C-B029-7FE99A87C641"
        self.assertEqual(bytes(known_folders._guid_from_text(value)), UUID(value).bytes_le)

    def test_all_known_folder_lookups_succeed_and_release_allocations(self):
        home = Path("C:/Users/Test")
        shell32, ole32, calls, load_library = self.make_resolver(
            [
                "C:/Users/Test/OneDrive/Desktop",
                "C:/Users/Test/OneDrive/Documents",
                "C:/Users/Test/Downloads",
            ]
        )
        with patch.object(known_folders.sys, "platform", "win32"), patch.object(
            known_folders.ctypes, "WinDLL", side_effect=load_library
        ):
            result = known_folders.known_user_folders(home)

        self.assertEqual(result["home"], home)
        self.assertEqual(result["desktop"], Path("C:/Users/Test/OneDrive/Desktop"))
        self.assertEqual(result["documents"], Path("C:/Users/Test/OneDrive/Documents"))
        self.assertEqual(result["downloads"], Path("C:/Users/Test/Downloads"))
        self.assertEqual(calls, [0, 1, 2])
        self.assertEqual(ole32.CoTaskMemFree.call_count, 3)
        self.assertEqual(shell32.SHGetKnownFolderPath.call_count, 3)

    def test_one_failed_lookup_keeps_other_redirected_folders(self):
        home = Path("C:/Users/Test")
        _shell32, _ole32, _calls, load_library = self.make_resolver(
            [
                None,
                "C:/Corp/Documents",
                "C:/Corp/Downloads",
            ],
            failures={0},
        )
        with patch.object(known_folders.sys, "platform", "win32"), patch.object(
            known_folders.ctypes, "WinDLL", side_effect=load_library
        ):
            result = known_folders.known_user_folders(home)

        self.assertEqual(result["desktop"], home / "Desktop")
        self.assertEqual(result["documents"], Path("C:/Corp/Documents"))
        self.assertEqual(result["downloads"], Path("C:/Corp/Downloads"))

    def test_non_windows_uses_fallbacks_without_loading_ctypes(self):
        home = Path("/tmp/test-home")
        with patch.object(known_folders.sys, "platform", "linux"), patch.object(
            known_folders, "_resolve_known_folder"
        ) as resolve:
            result = known_folders.known_user_folders(home)

        self.assertEqual(result, {
            "home": home,
            "desktop": home / "Desktop",
            "documents": home / "Documents",
            "downloads": home / "Downloads",
        })
        resolve.assert_not_called()

    def test_api_unavailability_falls_back_per_folder(self):
        home = Path("C:/Users/Test")
        with patch.object(known_folders.sys, "platform", "win32"), patch.object(
            known_folders.ctypes, "WinDLL", side_effect=OSError("not available")
        ):
            result = known_folders.known_user_folders(home)

        self.assertEqual(result["desktop"], home / "Desktop")
        self.assertEqual(result["documents"], home / "Documents")
        self.assertEqual(result["downloads"], home / "Downloads")

    def test_allocated_path_is_released_when_resolver_succeeds(self):
        shell32 = MagicMock()
        free = MagicMock()

        def get_known_folder_path(_guid, _flags, _token, output):
            output._obj.value = "C:/Users/Test/Desktop"
            return 0

        shell32.SHGetKnownFolderPath.side_effect = get_known_folder_path
        with patch.object(known_folders, "_windows_api", return_value=(shell32.SHGetKnownFolderPath, free)):
            result = known_folders._resolve_known_folder(known_folders.KNOWN_FOLDER_IDS["desktop"])

        self.assertEqual(result, Path("C:/Users/Test/Desktop"))
        free.assert_called_once()


class QuickAccessKnownFolderTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_standard_duplicate_paths_are_not_repeated_and_pins_are_preserved(self):
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "Home"
            documents = home / "Documents"
            home.mkdir()
            documents.mkdir()
            files._set_path_setting(db, files.IMPORT_PINNED_FOLDERS_KEY, [str(home).upper()])
            files._set_path_setting(db, files.IMPORT_RECENT_FOLDERS_KEY, [str(home).upper()])
            db.commit()
            standard = {
                "home": home,
                "desktop": home,
                "documents": documents,
                "downloads": home / "Downloads",
            }
            with patch.object(files, "known_user_folders", return_value=standard):
                items = files.import_quick_access(db)

        self.assertEqual([item["label"] for item in items[:3]], ["Home", "Documents", "Downloads"])
        self.assertEqual(sum(item["path"].casefold() == str(home).casefold() for item in items), 1)
        self.assertTrue(items[0]["pinned"])

    def test_redirected_and_unavailable_standard_entries_keep_shape(self):
        db = self.make_session()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "Home"
            redirected = Path(tmp) / "OneDrive" / "Documents"
            home.mkdir()
            standard = {
                "home": home,
                "desktop": home / "Desktop",
                "documents": redirected,
                "downloads": home / "Downloads",
            }
            with patch.object(files, "known_user_folders", return_value=standard):
                items = files.import_quick_access(db)

        self.assertEqual([item["label"] for item in items], ["Home", "Desktop", "Documents", "Downloads"])
        self.assertTrue(items[0]["available"])
        self.assertFalse(items[1]["available"])
        self.assertFalse(items[2]["available"])
        self.assertFalse(items[3]["available"])
        self.assertEqual(items[2]["path"], str(redirected))


if __name__ == "__main__":
    unittest.main()
