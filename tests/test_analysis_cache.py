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
        analysis_cache.store_artifact(7, "plot-one", "signature-a", svg)

        self.assertEqual(analysis_cache.load_artifact(7, "plot-one", "signature-a"), svg)
        self.assertIsNone(analysis_cache.load_artifact(7, "plot-one", "signature-b"))

        analysis_cache.delete_analysis_artifacts(7)
        self.assertIsNone(analysis_cache.load_artifact(7, "plot-one", "signature-a"))


if __name__ == "__main__":
    unittest.main()
