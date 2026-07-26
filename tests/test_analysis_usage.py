import os
import sys
import unittest
from copy import deepcopy
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import Analysis, Cell, ReplicateGroup, ReplicateGroupCell
from app.services import analysis_engine, analysis_usage


class AnalysisUsageTests(unittest.TestCase):
    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def _analysis(self, db, title: str, entries: list[dict], saved_plots: list[dict] | None = None):
        spec = analysis_engine.default_spec(title)
        spec["selection"]["entries"] = entries
        if saved_plots is not None:
            spec["saved_plots"] = saved_plots
        row = Analysis(title=title, spec=spec)
        db.add(row)
        db.flush()
        return row

    def _plot(self, plot_id: str, name: str, exclusions: list[dict] | None = None):
        return {
            "id": plot_id,
            "tab": "cycles",
            "name": name,
            "subtitle": "",
            "description": None,
            "selection": {
                "entries": [],
                "exclusions": exclusions or [],
                "hidden_replicate_group_ids": [],
            },
            "computation": {},
            "aggregation": {},
            "presentation": {},
            "created_at": "2026-01-01T00:00:00+00:00",
            "modified_at": "2026-01-01T00:00:00+00:00",
        }

    def test_direct_cell_reference_and_empty_analysis(self):
        db = self.make_session()
        cell = Cell(name="Solo")
        other = Cell(name="Other")
        db.add_all([cell, other])
        db.flush()
        empty = self._analysis(
            db,
            "Only solo",
            [{"kind": "cell", "ref_id": cell.id}],
            [self._plot("p1", "Capacity fade")],
        )
        kept = self._analysis(
            db,
            "Has other",
            [
                {"kind": "cell", "ref_id": cell.id},
                {"kind": "cell", "ref_id": other.id},
            ],
            [self._plot("p2", "CE")],
        )
        untouched = self._analysis(
            db,
            "Untouched",
            [{"kind": "cell", "ref_id": other.id}],
            [self._plot("p3", "Other plot")],
        )
        db.commit()

        payload = analysis_usage.preview_removal_usage(db, cell_ids=[cell.id], group_ids=[])
        ids = [row["id"] for row in payload["analyses"]]
        self.assertEqual(ids[0], empty.id)  # empty-after first
        self.assertIn(kept.id, ids)
        self.assertNotIn(untouched.id, ids)
        self.assertEqual(payload["empty_after"], [empty.id])

        by_id = {row["id"]: row for row in payload["analyses"]}
        self.assertTrue(by_id[empty.id]["becomes_empty"])
        self.assertEqual(by_id[empty.id]["remaining_entry_count"], 0)
        self.assertTrue(by_id[empty.id]["plots"][0]["affected"])
        self.assertFalse(by_id[kept.id]["becomes_empty"])
        self.assertEqual(by_id[kept.id]["remaining_entry_count"], 1)
        self.assertEqual(by_id[kept.id]["matched"][0]["name"], "Solo")

    def test_cell_via_replicate_group_survives(self):
        db = self.make_session()
        a = Cell(name="A")
        b = Cell(name="B")
        db.add_all([a, b])
        db.flush()
        group = ReplicateGroup(name="Pair")
        db.add(group)
        db.flush()
        db.add_all(
            [
                ReplicateGroupCell(group_id=group.id, cell_id=a.id, position=0),
                ReplicateGroupCell(group_id=group.id, cell_id=b.id, position=1),
            ]
        )
        analysis = self._analysis(
            db,
            "Group analysis",
            [{"kind": "replicate_group", "ref_id": group.id}],
            [self._plot("p1", "Fade")],
        )
        db.commit()

        payload = analysis_usage.preview_removal_usage(db, cell_ids=[a.id], group_ids=[])
        self.assertEqual(len(payload["analyses"]), 1)
        row = payload["analyses"][0]
        self.assertEqual(row["id"], analysis.id)
        self.assertFalse(row["becomes_empty"])
        self.assertEqual(row["remaining_entry_count"], 1)
        self.assertEqual(row["matched"], [{"kind": "cell", "ref_id": a.id, "name": "A"}])
        self.assertTrue(row["plots"][0]["affected"])
        self.assertEqual(payload["empty_after"], [])

    def test_explode_group_empties_sole_entry(self):
        db = self.make_session()
        a = Cell(name="A")
        db.add(a)
        db.flush()
        group = ReplicateGroup(name="Solo group")
        db.add(group)
        db.flush()
        db.add(ReplicateGroupCell(group_id=group.id, cell_id=a.id, position=0))
        analysis = self._analysis(
            db,
            "Only group",
            [{"kind": "replicate_group", "ref_id": group.id}],
            [self._plot("p1", "Fade"), self._plot("p2", "CE")],
        )
        db.commit()

        payload = analysis_usage.preview_removal_usage(db, cell_ids=[], group_ids=[group.id])
        row = payload["analyses"][0]
        self.assertEqual(row["id"], analysis.id)
        self.assertTrue(row["becomes_empty"])
        self.assertEqual(row["matched"][0]["kind"], "replicate_group")
        self.assertTrue(all(plot["affected"] for plot in row["plots"]))
        self.assertEqual(payload["empty_after"], [analysis.id])

    def test_plot_unaffected_when_exclusions_hide_matched_cells(self):
        db = self.make_session()
        cell = Cell(name="Hidden")
        other = Cell(name="Visible")
        db.add_all([cell, other])
        db.flush()
        analysis = self._analysis(
            db,
            "Mixed",
            [
                {"kind": "cell", "ref_id": cell.id},
                {"kind": "cell", "ref_id": other.id},
            ],
            [
                self._plot(
                    "hidden",
                    "Already excluded",
                    exclusions=[{"cell_id": cell.id}],
                ),
                self._plot("shown", "Still showing"),
            ],
        )
        db.commit()

        payload = analysis_usage.preview_removal_usage(db, cell_ids=[cell.id], group_ids=[])
        row = {item["id"]: item for item in payload["analyses"]}[analysis.id]
        by_name = {plot["name"]: plot for plot in row["plots"]}
        self.assertFalse(by_name["Already excluded"]["affected"])
        self.assertTrue(by_name["Still showing"]["affected"])

    def test_unrelated_request_returns_empty(self):
        db = self.make_session()
        cell = Cell(name="C")
        db.add(cell)
        db.flush()
        self._analysis(db, "Has cell", [{"kind": "cell", "ref_id": cell.id}])
        db.commit()
        payload = analysis_usage.preview_removal_usage(db, cell_ids=[99999], group_ids=[88888])
        self.assertEqual(payload, {"analyses": [], "empty_after": []})

    def test_sole_replicate_member_marks_group_only_analysis_empty(self):
        db = self.make_session()
        cell = Cell(name="Only")
        db.add(cell)
        db.flush()
        group = ReplicateGroup(name="Solo")
        db.add(group)
        db.flush()
        db.add(ReplicateGroupCell(group_id=group.id, cell_id=cell.id, position=0))
        analysis = self._analysis(
            db,
            "Group only",
            [{"kind": "replicate_group", "ref_id": group.id}],
            [self._plot("p1", "Fade")],
        )
        db.commit()

        payload = analysis_usage.preview_removal_usage(db, cell_ids=[cell.id], group_ids=[])
        row = payload["analyses"][0]
        self.assertEqual(row["id"], analysis.id)
        self.assertTrue(row["becomes_empty"])
        self.assertEqual(row["remaining_entry_count"], 0)
        self.assertEqual(payload["empty_after"], [analysis.id])

    def test_all_replicate_members_batch_marks_group_only_analysis_empty(self):
        db = self.make_session()
        a = Cell(name="A")
        b = Cell(name="B")
        db.add_all([a, b])
        db.flush()
        group = ReplicateGroup(name="Pair")
        db.add(group)
        db.flush()
        db.add_all(
            [
                ReplicateGroupCell(group_id=group.id, cell_id=a.id, position=0),
                ReplicateGroupCell(group_id=group.id, cell_id=b.id, position=1),
            ]
        )
        analysis = self._analysis(
            db,
            "Group only",
            [{"kind": "replicate_group", "ref_id": group.id}],
        )
        db.commit()

        payload = analysis_usage.preview_removal_usage(
            db, cell_ids=[a.id, b.id], group_ids=[]
        )
        row = payload["analyses"][0]
        self.assertEqual(row["id"], analysis.id)
        self.assertTrue(row["becomes_empty"])
        self.assertEqual(payload["empty_after"], [analysis.id])

    def test_purge_empty_candidates_rechecks_after_mutation(self):
        db = self.make_session()
        sole = Cell(name="Sole")
        kept = Cell(name="Kept")
        db.add_all([sole, kept])
        db.flush()
        group = ReplicateGroup(name="Solo group")
        db.add(group)
        db.flush()
        db.add(ReplicateGroupCell(group_id=group.id, cell_id=sole.id, position=0))
        empty = self._analysis(
            db,
            "Will empty",
            [{"kind": "replicate_group", "ref_id": group.id}],
        )
        survivor = self._analysis(
            db,
            "Still has cell",
            [{"kind": "cell", "ref_id": kept.id}],
        )
        db.commit()

        preflight = analysis_usage.preview_removal_usage(db, cell_ids=[sole.id], group_ids=[])
        self.assertEqual(preflight["empty_after"], [empty.id])

        # Simulate library deletion of the sole member and the emptied group.
        db.query(ReplicateGroupCell).filter(ReplicateGroupCell.group_id == group.id).delete()
        db.delete(group)
        db.delete(sole)
        db.commit()

        purged = analysis_usage.purge_empty_candidates(
            db, preflight["empty_after"] + [survivor.id]
        )
        self.assertEqual(purged["deleted_ids"], [empty.id])
        self.assertIsNone(db.get(Analysis, empty.id))
        self.assertIsNotNone(db.get(Analysis, survivor.id))

    def test_strip_replicate_groups_removes_dead_entries(self):
        db = self.make_session()
        a = Cell(name="A")
        b = Cell(name="B")
        kept = Cell(name="Kept")
        db.add_all([a, b, kept])
        db.flush()
        group = ReplicateGroup(name="Pair")
        other = ReplicateGroup(name="Other")
        db.add_all([group, other])
        db.flush()
        db.add_all(
            [
                ReplicateGroupCell(group_id=group.id, cell_id=a.id, position=0),
                ReplicateGroupCell(group_id=group.id, cell_id=b.id, position=1),
                ReplicateGroupCell(group_id=other.id, cell_id=kept.id, position=0),
            ]
        )
        sole = self._analysis(
            db,
            "Only exploded",
            [{"kind": "replicate_group", "ref_id": group.id}],
            [
                self._plot(
                    "p1",
                    "Fade",
                    exclusions=[
                        {
                            "cell_id": a.id,
                            "entry_kind": "replicate_group",
                            "entry_ref_id": group.id,
                        }
                    ],
                )
            ],
        )
        mixed = self._analysis(
            db,
            "Mixed",
            [
                {"kind": "replicate_group", "ref_id": group.id},
                {"kind": "cell", "ref_id": kept.id},
                {"kind": "replicate_group", "ref_id": other.id},
            ],
        )
        untouched = self._analysis(
            db,
            "Untouched",
            [{"kind": "replicate_group", "ref_id": other.id}],
        )
        sole_spec = deepcopy(sole.spec)
        sole_spec["selection"]["hidden_replicate_group_ids"] = [group.id, other.id]
        sole.spec = sole_spec
        db.commit()

        result = analysis_usage.strip_replicate_groups_from_analyses(db, [group.id])
        db.commit()
        self.assertEqual(sorted(result["modified_analysis_ids"]), sorted([sole.id, mixed.id]))

        sole_spec = db.get(Analysis, sole.id).spec
        self.assertEqual(sole_spec["selection"]["entries"], [])
        self.assertEqual(sole_spec["selection"]["hidden_replicate_group_ids"], [other.id])
        self.assertEqual(sole_spec["saved_plots"][0]["selection"]["exclusions"], [])

        mixed_spec = db.get(Analysis, mixed.id).spec
        self.assertEqual(
            mixed_spec["selection"]["entries"],
            [
                {"kind": "cell", "ref_id": kept.id},
                {"kind": "replicate_group", "ref_id": other.id},
            ],
        )
        untouched_spec = db.get(Analysis, untouched.id).spec
        self.assertEqual(
            untouched_spec["selection"]["entries"],
            [{"kind": "replicate_group", "ref_id": other.id}],
        )

    def test_purge_skips_when_candidate_still_has_samples(self):
        db = self.make_session()
        a = Cell(name="A")
        b = Cell(name="B")
        db.add_all([a, b])
        db.flush()
        group = ReplicateGroup(name="Pair")
        db.add(group)
        db.flush()
        db.add_all(
            [
                ReplicateGroupCell(group_id=group.id, cell_id=a.id, position=0),
                ReplicateGroupCell(group_id=group.id, cell_id=b.id, position=1),
            ]
        )
        analysis = self._analysis(
            db,
            "Group analysis",
            [{"kind": "replicate_group", "ref_id": group.id}],
        )
        db.commit()

        preflight = analysis_usage.preview_removal_usage(db, cell_ids=[a.id], group_ids=[])
        self.assertEqual(preflight["empty_after"], [])

        db.query(ReplicateGroupCell).filter(
            ReplicateGroupCell.group_id == group.id,
            ReplicateGroupCell.cell_id == a.id,
        ).delete()
        db.delete(a)
        db.commit()

        # Even if the client wrongly listed the analysis, recheck keeps it.
        purged = analysis_usage.purge_empty_candidates(db, [analysis.id])
        self.assertEqual(purged["deleted_ids"], [])
        self.assertIsNotNone(db.get(Analysis, analysis.id))


if __name__ == "__main__":
    unittest.main()
