"""The application module must import and complete its ASGI lifespan.

This exists because a shipped installer once contained a backend that could not
start at all: `app/main.py` called `app.add_event_handler(...)`, which recent
Starlette removed, so the packaged process aborted during import with

    AttributeError: 'FastAPI' object has no attribute 'add_event_handler'

CI stayed green because **no test imported `app.main`** — the whole suite
exercised routers and services directly. These tests close that gap.

They drive the lifespan through the raw ASGI protocol rather than
`fastapi.testclient.TestClient`, deliberately:

* `TestClient` requires `httpx`, which is not a runtime dependency. Declaring it
  in `backend/requirements.txt` would ship it inside the PyInstaller bundle for
  no reason, and a test-only requirements file would be one more thing that can
  drift from what CI installs — the very failure mode this file guards.
* The three ASGI messages below are exactly what uvicorn exchanges with the app
  on boot, so this reproduces the packaged start-up path more closely than an
  HTTP client would.
"""

import asyncio
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))


def drive_lifespan(app) -> list[dict]:
    """Run startup then shutdown, returning the messages the app sent back."""
    incoming = [{"type": "lifespan.startup"}, {"type": "lifespan.shutdown"}]
    sent: list[dict] = []

    async def receive() -> dict:
        return incoming.pop(0)

    async def send(message: dict) -> None:
        sent.append(message)

    async def run() -> None:
        await app(
            {"type": "lifespan", "asgi": {"version": "3.0", "spec_version": "2.0"}},
            receive,
            send,
        )

    asyncio.run(run())
    return sent


class AppStartupTests(unittest.TestCase):
    def test_main_module_imports(self):
        """Importing the app must not raise — the packaged entry point does this."""
        from app.main import app

        self.assertIsNotNone(app)

    def test_health_route_is_registered(self):
        from app.main import app

        paths = {getattr(route, "path", None) for route in app.routes}
        self.assertIn("/api/health", paths)

    def test_lifespan_starts_and_stops_cleanly(self):
        """Startup and shutdown must both complete, not fail."""
        from app.main import app, DATABASE_STATUS

        # If the database were incompatible the lifespan would skip the service
        # start/stop entirely and this test would prove nothing.
        self.assertTrue(
            DATABASE_STATUS.compatible,
            "test database is incompatible, so the lifespan body is skipped",
        )

        sent = drive_lifespan(app)
        types = [message["type"] for message in sent]
        self.assertEqual(
            types,
            ["lifespan.startup.complete", "lifespan.shutdown.complete"],
            f"lifespan did not complete cleanly: {sent}",
        )

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
