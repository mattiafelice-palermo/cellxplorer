from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import Cell, SourceFile, Test, TestFile
from app.services import analysis_engine as engine


class SourceStalenessTests(unittest.TestCase):
    """An analysis is stale when its sources no longer match its provenance.

    The signal is derived, never stored, so recomputing clears it and there is
    no "seen" flag that can drift away from the truth.
    """

    def setUp(self):
        eng = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(eng)
        self.db = sessionmaker(bind=eng, autoflush=False, expire_on_commit=False)()
        self.cell = Cell(name="c1")
        self.db.add(self.cell)
        self.db.flush()
        test = Test(cell_id=self.cell.id, name="t")
        self.db.add(test)
        self.db.flush()
        for position, digest in enumerate(("a" * 64, "b" * 64)):
            source = SourceFile(
                hash=digest, path=digest, filename=f"{digest[:4]}.ndax", size=1, ext="ndax"
            )
            self.db.add(source)
            self.db.flush()
            self.db.add(TestFile(test_id=test.id, file_id=source.id, position=position))
        self.db.commit()

    def provenance(self, hashes: list[str]) -> dict:
        return {"sources": [{"cell_id": self.cell.id, "file_hashes": hashes}]}

    def test_matching_hashes_are_not_stale(self):
        current = engine.current_cell_hashes(self.db)
        self.assertEqual(current[self.cell.id], ["a" * 64, "b" * 64])
        self.assertFalse(
            engine.sources_changed_since_compute(self.provenance(["a" * 64, "b" * 64]), current)
        )

    def test_a_replaced_file_is_stale(self):
        current = engine.current_cell_hashes(self.db)
        self.assertTrue(
            engine.sources_changed_since_compute(self.provenance(["a" * 64, "z" * 64]), current)
        )

    def test_an_added_or_removed_file_is_stale(self):
        current = engine.current_cell_hashes(self.db)
        self.assertTrue(engine.sources_changed_since_compute(self.provenance(["a" * 64]), current))
        self.assertTrue(
            engine.sources_changed_since_compute(
                self.provenance(["a" * 64, "b" * 64, "c" * 64]), current
            )
        )

    def test_reordered_files_are_stale(self):
        # Order is the stitching order, so a swap changes the resulting series.
        current = engine.current_cell_hashes(self.db)
        self.assertTrue(
            engine.sources_changed_since_compute(self.provenance(["b" * 64, "a" * 64]), current)
        )

    def test_hashes_reject_multiple_internal_rows(self):
        second = Test(cell_id=self.cell.id, name="t2")
        self.db.add(second)
        self.db.flush()
        source = SourceFile(hash="c" * 64, path="c", filename="c.ndax", size=1, ext="ndax")
        self.db.add(source)
        self.db.flush()
        self.db.add(TestFile(test_id=second.id, file_id=source.id, position=0))
        self.db.commit()

        with self.assertRaises(engine.CellSourceChainInvariantError):
            engine.current_cell_hashes(self.db)
        with self.assertRaises(engine.CellSourceChainInvariantError):
            engine.cell_ordered_hashes(self.db, self.cell)

    def test_hashes_reject_zero_internal_rows(self):
        test = self.db.query(Test).filter(Test.cell_id == self.cell.id).one()
        self.db.delete(test)
        self.db.commit()
        self.db.expire(self.cell, ["tests"])

        with self.assertRaises(engine.CellSourceChainInvariantError) as current:
            engine.current_cell_hashes(self.db)
        self.assertEqual(current.exception.detail["code"], "single_internal_test_required")
        self.assertEqual(current.exception.detail["cell_id"], self.cell.id)
        self.assertEqual(current.exception.detail["cell_name"], "c1")
        self.assertEqual(current.exception.detail["test_count"], 0)

        with self.assertRaises(engine.CellSourceChainInvariantError) as direct:
            engine.cell_ordered_hashes(self.db, self.cell)
        self.assertEqual(direct.exception.detail["test_count"], 0)

    def test_an_uncomputed_analysis_is_not_stale(self):
        current = engine.current_cell_hashes(self.db)
        self.assertFalse(engine.sources_changed_since_compute(None, current))
        self.assertFalse(engine.sources_changed_since_compute({}, current))

    def test_a_cell_deleted_since_compute_is_stale(self):
        # Its hashes are gone, so the analysis no longer matches its sources.
        self.assertTrue(
            engine.sources_changed_since_compute(self.provenance(["a" * 64, "b" * 64]), {})
        )

    def test_tracked_source_rejects_multiple_internal_rows(self):
        from app.services import analysis_usage

        second_test = Test(cell_id=self.cell.id, name="tail-test")
        self.db.add(second_test)
        self.db.flush()
        tail = SourceFile(hash="d" * 64, path="d", filename="d.ndax", size=1, ext="ndax")
        self.db.add(tail)
        self.db.flush()
        self.db.add(TestFile(test_id=second_test.id, file_id=tail.id, position=0))
        self.db.commit()
        with self.assertRaises(engine.CellSourceChainInvariantError):
            analysis_usage.tracked_source_file_id(self.cell)


if __name__ == "__main__":
    unittest.main()
