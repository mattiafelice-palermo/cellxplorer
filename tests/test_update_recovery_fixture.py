"""Deterministic controller/child lifetime coverage; no installed-app mutations."""
from contextlib import contextmanager
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("recovery_fixture_test_module", ROOT / "scripts/check_update_recovery.py")
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)


class RelayControllerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "tmp").mkdir()
        self.output = self.root / "tmp" / "relay"
        self.events = []
        self.clock = 0.0
        self.ready = True
        self.code = None
        self.exit_status = 7
        self.timeout_once = False
        self.process = mock.Mock()
        self.process.poll.side_effect = lambda: self.code
        def wait(*, timeout):
            self.events.append(("wait", timeout))
            if self.timeout_once:
                self.timeout_once = False
                raise subprocess.TimeoutExpired("owned-fixture", timeout)
            self.code = self.exit_status
            return self.code
        self.process.wait.side_effect = wait
        @contextmanager
        def release_event():
            def release():
                self.events.append("release")
            try:
                yield "Local\\fixture-test-event", release
            finally:
                self.events.append("close-event")
        def compile_fixture(output, parent, **kwargs):
            self.assertTrue(kwargs["relay"])
            self.assertEqual(kwargs["relay_release_event"], "Local\\fixture-test-event")
            exe = output / "owned-fixture.exe"
            exe.write_bytes(b"harmless fixture")
            if self.ready:
                (output / "relay-child.txt").write_text("locked child ready")
            return exe
        def assert_locks(*args):
            self.assertIsNone(self.code)
            self.assertNotIn("release", self.events)
            self.events.append("both-lock-assertions")
        for patcher in [
            mock.patch.object(fixture, "ROOT", self.root),
            mock.patch.object(fixture, "relay_release_event", release_event),
            mock.patch.object(fixture, "compile_fixture", side_effect=compile_fixture),
            mock.patch.object(fixture.subprocess, "Popen", return_value=self.process),
            mock.patch.object(fixture, "assert_relay_locks", side_effect=assert_locks),
            mock.patch.object(fixture, "relay_failure_state", return_value={"unit": "failure evidence"}),
            mock.patch.object(fixture.time, "monotonic", side_effect=lambda: self.clock),
            mock.patch.object(fixture.time, "sleep", side_effect=lambda delay: setattr(self, "clock", self.clock + delay)),
        ]:
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_case(self, **kwargs):
        return fixture.run_relay_case(self.output, Path("powershell.exe"), **kwargs)

    def test_child_is_released_only_after_both_lock_assertions_then_exit_is_joined(self):
        result = self.run_case()
        self.assertTrue(result["passed"])
        self.assertEqual(self.events[:3], ["both-lock-assertions", "release", ("wait", 15)])
        self.assertEqual(self.events[-1], "close-event")

    def test_delayed_observer_keeps_original_readiness_budget_and_all_assertions(self):
        def delayed_observer():
            self.clock += 2.5  # Longer than the old blind child sleep, below 10s.
        self.assertTrue(self.run_case(on_child_ready=delayed_observer)["delayed_observer"])
        self.assertEqual(self.events[0], "both-lock-assertions")
        self.assertEqual(fixture.RELAY_READY_TIMEOUT, 10)
        self.assertEqual(fixture.RELAY_EXIT_TIMEOUT, 15)

    def test_missing_ready_marker_fails_at_original_ten_second_deadline(self):
        self.ready = False
        with self.assertRaisesRegex(RuntimeError, "marker=False"):
            self.run_case()
        self.assertGreaterEqual(self.clock, 10)
        self.assertLess(self.clock, 10.1)
        self.assertNotIn("both-lock-assertions", self.events)
        self.assertEqual(self.code, 7)  # Failure cleanup still joined owned relay.

    def test_ready_marker_after_deadline_does_not_turn_timeout_into_pass(self):
        with self.assertRaisesRegex(RuntimeError, "live checked child"):
            self.run_case(on_child_ready=lambda: setattr(self, "clock", 10))
        self.assertNotIn("both-lock-assertions", self.events)

    def test_already_exited_relay_is_not_accepted_even_with_ready_marker(self):
        self.code = 7
        with self.assertRaisesRegex(RuntimeError, "exit=7"):
            self.run_case()

    def test_lock_failure_is_preserved_after_release_and_join_cleanup(self):
        with mock.patch.object(fixture, "assert_relay_locks", side_effect=RuntimeError("lock failure")):
            with self.assertRaisesRegex(RuntimeError, "lock failure"):
                self.run_case()
        self.assertEqual(self.code, 7)
        self.assertIn(("wait", 15), self.events)

    def test_wrong_child_exit_status_still_fails(self):
        self.exit_status = 9
        with self.assertRaisesRegex(RuntimeError, "exit status"):
            self.run_case()

    def test_relay_exit_during_lock_assertions_is_not_accepted(self):
        with mock.patch.object(fixture, "assert_relay_locks", side_effect=lambda *args: setattr(self, "code", 7)):
            with self.assertRaisesRegex(RuntimeError, "before the controller released"):
                self.run_case()

    def test_stuck_owned_process_is_killed_only_for_failure_cleanup(self):
        self.process.wait.side_effect = [subprocess.TimeoutExpired("owned-fixture", 15), 2]
        with mock.patch.object(fixture, "assert_relay_locks", side_effect=RuntimeError("original lock failure")):
            with self.assertRaisesRegex(RuntimeError, "original lock failure"):
                self.run_case()
        self.process.kill.assert_called_once_with()
        self.assertEqual(self.process.wait.call_args_list, [mock.call(timeout=15), mock.call(timeout=15)])
        self.assertEqual(self.events[-1], "close-event")

    def test_completion_timeout_cannot_be_retried_into_success_by_cleanup(self):
        self.timeout_once = True
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_case()
        self.assertEqual(self.events[2], ("wait", 15))
        self.assertEqual(self.code, 7)  # Joined only for cleanup; test still failed.


class RelayFixtureSourceTests(unittest.TestCase):
    def test_fixture_waits_on_owned_release_event_with_bounded_completion_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with mock.patch.object(fixture, "nsis_compiler", return_value=Path("makensis.exe")), \
                 mock.patch.object(fixture.subprocess, "run", return_value=mock.Mock(returncode=0)):
                fixture.compile_fixture(folder, Path("powershell.exe"), relay=True,
                                        relay_release_event="Local\\fixture-test-event")
            source = (folder / "recovery-policy.nsi").read_text()
            child = source.split('"/CXTESTCHILD"')[1].split('"/CXTESTRELAY"')[0]
            self.assertIn("Call CxLockRecoveryPayload", child)
            self.assertIn("OpenEventW", child)
            self.assertIn("WaitForSingleObject(p r7, i 15000)", child)
            self.assertNotIn("Sleep 2000", child)
            self.assertIn("Sleep 2000", source)  # Pre-lock substitution wait unchanged.
            self.assertIn("CX_RECOVERY_TIMEOUT_MS 2000", source)

    def test_missing_release_event_is_rejected_before_compilation(self):
        with self.assertRaises(ValueError):
            fixture.compile_fixture(Path("unused"), Path("powershell.exe"), relay=True)

    def test_payload_write_access_is_never_accepted(self):
        executable = mock.MagicMock(spec=Path)
        with self.assertRaisesRegex(RuntimeError, "payload could be opened"):
            fixture.assert_relay_locks(executable, Path("unused"))

    def test_successful_directory_rename_is_reverted_but_still_fails(self):
        executable = mock.Mock(spec=Path)
        executable.open.side_effect = PermissionError("locked")
        output = ROOT / "tmp" / "relay-unit-fixture"
        with mock.patch.object(Path, "rename", autospec=True) as rename:
            with self.assertRaisesRegex(RuntimeError, "directory could be renamed"):
                fixture.assert_relay_locks(executable, output)
            self.assertEqual(rename.call_count, 2)


if __name__ == "__main__":
    unittest.main()
