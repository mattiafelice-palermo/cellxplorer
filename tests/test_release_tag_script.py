import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "release_tag.py"


def load_release_tag():
    spec = importlib.util.spec_from_file_location("release_tag_standalone", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


release_tag = load_release_tag()


class ReleaseTagScriptTests(unittest.TestCase):
    def test_accepts_exact_stable_and_beta_tags(self):
        self.assertTrue(release_tag.is_stable_release_tag("v0.17.0"))
        self.assertTrue(release_tag.is_beta_release_tag("v0.17.0-beta.1"))
        self.assertEqual(
            release_tag.require_publishable_release_tag("v0.17.0-beta.1"),
            "v0.17.0-beta.1",
        )

    def test_rejects_crossed_or_loose_semver(self):
        for value in (
            "0.17.0",
            "v0.17",
            "v0.17.0-rc.1",
            "v0.17.0-beta",
            "v0.17.0-beta.1+build.1",
        ):
            with self.subTest(value=value):
                with self.assertRaises(release_tag.ReleaseTagError):
                    release_tag.require_publishable_release_tag(value)


if __name__ == "__main__":
    unittest.main()
