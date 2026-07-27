import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RELEASE_NOTES_PATH = ROOT / "scripts" / "release_notes.py"


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


release_notes = load_module(RELEASE_NOTES_PATH, "release_notes")


SAMPLE_CHANGELOG = """# Changelog

## 0.15.0 - 2026-07-27

- Signed in-app updates through the power menu.
- Automated GitHub release publishing for Windows.

## 0.14.3 - 2026-07-26

- Older release notes.
"""


class ReleaseNotesScriptTests(unittest.TestCase):
    def test_extracts_exact_current_section(self):
        notes = release_notes.extract_release_notes(SAMPLE_CHANGELOG, "0.15.0")
        self.assertIn("Signed in-app updates", notes)
        self.assertNotIn("Older release notes", notes)

    def test_accepts_leading_v(self):
        notes = release_notes.extract_release_notes(SAMPLE_CHANGELOG, "v0.15.0")
        self.assertIn("Automated GitHub release publishing", notes)

    def test_stops_at_next_version_heading(self):
        notes = release_notes.extract_release_notes(SAMPLE_CHANGELOG, "0.14.3")
        self.assertIn("Older release notes", notes)
        self.assertNotIn("Signed in-app updates", notes)

    def test_missing_section_fails(self):
        with self.assertRaises(release_notes.ReleaseNotesError):
            release_notes.extract_release_notes(SAMPLE_CHANGELOG, "0.16.0")

    def test_duplicate_section_fails(self):
        duplicate = SAMPLE_CHANGELOG + "\n## 0.15.0 - 2026-07-28\n\n- Duplicate.\n"
        with self.assertRaises(release_notes.ReleaseNotesError):
            release_notes.extract_release_notes(duplicate, "0.15.0")

    def test_empty_section_fails(self):
        empty = "# Changelog\n\n## 0.15.0 - 2026-07-27\n\n\n## 0.14.3 - 2026-07-26\n\n- Old.\n"
        with self.assertRaises(release_notes.ReleaseNotesError):
            release_notes.extract_release_notes(empty, "0.15.0")

    def test_crlf_and_lf_are_stable(self):
        crlf = SAMPLE_CHANGELOG.replace("\n", "\r\n")
        self.assertEqual(
            release_notes.extract_release_notes(crlf, "0.15.0"),
            release_notes.extract_release_notes(SAMPLE_CHANGELOG, "0.15.0"),
        )

    def test_cli_writes_output_without_modifying_changelog(self):
        with tempfile.TemporaryDirectory() as tmp:
            changelog = Path(tmp) / "CHANGELOG.md"
            changelog.write_text(SAMPLE_CHANGELOG, encoding="utf-8")
            output = Path(tmp) / "notes.md"
            before = changelog.read_text(encoding="utf-8")
            code = release_notes.main(
                [
                    "--expected-version",
                    "v0.15.0",
                    "--changelog",
                    str(changelog),
                    "--output",
                    str(output),
                ]
            )
            self.assertEqual(code, 0)
            self.assertTrue(output.is_file())
            self.assertEqual(changelog.read_text(encoding="utf-8"), before)


if __name__ == "__main__":
    unittest.main()
