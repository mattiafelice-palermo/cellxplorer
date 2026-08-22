from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tests"))

from golden_analysis_support import GoldenFixtureEnvironment, load_case_spec
from app.services import analysis_detail, chargeability, rate_capability
from app.services import analysis_engine


def _without_volatile(value):
    if isinstance(value, dict):
        return {
            key: _without_volatile(item)
            for key, item in value.items()
            if key not in {"computed_at", "current_parser_version", "current_calc_version"}
        }
    if isinstance(value, list):
        return [_without_volatile(item) for item in value]
    return value


class IndexedFamilyParityTests(unittest.TestCase):
    CASES = (
        ("steps_baseline.json", "steps"),
        ("dcir_baseline.json", "dcir"),
        ("chargeability_baseline.json", "chargeability"),
        ("rate_capability_baseline.json", "rate_capability"),
    )

    def test_indexed_family_misses_match_forced_legacy_payloads(self) -> None:
        fixture_root = ROOT / "tests" / "fixtures" / "golden_analysis"
        with GoldenFixtureEnvironment.create() as env:
            for spec_name, kind in self.CASES:
                with self.subTest(kind=kind):
                    spec = load_case_spec(
                        fixture_root,
                        {"spec_path": f"specs/{spec_name}"},
                    )
                    if kind == "steps":
                        indexed = analysis_engine.compute_steps(env.db, spec, None)
                    elif kind == "dcir":
                        indexed = analysis_engine.compute_dcir(env.db, spec, None)
                    elif kind == "chargeability":
                        indexed = chargeability.compute(env.db, spec, None)
                    else:
                        indexed = rate_capability.compute(env.db, spec, None)

                    with (
                        patch.object(
                            analysis_detail,
                            "load_indexed_stitched_raw",
                            return_value=None,
                        ),
                        patch.object(
                            analysis_detail,
                            "load_indexed_source_raw",
                            return_value=None,
                        ),
                    ):
                        if kind == "steps":
                            legacy = analysis_engine.compute_steps(env.db, spec, None)
                        elif kind == "dcir":
                            legacy = analysis_engine.compute_dcir(env.db, spec, None)
                        elif kind == "chargeability":
                            legacy = chargeability.compute(env.db, spec, None)
                        else:
                            legacy = rate_capability.compute(env.db, spec, None)

                    self.assertEqual(
                        _without_volatile(indexed),
                        _without_volatile(legacy),
                    )


if __name__ == "__main__":
    unittest.main()
