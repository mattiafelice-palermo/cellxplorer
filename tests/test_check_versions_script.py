import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "check_versions.py"


def load_check_versions():
    spec = importlib.util.spec_from_file_location("check_versions", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


check_versions = load_check_versions()


def write_repo(root: Path, version: str, *, frontend_version: str | None = None) -> None:
    frontend_version = frontend_version if frontend_version is not None else version
    (root / "backend" / "app").mkdir(parents=True, exist_ok=True)
    (root / "frontend").mkdir(parents=True, exist_ok=True)
    (root / "src-tauri").mkdir(parents=True, exist_ok=True)

    (root / "backend" / "app" / "config.py").write_text(
        f'APP_VERSION = "{version}"\n',
        encoding="utf-8",
    )
    (root / "package.json").write_text(
        json.dumps({"name": "cellxplorer-desktop", "version": version}),
        encoding="utf-8",
    )
    (root / "package-lock.json").write_text(
        json.dumps(
            {
                "name": "cellxplorer-desktop",
                "version": version,
                "packages": {"": {"name": "cellxplorer-desktop", "version": version}},
            }
        ),
        encoding="utf-8",
    )
    (root / "frontend" / "package.json").write_text(
        json.dumps({"name": "cellxplorer-frontend", "version": frontend_version}),
        encoding="utf-8",
    )
    (root / "frontend" / "package-lock.json").write_text(
        json.dumps(
            {
                "name": "cellxplorer-frontend",
                "version": frontend_version,
                "packages": {"": {"name": "cellxplorer-frontend", "version": frontend_version}},
            }
        ),
        encoding="utf-8",
    )
    (root / "src-tauri" / "tauri.conf.json").write_text(
        json.dumps({"version": version}),
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


class CheckVersionsScriptTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.repo = Path(self.tempdir.name)

    def tearDown(self):
        self.tempdir.cleanup()

    def test_all_versions_match(self):
        write_repo(self.repo, "1.2.3")
        sources, errors = check_versions.check_versions(self.repo)
        self.assertEqual(errors, [])
        self.assertEqual({source.version for source in sources}, {"1.2.3"})

    def test_one_version_differs(self):
        write_repo(self.repo, "1.2.3", frontend_version="1.2.2")
        sources, errors = check_versions.check_versions(self.repo)
        self.assertTrue(errors)
        self.assertIn("1.2.3", {source.version for source in sources})
        self.assertIn("1.2.2", {source.version for source in sources})

    def test_missing_json_version(self):
        write_repo(self.repo, "1.2.3")
        path = self.repo / "frontend" / "package.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        del data["version"]
        path.write_text(json.dumps(data), encoding="utf-8")
        sources, errors = check_versions.check_versions(self.repo)
        self.assertEqual(sources, [])
        self.assertEqual(len(errors), 1)
        self.assertIn("version", errors[0])

    def test_malformed_json(self):
        write_repo(self.repo, "1.2.3")
        (self.repo / "package.json").write_text("{not-json", encoding="utf-8")
        sources, errors = check_versions.check_versions(self.repo)
        self.assertEqual(sources, [])
        self.assertIn("malformed JSON", errors[0])

    def test_malformed_toml(self):
        write_repo(self.repo, "1.2.3")
        (self.repo / "src-tauri" / "Cargo.toml").write_text("[package\n", encoding="utf-8")
        sources, errors = check_versions.check_versions(self.repo)
        self.assertEqual(sources, [])
        self.assertIn("malformed TOML", errors[0])

    def test_missing_app_version(self):
        write_repo(self.repo, "1.2.3")
        (self.repo / "backend" / "app" / "config.py").write_text(
            'VERSION = "1.2.3"\n',
            encoding="utf-8",
        )
        sources, errors = check_versions.check_versions(self.repo)
        self.assertEqual(sources, [])
        self.assertIn("APP_VERSION is missing", errors[0])

    def test_missing_cellxplorer_package_in_lock(self):
        write_repo(self.repo, "1.2.3")
        (self.repo / "src-tauri" / "Cargo.lock").write_text(
            '[[package]]\nname = "other"\nversion = "9.9.9"\n',
            encoding="utf-8",
        )
        sources, errors = check_versions.check_versions(self.repo)
        self.assertEqual(sources, [])
        self.assertIn("no package named", errors[0])
        self.assertIn("cellxplorer", errors[0])

    def test_matching_expected_version(self):
        write_repo(self.repo, "1.2.3")
        sources, errors = check_versions.check_versions(self.repo, "1.2.3")
        self.assertEqual(errors, [])
        self.assertTrue(sources)

    def test_expected_version_with_leading_v(self):
        write_repo(self.repo, "1.2.3")
        sources, errors = check_versions.check_versions(self.repo, "v1.2.3")
        self.assertEqual(errors, [])
        self.assertTrue(sources)

    def test_mismatching_expected_version(self):
        write_repo(self.repo, "1.2.3")
        sources, errors = check_versions.check_versions(self.repo, "1.2.4")
        self.assertTrue(errors)
        self.assertTrue(sources)
        self.assertIn("expected version 1.2.4", errors[0])

    def test_main_success_on_real_repository(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            code = check_versions.main(["--repo-root", str(ROOT)])
        self.assertEqual(code, 0)
        self.assertIn("PASS:", stdout.getvalue())

    def test_main_invalid_arguments(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = check_versions.main(["--not-a-flag"])
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
