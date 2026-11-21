"""Exercise the Cell 38 recordings through the browser request and preview route."""
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.db import Base
from app.routers import files
from app.services import cache
from app.services.filesystem_cleanup import TemporaryDirectory

CORPUS = ROOT / ".local-regression" / "parser-corpus" / "cell38-import"


@unittest.skipUnless(CORPUS.is_dir(), "Private Cell 38 regression recordings are unavailable")
class ContinuedImportRecordingsTests(unittest.TestCase):
    def test_combined_voltage_preview_from_real_staged_drafts(self):
        cases = json.loads((CORPUS / "manifest.json").read_text(encoding="utf-8"))["cases"]
        expected = json.loads((CORPUS / "import-preview-expected.json").read_text(encoding="utf-8"))
        recordings = expected["recordings"]
        order = [case["id"] for case in cases]
        self.assertEqual(order, ["step-02", "step-04", "step-06"])
        engine = create_engine("sqlite://")
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        with Session(engine) as db, TemporaryDirectory() as temp, patch.object(cache, "CACHE_DIR", Path(temp)):
            drafts = []
            for case in cases:
                path = CORPUS / case["file"]
                bounds = recordings[case["id"]]
                draft = files._inspect_import_path(path, db, staged_name=case["id"], read_mode=case["read_mode"])
                self.assertEqual(draft["hash"], case["sha256"])
                self.assertEqual(draft["first_measurement"][:19], bounds["first"])
                self.assertEqual(draft["last_measurement"][:19], bounds["last"])
                built = cache.build(case["sha256"], path, read_mode=case["read_mode"], prepare_time_capacity=False)
                self.assertEqual(built["rows"], bounds["rows"])
                drafts.append(draft)

            # Use the same request builder as the editor. A hand-built API request
            # would miss the regression where the browser discarded the read mode.
            script = """
                import fs from 'node:fs';
                import { continuationPreviewRequest } from './frontend/src/continuedImportPreviewPolicy.ts';
                import { continuedImportChannel } from './frontend/src/continuedImportWorkspacePolicy.ts';
                const drafts = JSON.parse(fs.readFileSync(0, 'utf8'));
                const order = drafts.map(d => d.staged_name);
                console.log(JSON.stringify([continuedImportChannel(drafts),
                    continuationPreviewRequest(drafts, order, 'voltage', 'stitched')]));
            """
            result = subprocess.run(
                ["node", "--input-type=module", "-e", script], cwd=ROOT, input=json.dumps(drafts),
                text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            channel, request = json.loads(result.stdout)
            self.assertEqual(channel, expected["channel"])
            inspection = files.inspect_continuation_sources(files.ContinuationInspectRequest(
                sources=request["sources"], proposed_order=request["proposed_order"],
            ), db)
            self.assertEqual(inspection["suggested_order"], request["proposed_order"])
            for source in inspection["sources"]:
                bounds = recordings[source["key"]]
                self.assertEqual(source["first_measurement"][:19], bounds["first"])
                self.assertEqual(source["last_measurement"][:19], bounds["last"])
            preview = files.preview_continuation_sources(files.ContinuationPreviewRequest(**request))
            self.assertEqual([segment["source_key"] for segment in preview["segments"]], order)
            for segment in preview["segments"]:
                self.assertEqual(len(segment["x"]), recordings[segment["source_key"]]["preview_points"])
                self.assertEqual(len(segment["x"]), len(segment["y"]))
                self.assertTrue(all(math.isfinite(value) for value in segment["x"] + segment["y"]))
