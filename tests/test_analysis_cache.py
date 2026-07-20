from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
os.environ["CELLXPLORER_DATA"] = str(ROOT / ".test-cellxplorer")
sys.path.insert(0, str(ROOT / "backend"))

from app.services import analysis_cache


class AnalysisCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.patchers = [
            patch.object(analysis_cache, "_ROOT", root),
            patch.object(analysis_cache, "_RESULTS", root / "results"),
            patch.object(analysis_cache, "_ARTIFACTS", root / "artifacts"),
            patch.object(analysis_cache, "_THUMBNAILS", root / "thumbnails"),
            patch.object(analysis_cache, "_THUMBNAIL_INDEXES", root / "thumbnail-index"),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temporary.cleanup()

    def test_result_cache_survives_memory_lifetimes(self):
        value = {"cell_traces": [{"x": [1, 2], "y": [3.25, 4.5]}]}
        analysis_cache.store_result("time_capacity", "a" * 64, value)

        loaded = analysis_cache.load_result("time_capacity", "a" * 64)

        self.assertEqual(loaded["cell_traces"], value["cell_traces"])
        self.assertEqual(loaded["cache_status"], "hit")

    def test_artifacts_are_signature_scoped_and_removable(self):
        svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'
        artifact = {
            "svg": svg,
            "thumbnail": "data:image/png;base64,iVBORw0KGgo=",
            "figure": {"data": [], "layout": {}, "config": {}},
            "summary": [{"label": "Cell A", "cycles": 3, "status": "Visible"}],
        }
        analysis_cache.store_artifact(
            7,
            "plot-one",
            "signature-a",
            artifact,
            client_signature="client-signature-a",
        )

        self.assertEqual(analysis_cache.load_artifact(7, "plot-one", "signature-a"), artifact)
        self.assertEqual(
            analysis_cache.load_thumbnail(7, "plot-one", "signature-a"),
            artifact["thumbnail"],
        )
        self.assertEqual(
            analysis_cache.load_indexed_thumbnail(7, "plot-one", "client-signature-a"),
            artifact["thumbnail"],
        )
        self.assertTrue(analysis_cache.has_indexed_thumbnails(7, "plot-one"))
        self.assertEqual(
            analysis_cache.load_latest_thumbnail(7, "plot-one"),
            artifact["thumbnail"],
        )
        self.assertIsNone(analysis_cache.load_artifact(7, "plot-one", "signature-b"))

        refreshed = {
            "svg": '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>',
            "thumbnail": None,
            "figure": {"data": [{"x": [1], "y": [2]}], "layout": {}, "config": {}},
            "summary": [{"label": "Cell A", "cycles": 4, "status": "Visible"}],
        }
        analysis_cache.store_artifact(7, "plot-one", "signature-a", refreshed)
        merged = analysis_cache.load_artifact(7, "plot-one", "signature-a")
        self.assertEqual(merged["thumbnail"], artifact["thumbnail"])
        self.assertEqual(merged["svg"], refreshed["svg"])

        analysis_cache.delete_analysis_artifacts(7)
        self.assertIsNone(analysis_cache.load_artifact(7, "plot-one", "signature-a"))
        self.assertIsNone(analysis_cache.load_thumbnail(7, "plot-one", "signature-a"))
        self.assertIsNone(
            analysis_cache.load_indexed_thumbnail(7, "plot-one", "client-signature-a")
        )
        self.assertFalse(analysis_cache.has_indexed_thumbnails(7, "plot-one"))

    def test_lru_pruning_preserves_saved_plot_thumbnails(self):
        analysis_cache.store_artifact(
            8,
            "plot-two",
            "signature-b",
            {
                "svg": '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
                "thumbnail": "data:image/png;base64,iVBORw0KGgo=",
                "figure": {"data": [{"x": list(range(100)), "y": list(range(100))}]},
                "summary": [],
            },
            client_signature="client-signature-b",
        )

        with analysis_cache._lock:
            analysis_cache._prune_locked(limit_bytes=1)

        self.assertIsNone(analysis_cache.load_artifact(8, "plot-two", "signature-b"))
        self.assertEqual(
            analysis_cache.load_indexed_thumbnail(8, "plot-two", "client-signature-b"),
            "data:image/png;base64,iVBORw0KGgo=",
        )


class ResultBodySplitTests(AnalysisCacheTests):
    """Results are stored as an immutable body plus a tiny badge sidecar.

    A cache hit is then served by splicing bytes rather than parsing megabytes
    of JSON, so the splice must reproduce the old payload exactly.
    """

    RESULT = {
        "calc_version": "1.0",
        "cell_series": [{"label": "c1", "x": [1, 2, 3]}],
        "badges": [
            {"kind": "newer_calc", "detail": "keep me"},
            {"kind": "source_offline", "detail": "rebuild me"},
        ],
    }

    def test_round_trip_matches_the_parsing_path(self):
        import json

        analysis_cache.store_result("cycles", "k1", self.RESULT)

        # Availability badges are never replayed; everything else survives.
        loaded = analysis_cache.load_result("cycles", "k1")
        self.assertEqual(loaded["badges"], [{"kind": "newer_calc", "detail": "keep me"}])
        self.assertEqual(loaded["cache_status"], "hit")
        self.assertEqual(loaded["cell_series"], self.RESULT["cell_series"])

        body, kept = analysis_cache.load_result_body("cycles", "k1")
        fresh = [{"kind": "source_offline", "detail": "fresh"}]
        spliced = json.loads(analysis_cache.splice_result_body(body, kept + fresh, "hit"))
        self.assertEqual(spliced, {**loaded, "badges": kept + fresh})

    def test_entries_without_a_sidecar_fall_back_and_then_upgrade(self):
        """Existing caches must keep working and then get the fast path."""
        analysis_cache.store_result("cycles", "k2", self.RESULT)
        analysis_cache._sidecar_path("cycles", "k2").unlink()

        # No sidecar -> no fast path, but the slow path still reads correctly.
        self.assertIsNone(analysis_cache.load_result_body("cycles", "k2"))
        recovered = analysis_cache.load_result("cycles", "k2")
        self.assertEqual(recovered["cell_series"], self.RESULT["cell_series"])

        analysis_cache.upgrade_result_format("cycles", "k2", recovered)
        self.assertIsNotNone(analysis_cache.load_result_body("cycles", "k2"))

    def test_pruning_a_body_removes_its_sidecar(self):
        analysis_cache.store_result("cycles", "k3", self.RESULT)
        sidecar = analysis_cache._sidecar_path("cycles", "k3")
        self.assertTrue(sidecar.is_file())

        with analysis_cache._lock:
            analysis_cache._prune_locked(limit_bytes=0)

        self.assertFalse(analysis_cache._result_path("cycles", "k3").is_file())
        self.assertFalse(sidecar.is_file(), "sidecar outlived the body it describes")


if __name__ == "__main__":
    unittest.main()
