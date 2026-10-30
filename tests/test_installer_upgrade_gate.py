import base64
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib
import unittest
from unittest import mock
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("installer_upgrade_gate", ROOT / "scripts/installer_upgrade_gate.py")
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)
SMOKE = ROOT / "scripts/smoke_installer_upgrade.ps1"


def release(tag, *, draft=False, published=True):
    return {"tag_name": tag, "draft": draft, "published_at": "2026-01-01" if published else None}


class PackagedApplicationReferenceTests(unittest.TestCase):
    def test_expected_whole_binary_matches_exact_pinned_tauri_nsis_patch(self):
        binary = b'MZ' + b'x' * 64 + b'__TAURI_BUNDLE_TYPE_VAR_UNK' + b'end'
        expected = b'MZ' + b'x' * 64 + b'__TAURI_BUNDLE_TYPE_VAR_NSS' + b'end'
        self.assertEqual(gate.expected_nsis_application_hash(binary, '2.11.4', {}), hashlib.sha256(expected).hexdigest())
        self.assertNotEqual(gate.expected_nsis_application_hash(binary, '2.11.4', {}), hashlib.sha256(binary).hexdigest())
        changed = binary.replace(b'end', b'bad')
        self.assertNotEqual(gate.expected_nsis_application_hash(changed, '2.11.4', {}), hashlib.sha256(expected).hexdigest())

    def test_unreviewed_versions_markers_and_signing_fail_closed(self):
        binary = b'MZ' + b'x' * 64 + b'__TAURI_BUNDLE_TYPE_VAR_UNK'
        for candidate, cli, config in ((binary, '2.12.0', {}), (binary + b'__TAURI_BUNDLE_TYPE_VAR_UNK', '2.11.4', {}),
                                       (binary.replace(b'_UNK', b'_NSS'), '2.11.4', {}), (b'not PE', '2.11.4', {}),
                                       (binary, '2.11.4', {'certificateThumbprint': 'configured'}),
                                       (binary, '2.11.4', {'signCommand': 'configured'})):
            with self.subTest(cli=cli, config=config), self.assertRaises(ValueError):
                gate.expected_nsis_application_hash(candidate, cli, config)


class ReleaseSelectionTests(unittest.TestCase):
    def test_exact_channel_numeric_order_excludes_drafts_future_and_candidate(self):
        rows = [release(tag) for tag in ("v1.2.0-alpha.9", "v1.2.0-alpha.10", "v1.2.0-beta.12",
                                        "v1.2.0", "v1.2.0-alpha.12", "v1.3.0-alpha.1")]
        rows += [release("v1.2.0-alpha.11", draft=True), release("v1.2.0-alpha.11", published=False),
                 release("v1.2.0-alpha.011"), release("v1.2.0-alpha.11+other")]
        self.assertEqual(gate.previous_release(rows, "alpha", "v1.2.0-alpha.12")["tag_name"], "v1.2.0-alpha.10")

    def test_compact_beta_leading_zeros_and_semver_lexical_order(self):
        rows = [release(t) for t in ("v1.0.0-beta.999", "v1.0.0-beta009", "v1.0.0-beta011", "v1.0.0-beta012")]
        self.assertEqual(gate.previous_release(rows, "beta", "v1.0.0-beta012")["tag_name"], "v1.0.0-beta011")
        self.assertEqual(gate.previous_release(rows, "beta", "v1.0.0-beta010")["tag_name"], "v1.0.0-beta009")
        self.assertEqual(gate.previous_release(rows, "beta", "v1.0.0-beta.1000")["tag_name"], "v1.0.0-beta.999")

    def test_no_same_channel_predecessor_is_failure_not_skip(self):
        for rows in ([], [release("v1.0.0-beta.1")], [release("v1.0.0-alpha.1", draft=True)],
                     [release("v1.0.0-alpha.2")]):
            with self.subTest(rows=rows), self.assertRaisesRegex(ValueError, "cannot skip"):
                gate.previous_release(rows, "alpha", "v1.0.0-alpha.2")

    def test_other_channels_use_latest_published_release(self):
        rows = [release("v1.9.0"), release("v1.10.0"), release("v9.0.0", draft=True)]
        self.assertEqual(gate.previous_release(rows, "stable", "")["tag_name"], "v1.10.0")


class GitHubArtifactTests(unittest.TestCase):
    def test_baseline_scope_capabilities_read_release_config_not_candidate_assumptions(self):
        def content(value):
            text = value if isinstance(value, str) else json.dumps(value)
            return {"content": base64.b64encode(text.encode()).decode()}

        for scope, user, machine in (("perMachine", False, True), ("currentUser", True, False), ("both", False, False)):
            github = gate.GitHub("owner/repo", "dummy")
            config = content({"bundle": {"windows": {"nsis": {"installMode": scope}}}})
            effects = [config]
            if scope == "currentUser":
                effects += [HTTPError("https://api.github.com/source", 404, "not found", {}, None)]
            with self.subTest(scope=scope), mock.patch.object(github, "get", side_effect=effects):
                result = github.installer_capabilities("v1.0.0", "stable")
                self.assertEqual(result["supports_user_baseline"], user)
                self.assertEqual(result["supports_machine_baseline"], machine)
        github = gate.GitHub("owner/repo", "dummy")
        base = content({"bundle": {"windows": {"nsis": {"installMode": "currentUser"}}}})
        policy = content('${GetOptions} $CMDLINE "/CXALLUSERS" $0\n${GetOptions} $CMDLINE "/CXCURRENTUSER" $0')
        with mock.patch.object(github, "get", side_effect=[base, content({}), policy]):
            capabilities = github.installer_capabilities("v1.0.0-alpha.1", "alpha")
            self.assertTrue(capabilities["supports_user_baseline"])
            self.assertTrue(capabilities["supports_machine_baseline"])
        with mock.patch.object(github, "get", side_effect=[base, content({"bundle": {"windows": {"nsis": {"installMode": "perMachine"}}}})]):
            self.assertFalse(github.installer_capabilities("v1.0.0-beta.1", "beta")["supports_user_baseline"])
        forbidden = HTTPError("https://api.github.com/source", 403, "forbidden", {}, None)
        with mock.patch.object(github, "get", side_effect=[base, forbidden]):
            with self.assertRaises(HTTPError):
                github.installer_capabilities("v1.0.0", "stable")
        forbidden.close()

    def test_pagination_and_exact_asset_id_download(self):
        github = gate.GitHub("owner/repo", "dummy")
        with mock.patch.object(github, "get", side_effect=[[{}] * 100, [release("v1.0.0")]]) as get:
            self.assertEqual(len(github.releases()), 101)
            self.assertEqual([call.args[0] for call in get.call_args_list],
                             ["/releases?per_page=100&page=1", "/releases?per_page=100&page=2"])
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "candidate.exe"
            metadata = {"assets": [{"id": 412, "name": "expected.exe", "size": 4}]}
            with mock.patch.object(github, "get", return_value=b"real") as get:
                github.asset(metadata, "expected.exe", target)
                self.assertEqual(target.read_bytes(), b"real")
                get.assert_called_once_with("/releases/assets/412", binary=True)
            with mock.patch.object(github, "get", return_value=b"truncated"):
                with self.assertRaisesRegex(ValueError, "Incomplete"):
                    github.asset(metadata, "expected.exe", target)
            with self.assertRaises(ValueError):
                github.asset(metadata, "another.exe", target)

    def test_api_token_is_not_forwarded_to_asset_redirects(self):
        github = gate.GitHub("owner/repo", "dummy")
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b"payload"
        with mock.patch.object(gate.urllib.request, "urlopen", return_value=response) as open_url:
            self.assertEqual(github.get("/releases/assets/12", binary=True), b"payload")
        request = open_url.call_args.args[0]
        self.assertNotIn("Authorization", request.headers)
        self.assertEqual(request.unredirected_hdrs["Authorization"], "Bearer dummy")

    def test_exact_local_hash_mismatch_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            local, staged = Path(temporary) / "local", Path(temporary) / "staged"
            local.write_bytes(b"real setup")
            staged.write_bytes(b"real setup")
            self.assertEqual(gate.require_equal_bytes(local, staged), gate.sha256(local))
            staged.write_bytes(b"real setuP")
            with self.assertRaisesRegex(ValueError, "exact local build"):
                gate.require_equal_bytes(local, staged)

    def test_rust_verifier_failure_propagates_and_uses_embedded_config(self):
        with mock.patch.object(gate.subprocess, "run") as run:
            gate.verify_installer(Path("candidate.exe"), Path("candidate.sig"))
            args = run.call_args.args[0]
            self.assertEqual(args[:4], ["cargo", "run", "--locked", "--manifest-path"])
            self.assertIn("verify_updater_signature", args)
            self.assertNotIn("--offline", args)
            self.assertEqual(args[4], str(ROOT / 'scripts/updater_signature_verifier/Cargo.toml'))
            self.assertEqual(args[-2:], ["--config", str(ROOT / "src-tauri/tauri.conf.json")])
            self.assertTrue(run.call_args.kwargs["check"])
        with mock.patch.object(gate.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "verifier")):
            with self.assertRaises(subprocess.CalledProcessError):
                gate.verify_installer(Path("candidate.exe"), Path("candidate.sig"))


class PreparationTests(unittest.TestCase):
    def test_draft_evidence_inside_native_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(os.environ, {"GITHUB_REPOSITORY": "owner/repo", "GH_TOKEN": "dummy"}):
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, 'outside the native root'):
                gate.prepare(root, 'alpha', '1.0.0-alpha.2', '123', root / 'forged-provenance.json')

    def test_complete_staged_and_manual_provenance_and_rejection(self):
        for mode in ("staged", "manual", "selected-machine-only", "selected-user-only", "other-user-only", "no-proven-scope", "corrupt-installer", "corrupt-signature", "corrupt-manifest", "not-draft", "wrong-tag", "missing-previous", "bad-crypto"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                repo = Path(temporary) / "repo"
                bundle = repo / "src-tauri/target/release/bundle/nsis"
                bundle.mkdir(parents=True)
                application = b'MZ' + b'x' * 64 + b'__TAURI_BUNDLE_TYPE_VAR_UNK'
                (bundle.parent.parent / "cellxplorer.exe").write_bytes(application)
                cli = repo / 'node_modules/@tauri-apps/cli'
                cli.mkdir(parents=True)
                (cli / 'package.json').write_text(json.dumps({'version': '2.11.4'}))
                candidate_name = "CellXplorer.Alpha_1.0.0-alpha.2_x64-setup.exe"
                local_name = "CellXplorer Alpha_1.0.0-alpha.2_x64-setup.exe"
                (bundle / local_name).write_bytes(b"candidate")
                (bundle / (local_name + ".sig")).write_bytes(b"signed")
                (repo / "uploaded-latest.json").write_bytes(b"manifest")
                (repo / "src-tauri/tauri.conf.json").write_text(json.dumps({"plugins": {"updater": {"pubkey": "configured-key"}}}))
                (repo / 'src-tauri/tauri.alpha.conf.json').write_text('{}')
                output = Path(temporary) / "output"
                output.mkdir()
                controller = Path(temporary) / "controller"
                controller.mkdir()
                evidence = controller / "provenance.json"
                github = mock.Mock()
                def capabilities(_tag, channel):
                    if mode == "no-proven-scope":
                        return {"declared_nsis_scope": "both", "supports_user_baseline": False, "supports_machine_baseline": False}
                    user = not (mode == "selected-machine-only" and channel == "alpha")
                    machine = not ((mode == "selected-user-only" and channel == "alpha") or (mode == "other-user-only" and channel == "stable"))
                    return {"declared_nsis_scope": "currentUser" if user else "perMachine", "supports_user_baseline": user, "supports_machine_baseline": machine}
                github.installer_capabilities.side_effect = capabilities
                github.get.return_value = {"id": 123, "draft": mode != "not-draft", "tag_name": "v9.0.0-alpha.1" if mode == "wrong-tag" else "v1.0.0-alpha.2",
                                           "assets": [{"id": 101, "name": candidate_name, "size": 9}, {"id": 102, "name": candidate_name + ".sig", "size": 6}, {"id": 103, "name": "latest.json", "size": 8}]}
                github.releases.return_value = [] if mode == "missing-previous" else [release("v0.9.0"), release("v1.0.0-beta009"), release("v1.0.0-alpha.1")]

                def asset(_release, name, target):
                    data = b"manifest" if name == "latest.json" else b"signed" if name.endswith(".sig") else b"candidate"
                    if ((mode == "corrupt-installer" and name == candidate_name) or
                            (mode == "corrupt-signature" and name == candidate_name + ".sig") or
                            (mode == "corrupt-manifest" and name == "latest.json")):
                        data += b"changed"
                    target.write_bytes(data)

                github.asset.side_effect = asset
                with mock.patch.object(gate, "ROOT", repo), mock.patch.object(gate, "GitHub", return_value=github), mock.patch.dict(os.environ, {"GITHUB_REPOSITORY": "owner/repo", "GH_TOKEN": "dummy"}), mock.patch.object(gate, "verify_installer") as verify:
                    if mode == "bad-crypto":
                        verify.side_effect = subprocess.CalledProcessError(1, "verifier")
                    if mode in ("manual", "staged", "selected-machine-only", "selected-user-only"):
                        gate.prepare(output, "alpha", "v1.0.0-alpha.2", None if mode == "manual" else "123", None if mode == "manual" else evidence)
                        self.assertEqual(verify.call_count, 4)
                        plan = json.loads((output / "plan.json").read_text())
                        self.assertEqual(plan["candidate_sha256"], gate.sha256(output / "candidate.exe"))
                        self.assertEqual(plan['binary_sha256'], hashlib.sha256(application.replace(b'_UNK', b'_NSS')).hexdigest())
                        self.assertEqual(plan['unbundled_binary_sha256'], hashlib.sha256(application).hexdigest())
                        self.assertEqual(set(plan["previous"]), {"stable", "beta", "alpha"})
                        self.assertEqual(plan["previous"]["alpha"]["supports_user_baseline"], mode != "selected-machine-only")
                        self.assertEqual(plan["previous"]["alpha"]["supports_machine_baseline"], mode != "selected-user-only")
                        if mode == 'manual':
                            self.assertFalse(evidence.exists())
                        else:
                            provenance = json.loads(evidence.read_text())
                            self.assertEqual(provenance['release_id'], 123)
                            self.assertEqual(provenance['tag'], 'v1.0.0-alpha.2')
                            self.assertEqual(provenance['assets']['installer']['id'], 101)
                            self.assertEqual(provenance['assets']['installer']['sha256'], gate.sha256(output / 'candidate.exe'))
                            self.assertFalse(evidence.resolve().is_relative_to(output.resolve()))
                    else:
                        with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                            gate.prepare(output, "alpha", "1.0.0-alpha.2", "123", evidence)
                        self.assertFalse((output / "plan.json").exists())
                        self.assertFalse(evidence.exists())


class FinalAssetRecheckTests(unittest.TestCase):
    def test_identity_byte_tag_and_crypto_changes_invalidate_native_gate(self):
        for mode in ('same', 'installer-id', 'signature-id', 'manifest-id', 'installer-bytes', 'signature-bytes', 'manifest-bytes', 'not-draft', 'wrong-tag', 'wrong-release', 'wrong-target', 'crypto-failed'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                controller = Path(temporary)
                names = {'installer': 'CellXplorer.Alpha_1.0.0-alpha.2_x64-setup.exe', 'signature': 'CellXplorer.Alpha_1.0.0-alpha.2_x64-setup.exe.sig', 'manifest': 'latest.json'}
                payloads = {'installer': b'original exe', 'signature': b'original sig', 'manifest': b'original manifest'}
                evidence = {'schema': 1, 'repository': 'owner/repo', 'release_id': 123, 'tag': 'v1.0.0-alpha.2', 'updater_pubkey': 'original-key', 'assets': {}}
                for index, (role, name) in enumerate(names.items(), 100):
                    path = controller / role
                    path.write_bytes(payloads[role])
                    evidence['assets'][role] = {'id': index, 'name': name, 'size': len(payloads[role]), 'sha256': gate.sha256(path)}
                path = controller / 'provenance.json'
                path.write_text(json.dumps(evidence))
                metadata = {'id': 124 if mode == 'wrong-release' else 123, 'draft': mode != 'not-draft', 'tag_name': 'v1.0.0-alpha.3' if mode == 'wrong-tag' else evidence['tag'], 'assets': [{k: entry[k] for k in ('id', 'name', 'size')} for entry in evidence['assets'].values()]}
                if mode.endswith('-id'):
                    role = mode.removesuffix('-id')
                    next(entry for entry in metadata['assets'] if entry['name'] == names[role])['id'] += 999
                github = mock.Mock()
                github.get.return_value = metadata

                def asset(_release, name, target):
                    role = next(role for role, value in names.items() if value == name)
                    data = payloads[role]
                    if mode == role + '-bytes':
                        data = data[:-1] + bytes([data[-1] ^ 1])  # same length and same asset ID
                    target.write_bytes(data)

                github.asset.side_effect = asset
                with mock.patch.object(gate, 'GitHub', return_value=github), mock.patch.dict(os.environ, {'GITHUB_REPOSITORY': 'owner/repo', 'GH_TOKEN': 'fresh-controller-token'}), mock.patch.object(gate, 'verify_installer') as verify:
                    if mode == 'crypto-failed':
                        verify.side_effect = subprocess.CalledProcessError(1, 'verifier')
                    if mode == 'same':
                        manifest = gate.recheck(path, '123', evidence['tag'])
                        self.assertEqual(manifest.read_bytes(), payloads['manifest'])
                        self.assertEqual(manifest.parent, controller)
                        verify.assert_called_once()
                        self.assertEqual(verify.call_args.args[2].parent.parent, controller)
                        github.get.assert_called_once_with('/releases/123')
                    else:
                        with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                            gate.recheck(path, '999' if mode == 'wrong-target' else '123', evidence['tag'])
                        self.assertFalse((controller / 'rechecked-latest.json').exists())


@unittest.skipUnless(shutil.which("pwsh"), "PowerShell required")
class PowerShellGateTests(unittest.TestCase):
    def test_whole_file_hash_needs_no_cmdlet_module_and_missing_files_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Path(temporary) / '[literal-file].bin'
            for shell in ('pwsh', 'powershell'):
                if not shutil.which(shell):
                    continue
                for data in (b'', b'abc', bytes(range(256)) * 1024):
                    fixture.write_bytes(data)
                    command = "function Get-FileHash { throw 'Cmdlet module must not be used' }\n" + f"Assert-True ((Get-Hash '{fixture}') -ceq '{hashlib.sha256(data).hexdigest()}') 'Incorrect whole-file digest'"
                    with self.subTest(shell=shell, size=len(data)):
                        result = self.run_functions(command, shell=shell)
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            result = self.run_functions(f"Get-Hash '{fixture.with_name('missing.bin')}'")
            self.assertNotEqual(result.returncode, 0)

    def test_machine_task_requires_dedicated_account_and_checks_exit_and_cleanup(self):
        for outcome in ('success', 'exit-failure', 'launch-failure', 'wrong-account', 'cleanup-query-failure', 'cleanup-stop-failure'):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as temporary:
                command = f"$Root = '{temporary}'\n$scenario = '{outcome}'\n" + r'''
$env:RUNNER_TEMP = $Root
function Assert-CI { }
function Assert-TempRoot { }
function Start-Sleep { }
$script:registered = $false; $script:removed = $false; $script:taskQueries = 0
function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory)
    $encoded = $Argument.Split(' ')[-1]
    $decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
    Assert-True ($decoded.Contains('GITHUB_ACTIONS') -and $decoded.Contains('temp-machine') -and -not $decoded.Contains('GH_TOKEN')) 'Wrong scheduled environment'
    return [pscustomobject]@{ Execute = $Execute }
}
function Register-ScheduledTask { param($TaskName, $Action, $User, $Password, $RunLevel)
    Assert-True ($RunLevel -ceq 'Highest' -and $User.EndsWith('-m')) 'Wrong machine task token selection'
    $script:registered = $true
}
function Start-ScheduledTask { if ($scenario -ceq 'launch-failure') { throw 'fixture launch failure' } }
function Get-ScheduledTask {
    $script:taskQueries++
    if ($script:taskQueries -gt 1 -and $scenario -ceq 'cleanup-query-failure') { throw 'fixture cleanup query failed' }
    [pscustomobject]@{ State = $(if ($script:taskQueries -gt 1 -and $scenario -ceq 'cleanup-stop-failure') { 'Running' } else { 'Ready' }) }
}
function Get-ScheduledTaskInfo { [pscustomobject]@{ LastRunTime = (Get-Date); LastTaskResult = $(if ($scenario -ceq 'exit-failure') { 7 } else { 0 }) } }
function Stop-ScheduledTask { throw 'Completed task should not be stopped' }
function Unregister-ScheduledTask { param($TaskName, $Confirm) $script:removed = $true }
$name = 'HOST' + [char]92 + $(if ($scenario -ceq 'wrong-account') { 'cxg-aaaaaaaaaaaa-u' } else { 'cxg-aaaaaaaaaaaa-m' })
$credential = [pscredential]::new($name, (ConvertTo-SecureString 'fixture-not-a-real-password' -AsPlainText -Force))
$failed = $false
try { Invoke-ElevatedMachineWorker $credential '-NoProfile -Command exit' } catch { $failed = $true; Write-Host "Mock task outcome: $_" }
Assert-True ($failed -eq ($scenario -cne 'success')) 'Task failure treated as success'
Assert-True ($script:registered -eq ($scenario -cne 'wrong-account')) 'Unexpected task registration'
Assert-True ($script:removed -eq $script:registered) 'Unique task not cleaned up'
'''
                result = self.run_functions(command)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_profile_probe_returns_before_loading_plan_or_running_installers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'accounts.json').write_text(json.dumps({'user': 'disposable-fixture'}))
            command = f"$Root = '{root}'\n" + r'''
$ProfileProbe = $true
$WorkerScope = 'user'
function Initialize-WorkerProfile($Expected) { Assert-True ($Expected -ceq 'disposable-fixture') 'Wrong account plan'; return $false }
function Invoke-Setup { throw 'Profile-only probe must never install' }
Invoke-Worker
$result = Get-Content -LiteralPath "$Root\user-result.json" -Raw | ConvertFrom-Json
Assert-True (@($result.completed).Count -eq 1 -and $result.completed[0] -ceq 'profile-bootstrap') 'Probe falsely reported native installation cases'
'''
            result = self.run_functions(command)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_profile_probe_cannot_replace_full_publication_gate(self):
        workflow = (ROOT / '.github/workflows/release.yml').read_text()
        early = workflow.split('- name: Verify disposable installer worker profiles', 1)[1].split('- parallel:', 1)[0]
        self.assertIn('smoke_installer_upgrade.ps1 -ProfileProbe', early)
        native = workflow.split('- name: Mandatory native installer upgrade and reinstall gate', 1)[1].split('- name:', 1)[0]
        self.assertNotIn('ProfileProbe', native)
        self.assertIn('smoke_installer_upgrade.ps1 @arguments', native)
        source = SMOKE.read_text()
        self.assertIn('Profile-only probe cannot verify draft release provenance', source)
        self.assertIn("$expectedCases = if ($ProfileProbe) { 1 } else { 4 }", source)

    def test_worker_temp_is_selected_before_credentialed_launch_and_helper_compilation(self):
        source = SMOKE.read_text()
        driver = source.split('\nAssert-CI\n', 1)[1]
        worker = driver.split('if ($WorkerScope)', 1)[1].split('exit 0', 1)[0]
        self.assertLess(worker.index('Initialize-WorkerTemp $WorkerScope'), worker.index('Invoke-Worker'))
        launches = driver.split('# Real harmless credentialed exit-code probes', 1)[1]
        self.assertLess(launches.index('Initialize-WorkerTemp $scope'), launches.index('Start-Process'))
        self.assertNotIn('New-Item -ItemType Directory -Path $workerTemp', source.split('function Initialize-WorkerProfile', 1)[1])

    @unittest.skipUnless(os.name == 'nt', 'Windows PowerShell compilation required')
    def test_worker_temp_recovers_poisoned_controller_temp_before_native_helper_loading(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root = parent / ('cx-upgrade-' + 'a' * 32)
            root.mkdir()
            command = f"$Root = '{root}'\n$env:RUNNER_TEMP = '{parent}'\n" + r'''
$env:TEMP = 'C:\missing-controller-temp'
$env:TMP = 'C:\missing-controller-temp'
Initialize-WorkerTemp 'user'
Assert-True ($env:TEMP -ceq (Join-Path $Root 'temp-user') -and $env:TMP -ceq $env:TEMP) 'Controller temp survived'
Assert-True (Test-Path -LiteralPath $env:TEMP -PathType Container) 'Worker temp was not created'
Initialize-WorkerTemp 'user'
$block = Get-TokenProfileEnvironment ([Security.Principal.WindowsIdentity]::GetCurrent())
Assert-True (-not [string]::IsNullOrWhiteSpace($block['USERPROFILE'])) 'Native helper did not load'
'''
            result = self.run_functions(command, shell='powershell')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_fresh_profile_initializes_real_shell_folders_after_profile_validation(self):
        source = SMOKE.read_text().split('function Initialize-WorkerProfile', 1)[1].split('function Invoke-Worker', 1)[0]
        self.assertLess(source.index('$profile -ieq $profileRecord.ProfileImagePath'), source.index('Set-WorkerTokenProfileEnvironment $profile'))
        self.assertLess(source.index('Set-WorkerTokenProfileEnvironment $profile'), source.index('Initialize-WorkerShellFolders $profile'))
        fresh = SMOKE.read_text().split('function Initialize-WorkerShellFolders', 1)[1].split('function Initialize-WorkerProfile', 1)[0]
        self.assertEqual(fresh.count('[Environment+SpecialFolderOption]::Create'), 2)
        self.assertEqual(fresh.count('[Environment+SpecialFolderOption]::DoNotVerify'), 2)
        self.assertLess(fresh.index('Assert-WorkerAppData `$profile'), fresh.index('[Environment+SpecialFolderOption]::Create'))
        self.assertIn('Wait-CheckedProcess $child 30000', fresh)
        self.assertIn('Fresh shell result identity mismatch', fresh)
        self.assertNotIn("Join-Path $profile 'AppData", source)

    def test_token_environment_replaces_inherited_profile_paths_only_after_validation(self):
        command = r'''
$env:USERPROFILE = 'C:\Users\controller'
$env:LOCALAPPDATA = 'C:\Users\controller\AppData\Local'
$env:APPDATA = 'C:\Users\controller\AppData\Roaming'
$block = @{ USERPROFILE = 'C:\Users\fixture'; LOCALAPPDATA = 'C:\Users\fixture\AppData\Local'; APPDATA = 'C:\Users\fixture\AppData\Roaming'; GH_TOKEN = 'must-not-be-copied' }
Set-WorkerTokenProfileEnvironment 'C:\Users\fixture' $block
Assert-True ($env:LOCALAPPDATA -ceq $block.LOCALAPPDATA -and $env:APPDATA -ceq $block.APPDATA -and $env:USERPROFILE -ceq $block.USERPROFILE) 'Inherited controller profile survived'
Assert-True ($env:HOMEDRIVE -ceq 'C:' -and $env:HOMEPATH -ceq '\Users\fixture') 'Home variables do not match genuine profile'
Assert-True ($env:GH_TOKEN -cne 'must-not-be-copied') 'Non-profile environment was copied'
'''
        result = self.run_functions(command)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for before, after in (("USERPROFILE = 'C:\\Users\\fixture'", "USERPROFILE = 'C:\\Users\\other'"),
                              ("LOCALAPPDATA = 'C:\\Users\\fixture\\AppData\\Local'", "LOCALAPPDATA = 'C:\\Users\\controller\\AppData\\Local'")):
            result = self.run_functions(command.replace(before, after))
            self.assertNotEqual(result.returncode, 0)

    @unittest.skipUnless(os.name == 'nt', 'Native Windows environment API required')
    def test_native_token_environment_excludes_inherited_profile_variables(self):
        command = r'''
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$env:USERPROFILE = 'C:\not-the-token-profile'
$env:LOCALAPPDATA = 'C:\not-the-token-profile\Local'
$env:APPDATA = 'C:\not-the-token-profile\Roaming'
$block = Get-TokenProfileEnvironment $identity
Assert-True ($block['LOCALAPPDATA'] -cne $env:LOCALAPPDATA -and $block['APPDATA'] -cne $env:APPDATA) 'Native token block inherited controller paths'
Assert-True (-not [string]::IsNullOrWhiteSpace($block['USERPROFILE']) -and $block['USERPROFILE'] -cne $env:USERPROFILE) 'Token environment has no genuine loaded profile'
Set-WorkerTokenProfileEnvironment $block['USERPROFILE'] $block
$folders = Initialize-WorkerShellFolders $block['USERPROFILE'] $identity.User.Value $false
Assert-True ($folders.local -ieq $block['LOCALAPPDATA'] -and $folders.roaming -ieq $block['APPDATA']) 'Fresh shell resolver uses inherited AppData'
'''
        for shell in ('pwsh', 'powershell'):
            if not shutil.which(shell):
                continue
            with self.subTest(shell=shell):
                result = self.run_functions(command, shell=shell)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(os.name == 'nt', 'Native Windows identity required')
    def test_fresh_shell_child_rejects_wrong_expected_sid_before_folder_creation(self):
        result = self.run_functions(r'''
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$block = Get-TokenProfileEnvironment $identity
Set-WorkerTokenProfileEnvironment $block['USERPROFILE'] $block
Initialize-WorkerShellFolders $block['USERPROFILE'] 'S-1-0-0' $false
''')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('identity/profile mismatch', result.stdout + result.stderr)

    def test_profile_containment_still_rejects_missing_or_foreign_shell_folders(self):
        for local, roaming, accepted in ((r'C:\Users\fixture\AppData\Local', r'C:\Users\fixture\AppData\Roaming', True),
                                         ('', r'C:\Users\fixture\AppData\Roaming', False),
                                         (r'C:\Users\runner\AppData\Local', r'C:\Users\fixture\AppData\Roaming', False),
                                         (r'C:\Users\fixture\AppData\Local', '', False),
                                         (r'C:\Users\fixture\..\runner\AppData\Local', r'C:\Users\fixture\AppData\Roaming', False),
                                         (r'AppData\Local', r'C:\Users\fixture\AppData\Roaming', False),
                                         (r'C:\Users\fixture-other\AppData\Local', r'C:\Users\fixture\AppData\Roaming', False)):
            with self.subTest(local=local, roaming=roaming):
                result = self.run_functions(f"Assert-WorkerAppData 'C:\\Users\\fixture' '{local}' '{roaming}'")
                self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)

    def test_native_execution_strips_credentials_without_exposing_values(self):
        names = ['GH_TOKEN', 'GITHUB_TOKEN', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ID_TOKEN_TEST', 'GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY']
        assignments = '\n'.join(f"$env:{name} = 'not-a-real-secret'" for name in names)
        checks = '\n'.join(f"Assert-True ($null -eq [Environment]::GetEnvironmentVariable('{name}')) 'Credential was not removed: {name}'" for name in names)
        result = self.run_functions(assignments + "\n$env:CELLXPLORER_GATE_NON_SECRET = 'keep'\nRemove-NativeCredentials\n" + checks + "\nAssert-True ($env:CELLXPLORER_GATE_NON_SECRET -eq 'keep') 'Non-secret removed'")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('not-a-real-secret', result.stdout + result.stderr)

    def test_driver_strips_before_accounts_or_child_processes_and_isolates_evidence(self):
        source = SMOKE.read_text()
        driver = source.split('\nAssert-CI\n', 1)[1]
        self.assertLess(driver.index('& python @prepare'), driver.index('Remove-NativeCredentials', driver.index('& python @prepare')))
        strip = driver.index('Remove-NativeCredentials', driver.index('& python @prepare'))
        self.assertLess(strip, driver.index('New-LocalUser'))
        self.assertLess(strip, driver.index('Start-Process'))
        self.assertIn('SetAccessRuleProtection($true, $false)', source)
        self.assertIn("Join-Path $env:RUNNER_TEMP ('cx-controller-'", source)
        self.assertIn('New-ControllerEvidence', driver)
        self.assertIn("'--evidence', $evidence", driver)
        self.assertIn('provenance_path=$evidence', driver)
        self.assertNotIn('icacls.exe $evidence', source)

    def test_local_execution_is_refused_before_creating_accounts_or_installs(self):
        environment = dict(os.environ)
        environment.pop("GITHUB_ACTIONS", None)
        process = subprocess.run(["pwsh", "-NoProfile", "-File", str(SMOKE), "-Channel", "alpha", "-Version", "1.0.0-alpha.2"], env=environment, text=True, capture_output=True)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("never run locally", process.stdout + process.stderr)

    def run_functions(self, command, shell='pwsh'):
        # Load definitions ONLY; never execute the driver/worker/installers.
        definitions = SMOKE.read_text().split("\nAssert-CI\n", 1)[0]
        with tempfile.TemporaryDirectory() as temporary:
            script = Path(temporary) / 'functions-only.ps1'
            script.write_text(definitions + "\n" + command, encoding='utf-8')
            process = subprocess.run([shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)], text=True, capture_output=True)
        return process

    def test_installed_identity_validation_rejects_real_semantic_mismatches(self):
        for field, value in ((None, None), ("DisplayVersion", "wrong"), ("InstallLocation", r"C:\wrong"), ("InstallScope", "machine"), ("BundleId", "com.other")):
            command = r'''
$Channel = 'alpha'
$record = @{ InstallLocation = 'C:\fixture'; DisplayVersion = '1.0.0'; InstallScope = 'user'; BundleId = 'com.cellxplorer.desktop.alpha' }
function Get-Registration($Product, $Hive) { if ($Hive -eq 'CurrentUser') { [pscustomobject]@{ Values = $record; ManufacturerDirectory = 'C:\fixture' } } }
function Test-Path { return $true }
function Get-Hash { return 'expected' }
function Get-Item { [pscustomobject]@{ Length = 123 } }
'''
            if field:
                command += f"\n$record['{field}'] = '{value}'"
            command += "\nAssert-Install 'CellXplorer Alpha' 'user' 'C:\\fixture' '1.0.0' 'expected'"
            with self.subTest(field=field):
                result = self.run_functions(command)
                if field:
                    self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertRegex(result.stdout + result.stderr, "changed|match|mismatch")
                else:
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_staged_hash_is_checked_under_deny_write_lock_before_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate = Path(temporary) / 'candidate.exe'
            candidate.write_bytes(b'harmless non-executable test data')
            setup = f"\n$Root = '{temporary}'\n$stage = '{candidate}'\n"
            setup += r'''
function Start-Process {
    try {
        $writer = [IO.File]::Open($stage, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    } catch [IO.IOException] { $blocked = $true }
    if ($writer) { $writer.Dispose(); throw 'Stage was writable during launch' }
    Assert-True $blocked 'Expected deny-write/delete lock'
    $p = [pscustomobject]@{ ExitCode = 0; Handle = 1 }
    $p | Add-Member ScriptMethod WaitForExit { param($Timeout) return $true }
    return $p
}
'''.replace('try {', '$writer = $null; $blocked = $false\n    try {', 1)
            result = self.run_functions(setup + f"\nInvoke-Setup $stage '/S' '{gate.sha256(candidate)}'")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            result = self.run_functions(setup + "\nInvoke-Setup $stage '/S' '" + '0' * 64 + "'")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Locked installer bytes differ', result.stdout + result.stderr)

    def test_scope_and_baseline_matrix_generates_honest_executable_cases(self):
        command = r'''
$rows = foreach ($scope in @('user', 'machine')) {
    foreach ($layout in @('default', 'custom')) {
        foreach ($baseline in @($true, $false)) {
            foreach ($operation in @('upgrade', 'same-version-reinstall')) {
                Get-InstallerCase $scope $layout $operation $baseline 'C:\custom folder\app'
            }
        }
    }
}
$rows | ConvertTo-Json
'''
        result = self.run_functions(command)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        rows = json.loads(result.stdout)
        self.assertEqual(len(rows), 16)
        self.assertEqual(sum(row['NativePriorUpgrade'] for row in rows), 4)
        self.assertEqual(sum('candidate-fresh-install' in row['Name'] for row in rows), 2)
        for row in rows:
            self.assertIn('/CXEXPECTEDDIR="C:\\custom folder\\app"', row['Options'])
            self.assertIn('/CXALLUSERS' if row['Name'].startswith('machine/') else '/CXCURRENTUSER', row['Options'])
            if row['NativePriorUpgrade'] or 'candidate-custom-update' in row['Name']:
                self.assertIn('/UPDATE', row['Options'])
            else:
                self.assertNotIn('/UPDATE', row['Options'])

    def test_installer_exit_failure_and_timeout_are_not_success(self):
        command = r'''
$Root = 'C:\fixture'
function Start-Process {
    $p = [pscustomobject]@{ ExitCode = 7; Handle = 1 }
    $p | Add-Member ScriptMethod WaitForExit { param($Timeout) return $true }
    return $p
}
Invoke-Setup 'C:\not-a-real-install\setup.exe' '/S'
'''
        result = self.run_functions(command)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Installer failed (7)", result.stdout + result.stderr)
        result = self.run_functions(command.replace('return $true', 'return $false').replace('return $p', "$p | Add-Member ScriptMethod Kill { }; return $p"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Installer timed out", result.stdout + result.stderr)

    def test_process_handle_wait_retains_real_harmless_child_exit_codes(self):
        result = self.run_functions(r'''
foreach ($expected in @(0, 7)) {
    $child = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList "-NoProfile -NonInteractive -Command `"Start-Sleep -Milliseconds 200; exit $expected`"" -PassThru -WindowStyle Hidden
    Wait-CheckedProcess $child 10000 'harmless exit-code fixture' $expected
}
''')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


@unittest.skipUnless(shutil.which("cargo"), "Rust toolchain required")
class RealSignatureVerifierTests(unittest.TestCase):
    def test_minimal_verifier_reuses_source_and_locked_production_crypto(self):
        manifest_path = ROOT / 'scripts/updater_signature_verifier/Cargo.toml'
        manifest = tomllib.loads(manifest_path.read_text())
        source = (manifest_path.parent / manifest['bin'][0]['path']).resolve()
        self.assertEqual(source, (ROOT / 'src-tauri/examples/verify_updater_signature.rs').resolve())
        production = tomllib.loads((ROOT / 'src-tauri/Cargo.lock').read_text())
        minimal = tomllib.loads((manifest_path.parent / 'Cargo.lock').read_text())
        production_versions = {(p['name'], p['version']) for p in production['package']}
        for name in ('base64', 'minisign-verify', 'serde_json'):
            version, = [p['version'] for p in minimal['package'] if p['name'] == name]
            self.assertEqual(manifest['dependencies'][name], '=' + version)
            self.assertIn((name, version), production_versions)

    def test_valid_signed_bytes_and_same_key_id_byte_tampering(self):
        # Public upstream minisign test vector; no private keys/secrets.
        key = 'untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n'
        signature = ('untrusted comment: signature from minisign secret key\n'
                     'RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\n'
                     'trusted comment: timestamp:1555779966\tfile:test\n'
                     'QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==\n')
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Path(temporary)
            (fixture / 'installer.exe').write_bytes(b'test')
            (fixture / 'installer.sig').write_text(base64.b64encode(signature.encode()).decode())
            (fixture / 'config.json').write_text(json.dumps({'plugins': {'updater': {'pubkey': base64.b64encode(key.encode()).decode()}}}))
            command = ['cargo', 'run', '--locked', '--manifest-path', str(ROOT / 'scripts/updater_signature_verifier/Cargo.toml'), '--target-dir', str(ROOT / 'src-tauri/target/signature-verifier'), '--bin', 'verify_updater_signature', '--', '--installer', str(fixture / 'installer.exe'), '--signature', str(fixture / 'installer.sig'), '--config', str(fixture / 'config.json')]
            valid = subprocess.run(command, capture_output=True, text=True, timeout=180)
            self.assertEqual(valid.returncode, 0, valid.stdout + valid.stderr)
            (fixture / 'installer.exe').write_bytes(b'tesT')
            invalid = subprocess.run(command, capture_output=True, text=True, timeout=180)
            self.assertNotEqual(invalid.returncode, 0, invalid.stdout + invalid.stderr)


if __name__ == "__main__":
    unittest.main()
