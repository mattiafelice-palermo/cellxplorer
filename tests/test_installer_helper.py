"""Native-helper build and trust-boundary contracts; actual kernel fixtures run in CI."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class NativeInstallerHelperContracts(unittest.TestCase):
    def test_fresh_helper_is_locked_and_hashed_before_recovery_authorization(self):
        nsis = (ROOT / "src-tauri/cellxplorer-installer.nsi").read_text()
        prepare = (ROOT / "src-tauri/installer_helper.nsh").read_text()
        init = nsis.split("Function .onInit", 1)[1].split("FunctionEnd", 1)[0]
        install = nsis.split("Section Install", 1)[1]
        self.assertIn("Call CxPrepareInstallerHelper", init)
        self.assertIn("Call CxPrepareRecovery", install)
        self.assertIn('File "/oname=$PLUGINSDIR\\cellxplorer-installer-helper.exe"', prepare)
        self.assertIn('CreateFileW(w "$PLUGINSDIR\\cellxplorer-installer-helper.exe", i 0x80000000, i 1', prepare)
        self.assertIn('ReadFile(p $CxHelperFileLock', prepare)
        self.assertIn('CxHelperComputedHash != "${CX_INSTALLER_HELPER_SHA256}"', prepare)
        self.assertIn('!insertmacro DefineInstallerHelper "un."', prepare)
        self.assertIn('Delete "$INSTDIR\\cellxplorer-installer-helper.exe"', nsis)

    def test_monotonic_cleanup_preserves_all_original_safety_gates(self):
        policy = (ROOT / "scripts/installer_helper/src/policy.rs").read_text(encoding="utf-8")
        native = (ROOT / "scripts/installer_helper/src/processes.rs").read_text()
        self.assertIn("Duration::from_secs(10)", policy)
        self.assertIn("Duration::from_millis(200)", policy)
        self.assertIn("QUIET_SAMPLES: usize = 5", policy)
        self.assertIn("Instant::now()", native)
        self.assertIn("policy::ancestors", native)
        self.assertIn("policy::owned(&path, prefix, backend_only)", native)
        self.assertIn("TerminateProcess(handle.0", native)
        self.assertIn("WaitForSingleObject(handle.0", native)
        self.assertNotIn("taskkill", native)


if __name__ == "__main__":
    unittest.main()
