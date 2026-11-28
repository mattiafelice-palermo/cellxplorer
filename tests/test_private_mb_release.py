"""Exercise the locally archived MB recording during release-workstation preflight."""
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
CORPUS = Path(os.environ.get("CELLXPLORER_PRIVATE_CORPUS", ROOT / ".local-regression" / "parser-corpus"))


@unittest.skipUnless(CORPUS.is_dir(), "Private MPR corpus is unavailable on this workstation")
class PrivateMbReleaseTests(unittest.TestCase):
    def test_final_charge_in_full_and_sampled_analysis(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "parser_regression_corpus.py"),
             "--root", str(CORPUS / "mb-final-charge"), "verify", "--release"],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
