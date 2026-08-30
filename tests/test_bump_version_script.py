import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "bump_version.py"


def load_bump_version():
    spec = importlib.util.spec_from_file_location("bump_version", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


bump_version = load_bump_version()


def write_min_repo(root: Path, version: str) -> None:
    (root / "backend" / "app").mkdir(parents=True, exist_ok=True)
    (root / "frontend").mkdir(parents=True, exist_ok=True)
    (root / "src-tauri").mkdir(parents=True, exist_ok=True)
    (root / "backend" / "app" / "config.py").write_text(
        f'APP_VERSION = "{version}"\n',
        encoding="utf-8",
    )
    for name, pkg in (
        ("package.json", "cellxplorer-desktop"),
        ("frontend/package.json", "cellxplorer-frontend"),
    ):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"name": pkg, "version": version}) + "\n", encoding="utf-8")
    for name, pkg in (
        ("package-lock.json", "cellxplorer-desktop"),
        ("frontend/package-lock.json", "cellxplorer-frontend"),
    ):
        path = root / name
        path.write_text(
            json.dumps(
                {
                    "name": pkg,
                    "version": version,
                    "packages": {"": {"name": pkg, "version": version}},
                }
            )
            + "\n",
            encoding="utf-8",
        )
    (root / "src-tauri" / "tauri.conf.json").write_text(
        json.dumps({"version": version}) + "\n",
        encoding="utf-8",
    )
    (root / "src-tauri" / "Cargo.toml").write_text(
        f'[package]\nname = "cellxplorer"\nversion = "{version}"\n',
        encoding="utf-8",
    )
    (root / "src-tauri" / "Cargo.lock").write_text(
        f'[[package]]\nname = "cellxplorer"\nversion = "{version}"\n',
        encoding="utf-8",
    )
    (root / "CHANGELOG.md").write_text(
        "# Changelog\n\n## 0.1.0 - 2026-01-01\n\n- Baseline.\n",
        encoding="utf-8",
    )


class BumpVersionScriptTests(unittest.TestCase):
    def test_patch_bump_updates_every_declaration_and_changelog(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_min_repo(root, "0.1.0")
            code = bump_version.main(
                [
                    "--patch",
                    "--notes",
                    "First bullet.",
                    "--notes",
                    "Second bullet.",
                    "--repo-root",
                    str(root),
                ]
            )
            self.assertEqual(code, 0)

            sources = bump_version.collect_version_sources(root)
            self.assertTrue(all(source.version == "0.1.1" for source in sources))

            changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
            self.assertIn("## 0.1.1 -", changelog)
            self.assertIn("- First bullet.", changelog)
            self.assertIn("- Second bullet.", changelog)
            self.assertLess(changelog.index("## 0.1.1 -"), changelog.index("## 0.1.0 -"))

    def test_explicit_version_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_min_repo(root, "1.2.3")
            code = bump_version.main(
                [
                    "1.2.4",
                    "--notes",
                    "Explicit target.",
                    "--repo-root",
                    str(root),
                ]
            )
            self.assertEqual(code, 0)
            self.assertEqual(
                json.loads((root / "package.json").read_text(encoding="utf-8"))["version"],
                "1.2.4",
            )

    def test_explicit_beta_version_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_min_repo(root, "0.16.1")
            code = bump_version.main(
                [
                    "0.16.2-beta.1",
                    "--notes",
                    "Beta probe release.",
                    "--repo-root",
                    str(root),
                ]
            )
            self.assertEqual(code, 0)
            sources = bump_version.collect_version_sources(root)
            self.assertTrue(all(source.version == "0.16.2-beta.1" for source in sources))
            changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
            self.assertIn("## 0.16.2-beta.1 -", changelog)

    def test_explicit_alpha_version_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_min_repo(root, "0.27.0-beta.12")
            code = bump_version.main(
                [
                    "0.27.0-alpha.1",
                    "--notes",
                    "Alpha release probe.",
                    "--repo-root",
                    str(root),
                ]
            )
            self.assertEqual(code, 0)
            sources = bump_version.collect_version_sources(root)
            self.assertTrue(all(source.version == "0.27.0-alpha.1" for source in sources))
            changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
            self.assertIn("## 0.27.0-alpha.1 -", changelog)

    def test_rejects_duplicate_changelog_section(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_min_repo(root, "0.1.0")
            self.assertEqual(
                bump_version.main(
                    ["0.1.1", "--notes", "Once.", "--repo-root", str(root)]
                ),
                0,
            )
            self.assertNotEqual(
                bump_version.main(
                    ["0.1.1", "--notes", "Duplicate.", "--repo-root", str(root)]
                ),
                0,
            )

    def test_sectioned_changelog_omits_empty_sections(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_min_repo(root, "0.1.0")
            code = bump_version.main(
                [
                    "0.1.1",
                    "--bugfix",
                    "Fix tab switching.",
                    "--repo-root",
                    str(root),
                ]
            )
            self.assertEqual(code, 0)
            changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
            self.assertIn("### Bug fixes", changelog)
            self.assertIn("- Fix tab switching.", changelog)
            self.assertNotIn("### New features", changelog)

    def test_notes_file_supports_section_headings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_min_repo(root, "0.1.0")
            notes_file = root / "notes.txt"
            notes_file.write_text(
                "New features\nFirst feature.\n\nBug fixes\nFirst fix.\n",
                encoding="utf-8",
            )
            code = bump_version.main(
                [
                    "0.1.1",
                    "--notes-file",
                    str(notes_file),
                    "--repo-root",
                    str(root),
                ]
            )
            self.assertEqual(code, 0)
            changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
            self.assertLess(changelog.index("### New features"), changelog.index("### Bug fixes"))
            self.assertIn("- First feature.", changelog)
            self.assertIn("- First fix.", changelog)


if __name__ == "__main__":
    unittest.main()
