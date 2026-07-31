from __future__ import annotations

import json
import importlib
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))
CORPUS = ROOT / "tests" / "fixtures" / "multi_source_continuation_corpus.json"

from app.services import stitch


class MultiSourceRegressionTests(unittest.TestCase):
    def test_committed_corpus_names_every_locked_closure_case(self):
        corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
        ids = {case["id"] for case in corpus["cases"]}
        self.assertEqual(len(ids), 17)
        self.assertIn("portable_exact_order", ids)
        self.assertIn("portable_one_internal_test", ids)
        self.assertIn("second_test_creation", ids)

    def test_every_corpus_case_points_to_named_executable_assertions(self):
        corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
        self.assertEqual(len(corpus["cases"]), 17)
        for case in corpus["cases"]:
            with self.subTest(case=case["id"]):
                references = case.get("tests")
                self.assertTrue(references, "each closure case needs executable evidence")
                for reference in references:
                    module_name, class_name, method_name = reference.rsplit(".", 2)
                    test_class = getattr(importlib.import_module(module_name), class_name)
                    self.assertTrue(callable(getattr(test_class, method_name)), reference)

    def test_source_order_is_authoritative_when_user_order_is_reversed(self):
        first = "a" * 64
        second = "b" * 64
        frame = lambda: pd.DataFrame(
            {"cycle": [1, 2], "discharge_capacity_mah": [1.0, 0.9]}
        )
        with patch(
            "app.services.stitch.cache.load_cycles",
            side_effect=lambda source_hash, _parser, _calc: {
                first: frame(),
                second: frame(),
            }[source_hash],
        ):
            ordered, _segments, missing = stitch.stitch_cycles(
                [first, second], "parser", "calc"
            )
            reversed_result, _reversed_segments, reversed_missing = stitch.stitch_cycles(
                [second, first], "parser", "calc"
            )
        self.assertEqual(missing, [])
        self.assertEqual(reversed_missing, [])
        self.assertEqual(ordered["source_hash"].tolist(), [first, first, second, second])
        self.assertEqual(
            reversed_result["source_hash"].tolist(),
            [second, second, first, first],
        )


if __name__ == "__main__":
    unittest.main()
