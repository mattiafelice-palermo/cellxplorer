"""The application module must import and complete its lifespan.

This exists because a shipped installer once contained a backend that could not
start at all: `app/main.py` called `app.add_event_handler(...)`, which recent
Starlette removed, so the packaged process aborted during import with

    AttributeError: 'FastAPI' object has no attribute 'add_event_handler'

CI stayed green because **no test imported `app.main`** — the whole suite
exercised routers and services directly. These tests close that gap: they import
the real module and drive the lifespan, so any future use of an API that the
resolved dependency set does not provide fails here instead of in an installer.
"""

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from fastapi.testclient import TestClient  # noqa: E402


class AppStartupTests(unittest.TestCase):
    def test_main_module_imports(self):
        """Importing the app must not raise — the packaged entry point does this."""
        from app.main import app

        self.assertIsNotNone(app)

    def test_lifespan_runs_startup_and_shutdown(self):
        """`with TestClient(...)` drives the lifespan; a bare TestClient does not.

        The bare form is what the rest of the suite uses, and it is precisely why
        the startup path went unexercised. Keep the context-manager form here.
        """
        from app.main import app

        with TestClient(app) as client:
            response = client.get("/api/health")
            self.assertEqual(response.status_code, 200)

    def test_lifespan_is_used_rather_than_removed_event_api(self):
        """Guard the regression directly.

        `router.on_startup` / `on_shutdown` stay empty when lifespan owns the
        transitions; a non-empty list means someone re-introduced the deprecated
        registration path that broke the shipped build.
        """
        from app.main import app

        self.assertEqual(list(getattr(app.router, "on_startup", []) or []), [])
        self.assertEqual(list(getattr(app.router, "on_shutdown", []) or []), [])
        self.assertIsNotNone(app.router.lifespan_context)


if __name__ == "__main__":
    unittest.main()
