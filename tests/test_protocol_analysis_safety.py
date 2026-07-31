from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import Analysis, Cell, SourceFile, Test, TestFile
from app.routers import analyses
from app.services import analysis_engine, cache_maintenance


class ProtocolAnalysisSafetyTests(unittest.TestCase):
    def setUp(self):
        self.database = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.database)
        self.db = sessionmaker(bind=self.database, autoflush=False, expire_on_commit=False)()

        self.multi = self._cell("Restarted cell", ["a" * 64, "b" * 64])
        self.single = self._cell("Uninterrupted cell", ["c" * 64])
        self.db.flush()
        self.analysis = Analysis(
            title="Protocol safety",
            spec={
                "selection": {
                    "entries": [
                        {"kind": "cell", "ref_id": self.multi.id},
                        {"kind": "cell", "ref_id": self.single.id},
                    ]
                }
            },
        )
        self.db.add(self.analysis)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.database.dispose()

    def _cell(self, name: str, hashes: list[str]) -> Cell:
        cell = Cell(name=name)
        self.db.add(cell)
        self.db.flush()
        test = Test(cell_id=cell.id, name=f"{name} protocol")
        self.db.add(test)
        self.db.flush()
        for position, digest in enumerate(hashes):
            source = SourceFile(
                hash=digest,
                path=digest,
                filename=f"{digest[:4]}.ndax",
                size=1,
                ext="ndax",
            )
            self.db.add(source)
            self.db.flush()
            self.db.add(TestFile(test_id=test.id, file_id=source.id, position=position))
        return cell

    def test_support_predicate_reports_only_multi_source_cells(self):
        detail = analysis_engine.protocol_analysis_guard(
            self.db,
            self.analysis.spec,
            "rate_capability",
        )
        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertEqual(detail["code"], "multi_source_protocol_mapping_required")
        self.assertEqual(detail["plot_family"], "rate_capability")
        self.assertEqual(
            detail["unsupported_cells"],
            [{"id": self.multi.id, "name": "Restarted cell", "source_count": 2}],
        )
        self.assertEqual(detail["supported_alternatives"], ["cycles", "time_capacity"])

    def test_steps_and_dcir_protocol_endpoints_fail_before_cache_or_recognition(self):
        with patch.object(analyses.analysis_cache, "result_key", side_effect=AssertionError("cache accessed")):
            for route, request in (
                (analyses.compute_steps_analysis, analyses.ComputeRequest()),
                (analyses.compute_dcir_analysis, analyses.ComputeRequest()),
                (analyses.get_dcir_protocols, analyses.DcirProtocolRequest()),
            ):
                with self.subTest(route=route.__name__):
                    with self.assertRaises(HTTPException) as context:
                        route(self.analysis.id, request, self.db)
                    self.assertEqual(context.exception.status_code, 422)
                    self.assertEqual(
                        context.exception.detail["code"],
                        "multi_source_protocol_mapping_required",
                    )

    def test_all_recognition_jobs_fail_without_opening_a_job(self):
        with patch.object(analyses.background_jobs, "create_job", side_effect=AssertionError("job opened")):
            for kind in ("steps", "dcir", "chargeability", "rate_capability"):
                with self.subTest(kind=kind):
                    with self.assertRaises(HTTPException) as context:
                        analyses.create_analysis_compute_job(
                            self.analysis.id,
                            analyses.AnalysisComputeJobCreate(kind=kind),
                            self.db,
                        )
                    self.assertEqual(context.exception.status_code, 422)
                    self.assertEqual(
                        context.exception.detail["plot_family"],
                        kind,
                    )

    def test_warmup_does_not_enqueue_guarded_saved_plot(self):
        self.analysis.spec["saved_plots"] = [
            {"id": "steps-plot", "name": "Steps", "tab": "steps"}
        ]
        self.db.commit()
        coordinator = cache_maintenance.WarmupCoordinator()
        self.assertEqual(coordinator._tasks_for_analyses(self.db, [self.analysis]), [])

    def test_single_source_selection_remains_supported(self):
        spec = {
            "selection": {"entries": [{"kind": "cell", "ref_id": self.single.id}]}
        }
        for family in ("steps", "dcir", "chargeability", "rate_capability"):
            with self.subTest(family=family):
                self.assertIsNone(
                    analysis_engine.protocol_analysis_guard(self.db, spec, family)
                )


if __name__ == "__main__":
    unittest.main()
