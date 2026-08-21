from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.models import (
    ActivityEvent,
    Analysis,
    Cell,
    ReplicateGroup,
    ReplicateGroupCell,
    SourceFile,
    Test,
    TestFile,
)
from app.services import background_jobs, cache, cache_maintenance
from app.routers import analyses as analyses_router


class CacheMaintenanceTests(unittest.TestCase):
    _THUMBNAIL = "data:image/webp;base64,AA=="

    def setUp(self):
        background_jobs.clear_jobs()
        # Prepared markers persist on disk; stale ones from earlier runs
        # would make the warmup queue tests order-dependent.
        cache_maintenance.analysis_cache.clear_prepared_markers()

    def tearDown(self):
        background_jobs.clear_jobs()
        cache_maintenance.analysis_cache.clear_prepared_markers()

    def make_session(self):
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    def test_cache_policy_round_trips_nullable_budgets(self):
        db = self.make_session()
        policy = cache_maintenance.CachePolicy(
            warmup_enabled=False,
            only_when_hidden=True,
            idle_seconds=45,
            scientific_limit_bytes=None,
            analysis_limit_bytes=2 * 1024**3,
        )

        with patch.object(cache_maintenance.analysis_cache, "configure_limit"):
            cache_maintenance.save_policy(db, policy)

        self.assertEqual(cache_maintenance.load_policy(db), policy)

    def test_offline_scientific_cache_requires_explicit_force(self):
        db = self.make_session()
        source_hash = "a" * 64
        db.add(
            SourceFile(
                hash=source_hash,
                path=str(ROOT / "missing-source.ndax"),
                filename="missing-source.ndax",
                size=123,
                ext="ndax",
            )
        )
        db.commit()

        with tempfile.TemporaryDirectory() as folder:
            cache_root = Path(folder)
            scientific = cache_root / source_hash[:2] / source_hash
            scientific.mkdir(parents=True)
            (scientific / "cycles.parquet").write_bytes(b"cached")
            with patch.object(cache_maintenance, "CACHE_DIR", cache_root):
                with self.assertRaises(PermissionError):
                    cache_maintenance.cleanup_offender(db, "scientific", source_hash)

                removed = cache_maintenance.cleanup_offender(
                    db,
                    "scientific",
                    source_hash,
                    force=True,
                )

            self.assertEqual(removed, len(b"cached"))
            self.assertFalse(scientific.exists())

    def test_category_scientific_cleanup_preserves_offline_sources(self):
        db = self.make_session()
        online_hash = "1" * 64
        offline_hash = "2" * 64
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            online_source = root / "online.ndax"
            online_source.write_bytes(b"source")
            db.add_all(
                [
                    SourceFile(
                        hash=online_hash,
                        path=str(online_source),
                        filename=online_source.name,
                        size=6,
                        ext="ndax",
                    ),
                    SourceFile(
                        hash=offline_hash,
                        path=str(root / "offline.ndax"),
                        filename="offline.ndax",
                        size=7,
                        ext="ndax",
                    ),
                ]
            )
            db.commit()
            cache_root = root / "cache"
            online_cache = cache_root / online_hash[:2] / online_hash
            offline_cache = cache_root / offline_hash[:2] / offline_hash
            online_cache.mkdir(parents=True)
            offline_cache.mkdir(parents=True)
            (online_cache / "raw.parquet").write_bytes(b"online")
            (offline_cache / "raw.parquet").write_bytes(b"offline")

            with (
                patch.object(cache_maintenance, "CACHE_DIR", cache_root),
                patch.object(cache_maintenance.cache, "pending_hashes", return_value=set()),
            ):
                result = cache_maintenance.cleanup_eligible_scientific(db)

            self.assertEqual(result["bytes_removed"], len(b"online"))
            self.assertEqual(result["protected_items"], 1)
            self.assertFalse(online_cache.exists())
            self.assertTrue(offline_cache.exists())

    def test_category_scientific_cleanup_preserves_active_builds(self):
        db = self.make_session()
        source_hash = "3" * 64
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source_path = root / "online.ndax"
            source_path.write_bytes(b"source")
            db.add(
                SourceFile(
                    hash=source_hash,
                    path=str(source_path),
                    filename=source_path.name,
                    size=6,
                    ext="ndax",
                    location_status="online",
                )
            )
            db.commit()
            cache_root = root / "cache"
            scientific = cache_root / source_hash[:2] / source_hash
            scientific.mkdir(parents=True)
            (scientific / "raw.parquet").write_bytes(b"active")

            with (
                patch.object(cache_maintenance, "CACHE_DIR", cache_root),
                cache.protect_hash_from_cleanup(source_hash),
            ):
                result = cache_maintenance.cleanup_eligible_scientific(db)

            self.assertEqual(result["bytes_removed"], 0)
            self.assertEqual(result["protected_items"], 1)
            self.assertTrue(scientific.exists())

    def test_thumbnail_cleanup_removes_images_and_indexes_together(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            thumbnails = root / "analysis" / "thumbnails" / "1"
            indexes = root / "analysis" / "thumbnail-index" / "1"
            thumbnails.mkdir(parents=True)
            indexes.mkdir(parents=True)
            (thumbnails / "plot.webp").write_bytes(b"image")
            (indexes / "plot.json").write_bytes(b"index")
            with (
                patch.object(cache_maintenance, "CACHE_DIR", root),
                patch.object(
                    cache_maintenance.analysis_cache,
                    "clear_prepared_markers",
                ) as clear_markers,
                patch.object(
                    cache_maintenance.analysis_cache,
                    "invalidate_size_tracker",
                ),
            ):
                removed = cache_maintenance.cleanup_category("thumbnails")

            self.assertEqual(removed, len(b"image") + len(b"index"))
            self.assertFalse(thumbnails.parent.exists())
            self.assertFalse(indexes.parent.exists())
            clear_markers.assert_called_once_with()

    def test_obsolete_source_cache_is_removed_by_checksum(self):
        source_hash = "a" * 64
        with tempfile.TemporaryDirectory() as folder:
            cache_root = Path(folder)
            scientific = cache_root / source_hash[:2] / source_hash
            scientific.mkdir(parents=True)
            (scientific / "raw.parquet").write_bytes(b"raw-cache")
            with patch.object(cache, "CACHE_DIR", cache_root):
                removed = cache.remove_hash_cache(source_hash)

            self.assertEqual(removed, len(b"raw-cache"))
            self.assertFalse(scientific.exists())

    def test_cache_removal_waits_for_active_protected_build(self):
        source_hash = "c" * 64
        with tempfile.TemporaryDirectory() as folder:
            cache_root = Path(folder)
            scientific = cache_root / source_hash[:2] / source_hash
            scientific.mkdir(parents=True)
            (scientific / "raw.parquet").write_bytes(b"active")
            entered = threading.Event()
            release = threading.Event()
            removed = threading.Event()

            def protect_build():
                with cache.protect_hash_from_cleanup(source_hash):
                    entered.set()
                    release.wait(timeout=2)

            def remove_cache():
                with patch.object(cache, "CACHE_DIR", cache_root):
                    cache.remove_hash_cache(source_hash)
                removed.set()

            owner = threading.Thread(target=protect_build)
            owner.start()
            self.assertTrue(entered.wait(timeout=1))
            remover = threading.Thread(target=remove_cache)
            remover.start()
            self.assertFalse(removed.wait(timeout=0.15))
            release.set()
            self.assertTrue(removed.wait(timeout=2))
            owner.join(timeout=1)
            remover.join(timeout=1)
            self.assertFalse(scientific.exists())

    def test_scientific_cleanup_paths_wait_for_live_protection(self):
        source_hash = "d" * 64
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cache_root = root / "cache"
            fake_db = MagicMock()
            fake_db.query.return_value.filter.return_value.one_or_none.return_value = None

            def run_while_protected(cleanup):
                scientific = cache_root / source_hash[:2] / source_hash
                scientific.mkdir(parents=True, exist_ok=True)
                (scientific / "raw.parquet").write_bytes(b"active")
                entered = threading.Event()
                release = threading.Event()
                finished = threading.Event()
                result: list[object] = []

                def owner():
                    with cache.protect_hash_from_cleanup(source_hash):
                        entered.set()
                        release.wait(timeout=2)

                def cleaner():
                    result.append(cleanup())
                    finished.set()

                owner_thread = threading.Thread(target=owner)
                cleaner_thread = threading.Thread(target=cleaner)
                owner_thread.start()
                self.assertTrue(entered.wait(timeout=1))
                cleaner_thread.start()
                self.assertFalse(finished.wait(timeout=0.15))
                self.assertTrue(scientific.exists())
                release.set()
                self.assertTrue(finished.wait(timeout=2))
                owner_thread.join(timeout=1)
                cleaner_thread.join(timeout=1)
                self.assertFalse(scientific.exists())
                return result[0]

            with (
                patch.object(cache_maintenance, "CACHE_DIR", cache_root),
                patch.object(cache_maintenance, "_source_labels", return_value={}),
                # Simulate protection being acquired after maintenance's
                # candidate snapshot; the shared deletion boundary must still
                # observe the live protected set.
                patch.object(cache_maintenance.cache, "pending_hashes", return_value=set()),
            ):
                automatic = run_while_protected(
                    lambda: cache_maintenance.cleanup_eligible_scientific(fake_db)
                )
                self.assertEqual(automatic["items_removed"], 1)

                budget = run_while_protected(
                    lambda: cache_maintenance.enforce_scientific_limit(fake_db, 1)
                )
                self.assertGreater(budget, 0)

                explicit = run_while_protected(
                    lambda: cache_maintenance.cleanup_offender(
                        fake_db,
                        "scientific",
                        source_hash,
                        force=True,
                    )
                )
                self.assertGreater(explicit, 0)

    def test_orphaned_source_cache_is_eligible_for_lru_cleanup(self):
        db = self.make_session()
        source_hash = "b" * 64
        with tempfile.TemporaryDirectory() as folder:
            cache_root = Path(folder)
            scientific = cache_root / source_hash[:2] / source_hash
            scientific.mkdir(parents=True)
            (scientific / "cycles.parquet").write_bytes(b"orphaned")
            with (
                patch.object(cache_maintenance, "CACHE_DIR", cache_root),
                patch.object(cache_maintenance.cache, "pending_hashes", return_value=set()),
            ):
                removed = cache_maintenance.enforce_scientific_limit(db, 1)

            self.assertEqual(removed, len(b"orphaned"))
            self.assertFalse(scientific.exists())

    def test_cell_update_invalidates_direct_and_replicate_analyses(self):
        db = self.make_session()
        cell = Cell(name="Updated cell")
        other = Cell(name="Other cell")
        group = ReplicateGroup(name="Replicates")
        db.add_all([cell, other, group])
        db.flush()
        db.add(ReplicateGroupCell(group_id=group.id, cell_id=cell.id, position=0))
        direct = Analysis(
            title="Direct",
            spec={
                "selection": {"entries": [{"kind": "cell", "ref_id": cell.id}]},
                "saved_plots": [{"id": "direct-plot", "name": "Direct plot"}],
            },
        )
        replicate = Analysis(
            title="Replicate",
            spec={
                "selection": {"entries": [{"kind": "replicate_group", "ref_id": group.id}]},
                "saved_plots": [{"id": "replicate-plot", "name": "Replicate plot"}],
            },
        )
        unrelated = Analysis(
            title="Unrelated",
            spec={
                "selection": {"entries": [{"kind": "cell", "ref_id": other.id}]},
                "saved_plots": [{"id": "other-plot", "name": "Other plot"}],
            },
        )
        db.add_all([direct, replicate, unrelated])
        db.commit()

        with (
            patch.object(cache_maintenance.analysis_cache, "delete_analysis_artifacts") as delete,
            patch.object(
                cache_maintenance.warmup,
                "enqueue_analyses",
                return_value={"analyses": 2, "plots": 2},
            ) as enqueue,
        ):
            result = cache_maintenance.invalidate_cell_dependents(
                db,
                cell.id,
                source_id=7,
            )

        self.assertEqual(result["analysis_ids"], sorted([direct.id, replicate.id]))
        self.assertEqual(result["queued_plots"], 2)
        self.assertEqual({call.args[0] for call in delete.call_args_list}, {direct.id, replicate.id})
        enqueue.assert_called_once_with(db, {direct.id, replicate.id})

    def test_warmup_finishes_current_plot_then_pauses_and_resumes(self):
        db = self.make_session()
        db.add(
            Analysis(
                title="Two plots",
                spec={
                    "selection": {"entries": []},
                    "saved_plots": [
                        {"id": "one", "name": "One"},
                        {"id": "two", "name": "Two"},
                    ],
                },
            )
        )
        db.commit()
        coordinator = cache_maintenance.WarmupCoordinator()
        started = coordinator.start(db)
        first = coordinator.next_task(db)

        pause = coordinator.request_pause()
        self.assertTrue(pause["finishing_current"])
        self.assertEqual(background_jobs.get_job(started["id"])["status"], "running")
        self.assertFalse(coordinator.cancel_pending_for_rebuild())

        coordinator.complete(first["id"], status="ready", detail="Ready", error=None)
        paused = background_jobs.get_job(started["id"])
        self.assertEqual(paused["status"], "paused")
        self.assertEqual(paused["completed"], 1)
        self.assertIsNone(coordinator.next_task(db))

        coordinator.resume()
        self.assertEqual(background_jobs.get_job(started["id"])["status"], "running")
        self.assertEqual(coordinator.next_task(db)["plot_id"], "two")

    def test_manual_rebuild_can_supersede_a_paused_queue_without_active_work(self):
        db = self.make_session()
        db.add(
            Analysis(
                title="Queued plots",
                spec={
                    "selection": {"entries": []},
                    "saved_plots": [
                        {"id": "one", "name": "One"},
                        {"id": "two", "name": "Two"},
                    ],
                },
            )
        )
        db.commit()
        coordinator = cache_maintenance.WarmupCoordinator()
        old = coordinator.start(db)
        coordinator.request_pause()

        self.assertTrue(coordinator.cancel_pending_for_rebuild())
        self.assertEqual(background_jobs.get_job(old["id"])["status"], "completed")

        rebuilt = coordinator.start(db, force=True)
        self.assertNotEqual(rebuilt["id"], old["id"])
        self.assertEqual(rebuilt["total"], 2)

    def test_new_source_revision_supersedes_older_queued_plot(self):
        db = self.make_session()
        cell = Cell(name="Changing cell")
        source = SourceFile(
            hash="c" * 64,
            path="C:/data/changing.ndax",
            filename="changing.ndax",
            size=1,
            ext="ndax",
            parse_status="parsed",
        )
        db.add_all([cell, source])
        db.flush()
        test = Test(cell_id=cell.id, name="Changing cell")
        db.add(test)
        db.flush()
        db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        analysis = Analysis(
            title="Changing analysis",
            spec={
                "selection": {"entries": [{"kind": "cell", "ref_id": cell.id}]},
                "saved_plots": [{"id": "plot", "name": "Plot"}],
            },
        )
        db.add(analysis)
        db.commit()
        coordinator = cache_maintenance.WarmupCoordinator()

        coordinator.enqueue_analyses(db, {analysis.id})
        source.hash = "d" * 64
        db.commit()
        coordinator.enqueue_analyses(db, {analysis.id})

        task = coordinator.next_task(db)
        self.assertIsNotNone(task)
        self.assertEqual(task["expected_data_signature"], cache_maintenance.analysis_cache.saved_plot_data_signature(
            db, analysis, analysis.spec["saved_plots"][0]
        ))
        job = background_jobs.list_jobs()[0]
        self.assertEqual(job["completed"], 1)
        self.assertEqual(job["counters"]["skipped"], 1)

    def test_foreground_plot_retires_matching_idle_work(self):
        db = self.make_session()
        analysis = Analysis(
            title="Foreground",
            spec={
                "selection": {"entries": []},
                "saved_plots": [{"id": "plot", "name": "Plot"}],
            },
        )
        db.add(analysis)
        db.commit()
        coordinator = cache_maintenance.WarmupCoordinator()
        started = coordinator.start(db)

        self.assertEqual(coordinator.foreground_ready(analysis.id, "plot"), 1)
        self.assertIsNone(coordinator.next_task(db))
        job = background_jobs.get_job(started["id"])
        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["counters"]["skipped"], 1)

    def _seed_cell_with_source(self, db, *, source_hash: str = "e" * 64):
        cell = Cell(name="Keyed cell")
        source = SourceFile(
            hash=source_hash,
            path="C:/data/keyed.ndax",
            filename="keyed.ndax",
            size=1,
            ext="ndax",
            parse_status="parsed",
            location_status="online",
        )
        db.add_all([cell, source])
        db.flush()
        test = Test(cell_id=cell.id, name="Keyed cell")
        db.add(test)
        db.flush()
        db.add(TestFile(test_id=test.id, file_id=source.id, position=0))
        analysis = Analysis(
            title="Keyed analysis",
            spec={
                "selection": {"entries": [{"kind": "cell", "ref_id": cell.id}]},
                "saved_plots": [{"id": "plot", "name": "Plot"}],
            },
        )
        db.add(analysis)
        db.commit()
        return cell, source, analysis

    def test_result_key_ignores_location_status_flips(self):
        db = self.make_session()
        _cell, source, analysis = self._seed_cell_with_source(db)
        plot = analysis.spec["saved_plots"][0]
        online = cache_maintenance.analysis_cache.saved_plot_data_signature(db, analysis, plot)

        source.location_status = "offline"
        db.commit()
        offline = cache_maintenance.analysis_cache.saved_plot_data_signature(db, analysis, plot)
        source.location_status = "changed"
        db.commit()
        changed_status = cache_maintenance.analysis_cache.saved_plot_data_signature(db, analysis, plot)

        self.assertEqual(online, offline)
        self.assertEqual(online, changed_status)

        source.hash = "f" * 64
        db.commit()
        new_bytes = cache_maintenance.analysis_cache.saved_plot_data_signature(db, analysis, plot)
        self.assertNotEqual(online, new_bytes)

    def test_cached_result_gets_fresh_availability_badges(self):
        from app.services import analysis_engine

        db = self.make_session()
        cell, source, analysis = self._seed_cell_with_source(db)
        result = {
            "badges": [
                {"kind": "source_changed", "cell_id": cell.id, "cell_name": cell.name,
                 "file": "stale.ndax", "detail": "stale"},
                {"kind": "cell_archived", "cell_id": cell.id, "cell_name": cell.name,
                 "detail": "kept"},
            ]
        }

        source.location_status = "offline"
        db.commit()
        analysis_engine.refresh_availability_badges(db, analysis.spec, result)

        kinds = [badge["kind"] for badge in result["badges"]]
        self.assertIn("cell_archived", kinds)
        self.assertIn("source_offline", kinds)
        self.assertNotIn("source_changed", kinds)

        source.location_status = "online"
        db.commit()
        analysis_engine.refresh_availability_badges(db, analysis.spec, result)
        kinds = [badge["kind"] for badge in result["badges"]]
        self.assertEqual(kinds, ["cell_archived"])

    def test_cell_property_edit_invalidates_dependent_visuals(self):
        from app.routers import library as library_router

        db = self.make_session()
        cell, _source, _analysis = self._seed_cell_with_source(db)

        with patch.object(
            cache_maintenance,
            "invalidate_cell_dependents",
            return_value={"cell_id": cell.id, "analysis_ids": [], "queued_plots": 0},
        ) as invalidate:
            library_router.update_cell(
                cell.id,
                library_router.CellUpdate(active_mass_mg_override=12.5),
                db,
            )
        invalidate.assert_called_once()
        self.assertEqual(invalidate.call_args.kwargs.get("reason"), "cell_edit")

        with patch.object(cache_maintenance, "invalidate_cell_dependents") as invalidate:
            library_router.update_cell(
                cell.id,
                library_router.CellUpdate(description="Notes only"),
                db,
            )
        invalidate.assert_not_called()

    def test_invalidation_activity_names_affected_analyses(self):
        db = self.make_session()
        cell, _source, analysis = self._seed_cell_with_source(db)

        with (
            patch.object(cache_maintenance.analysis_cache, "delete_analysis_artifacts"),
            patch.object(
                cache_maintenance.warmup,
                "enqueue_analyses",
                return_value={"analyses": 1, "plots": 1},
            ),
            patch.object(cache_maintenance, "record_activity") as record,
        ):
            cache_maintenance.invalidate_cell_dependents(db, cell.id, reason="cell_edit")

        message = record.call_args.kwargs["message"]
        self.assertIn(analysis.title, message)
        self.assertIn("Cell property change", message)
        self.assertEqual(
            record.call_args.kwargs["details"]["analysis_titles"], [analysis.title]
        )

    def test_warmup_start_skips_full_rescan_when_analyses_unchanged(self):
        from datetime import datetime, timezone

        db = self.make_session()
        _cell, _source, analysis = self._seed_cell_with_source(db)
        analysis.modified_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
        db.commit()
        coordinator = cache_maintenance.WarmupCoordinator()
        calls = {"count": 0}
        real_signature = cache_maintenance.analysis_cache.saved_plot_data_signature

        def counting_signature(*args, **kwargs):
            calls["count"] += 1
            return real_signature(*args, **kwargs)

        with patch.object(
            cache_maintenance.analysis_cache,
            "saved_plot_data_signature",
            side_effect=counting_signature,
        ):
            started = coordinator.start(db)
            task = coordinator.next_task(db)
            cache_maintenance.analysis_cache.store_thumbnail(
                analysis.id,
                task["plot_id"],
                "probe-short-circuit-test",
                self._THUMBNAIL,
                self._THUMBNAIL,
                task["expected_data_signature"],
            )
            coordinator.complete(task["id"], status="ready", detail=None, error=None, db=db)
            after_first = calls["count"]
            self.assertGreater(after_first, 0)

            # Unchanged analyses: the probe short-circuits before any
            # per-plot fingerprinting.
            second = coordinator.start(db)
            self.assertEqual(calls["count"], after_first)
            self.assertEqual(second["id"], started["id"])

            # An analysis autosave that does not touch saved plots rescans
            # once but must not spawn a new job over all plots.
            analysis.modified_at = datetime(2026, 1, 2, tzinfo=timezone.utc)
            db.commit()
            third = coordinator.start(db)
            self.assertGreater(calls["count"], after_first)
            self.assertEqual(third["id"], started["id"])

            # A saved-plot edit produces a new fingerprint and a new job.
            spec = dict(analysis.spec)
            spec["saved_plots"] = [
                {"id": "plot", "name": "Plot", "modified_at": "2026-01-03T00:00:00Z"}
            ]
            analysis.spec = spec
            analysis.modified_at = datetime(2026, 1, 3, tzinfo=timezone.utc)
            db.commit()
            fourth = coordinator.start(db)
            self.assertNotEqual(fourth["id"], started["id"])

    def test_forced_warmup_rescans_after_prepared_markers_are_cleared(self):
        db = self.make_session()
        analysis = Analysis(
            title="Force refresh",
            spec={
                "selection": {"entries": []},
                "saved_plots": [{"id": "plot", "name": "Plot"}],
            },
        )
        db.add(analysis)
        db.commit()
        coordinator = cache_maintenance.WarmupCoordinator()
        first = coordinator.start(db)
        task = coordinator.next_task(db)
        cache_maintenance.analysis_cache.store_thumbnail(
            analysis.id,
            "plot",
            "force-refresh-test",
            self._THUMBNAIL,
            self._THUMBNAIL,
            task["expected_data_signature"],
        )
        coordinator.complete(task["id"], status="ready", detail="Ready", error=None, db=db)
        self.assertEqual(coordinator.start(db)["id"], first["id"])

        cache_maintenance.analysis_cache.clear_prepared_markers(analysis.id)
        forced = coordinator.start(db, force=True)

        self.assertNotEqual(forced["id"], first["id"])
        self.assertEqual(forced["total"], 1)

    def test_analysis_budget_uses_running_total_and_survives_bulk_delete(self):
        from app.services import analysis_cache

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            overrides = {
                "_ROOT": root,
                "_RESULTS": root / "results",
                "_ARTIFACTS": root / "artifacts",
                "_THUMBNAILS": root / "thumbnails",
                "_THUMBNAIL_INDEXES": root / "thumbnail-index",
            }
            with (
                patch.multiple(analysis_cache, **overrides),
                patch.object(analysis_cache, "ANALYSIS_CACHE_LIMIT_BYTES", 10_000),
                patch.object(analysis_cache, "_budget_total", None),
            ):
                for index in range(6):
                    # os.urandom hex resists gzip, so file sizes stay ~2 KB
                    # and the 10 KB budget genuinely overflows.
                    analysis_cache.store_result(
                        "cycles", f"{index:064d}", {"payload": os.urandom(2048).hex()}
                    )
                files = analysis_cache._budget_files()
                total = sum(path.stat().st_size for path in files)
                self.assertLessEqual(total, 10_000)
                self.assertLess(len(files), 6)

                # Thumbnails never count toward, nor are evicted by, the budget.
                analysis_cache.store_thumbnail(
                    5,
                    "plot",
                    "sig",
                    "data:image/png;base64," + "A" * 8192,
                    "data:image/webp;base64,UklGRg==",
                )
                self.assertTrue(
                    analysis_cache.load_thumbnail(5, "plot", "sig")
                )

                # Bulk deletion resets the tracker; later stores still prune.
                analysis_cache.delete_analysis_artifacts(5)
                for index in range(6, 12):
                    analysis_cache.store_result(
                        "cycles", f"{index:064d}", {"payload": os.urandom(2048).hex()}
                    )
                files = analysis_cache._budget_files()
                self.assertLessEqual(sum(path.stat().st_size for path in files), 10_000)

    def test_warmup_queues_only_unprepared_plots(self):
        db = self.make_session()
        analysis = Analysis(
            title="Partially prepared",
            spec={
                "selection": {"entries": []},
                "saved_plots": [
                    {"id": "old", "name": "Old plot"},
                    {"id": "new", "name": "New plot"},
                ],
            },
        )
        db.add(analysis)
        db.commit()
        old_signature = cache_maintenance.analysis_cache.saved_plot_data_signature(
            db, analysis, analysis.spec["saved_plots"][0]
        )
        cache_maintenance.analysis_cache.store_prepared_marker(
            analysis.id, "old", old_signature, None
        )
        cache_maintenance.analysis_cache.store_thumbnail(
            analysis.id,
            "old",
            "prepared-test",
            self._THUMBNAIL,
            self._THUMBNAIL,
            old_signature,
        )

        coordinator = cache_maintenance.WarmupCoordinator()
        started = coordinator.start(db)

        self.assertEqual(started["total"], 1)
        task = coordinator.next_task(db)
        self.assertEqual(task["plot_id"], "new")
        self.assertIn(analysis.title, started["items"][0]["label"])

    def test_warmup_requeues_plot_after_thumbnail_renderer_upgrade(self):
        db = self.make_session()
        analysis = Analysis(
            title="Old thumbnail",
            spec={
                "selection": {"entries": []},
                "saved_plots": [{"id": "old", "name": "Old plot"}],
            },
        )
        db.add(analysis)
        db.commit()
        plot = analysis.spec["saved_plots"][0]
        signature = cache_maintenance.analysis_cache.saved_plot_data_signature(
            db, analysis, plot
        )
        cache_maintenance.analysis_cache.store_prepared_marker(
            analysis.id, "old", signature, None
        )
        cache_maintenance.analysis_cache.store_thumbnail(
            analysis.id,
            "old",
            "upgrade-test",
            self._THUMBNAIL,
            self._THUMBNAIL,
            signature,
        )
        marker_path = cache_maintenance.analysis_cache._prepared_marker_path(
            analysis.id, "old"
        )
        marker = json.loads(marker_path.read_text())
        marker["thumbnail_cache_version"] -= 1
        marker_path.write_text(json.dumps(marker))

        coordinator = cache_maintenance.WarmupCoordinator()
        started = coordinator.start(db)

        self.assertEqual(started["total"], 1)
        self.assertEqual(coordinator.next_task(db)["plot_id"], "old")

    def test_completed_probe_is_invalidated_by_thumbnail_renderer_upgrade(self):
        db = self.make_session()
        analysis = Analysis(
            title="Prepared before upgrade",
            spec={
                "selection": {"entries": []},
                "saved_plots": [{"id": "plot", "name": "Prepared plot"}],
            },
        )
        db.add(analysis)
        db.commit()
        plot = analysis.spec["saved_plots"][0]
        signature = cache_maintenance.analysis_cache.saved_plot_data_signature(
            db, analysis, plot
        )
        cache_maintenance.analysis_cache.store_prepared_marker(
            analysis.id, "plot", signature, None
        )
        cache_maintenance.analysis_cache.store_thumbnail(
            analysis.id,
            "plot",
            "probe-test",
            self._THUMBNAIL,
            self._THUMBNAIL,
            signature,
        )

        coordinator = cache_maintenance.WarmupCoordinator()
        ready = coordinator.start(db)
        self.assertEqual(ready["total"], 0)

        old_version = cache_maintenance.analysis_cache.THUMBNAIL_CACHE_VERSION
        with patch.object(
            cache_maintenance.analysis_cache,
            "THUMBNAIL_CACHE_VERSION",
            old_version + 1,
        ):
            upgraded = coordinator.start(db)
            task = coordinator.next_task(db)

        self.assertNotEqual(upgraded["id"], ready["id"])
        self.assertEqual(upgraded["total"], 1)
        self.assertEqual(task["plot_id"], "plot")

    def test_ready_completion_writes_prepared_marker_and_empties_next_queue(self):
        db = self.make_session()
        analysis = Analysis(
            title="One plot",
            spec={
                "selection": {"entries": []},
                "saved_plots": [{"id": "solo", "name": "Solo"}],
            },
        )
        db.add(analysis)
        db.commit()
        coordinator = cache_maintenance.WarmupCoordinator()
        started = coordinator.start(db)
        task = coordinator.next_task(db)
        cache_maintenance.analysis_cache.store_thumbnail(
            analysis.id,
            "solo",
            "completion-test",
            self._THUMBNAIL,
            self._THUMBNAIL,
            task["expected_data_signature"],
        )
        coordinator.complete(task["id"], status="ready", detail="Already cached", error=None, db=db)

        marker = cache_maintenance.analysis_cache.load_prepared_marker(analysis.id, "solo")
        self.assertIsNotNone(marker)
        self.assertEqual(marker["data_signature"], task["expected_data_signature"])
        self.assertEqual(
            marker["thumbnail_cache_version"],
            cache_maintenance.analysis_cache.THUMBNAIL_CACHE_VERSION,
        )

        # A later scan with unchanged data finds nothing to queue and does
        # not spawn a fresh job.
        from datetime import datetime, timezone

        analysis.modified_at = datetime(2026, 2, 1, tzinfo=timezone.utc)
        db.commit()
        again = coordinator.start(db)
        self.assertEqual(again["id"], started["id"])

    def test_prepared_marker_without_thumbnail_pair_requeues_plot(self):
        db = self.make_session()
        analysis = Analysis(
            title="Incomplete preview",
            spec={
                "selection": {"entries": []},
                "saved_plots": [{"id": "plot", "name": "Plot"}],
            },
        )
        db.add(analysis)
        db.commit()
        plot = analysis.spec["saved_plots"][0]
        signature = cache_maintenance.analysis_cache.saved_plot_data_signature(db, analysis, plot)
        cache_maintenance.analysis_cache.store_prepared_marker(
            analysis.id, "plot", signature, None
        )

        coordinator = cache_maintenance.WarmupCoordinator()
        with patch.object(
            cache_maintenance.analysis_cache,
            "load_latest_thumbnail",
            return_value=None,
        ):
            started = coordinator.start(db)

        self.assertEqual(started["total"], 1)
        self.assertEqual(coordinator.next_task(db)["plot_id"], "plot")

    def test_ready_completion_without_thumbnail_pair_is_rejected(self):
        db = self.make_session()
        analysis = Analysis(
            title="Incomplete completion",
            spec={
                "selection": {"entries": []},
                "saved_plots": [{"id": "plot", "name": "Plot"}],
            },
        )
        db.add(analysis)
        db.commit()

        coordinator = cache_maintenance.WarmupCoordinator()
        started = coordinator.start(db)
        task = coordinator.next_task(db)
        with patch.object(
            cache_maintenance.analysis_cache,
            "load_latest_thumbnail",
            return_value=None,
        ):
            coordinator.complete(
                task["id"], status="ready", detail="Reported ready", error=None, db=db
            )

        self.assertIsNone(
            cache_maintenance.analysis_cache.load_prepared_marker(
                analysis.id, "plot"
            )
        )
        job = background_jobs.get_job(started["id"])
        self.assertEqual(job["items"][0]["status"], "failed")

        retried = coordinator.start(db)
        self.assertNotEqual(retried["id"], started["id"])
        self.assertEqual(retried["total"], 1)
        self.assertEqual(coordinator.next_task(db)["plot_id"], "plot")

    def test_invalidation_clears_markers_so_plots_requeue(self):
        db = self.make_session()
        cell, _source, analysis = self._seed_cell_with_source(db)
        plot = analysis.spec["saved_plots"][0]
        signature = cache_maintenance.analysis_cache.saved_plot_data_signature(db, analysis, plot)
        cache_maintenance.analysis_cache.store_prepared_marker(
            analysis.id, plot["id"], signature, None
        )

        with patch.object(
            cache_maintenance.warmup,
            "enqueue_analyses",
            return_value={"analyses": 1, "plots": 1},
        ):
            cache_maintenance.invalidate_cell_dependents(db, cell.id)

        self.assertIsNone(
            cache_maintenance.analysis_cache.load_prepared_marker(analysis.id, plot["id"])
        )

    def test_artifact_write_rejects_superseded_scientific_signature(self):
        db = self.make_session()
        analysis = Analysis(
            title="Protected artifact",
            spec={
                "selection": {"entries": []},
                "saved_plots": [{"id": "plot", "name": "Plot"}],
            },
        )
        db.add(analysis)
        db.commit()
        request = analyses_router.PlotArtifactRequest(
            signature="client-signature",
            svg='<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            figure={"data": [], "layout": {}},
            expected_data_signature="superseded",
        )

        with self.assertRaises(HTTPException) as raised:
            analyses_router.store_plot_artifact(analysis.id, "plot", request, db)

        self.assertEqual(raised.exception.status_code, 409)

    def test_artifact_write_uses_the_validated_signature_without_recomputing(self):
        db = self.make_session()
        analysis = Analysis(
            title="Validated artifact",
            spec={
                "selection": {"entries": []},
                "saved_plots": [{"id": "plot", "name": "Plot", "tab": "time_capacity"}],
            },
        )
        db.add(analysis)
        db.commit()
        request = analyses_router.PlotArtifactRequest(
            signature="client-signature",
            svg='<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            figure={"data": [], "layout": {}},
            expected_data_signature="validated-source",
        )

        with (
            patch.object(
                analyses_router.analysis_cache,
                "saved_plot_data_signature",
                return_value="validated-source",
            ) as signature,
            patch.object(analyses_router.analysis_cache, "store_artifact") as store,
            patch.object(cache_maintenance.warmup, "foreground_ready"),
        ):
            response = analyses_router.store_plot_artifact(
                analysis.id, "plot", request, db
            )

        self.assertEqual(signature.call_count, 1)
        self.assertEqual(response["data_signature"], "validated-source")
        store.assert_called_once()
        self.assertEqual(store.call_args.args[2], "client-signature:validated-source")
        self.assertEqual(store.call_args.kwargs["data_signature"], "validated-source")

    def test_saved_plot_signatures_use_each_plot_family_result_kind(self):
        db = self.make_session()
        analysis = Analysis(
            title="Family identities",
            spec={"selection": {"entries": []}},
            provenance=None,
        )
        db.add(analysis)
        db.commit()

        expected = {
            "cycles": "cycles",
            "time_capacity": "time_capacity",
            "steps": "steps",
            "dcir": "dcir",
            "chargeability": "chargeability",
            "crate": "rate_capability",
        }
        for tab, kind in expected.items():
            with self.subTest(tab=tab):
                plot = {"id": f"{tab}-plot", "tab": tab}
                with patch.object(
                    cache_maintenance.analysis_cache,
                    "result_key",
                    return_value=f"{kind}-signature",
                ) as result_key:
                    signature = cache_maintenance.analysis_cache.saved_plot_data_signature(
                        db, analysis, plot
                    )
                self.assertEqual(signature, f"{kind}-signature")
                self.assertEqual(result_key.call_args.args[1], kind)

    def test_skipped_unavailable_warmup_is_durable_for_current_identity(self):
        db = self.make_session()
        analysis = Analysis(
            title="Unavailable auxiliary plot",
            spec={
                "selection": {"entries": []},
                "saved_plots": [{"id": "plot", "tab": "time_capacity", "name": "Plot"}],
            },
        )
        db.add(analysis)
        db.commit()
        coordinator = cache_maintenance.WarmupCoordinator()
        coordinator.start(db)
        task = coordinator.next_task(db)
        result = coordinator.complete(
            task["id"],
            status="skipped",
            detail="Working potential is unavailable",
            error=None,
            db=db,
        )

        self.assertTrue(result["ok"])
        marker = cache_maintenance.analysis_cache.load_prepared_marker(analysis.id, "plot")
        self.assertEqual(marker["disposition"], "unavailable")
        self.assertEqual(coordinator._tasks_for_analyses(db, [analysis]), [])

    def test_invalidation_supports_continuation_reason_labels(self):
        db = self.make_session()
        cell, _source, analysis = self._seed_cell_with_source(db)
        with patch.object(
            cache_maintenance.warmup,
            "enqueue_analyses",
            return_value={"analyses": 1, "plots": 1},
        ):
            cache_maintenance.invalidate_cell_dependents(
                db,
                cell.id,
                reason="continuation_attached",
                queue_warmup=False,
            )
        event = db.query(ActivityEvent).order_by(ActivityEvent.id.desc()).first()
        self.assertEqual(event.details["reason"], "continuation_attached")


if __name__ == "__main__":
    unittest.main()
