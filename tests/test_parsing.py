import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

import NewareNDA

from app.services import parsing


class NdaxHeaderParsingTests(unittest.TestCase):
    def test_direct_xml_flatten_matches_neware_metadata(self):
        paths = sorted(ROOT.glob("*.ndax"))
        paths.extend(sorted((ROOT / "tests" / "fixtures" / "golden_analysis" / "sources").glob("*.ndax")))
        if not paths:
            self.skipTest("no NDAX fixtures present")

        for path in paths:
            with self.subTest(file=path.name):
                expected = parsing._flatten(NewareNDA.read_metadata(str(path)))
                actual = parsing._read_ndax_metadata_flat(path)
                self.assertEqual(actual, expected)

    def test_header_result_uses_direct_flat_map_without_changing_fields(self):
        paths = sorted((ROOT / "tests" / "fixtures" / "golden_analysis" / "sources").glob("*.ndax"))
        if not paths:
            self.skipTest("no NDAX fixtures present")

        for path in paths:
            with self.subTest(file=path.name):
                expected_raw = parsing._flatten(NewareNDA.read_metadata(str(path)))
                result = parsing.read_header_metadata(path)
                self.assertEqual(result["raw"], expected_raw)


if __name__ == "__main__":
    unittest.main()
