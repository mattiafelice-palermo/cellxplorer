"""Guard the startup invariant from spec 031.

Importing `app.main` must not pull the science stack (pandas, numpy, pyarrow,
NewareNDA). Those cost ~1.9 s and block uvicorn from binding the port the desktop
shell polls; they are deferred to first actual use via `LazyModule`. A future
eager import in any router — the easy mistake — would silently reintroduce the
slow cold start, so this pins it.

Run in a subprocess: the rest of the suite imports pandas, so an in-process check
would always see it already loaded.
"""
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

_PROBE = """
import sys
sys.path.insert(0, r"{backend}")
from app import main  # noqa: F401
heavy = [m for m in ("pandas", "numpy", "pyarrow", "NewareNDA") if m in sys.modules]
print(",".join(heavy))
"""


class StartupImportIsLightTests(unittest.TestCase):
    def test_importing_app_main_does_not_load_the_science_stack(self):
        env = dict(os.environ)
        env["CELLXPLORER_DATA"] = str(ROOT / ".test-startup-import")
        result = subprocess.run(
            [sys.executable, "-c", _PROBE.format(backend=ROOT / "backend")],
            capture_output=True,
            text=True,
            env=env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        leaked = [name for name in result.stdout.strip().split(",") if name]
        self.assertEqual(
            leaked,
            [],
            f"importing app.main eagerly loaded {leaked}; a router or service imported one "
            "of them at module load. Wrap it in services.lazy_module.LazyModule (spec 031).",
        )


if __name__ == "__main__":
    unittest.main()
