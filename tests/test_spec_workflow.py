import argparse
import importlib.util
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "docs" / "specs" / "workflow" / "spec_workflow.py"


def load_spec_workflow():
    spec = importlib.util.spec_from_file_location("spec_workflow", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


workflow = load_spec_workflow()


class SpecWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.repo = Path(self.tempdir.name)
        (self.repo / "docs" / "specs").mkdir(parents=True)

    def tearDown(self):
        self.tempdir.cleanup()

    def write_state(
        self,
        *,
        turn="IMPLEMENTER",
        action="IMPLEMENT",
        active="050.1",
        children=None,
        pending=None,
        seq=0,
        include_message_fields=True,
    ):
        children = children or ["050.1", "050.2"]
        data = {
            "version": 1,
            "spec": "050",
            "branch": "feature/test",
            "active_child": active,
            "children": children,
            "turn": turn,
            "action": action,
            "findings": [],
            "resume_review": None,
            "updated_at": "2026-08-21T01:00:00+02:00",
        }
        if include_message_fields:
            data["user_message_seq"] = seq
            data["pending_user_messages"] = pending or []
        workflow.state_path(self.repo, "050").write_text(json.dumps(data), encoding="utf-8")
        workflow.coordination_path(self.repo, "050").write_text(
            "# coordination\n", encoding="utf-8"
        )
        return data

    def workflow_patches(self):
        return (
            patch.object(workflow, "root", return_value=self.repo),
            patch.object(workflow, "branch", return_value="feature/test"),
            patch.object(workflow, "git", return_value=""),
        )

    def test_numeric_child_discovery_excludes_proto_children(self):
        specs = self.repo / "docs" / "specs"
        (specs / "050.2-two.md").write_text("", encoding="utf-8")
        (specs / "050.1-one.md").write_text("", encoding="utf-8")
        (specs / "050.P1-future.md").write_text("", encoding="utf-8")
        self.assertEqual(workflow.discover_children(self.repo, "050"), ["050.1", "050.2"])
        self.assertEqual(workflow.discover_proto_children(self.repo, "050"), ["050.P1"])

    def test_version_one_state_without_message_fields_loads_with_empty_defaults(self):
        self.write_state(include_message_fields=False)
        data = workflow.load(workflow.state_path(self.repo, "050"))
        self.assertEqual(data["user_message_seq"], 0)
        self.assertEqual(data["pending_user_messages"], [])

    def test_user_message_records_id_timestamp_and_body_without_changing_turn(self):
        self.write_state()
        patches = self.workflow_patches()
        with (
            patches[0],
            patches[1],
            patches[2],
            patch.object(workflow, "now", return_value="2026-08-21T01:25:00+02:00"),
            redirect_stdout(StringIO()),
        ):
            workflow.cmd_user_message(
                argparse.Namespace(spec="050", message="Check opening speed.")
            )
        data = workflow.load(workflow.state_path(self.repo, "050"))
        self.assertEqual(data["turn"], "IMPLEMENTER")
        self.assertEqual(data["action"], "IMPLEMENT")
        self.assertEqual(
            data["pending_user_messages"],
            [{"id": "U1", "timestamp": "2026-08-21T01:25:00+02:00"}],
        )
        log = workflow.coordination_path(self.repo, "050").read_text(encoding="utf-8")
        self.assertIn("USER → REVIEWER", log)
        self.assertIn("User input U1", log)
        self.assertIn("Check opening speed.", log)

    def test_reviewer_transition_records_and_consumes_pending_user_messages(self):
        self.write_state(
            turn="REVIEWER",
            action="REVIEW",
            pending=[{"id": "U3", "timestamp": "2026-08-21T01:25:00+02:00"}],
            seq=3,
        )
        patches = self.workflow_patches()
        with (
            patches[0],
            patches[1],
            patches[2],
            patch.object(workflow, "now", return_value="2026-08-21T01:30:00+02:00"),
        ):
            workflow.cmd_request_fixes(
                argparse.Namespace(
                    spec="050",
                    findings=["R2"],
                    message="Apply the user clarification.",
                )
            )
        data = workflow.load(workflow.state_path(self.repo, "050"))
        self.assertEqual(data["pending_user_messages"], [])
        self.assertEqual(data["turn"], "IMPLEMENTER")
        self.assertEqual(data["findings"], ["R2"])
        log = workflow.coordination_path(self.repo, "050").read_text(encoding="utf-8")
        self.assertIn("**User messages considered**", log)
        self.assertIn("- U3", log)

    def test_add_child_schedules_authored_numeric_child_but_not_proto(self):
        specs = self.repo / "docs" / "specs"
        (specs / "050.3-promoted.md").write_text("# child", encoding="utf-8")
        (specs / "050.P1-future.md").write_text("# proto", encoding="utf-8")
        self.write_state(turn="REVIEWER", action="REVIEW", active="050.2")
        patches = self.workflow_patches()
        with (
            patches[0],
            patches[1],
            patches[2],
            patch.object(workflow, "now", return_value="2026-08-21T01:30:00+02:00"),
        ):
            workflow.cmd_add_child(
                argparse.Namespace(
                    spec="050", child="050.3", message="Promoted from 050.P1."
                )
            )
        data = workflow.load(workflow.state_path(self.repo, "050"))
        self.assertEqual(data["children"], ["050.1", "050.2", "050.3"])
        self.assertNotIn("050.P1", data["children"])

    def test_add_child_refuses_retroactive_number(self):
        specs = self.repo / "docs" / "specs"
        (specs / "050.1-late.md").write_text("# child", encoding="utf-8")
        self.write_state(
            turn="REVIEWER",
            action="REVIEW",
            active="050.2",
            children=["050.2"],
        )
        patches = self.workflow_patches()
        with patches[0], patches[1], patches[2]:
            with self.assertRaises(workflow.WorkflowError):
                workflow.cmd_add_child(
                    argparse.Namespace(spec="050", child="050.1", message="late")
                )


if __name__ == "__main__":
    unittest.main()
