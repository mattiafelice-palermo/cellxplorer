"""Verify the production local updater input using signed harmless NSIS fixtures.

Only generates/reads disposable files. Never executes a setup or touches real keys,
registrations or databases. A fresh fixture key is never exposed to the app command.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from check_installer_scope import nsis_compiler

ROOT = Path(__file__).resolve().parents[1]


def main():
    if os.name != 'nt':
        raise RuntimeError('Native Windows local-installer verification is required')
    cli = [shutil.which('node') or 'node', str(ROOT / 'node_modules/@tauri-apps/cli/tauri.js')]
    subprocess.run(['cargo', 'build', '--locked', '--manifest-path', str(ROOT / 'src-tauri/Cargo.toml'), '--example', 'local_installer_probe'], check=True, timeout=300)
    probe = ROOT / 'src-tauri/target/debug/examples/local_installer_probe.exe'
    scratch = ROOT / 'tmp'
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='local-installer-check-', dir=scratch) as directory:
        root = Path(directory)
        private = root / 'fixture.key'
        # Capture tool output: key generation may print the private fixture key.
        subprocess.run([*cli, 'signer', 'generate', '--ci', '--password', 'fixture-only', '--write-keys', str(private)], check=True, capture_output=True, timeout=30)
        public = Path(str(private) + '.pub')
        source = root / 'fixture.nsi'
        setup = root / 'renamed-untrusted-name.exe'
        source.write_text(f'''Unicode true
RequestExecutionLevel user
Name "Harmless local verification fixture"
OutFile "{setup}"
VIProductVersion "0.28.0.16"
VIAddVersionKey /LANG=1033 "ProductName" "CellXplorer Alpha"
VIAddVersionKey /LANG=1033 "ProductVersion" "0.28.0-alpha.16"
Section
  Quit
SectionEnd
''', encoding='utf8')
        subprocess.run([str(nsis_compiler()), '/INPUTCHARSET', 'UTF8', '/V2', str(source)], check=True, capture_output=True, timeout=30)
        subprocess.run([*cli, 'signer', 'sign', '--private-key-path', str(private), '--password', 'fixture-only', str(setup)], check=True, capture_output=True, timeout=30)
        signature = Path(str(setup) + '.sig')
        def run(name, current='0.28.0-alpha.15', channel='alpha', expect=True):
            result = subprocess.run([str(probe), str(setup), str(signature), str(public), channel, current], capture_output=True, text=True, timeout=30)
            if (result.returncode == 0) != expect:
                raise AssertionError(f'{name}: {result.stdout} {result.stderr}')
            return {'case': name, 'passed': True, 'installed': False}
        rows = [run('signed-renamed-installer'), run('same-version-reinstall', current='0.28.0-alpha.16'),
                run('downgrade-rejected', current='0.28.0-alpha.17', expect=False),
                run('cross-channel-rejected', channel='beta', current='0.28.0-beta.1', expect=False)]
        original = setup.read_bytes()
        setup.write_bytes(original + b'tampered')
        rows.append(run('changed-bytes-rejected', expect=False))
        setup.write_bytes(original)
        signature.unlink()
        rows.append(run('missing-signature-rejected', expect=False))
        print(json.dumps({'local_signed_installer': rows}, indent=2))


if __name__ == '__main__':
    main()
