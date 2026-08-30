import argparse
import importlib.util
import json
import sys
import tempfile
import unittest
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
        turn=workflow.IMPLEMENTER,
        action=workflow.IMPLEMENT,
        active="050.1",
        children=None,
        findings=None,
        updated_at="2026-08-21T01:00:00+02:00",
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
            "findings": findings or [],
            "resume_review": None,
            "updated_at": updated_at,
        }
        workflow.state_path(self.repo, "050").write_text(
            json.dumps(data, indent=2) + "\n", encoding="utf-8"
        )
        workflow.coordination_path(self.repo, "050").write_text(
            "# coordination\n", encoding="utf-8"
        )
        return data

    def workflow_patches(self, branch_name="feature/test"):
        return (
            patch.object(workflow, "root", return_value=self.repo),
            patch.object(workflow, "branch", return_value=branch_name),
            patch.object(workflow, "git", return_value=""),
        )

    def test_numeric_child_discovery_ignores_proto_children(self):
        specs = self.repo / "docs" / "specs"
        (specs / "050.2-two.md").write_text("", encoding="utf-8")
        (specs / "050.1-one.md").write_text("", encoding="utf-8")
        (specs / "050.P1-future.md").write_text("", encoding="utf-8")
        self.assertEqual(
            workflow.discover_children(self.repo, "050"), ["050.1", "050.2"]
        )

    def test_implementer_message_appends_without_changing_state(self):
        self.write_state()
        state_path = workflow.state_path(self.repo, "050")
        coordination_path = workflow.coordination_path(self.repo, "050")
        before_state = state_path.read_bytes()
        before_coordination = coordination_path.read_text(encoding="utf-8")
        patches = self.workflow_patches()
        with (
            patches[0],
            patches[1],
            patches[2],
            patch.object(workflow, "now", return_value="2026-08-21T01:25:00+02:00"),
        ):
            workflow.cmd_message(
                argparse.Namespace(
                    spec="050",
                    role=workflow.IMPLEMENTER,
                    message="Please clarify the install-root boundary.",
                )
            )

        self.assertEqual(state_path.read_bytes(), before_state)
        after_coordination = coordination_path.read_text(encoding="utf-8")
        self.assertTrue(after_coordination.startswith(before_coordination))
        self.assertIn(
            "2026-08-21T01:25:00+02:00 — IMPLEMENTER → REVIEWER — 050.1",
            after_coordination,
        )
        self.assertIn("Please clarify the install-root boundary.", after_coordination)

    def test_reviewer_message_appends_without_changing_state(self):
        self.write_state()
        state_path = workflow.state_path(self.repo, "050")
        before_state = state_path.read_bytes()
        patches = self.workflow_patches()
        with (
            patches[0],
            patches[1],
            patches[2],
            patch.object(workflow, "now", return_value="2026-08-21T01:30:00+02:00"),
        ):
            workflow.cmd_message(
                argparse.Namespace(
                    spec="050",
                    role=workflow.REVIEWER,
                    message="Please include the exact packaged matrix.",
                )
            )

        self.assertEqual(state_path.read_bytes(), before_state)
        log = workflow.coordination_path(self.repo, "050").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "2026-08-21T01:30:00+02:00 — REVIEWER → IMPLEMENTER — 050.1", log
        )
        self.assertIn("Please include the exact packaged matrix.", log)

    def test_message_rejects_whitespace_only_body(self):
        self.write_state()
        state_path = workflow.state_path(self.repo, "050")
        coordination_path = workflow.coordination_path(self.repo, "050")
        before_state = state_path.read_bytes()
        before_coordination = coordination_path.read_bytes()
        patches = self.workflow_patches()
        with (
            patches[0],
            patches[1],
            patches[2],
            self.assertRaises(workflow.WorkflowError),
        ):
            workflow.cmd_message(
                argparse.Namespace(
                    spec="050", role=workflow.IMPLEMENTER, message=" \t\n"
                )
            )
        self.assertEqual(state_path.read_bytes(), before_state)
        self.assertEqual(coordination_path.read_bytes(), before_coordination)

    def test_message_rejects_wrong_branch(self):
        self.write_state()
        patches = self.workflow_patches(branch_name="feature/other")
        with (
            patches[0],
            patches[1],
            patches[2],
            self.assertRaises(workflow.WorkflowError),
        ):
            workflow.cmd_message(
                argparse.Namespace(
                    spec="050", role=workflow.IMPLEMENTER, message="Clarify this."
                )
            )

    def test_message_is_closed_for_blocked_and_complete_workflows(self):
        for action in (workflow.BLOCKED, workflow.COMPLETE):
            with self.subTest(action=action):
                self.write_state(turn=workflow.REVIEWER, action=action)
                patches = self.workflow_patches()
                with (
                    patches[0],
                    patches[1],
                    patches[2],
                    self.assertRaises(workflow.WorkflowError),
                ):
                    workflow.cmd_message(
                        argparse.Namespace(
                            spec="050",
                            role=workflow.IMPLEMENTER,
                            message="Clarify this.",
                        )
                    )

    def test_request_fixes_transitions_without_obsolete_message_metadata(self):
        self.write_state(turn=workflow.REVIEWER, action=workflow.REVIEW)
        patches = self.workflow_patches()
        with (
            patches[0],
            patches[1],
            patches[2],
            patch.object(workflow, "now", return_value="2026-08-21T01:45:00+02:00"),
        ):
            workflow.cmd_request_fixes(
                argparse.Namespace(
                    spec="050",
                    findings=["R2"],
                    message="The review needs one focused correction.",
                )
            )

        data = workflow.load(workflow.state_path(self.repo, "050"))
        self.assertEqual(data["turn"], workflow.IMPLEMENTER)
        self.assertEqual(data["action"], workflow.FIX_REVIEW)
        self.assertEqual(data["active_child"], "050.1")
        self.assertEqual(data["findings"], ["R2"])
        self.assertEqual(data["resume_review"], workflow.REVIEW)
        self.assertEqual(data["updated_at"], "2026-08-21T01:45:00+02:00")
        log = workflow.coordination_path(self.repo, "050").read_text(
            encoding="utf-8"
        )
        self.assertIn("Changes required", log)
        self.assertIn("The review needs one focused correction.", log)


if __name__ == "__main__":
    unittest.main()
