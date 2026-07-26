import os
import unittest

from backend.app.services import process_priority


def _increment(value: int) -> int:
    return value + 1


class ProcessPriorityTests(unittest.TestCase):
    def test_background_helpers_do_not_raise(self):
        self.assertIsInstance(process_priority.apply_background_thread_priority(), bool)
        self.assertIsInstance(process_priority.apply_background_process_priority(), bool)

    def test_background_thread_context_manager(self):
        with process_priority.background_thread_priority(True):
            pass

    def test_process_pool_executor_can_be_created(self):
        with process_priority.process_pool_executor(1) as executor:
            self.assertEqual(list(executor.map(_increment, [1])), [2])

    def test_thread_pool_executor_can_be_created(self):
        with process_priority.thread_pool_executor(1) as executor:
            self.assertEqual(list(executor.map(_increment, [1])), [2])

    @unittest.skipUnless(os.name == "nt", "Windows-only scheduling check")
    def test_apply_background_process_priority_on_windows(self):
        # May return False in restricted test environments; must never raise.
        self.assertIsInstance(process_priority.apply_background_process_priority(), bool)
        self.assertIsInstance(process_priority.apply_background_thread_priority(), bool)


if __name__ == "__main__":
    unittest.main()
