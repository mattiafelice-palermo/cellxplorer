import os
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
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
    def test_stale_settings_save_cannot_delete_inline_presets(self):
        for kind in ("area", "material"):
            db = self.make_session()
            if kind == "area":
                baseline = settings.get_electrode_area_presets(db=db)
                appended = settings.add_electrode_area_preset(settings.NewAreaPreset(name="New", area_cm2=2), db=db)
                update = settings.update_electrode_area_presets
                stale = settings.UpdateElectrodeAreaPresetSettings(presets=baseline.presets, expected_presets=baseline.presets)
            else:
                baseline = settings.get_active_material_presets(db=db)
                appended = settings.add_active_material_preset(settings.NewMaterialPreset(name="New", specific_capacity_mah_g=200), db=db)
                update = settings.update_active_material_presets
                stale = settings.UpdateActiveMaterialPresetSettings(presets=baseline.presets, expected_presets=baseline.presets)
            with self.assertRaises(HTTPException) as conflict:
                update(stale, db=db)
            self.assertEqual(conflict.exception.status_code, 409)
            db.rollback()
            current = settings.get_electrode_area_presets(db=db) if kind == "area" else settings.get_active_material_presets(db=db)
            self.assertEqual(current, appended)
            db.close()

    def test_electrode_display_labels_persist_and_validate(self):
        db = self.make_session()
        defaults = settings.get_electrode_display_labels(db=db)
        self.assertIn("Working electrode", defaults.working_potential)
        updated = defaults.model_copy(update={"working_potential": [" Cathode ", "Custom reference", "Cathode"]})
        saved = settings.update_electrode_display_labels(updated, db=db)
        self.assertEqual(saved.working_potential, ["Cathode", "Custom reference"])
        self.assertEqual(settings.get_electrode_display_labels(db=db), saved)
        for labels in ([], [" "], ["a" * 81], ["Label"] * 51):
            with self.assertRaises(HTTPException):
                settings.update_electrode_display_labels(saved.model_copy(update={"voltage": labels}), db=db)
        self.assertEqual(settings.get_electrode_display_labels(db=db), saved)
        db.close()

    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_inline_preset_addition_preserves_existing_values_and_validates(self):
        db = self.make_session()
        area = settings.add_electrode_area_preset(
            settings.NewAreaPreset(name=" Custom area ", area_cm2=2.5), db=db,
        )
        self.assertEqual([p.name for p in area.presets], ["14 mm circular electrode", "15 mm circular electrode", "Custom area"])
        self.assertTrue(area.presets[0].is_default)
        material = settings.add_active_material_preset(
            settings.NewMaterialPreset(name=" Zinc ", specific_capacity_mah_g=820), db=db,
        )
        self.assertEqual(material.presets[-1].name, "Zinc")
        self.assertEqual(material.presets[-1].specific_capacity_mah_g, 820)
        with self.assertRaises(HTTPException) as duplicate:
            settings.add_active_material_preset(
                settings.NewMaterialPreset(name="zinc", specific_capacity_mah_g=800), db=db,
            )
        self.assertEqual(duplicate.exception.status_code, 409)
        db.rollback()
        with self.assertRaises(HTTPException):
            settings.add_electrode_area_preset(settings.NewAreaPreset(name="bad", area_cm2=float("nan")), db=db)
        db.close()

    def test_concurrent_inline_additions_do_not_replace_each_other(self):
        with tempfile.TemporaryDirectory() as folder:
            engine = create_engine(f"sqlite:///{Path(folder) / 'settings.db'}", connect_args={"timeout": 10})
            Base.metadata.create_all(engine)
            make_session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

            def add(name):
                with make_session() as db:
                    settings.add_electrode_area_preset(settings.NewAreaPreset(name=name, area_cm2=2.0), db=db)

            with ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(add, ["Area A", "Area B"]))
            with make_session() as db:
                names = {preset.name for preset in settings.get_electrode_area_presets(db=db).presets}
            self.assertTrue({"Area A", "Area B", "14 mm circular electrode"} <= names)
            engine.dispose()

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

    def test_plot_style_presets_support_specialized_analysis_families(self):
        db = self.make_session()
        families = ["dcir", "crate", "chargeability", "steps"]
        saved = settings.update_plot_style_presets(
            settings.PlotStylePresetSettings(
                presets=[
                    settings.PlotStylePreset(
                        id=family,
                        name=f"{family} style",
                        plot_family=family,
                        style={"line_width": 3},
                        is_default=True,
                    )
                    for family in families
                ]
            ),
            db=db,
        )

        self.assertEqual([preset.plot_family for preset in saved.presets], families)
        self.assertTrue(all(preset.is_default for preset in saved.presets))
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
