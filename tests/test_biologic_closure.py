"""Spec 041.6 synthetic BioLogic closure and format-neutral regressions.

This suite deliberately creates MPR bytes through the project-owned fixture,
then exercises the normal reader, scanner/cache, stitching and analysis
services.  It does not use an external parser or a private source file.
"""

from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

import numpy as np
import pandas as pd
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base  # noqa: E402
from app.models import Cell, Test, TestFile  # noqa: E402
from app.services import (  # noqa: E402
    analysis_engine,
    cache,
    chargeability,
    dcir,
    import_inspection,
    parsing,
    protocol,
    rate_capability,
    scanner,
)
from app.services.biologic_gcpl import (  # noqa: E402
    UnsupportedBiologicGcplError,
    read_gcpl_header_metadata,
)
from tests.biologic_mpr_fixture import (  # noqa: E402
    encode_gcpl_log,
    encode_gcpl_settings,
    write_gcpl_mpr,
)


def _cycling_rows() -> list[dict[str, object]]:
    """Two physically coherent 1 mAh charge/rest/discharge cycles.

    The current is 10 mA and each active phase lasts 360 seconds, so the
    independently expected transfer is 10 * 360 / 3600 = 1 mAh.  Rest rows
    are deliberately kept separate from the active phases to exercise the
    canonical step and cycle boundaries.
    """

    rows: list[dict[str, object]] = []

    def add(
        total_time_s: float,
        *,
        ns: int,
        half_cycle: int,
        mode: int,
        control: float,
        q_mAh: float,
        dq_mAh: float = 0.0,
        ewe_v: float,
        ece_v: float,
        ns_changed: bool = False,
    ) -> None:
        rows.append(
            {
                "total_time_s": total_time_s,
                "ns": ns,
                "half_cycle": half_cycle,
                "mode": mode,
                "control": control,
                "q_mAh": q_mAh,
                "raw_dq_mAh": dq_mAh,
                "ewe_v": ewe_v,
                "ece_v": ece_v,
                "ns_changed": ns_changed,
            }
        )

    for half_cycle, offset in ((0, 0.0), (1, 780.0)):
        add(offset + 0.0, ns=0, half_cycle=half_cycle, mode=1, control=10.0, q_mAh=0.0, ewe_v=3.6, ece_v=0.1, ns_changed=True)
        add(offset + 360.0, ns=0, half_cycle=half_cycle, mode=1, control=10.0, q_mAh=1.0, dq_mAh=1.0, ewe_v=3.8, ece_v=0.1)
        add(offset + 360.0, ns=1, half_cycle=half_cycle, mode=3, control=0.0, q_mAh=1.0, ewe_v=3.8, ece_v=0.1, ns_changed=True)
        add(offset + 420.0, ns=1, half_cycle=half_cycle, mode=3, control=0.0, q_mAh=1.0, ewe_v=3.7, ece_v=0.1)
        add(offset + 420.0, ns=2, half_cycle=half_cycle, mode=1, control=-10.0, q_mAh=1.0, ewe_v=3.7, ece_v=0.1, ns_changed=True)
        add(offset + 780.0, ns=2, half_cycle=half_cycle, mode=1, control=-10.0, q_mAh=0.0, dq_mAh=-1.0, ewe_v=3.2, ece_v=0.1)
    return rows


def _settings() -> bytes:
    return encode_gcpl_settings(
        [
            {"set_i_c": 0, "current": 10.0, "t1_s": 360.0, "voltage_limit_v": 4.2},
            {
                "set_i_c": 0,
                "current": 0.0,
                "t1_s": 60.0,
                "rest_duration_s": 60.0,
            },
            {"set_i_c": 0, "current": -10.0, "t1_s": 360.0, "voltage_limit_v": 2.8},
        ],
        active_mass_g=0.001,
        reference_electrode="Ag/AgCl",
        battery_capacity=1.0,
        battery_capacity_unit=1,
    )


def _dcir_rows() -> list[dict[str, object]]:
    """One 30 s, 1 mA discharge pulse after a 30 min rest."""

    return [
        {"total_time_s": 0.0, "ns": 0, "mode": 3, "control": 0.0, "q_mAh": 0.0, "ewe_v": 3.7, "ece_v": 0.1, "ns_changed": True},
        {"total_time_s": 1800.0, "ns": 0, "mode": 3, "control": 0.0, "q_mAh": 0.0, "ewe_v": 3.7, "ece_v": 0.1},
        {"total_time_s": 1800.0, "ns": 1, "mode": 1, "control": -1.0, "q_mAh": 0.0, "ewe_v": 3.7, "ece_v": 0.1, "ns_changed": True},
        {"total_time_s": 1830.0, "ns": 1, "mode": 1, "control": -1.0, "q_mAh": -1.0 / 120.0, "dq_mAh": -1.0 / 120.0, "ewe_v": 3.3, "ece_v": 0.1},
    ]


def _dcir_settings() -> bytes:
    return encode_gcpl_settings(
        [
            {"set_i_c": 0, "current": 0.0, "t1_s": 1800.0, "rest_duration_s": 1800.0},
            {"set_i_c": 0, "current": -1.0, "t1_s": 30.0, "voltage_limit_v": 2.8},
        ],
        active_mass_g=0.001,
        reference_electrode="Ag/AgCl",
        battery_capacity=1.0,
        battery_capacity_unit=1,
    )


def _rate_rows() -> list[dict[str, object]]:
    """Three charge-rate points with a fixed 0.5C discharge complement."""

    rows: list[dict[str, object]] = []
    elapsed = 0.0
    durations = ((0.5, 3600.0), (1.0, 1800.0), (2.0, 900.0))
    for pair_index, (charge_current, charge_duration) in enumerate(durations):
        charge_ns = pair_index * 2
        discharge_ns = charge_ns + 1
        half_cycle = pair_index * 2
        rows.extend(
            [
                {
                    "total_time_s": elapsed,
                    "ns": charge_ns,
                    "half_cycle": half_cycle,
                    "mode": 1,
                    "control": charge_current,
                    "q_mAh": 0.0,
                    "ewe_v": 3.3,
                    "ece_v": 0.1,
                    "ns_changed": True,
                },
                {
                    "total_time_s": elapsed + charge_duration,
                    "ns": charge_ns,
                    "half_cycle": half_cycle,
                    "mode": 1,
                    "control": charge_current,
                    "q_mAh": 0.5,
                    "dq_mAh": 0.5,
                    "ewe_v": 4.3,
                    "ece_v": 0.1,
                },
                {
                    "total_time_s": elapsed + charge_duration,
                    "ns": discharge_ns,
                    "half_cycle": half_cycle,
                    "mode": 1,
                    "control": -0.5,
                    "q_mAh": 0.5,
                    "ewe_v": 4.3,
                    "ece_v": 0.1,
                    "ns_changed": True,
                },
                {
                    "total_time_s": elapsed + charge_duration + 3600.0,
                    "ns": discharge_ns,
                    "half_cycle": half_cycle,
                    "mode": 1,
                    "control": -0.5,
                    "q_mAh": 0.0,
                    "dq_mAh": -0.5,
                    "ewe_v": 2.9,
                    "ece_v": 0.1,
                },
            ]
        )
        elapsed += charge_duration + 3600.0
    return rows


def _rate_settings() -> bytes:
    return encode_gcpl_settings(
        [
            {"set_i_c": 1, "current": 0.5, "c_rate": 0.5, "t1_s": 3600.0, "voltage_limit_v": 4.2},
            {"set_i_c": 1, "current": -0.5, "c_rate": 0.5, "t1_s": 3600.0, "voltage_limit_v": 2.8},
            {"set_i_c": 1, "current": 1.0, "c_rate": 1.0, "t1_s": 1800.0, "voltage_limit_v": 4.2},
            {"set_i_c": 1, "current": -0.5, "c_rate": 0.5, "t1_s": 3600.0, "voltage_limit_v": 2.8},
            {"set_i_c": 1, "current": 2.0, "c_rate": 2.0, "t1_s": 900.0, "voltage_limit_v": 4.2},
            {"set_i_c": 1, "current": -0.5, "c_rate": 0.5, "t1_s": 3600.0, "voltage_limit_v": 2.8},
        ],
        active_mass_g=0.001,
        reference_electrode="Ag/AgCl",
        battery_capacity=1.0,
        battery_capacity_unit=1,
    )


class BiologicClosureIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tempdir.name)
        cls.mpr_path = write_gcpl_mpr(
            cls.root / "synthetic-gcpl.mpr",
            _cycling_rows(),
            settings_payload=_settings(),
            log_payload=encode_gcpl_log(ole_timestamp=45000.0),
            include_log=True,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tempdir.cleanup()

    def setUp(self) -> None:
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
        self.cache_root = self.root / f"cache-{id(self)}"
        self.old_cache_dir = cache.CACHE_DIR
        cache.CACHE_DIR = self.cache_root
        self.source = scanner.ingest_path(self.db, self.mpr_path, parse_now=True)
        self.assertEqual(self.source.parse_status, "parsed", self.source.parse_error)
        self.assertEqual(self.source.row_count, 12)
        self.assertEqual(self.source.cycle_count, 2)
        self.assertEqual(self.source.parser_version, "bm:gcpl3:r1")

        self.cell = Cell(name="Synthetic BioLogic closure cell")
        self.db.add(self.cell)
        self.db.flush()
        test = Test(cell_id=self.cell.id, name="internal source chain")
        self.db.add(test)
        self.db.flush()
        self.db.add(TestFile(test_id=test.id, file_id=self.source.id, position=0))
        self.db.commit()

    def tearDown(self) -> None:
        cache.CACHE_DIR = self.old_cache_dir
        self.db.close()

    def _spec(self) -> dict:
        spec = analysis_engine.default_spec("Synthetic BioLogic closure")
        spec["selection"]["entries"] = [{"kind": "cell", "ref_id": self.cell.id}]
        return spec

    def _attach_source_cell(self, path: Path, name: str) -> tuple[object, Cell]:
        source = scanner.ingest_path(self.db, path, parse_now=True)
        self.assertEqual(source.parse_status, "parsed", source.parse_error)
        cell = Cell(name=name)
        self.db.add(cell)
        self.db.flush()
        test = Test(cell_id=cell.id, name="internal source chain")
        self.db.add(test)
        self.db.flush()
        self.db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        self.db.commit()
        return source, cell

    def test_normal_import_cache_cycles_and_time_capacity_preserve_roles(self) -> None:
        raw = cache.load_raw(self.source.hash, self.source.parser_version)
        cycles = cache.load_cycles(
            self.source.hash,
            self.source.parser_version,
            cache.CALC_VERSION,
        )
        self.assertIsNotNone(raw)
        self.assertIsNotNone(cycles)
        self.assertEqual(raw["cycle"].tolist(), [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2])
        self.assertEqual(cycles["cycle"].tolist(), [1, 2])
        np.testing.assert_allclose(cycles["charge_capacity_mah"], [1.0, 1.0])
        np.testing.assert_allclose(cycles["discharge_capacity_mah"], [1.0, 1.0])
        np.testing.assert_allclose(cycles["coulombic_efficiency_pct"], [100.0, 100.0])
        expected_transfer = 10.0 * 360.0 / 3600.0
        np.testing.assert_allclose(cycles["charge_capacity_mah"], [expected_transfer] * 2)
        np.testing.assert_allclose(cycles["discharge_capacity_mah"], [expected_transfer] * 2)
        np.testing.assert_allclose(cycles["cycle_duration_h"], [780.0 / 3600.0] * 2)
        np.testing.assert_allclose(cycles["charge_time_h"], [360.0 / 3600.0] * 2)
        np.testing.assert_allclose(cycles["discharge_time_h"], [360.0 / 3600.0] * 2)
        np.testing.assert_allclose(cycles["mean_charge_voltage_v"], [3.6, 3.6])
        np.testing.assert_allclose(cycles["mean_discharge_voltage_v"], [3.35, 3.35])
        np.testing.assert_allclose(cycles["first_charge_voltage_v"], [3.5, 3.5])
        np.testing.assert_allclose(cycles["last_charge_voltage_v"], [3.7, 3.7])
        np.testing.assert_allclose(cycles["first_discharge_voltage_v"], [3.6, 3.6])
        np.testing.assert_allclose(cycles["last_discharge_voltage_v"], [3.1, 3.1])
        self.assertTrue(cycles["charge_energy_mwh"].isna().all())
        self.assertTrue(cycles["discharge_energy_mwh"].isna().all())
        self.assertEqual(raw.attrs.get("biologic_gcpl", {}).get("cycle_source"), "execution charge/discharge pair")

        spec = self._spec()
        cycle_result = analysis_engine.compute(self.db, spec, None, use_current_versions=True)
        series = cycle_result["cell_series"][0]
        self.assertEqual(series["x"], [1, 2])
        np.testing.assert_allclose(series["quantities"]["discharge_capacity_mah"], [1.0, 1.0])
        np.testing.assert_allclose(series["quantities"]["discharge_capacity_mah_g"], [1000.0, 1000.0])
        self.assertEqual(cycle_result["parser_version"], "bm:gcpl3:r1")
        self.assertEqual(
            cycle_result["sources"][0]["files"][0]["parser_version"],
            "bm:gcpl3:r1",
        )

        for channel, expected_voltage in (
            ("working_potential", [3.6, 3.8, 3.8, 3.7, 3.7, 3.2] * 2),
            ("counter_potential", [0.1] * 12),
        ):
            spec["computation"]["time_capacity"] = {"voltage_channel": channel}
            spec["computation"]["time_capacity"]["voltage_channel"] = channel
            time_result = analysis_engine.compute_time_capacity(
                self.db, spec, None, use_current_versions=True, precision="full", compact=False
            )
            trace = time_result["cell_traces"][0]
            self.assertEqual(trace["cycle"], [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2])
            np.testing.assert_allclose(trace["voltage_v"], expected_voltage)
            self.assertTrue(time_result["voltage_channels"][channel]["available"])
        self.assertTrue(time_result["voltage_channels"]["working_potential"]["available"])
        self.assertTrue(time_result["voltage_channels"]["counter_potential"]["available"])

    def test_gcpl_revision_does_not_reuse_previous_parser_cache(self) -> None:
        old_identity = "bm:gcpl2:r1"
        current_identity = parsing.parser_identity(self.mpr_path)
        self.assertEqual(current_identity, "bm:gcpl3:r1")
        file_hash = parsing.capture_source_fingerprint(self.mpr_path).hash
        revision_cache = self.root / "revision-cache"
        old_cache_dir = cache.CACHE_DIR
        cache.CACHE_DIR = revision_cache
        try:
            old_raw = cache.raw_path(file_hash, old_identity)
            old_cycles = cache.cycles_path(file_hash, old_identity, cache.CALC_VERSION)
            old_raw.parent.mkdir(parents=True, exist_ok=True)
            pd.DataFrame({"sentinel": ["gcpl2"]}).to_parquet(old_raw, index=False)
            pd.DataFrame({"sentinel": ["gcpl2"]}).to_parquet(old_cycles, index=False)
            self.assertFalse(cache.raw_path(file_hash, current_identity).exists())
            self.assertFalse(
                cache.cycles_path(file_hash, current_identity, cache.CALC_VERSION).exists()
            )

            result = cache.build(file_hash, self.mpr_path)

            self.assertFalse(result["cached"])
            self.assertEqual(result["parser_version"], current_identity)
            self.assertEqual(result["rows"], 12)
            self.assertEqual(result["cycles"], 2)
            self.assertTrue(cache.raw_path(file_hash, current_identity).exists())
            self.assertTrue(
                cache.cycles_path(file_hash, current_identity, cache.CALC_VERSION).exists()
            )
            self.assertTrue(old_raw.exists(), "old parser cache should remain for cleanup")
            self.assertTrue(old_cycles.exists(), "old parser cache should remain for cleanup")
        finally:
            cache.CACHE_DIR = old_cache_dir

    def test_steps_dcir_and_capability_limited_families_use_shared_services(self) -> None:
        metadata = read_gcpl_header_metadata(self.mpr_path)
        declared = protocol.reconstruct_protocol(metadata["raw"])
        self.assertEqual(declared["signature"], metadata["protocol"]["signature"])

        spec = self._spec()
        spec["protocol_segments"] = [
            {
                "id": "all-gcpl",
                "name": "All GCPL operations",
                "targets": [
                    {
                        "protocol_signature": declared["signature"],
                        "step_indices": [1, 2, 3],
                    }
                ],
            }
        ]
        spec["computation"]["steps"]["series"] = [
            {"id": "steps-closure", "cell_id": self.cell.id, "segment_id": "all-gcpl"}
        ]
        steps = analysis_engine.compute_steps(self.db, spec, None, use_current_versions=True)
        self.assertEqual(steps["cell_series"][0]["n_blocks"], 2)
        self.assertEqual(steps["cell_series"][0]["x_cycle"], [1, 2])

        dcir_path = write_gcpl_mpr(
            self.root / "synthetic-dcir.mpr",
            _dcir_rows(),
            settings_payload=_dcir_settings(),
            include_log=False,
        )
        dcir_source, dcir_cell = self._attach_source_cell(dcir_path, "Synthetic BioLogic DCIR")
        dcir_metadata = read_gcpl_header_metadata(dcir_path)
        dcir_declared = protocol.reconstruct_protocol(dcir_metadata["raw"])
        candidates = dcir.detect_candidates(dcir_declared)
        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual(candidate["rest_step_index"], 1)
        self.assertEqual(candidate["pulse_step_index"], 2)
        self.assertEqual(candidate["direction"], "discharge")
        self.assertEqual(candidate["rest_duration_s"], 1800.0)
        self.assertEqual(candidate["pulse_duration_s"], 30.0)

        dcir_spec = analysis_engine.default_spec("Synthetic BioLogic DCIR")
        dcir_spec["selection"]["entries"] = [{"kind": "cell", "ref_id": dcir_cell.id}]
        dcir_spec["dcir_segments"] = [
            {
                "id": "rest-pulse",
                "name": "Rest/pulse",
                "targets": [
                    {
                        "protocol_signature": candidate["protocol_signature"],
                        "rest_step_index": candidate["rest_step_index"],
                        "pulse_step_index": candidate["pulse_step_index"],
                        "direction": candidate["direction"],
                    }
                ],
            }
        ]
        dcir_spec["computation"]["dcir"]["series"] = [
            {"id": "dcir-closure", "cell_id": dcir_cell.id, "segment_id": "rest-pulse"}
        ]
        dcir_result = analysis_engine.compute_dcir(
            self.db, dcir_spec, None, use_current_versions=True
        )
        dcir_series = dcir_result["cell_series"][0]
        self.assertEqual(dcir_series["n_measurements"], 1)
        np.testing.assert_allclose(
            dcir_series["quantities"]["dcir_mohm"], [400000.0], rtol=1e-5
        )

        self.assertEqual(rate_capability.build_rate_pairs(declared), [])
        self.assertEqual(chargeability.detect_candidates(declared), [])
        self.assertFalse(declared["capabilities"]["semantic_conditions_available"])
        self.assertIn("Chargeability", " ".join(declared["warnings"]))

    def test_rate_capability_recognizes_explicit_c_rate_sweep_and_cutoffs(self) -> None:
        rate_path = write_gcpl_mpr(
            self.root / "synthetic-rate-capability.mpr",
            _rate_rows(),
            settings_payload=_rate_settings(),
            include_log=False,
        )
        rate_source, rate_cell = self._attach_source_cell(
            rate_path, "Synthetic BioLogic rate capability"
        )
        rate_metadata = read_gcpl_header_metadata(rate_path)
        declared = protocol.reconstruct_protocol(rate_metadata["raw"])
        pairs = rate_capability.build_rate_pairs(declared)
        self.assertEqual(len(pairs), 3)
        self.assertEqual(
            [pair["charge_rate_c"] for pair in pairs], [0.5, 1.0, 2.0]
        )
        self.assertEqual([pair["discharge_rate_c"] for pair in pairs], [0.5] * 3)
        np.testing.assert_allclose([pair["upper_voltage_v"] for pair in pairs], [4.2] * 3)
        np.testing.assert_allclose([pair["lower_voltage_v"] for pair in pairs], [2.8] * 3)

        rate_spec = analysis_engine.default_spec("Synthetic BioLogic rate capability")
        rate_spec["selection"]["entries"] = [{"kind": "cell", "ref_id": rate_cell.id}]
        result = rate_capability.compute(
            self.db, rate_spec, None, use_current_versions=True
        )
        self.assertEqual(result["available"]["charge_rates_c"], [0.5, 1.0, 2.0])
        self.assertEqual(result["available"]["charge_fixed_rates_c"], [0.5])
        self.assertEqual(result["available"]["charge_structures"], ["cc"])
        self.assertEqual(result["cells"][0]["families"]["charge"]["status"], "matched")
        self.assertEqual(result["cells"][0]["families"]["charge"]["rate_count"], 3)
        self.assertEqual(result["cells"][0]["families"]["discharge"]["status"], "not_detected")
        block = next(block for block in result["blocks"] if block["family"] == "charge")
        self.assertEqual(block["rates_c"], [0.5, 1.0, 2.0])
        self.assertAlmostEqual(block["fixed_rate_c"], 0.5)
        self.assertAlmostEqual(block["upper_voltage_v"], 4.2, places=6)
        self.assertAlmostEqual(block["lower_voltage_v"], 2.8, places=6)
        self.assertTrue(all(point["valid"] for point in block["points"]))
        np.testing.assert_allclose(
            [point["capacity_mah"] for point in block["points"]], [0.5, 0.5, 0.5]
        )
        np.testing.assert_allclose(
            [point["capacity_mah_g"] for point in block["points"]], [500.0] * 3
        )
        self.assertEqual(rate_source.parser_version, "bm:gcpl3:r1")

    def test_header_batch_and_full_parse_paths_are_separate_and_bounded(self) -> None:
        paths = []
        for index in range(50):
            path = self.root / f"header-{index}.mpr"
            write_gcpl_mpr(
                path,
                [{"total_time_s": 0.0, "ns": 0, "control": -1.0}],
                settings_payload=_settings(),
                include_log=False,
            )
            paths.append(path)

        phases: list[dict] = []
        started = time.perf_counter()
        outcomes = import_inspection.inspect_files(
            [str(path) for path in paths],
            on_phase=phases.append,
        )
        elapsed = time.perf_counter() - started
        self.assertEqual([Path(outcome.path).name for outcome in outcomes], [path.name for path in paths])
        self.assertTrue(all(outcome.inspection is not None for outcome in outcomes))
        self.assertTrue(
            all(
                outcome.inspection.metadata["capabilities"]["canonical_cycling"]
                for outcome in outcomes
                if outcome.inspection is not None
            )
        )
        startup = [phase for phase in phases if phase["phase"] == "starting_workers"]
        self.assertEqual(import_inspection.inspection_strategy(25), "serial")
        self.assertEqual(import_inspection.inspection_strategy(26), "multiprocessing")
        self.assertEqual([phase["phase_current"] for phase in startup], [1, 2, 3, 4])
        self.assertEqual(startup[-1]["worker_count"], 4)
        self.assertGreater(elapsed, 0.0)

        full = parsing.parse_timeseries(self.mpr_path)
        self.assertEqual(len(full), 12)
        self.assertEqual(full.attrs["biologic_gcpl"]["cycle_source"], "execution charge/discharge pair")

    def test_production_mpr_cccv_fails_closed_without_measured_current_column(self) -> None:
        cv_path = write_gcpl_mpr(
            self.root / "synthetic-cccv-without-current.mpr",
            [
                {"total_time_s": 0.0, "ns": 0, "mode": 2, "control": 3.0, "q_mAh": 0.0, "ewe_v": 3.6, "ece_v": 0.1, "ns_changed": True},
                {"total_time_s": 30.0, "ns": 0, "mode": 2, "control": 3.0, "q_mAh": 0.5, "dq_mAh": 0.5, "ewe_v": 4.2, "ece_v": 0.1},
            ],
            settings_payload=encode_gcpl_settings(
                [{"set_i_c": 0, "current": 1.0, "t1_s": 30.0, "voltage_limit_v": 4.2}],
                active_mass_g=0.001,
                reference_electrode="Ag/AgCl",
                battery_capacity=1.0,
                battery_capacity_unit=1,
            ),
        )
        with self.assertRaisesRegex(UnsupportedBiologicGcplError, "measured-current"):
            parsing.parse_timeseries(cv_path)

    def test_generic_scientific_services_have_no_biologic_format_branch(self) -> None:
        service_paths = (
            ROOT / "backend" / "app" / "services" / "calc.py",
            ROOT / "backend" / "app" / "services" / "dcir.py",
            ROOT / "backend" / "app" / "services" / "chargeability.py",
            ROOT / "backend" / "app" / "services" / "rate_capability.py",
            ROOT / "backend" / "app" / "services" / "step_blocks.py",
        )
        for path in service_paths:
            text = path.read_text(encoding="utf-8").casefold()
            self.assertNotIn("biologic", text, path.name)
            self.assertNotIn(".mpr", text, path.name)


if __name__ == "__main__":
    unittest.main()
