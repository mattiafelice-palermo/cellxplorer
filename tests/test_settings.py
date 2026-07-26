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
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
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

    def test_export_filename_template_persists(self):
        db = self.make_session()
        saved = settings.update_settings(
            settings.DownloadSettings(
                download_mode="ask",
                export_filename_template="{analysis}_{quantity}_{date}",
            ),
            db=db,
        )
        self.assertEqual(
            saved.export_filename_template,
            "{analysis}_{quantity}_{date}",
        )
        self.assertEqual(settings.get_settings(db=db), saved)

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

    def test_area_presets_have_defaults_and_persist_user_values(self):
        db = self.make_session()
        defaults = settings.get_electrode_area_presets(db=db)
        self.assertEqual(defaults.presets[0].name, "14 mm circular electrode")
        self.assertAlmostEqual(defaults.presets[0].area_cm2, 1.539, places=6)

        saved = settings.update_electrode_area_presets(
            settings.ElectrodeAreaPresetSettings(
                presets=[
                    settings.ElectrodeAreaPreset(
                        id="custom",
                        name="Pouch coupon",
                        area_cm2=4.25,
                        description="Measured active overlap",
                        is_default=True,
                    )
                ]
            ),
            db=db,
        )

        self.assertEqual(saved.presets[0].name, "Pouch coupon")
        self.assertEqual(settings.get_electrode_area_presets(db=db), saved)

    def test_material_presets_have_defaults_and_persist_specific_capacity(self):
        db = self.make_session()
        defaults = settings.get_active_material_presets(db=db)
        self.assertEqual(defaults.presets[0].name, "LFP")
        self.assertEqual(defaults.presets[0].specific_capacity_mah_g, 170)

        saved = settings.update_active_material_presets(
            settings.ActiveMaterialPresetSettings(
                presets=[
                    settings.ActiveMaterialPreset(
                        id="lab-material",
                        name="Lab cathode",
                        specific_capacity_mah_g=182.5,
                        description="Validated reference",
                        is_default=True,
                    )
                ]
            ),
            db=db,
        )

        self.assertEqual(saved.presets[0].specific_capacity_mah_g, 182.5)
        self.assertEqual(settings.get_active_material_presets(db=db), saved)

    def test_plot_style_presets_persist_and_limit_defaults_per_family(self):
        db = self.make_session()
        saved = settings.update_plot_style_presets(
            settings.PlotStylePresetSettings(
                presets=[
                    settings.PlotStylePreset(
                        id="first",
                        name="Publication",
                        plot_family="cycles",
                        style={"line_width": 2.5},
                        is_default=True,
                    ),
                    settings.PlotStylePreset(
                        id="second",
                        name="Presentation",
                        plot_family="cycles",
                        style={"line_width": 4},
                        is_default=True,
                    ),
                ]
            ),
            db=db,
        )
        self.assertTrue(saved.presets[0].is_default)
        self.assertFalse(saved.presets[1].is_default)
        self.assertEqual(settings.get_plot_style_presets(db=db), saved)

    def test_color_palettes_persist_and_validate_hex_values(self):
        db = self.make_session()
        saved = settings.update_color_palettes(
            settings.ColorPaletteSettings(
                palettes=[
                    settings.ColorPalette(
                        id="lab",
                        name="Lab palette",
                        kind="categorical",
                        colors=["#12b886", "#2563eb"],
                    )
                ]
            ),
            db=db,
        )
        self.assertEqual(settings.get_color_palettes(db=db), saved)

        with self.assertRaises(HTTPException) as raised:
            settings.update_color_palettes(
                settings.ColorPaletteSettings(
                    palettes=[
                        settings.ColorPalette(
                            id="bad",
                            name="Bad palette",
                            colors=["teal"],
                        )
                    ]
                ),
                db=db,
            )
        self.assertEqual(raised.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
