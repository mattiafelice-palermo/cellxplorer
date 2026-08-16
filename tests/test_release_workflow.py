import base64
import importlib.util
import re
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "release.yml"
PREFLIGHT_WORKFLOW = ROOT / ".github" / "workflows" / "preflight.yml"
RELEASE_TAG_PATH = ROOT / "scripts" / "release_tag.py"
VERIFY_MANIFEST_PATH = ROOT / "scripts" / "verify_updater_manifest.py"
RELEASE_CHANNELS_PATH = ROOT / "scripts" / "release_channels.py"
RELEASE_CHANNEL_POLICY_PATH = ROOT / "scripts" / "release_channel_policy.py"
RESOLVE_PREFLIGHT_PATH = ROOT / "scripts" / "resolve_preflight_reuse.py"

TAURI_ACTION_SHA = "1deb371b0cd8bd54025b384f1cd735e725c4060f"
FULL_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
USES_RE = re.compile(r"^\s+uses:\s*([^\s#]+)(?:\s*#.*)?$", re.MULTILINE)


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


release_tag = load_module(RELEASE_TAG_PATH, "release_tag")
verify_updater_manifest = load_module(VERIFY_MANIFEST_PATH, "verify_updater_manifest")
release_channels = load_module(RELEASE_CHANNELS_PATH, "release_channels")
release_channel_policy = load_module(
    RELEASE_CHANNEL_POLICY_PATH, "release_channel_policy"
)
resolve_preflight_reuse = load_module(
    RESOLVE_PREFLIGHT_PATH, "resolve_preflight_reuse"
)


def step_names(workflow: str) -> list[str]:
    return re.findall(r"^\s+- name: (.+)$", workflow, re.MULTILINE)


def step_index(workflow: str, name: str) -> int:
    return step_names(workflow).index(name)


NOTES = "- Signed in-app updates through the power menu.\n"
SETUP_EXE = "CellXplorer_0.15.0_x64-setup.exe"
BETA_SETUP_EXE = "CellXplorer.Beta_0.16.0-beta.1_x64-setup.exe"
OWNER = "mattiafelice-palermo"
REPO = "cellxplorer"
ASSET_ID = 987654321
KEY_ID = b"\x11\x22\x33\x44\x55\x66\x77\x88"
OTHER_KEY_ID = b"\xaa\xbb\xcc\xdd\xee\xff\x00\x11"


def encode_tauri_pubkey(key_id: bytes) -> str:
    blob = b"Ed" + key_id + (b"\x00" * 32)
    pub_file = (
        "untrusted comment: minisign public key: TESTKEY\n"
        f"{base64.b64encode(blob).decode('ascii')}\n"
    )
    return base64.b64encode(pub_file.encode("utf-8")).decode("ascii")


def encode_tauri_sig(key_id: bytes) -> str:
    blob = b"ED" + key_id + (b"\x00" * 64)
    sig_file = (
        "untrusted comment: signature from tauri secret key\n"
        f"{base64.b64encode(blob).decode('ascii')}\n"
        "trusted comment: timestamp:1\tfile:setup.exe\n"
        f"{base64.b64encode(b'global').decode('ascii')}\n"
    )
    return base64.b64encode(sig_file.encode("utf-8")).decode("ascii")


SIGNATURE = encode_tauri_sig(KEY_ID)
PUBKEY = encode_tauri_pubkey(KEY_ID)


def sample_manifest(**overrides) -> dict:
    payload = {
        "version": "0.15.0",
        "notes": NOTES,
        "platforms": {
            "windows-x86_64": {
                "url": (
                    f"https://api.github.com/repos/{OWNER}/{REPO}/releases/assets/{ASSET_ID}"
                ),
                "signature": SIGNATURE,
            }
        },
    }
    payload.update(overrides)
    return payload


def sample_assets(*, asset_id: int = ASSET_ID, name: str = SETUP_EXE) -> list[dict]:
    return [
        {"id": asset_id, "name": name},
        {"id": asset_id + 1, "name": f"{name}.sig"},
        {"id": asset_id + 2, "name": "latest.json"},
    ]


class ReleaseTagTests(unittest.TestCase):
    def test_accepts_exact_stable_tags(self):
        self.assertTrue(release_tag.is_stable_release_tag("v0.15.0"))
        self.assertEqual(release_tag.require_stable_release_tag("v0.15.0"), "v0.15.0")
        self.assertTrue(release_tag.is_publishable_release_tag("v0.15.0"))

    def test_accepts_beta_tags(self):
        self.assertTrue(release_tag.is_beta_release_tag("v0.16.2-beta.1"))
        self.assertTrue(release_tag.is_publishable_release_tag("v0.16.2-beta.1"))
        self.assertEqual(
            release_tag.require_publishable_release_tag("v0.16.2-beta.1"),
            "v0.16.2-beta.1",
        )
        self.assertFalse(release_tag.is_stable_release_tag("v0.16.2-beta.1"))

    def test_rejects_prerelease_and_malformed_tags(self):
        for tag in (
            "v0.15",
            "release-0.15.0",
            "v0.15.0-rc.1",
            "v0.15.0+build",
            "vfoo",
            "0.15.0",
            "v0.16.2-beta",
            "v0.16.2-alpha.1",
        ):
            with self.subTest(tag=tag):
                self.assertFalse(release_tag.is_publishable_release_tag(tag))
                with self.assertRaises(release_tag.ReleaseTagError):
                    release_tag.require_publishable_release_tag(tag)


class ReleaseChannelBranchTests(unittest.TestCase):
    def valid_tree(self) -> dict:
        return {
            "truncated": False,
            "tree": [
                {"path": "README.md", "type": "blob", "sha": "readme"},
                {"path": "stable", "type": "tree", "sha": "stable-tree"},
                {
                    "path": "stable/latest.json",
                    "type": "blob",
                    "sha": "stable-manifest",
                },
                {"path": "beta", "type": "tree", "sha": "beta-tree"},
                {
                    "path": "beta/latest.json",
                    "type": "blob",
                    "sha": "beta-manifest",
                },
            ],
        }

    def test_accepts_exact_manifest_only_tree(self):
        blobs = release_channels.validate_branch_tree(self.valid_tree())
        self.assertEqual(set(blobs), release_channels.REQUIRED_CHANNEL_PATHS)

    def test_missing_ref_or_manifest_fails_closed(self):
        missing_manifest = self.valid_tree()
        missing_manifest["tree"] = [
            entry
            for entry in missing_manifest["tree"]
            if entry["path"] != "beta/latest.json"
        ]
        missing_manifest["tree"] = [
            entry for entry in missing_manifest["tree"] if entry["path"] != "beta"
        ]
        blobs = release_channels.validate_branch_tree(
            missing_manifest, target_channel="beta"
        )
        self.assertNotIn("beta/latest.json", blobs)

        with self.assertRaises(release_channels.ReleaseChannelBranchError):
            release_channels.validate_branch_tree(
                missing_manifest, target_channel="stable"
            )

        missing_stable = self.valid_tree()
        missing_stable["tree"] = [
            entry
            for entry in missing_stable["tree"]
            if entry["path"] not in {"stable", "stable/latest.json"}
        ]
        with self.assertRaises(release_channels.ReleaseChannelBranchError):
            release_channels.validate_branch_tree(
                missing_stable, target_channel="beta"
            )

    def test_rejects_source_tree_or_truncated_response(self):
        source_tree = self.valid_tree()
        source_tree["tree"].append(
            {"path": "src-tauri/Cargo.toml", "type": "blob", "sha": "source"}
        )
        with self.assertRaises(release_channels.ReleaseChannelBranchError):
            release_channels.validate_branch_tree(source_tree)

        truncated = self.valid_tree()
        truncated["truncated"] = True
        with self.assertRaises(release_channels.ReleaseChannelBranchError):
            release_channels.validate_branch_tree(truncated)


class ReleaseChannelPolicyTests(unittest.TestCase):
    def releases(self) -> list[dict]:
        return [
            {
                "tag_name": "v0.18.0",
                "draft": False,
                "prerelease": False,
                "published_at": "2026-07-01T00:00:00Z",
            },
            {
                # Legacy Beta was incorrectly a normal release; exact tag policy ignores it.
                "tag_name": "v0.19.0-beta.1",
                "draft": False,
                "prerelease": False,
                "published_at": "2026-07-02T00:00:00Z",
            },
            {
                "tag_name": "v9.0.0",
                "draft": True,
                "prerelease": False,
                "published_at": None,
            },
            {
                "tag_name": "release-20.0.0",
                "draft": False,
                "prerelease": False,
                "published_at": "2026-07-03T00:00:00Z",
            },
        ]

    def test_beta_core_must_be_strictly_greater_than_latest_stable(self):
        with self.assertRaises(release_channel_policy.ReleaseChannelPolicyError):
            release_channel_policy.require_beta_targets_future_stable(
                "v0.18.0-beta.1", self.releases()
            )
        release_channel_policy.require_beta_targets_future_stable(
            "v0.18.1-beta.1", self.releases()
        )

    def test_legacy_beta_drafts_and_malformed_tags_are_not_stable_baselines(self):
        self.assertEqual(
            release_channel_policy.latest_real_stable_core([self.releases()]),
            (0, 18, 0),
        )

    def test_missing_real_stable_release_blocks_beta(self):
        with self.assertRaises(release_channel_policy.ReleaseChannelPolicyError):
            release_channel_policy.require_beta_targets_future_stable(
                "v0.18.1-beta.1",
                [
                    {
                        "tag_name": "v0.18.0-beta.1",
                        "draft": False,
                        "published_at": "2026-07-01T00:00:00Z",
                    }
                ],
            )


class ReleaseWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.release = RELEASE_WORKFLOW.read_text(encoding="utf-8")
        cls.preflight = PREFLIGHT_WORKFLOW.read_text(encoding="utf-8")

    def test_tag_trigger_exists_only_in_release_workflow(self):
        self.assertIn('tags:\n      - "v*"', self.release)
        self.assertNotIn("tags:", self.preflight)

    def test_main_preflight_is_not_suppressed_for_release_tags(self):
        self.assertIn("name: Clean Windows preflight", self.preflight)
        self.assertIn("branches:\n      - main", self.preflight)
        self.assertNotIn("Release-tag gate", self.preflight)
        self.assertNotIn('git tag --points-at "${GITHUB_SHA}"', self.preflight)
        self.assertNotIn("needs: gate", self.preflight)

    def test_release_uses_exact_sha_preflight_reuse_without_cancellation(self):
        self.assertIn("actions: read", self.release)
        self.assertNotIn("actions: write", self.release)
        self.assertNotIn("Cancel redundant main preflight", self.release)
        self.assertNotIn("gh run cancel", self.release)
        self.assertIn("Resolve exact-SHA canonical main preflight", self.release)
        self.assertIn("scripts/resolve_preflight_reuse.py", self.release)
        self.assertIn("--repository", self.release)
        self.assertIn("--sha", self.release)
        self.assertIn("reuse_preflight", self.release)
        self.assertIn("Run canonical release-local preflight fallback", self.release)

    def test_shared_rust_cache_is_seeded_on_main_and_restore_only_in_release(self):
        self.assertIn("name: Warm Windows release Rust cache", self.preflight)
        self.assertIn("continue-on-error: true", self.preflight)
        self.assertIn("shared-key: cellxplorer-windows-release", self.preflight)
        self.assertIn('add-job-id-key: "false"', self.preflight)
        self.assertIn("steps.rust_cache.outputs.cache-hit", self.preflight)
        self.assertIn("cargo build --release --locked --manifest-path src-tauri/Cargo.toml", self.preflight)
        self.assertIn("$env:TAURI_CONFIG = '{\"bundle\":{\"resources\":[]}}'", self.preflight)
        self.assertIn("release packaging still uses the", self.preflight)
        self.assertIn("shared-key: cellxplorer-windows-release", self.release)
        self.assertIn('add-job-id-key: "false"', self.release)
        self.assertIn('save-if: "false"', self.release)

    def test_main_preflight_dependency_installation_uses_native_parallel_group(self):
        self.assertIn("      - parallel:\n", self.preflight)
        parallel = self.preflight.split("      - parallel:\n", 1)[1]
        parallel = parallel.split("      - name: Run CellXplorer preflight", 1)[0]
        self.assertIn("Install backend dependencies", parallel)
        self.assertIn("python -m pip install -r backend/requirements.txt", parallel)
        self.assertIn("python -m pip check", parallel)
        self.assertIn("Install frontend dependencies", parallel)
        self.assertIn("npm --prefix frontend ci", parallel)

    def test_dependency_installation_uses_native_parallel_group(self):
        self.assertIn("      - parallel:\n", self.release)
        parallel = self.release.split("      - parallel:\n", 1)[1]
        parallel = parallel.split("      - name: Resolve release channel", 1)[0]
        self.assertIn("Install backend dependencies", parallel)
        self.assertIn("python -m pip install -r backend/requirements.txt", parallel)
        self.assertIn("python -m pip install pyinstaller", parallel)
        self.assertIn("Install frontend and Tauri CLI dependencies", parallel)
        self.assertIn("npm ci", parallel)
        self.assertIn("npm --prefix frontend ci", parallel)

    def test_reused_preflight_builds_release_inputs_in_parallel_before_verification(self):
        self.assertIn("Build requested frontend channel", self.release)
        self.assertIn("Build Python sidecar", self.release)
        self.assertIn("github.ref_type == 'tag' && steps.preflight_reuse.outputs.reuse_preflight == 'true'", self.release)
        parallel = self.release.split("      - parallel:\n", 1)[1]
        parallel = parallel.split("      - name: Build Python sidecar (release-local preflight fallback)", 1)[0]
        self.assertIn("Build requested frontend channel", parallel)
        self.assertIn("Build Python sidecar", parallel)
        verify = step_index(self.release, "Verify requested frontend channel stamp")
        sidecar_fallback = step_index(self.release, "Build Python sidecar (release-local preflight fallback)")
        self.assertLess(sidecar_fallback, verify)
        self.assertLess(verify, step_index(self.release, "Smoke test the packaged backend"))
        self.assertLess(
            step_index(self.release, "Run canonical release-local preflight fallback"),
            step_index(self.release, "Stamp release-local preflight frontend"),
        )
        self.assertLess(
            step_index(self.release, "Stamp release-local preflight frontend"),
            sidecar_fallback,
        )
        fallback_preflight = self.release.split(
            "Run canonical release-local preflight fallback", 1
        )[1].split("Stamp release-local preflight frontend", 1)[0]
        self.assertIn("VITE_CELLXPLORER_CHANNEL", fallback_preflight)
        self.assertIn("python scripts/preflight.py --no-cache", fallback_preflight)

    def test_manual_dispatch_accepts_channel_input(self):
        self.assertIn("workflow_dispatch:", self.release)
        self.assertIn("channel:", self.release)
        self.assertIn("- stable", self.release)
        self.assertIn("- beta", self.release)

    def test_release_resolves_stable_and_beta_channels(self):
        self.assertIn("Resolve release channel", self.release)
        self.assertIn("channel_manifest=stable/latest.json", self.release)
        self.assertIn("channel_manifest=beta/latest.json", self.release)
        self.assertIn("VITE_CELLXPLORER_CHANNEL", self.release)
        self.assertIn("tauri.beta.conf.json", self.release)

    def test_requested_frontend_channel_is_built_and_verified_before_packaging(self):
        build = step_index(self.release, "Build requested frontend channel")
        verify = step_index(self.release, "Verify requested frontend channel stamp")
        reverify = step_index(
            self.release, "Reverify frontend channel immediately before packaging"
        )
        tag_package = step_index(self.release, "Stage signed draft release")
        manual_package = step_index(self.release, "Build release artifacts only")

        self.assertLess(build, verify)
        self.assertLess(verify, reverify)
        self.assertLess(reverify, tag_package)
        self.assertLess(reverify, manual_package)
        self.assertIn(
            'python scripts/build_frontend_channel.py "${{ steps.channel.outputs.channel }}"',
            self.release,
        )
        self.assertGreaterEqual(
            self.release.count(
                'python scripts/frontend_channel.py verify --channel "${{ steps.channel.outputs.channel }}"'
            ),
            2,
        )

    def test_beta_tags_publish_as_prereleases(self):
        self.assertIn("is_prerelease=true", self.release)
        self.assertIn("prerelease: ${{ steps.channel.outputs.is_prerelease == 'true' }}", self.release)

    def test_channel_manifest_is_published_after_verification(self):
        self.assertIn("Publish channel manifest pointer", self.release)
        self.assertLess(
            step_index(self.release, "Verify updater manifest"),
            step_index(self.release, "Publish channel manifest pointer"),
        )
        self.assertLess(
            step_index(self.release, "Publish verified draft release"),
            step_index(self.release, "Publish channel manifest pointer"),
        )

    def test_manifest_only_branch_gate_runs_before_draft_staging(self):
        self.assertLess(
            step_index(self.release, "Require manifest-only release channel branch"),
            step_index(self.release, "Stage signed draft release"),
        )
        self.assertIn(
            "python scripts/release_channels.py `",
            self.release,
        )
        self.assertIn(
            '--target-channel "${{ steps.channel.outputs.channel }}"',
            self.release,
        )
        self.assertIn("release-channels is not provisioned", self.release)
        self.assertNotIn('git/ref/heads/main"', self.release)
        self.assertNotIn("Initialize release channel manifests", self.release)

    def test_beta_future_stable_policy_runs_before_draft_staging(self):
        self.assertLess(
            step_index(self.release, "Require Beta targets a future Stable version"),
            step_index(self.release, "Stage signed draft release"),
        )
        self.assertIn("gh api --paginate --slurp", self.release)
        self.assertIn("scripts/release_channel_policy.py", self.release)
        self.assertIn(
            "steps.channel.outputs.channel == 'beta'",
            self.release,
        )

    def test_channel_pointer_update_is_optimistic_and_preserves_other_channel(self):
        publish = self.release.split("Publish channel manifest pointer", 1)[1]
        self.assertIn("steps.channel_branch.outputs.target_sha", publish)
        self.assertIn("steps.channel_branch.outputs.target_ref_sha", publish)
        self.assertIn("steps.channel_branch.outputs.other_sha", publish)
        self.assertIn("The target channel pointer changed", publish)
        self.assertIn("The release channel branch changed after the first-write gate", publish)
        self.assertIn("The non-target channel pointer changed", publish)
        self.assertIn("$publishedCommit = $putResult.commit.sha", publish)
        self.assertIn("contents/${channelPath}?ref=${branch}", publish)
        self.assertIn("contents/${channelPath}?ref=${publishedCommit}", publish)
        self.assertIn("contents/${otherPath}?ref=${publishedCommit}", publish)
        self.assertNotRegex(publish, r"\$[A-Za-z_][A-Za-z0-9_]*\?ref=")
        self.assertIn('[System.IO.File]::WriteAllBytes("remote-channel-latest.json", $remoteBytes)', publish)

    def test_manual_dispatch_is_build_only(self):
        self.assertIn("workflow_dispatch:", self.release)
        self.assertNotIn("publish:", self.release)
        self.assertIn("uploadWorkflowArtifacts: true", self.release)
        self.assertNotIn("inputs.publish", self.release)

    def test_concurrency_serializes_release_runs(self):
        self.assertIn("group: cellxplorer-release-${{ github.ref }}", self.release)
        self.assertIn("cancel-in-progress: false", self.release)

    def test_stable_tag_and_main_ancestry_guards_exist(self):
        self.assertIn("python scripts/release_tag.py --tag", self.release)
        self.assertIn("Require publishable SemVer tag", self.release)
        self.assertIn("git merge-base --is-ancestor", self.release)
        self.assertIn("Refuse to replace an already published release", self.release)

    def test_private_repository_blocks_tag_publish(self):
        self.assertIn("Require public repository for publishing", self.release)
        self.assertIn("github.event.repository.private", self.release)

    def test_draft_staging_then_publish_after_verification(self):
        self.assertIn("releaseDraft: true", self.release)
        self.assertNotIn("releaseDraft: false", self.release)
        self.assertLess(
            step_index(self.release, "Stage signed draft release"),
            step_index(self.release, "Verify updater manifest"),
        )
        self.assertLess(
            step_index(self.release, "Download staged draft manifest and signature"),
            step_index(self.release, "Verify updater manifest"),
        )
        self.assertLess(
            step_index(self.release, "Verify updater manifest"),
            step_index(self.release, "Publish verified draft release"),
        )

    def test_manifest_is_read_from_workspace_root(self):
        self.assertIn('Join-Path $env:GITHUB_WORKSPACE "latest.json"', self.release)
        self.assertNotIn("src-tauri/target", self.release)

    def test_uploaded_manifest_and_signature_are_verified(self):
        self.assertIn("uploaded-latest.json", self.release)
        self.assertIn("uploaded-setup.sig", self.release)
        self.assertIn(
            "--tauri-conf ${{ steps.channel.outputs.updater_key_conf }}",
            self.release,
        )
        self.assertIn(
            "updater_key_conf=src-tauri/tauri.conf.json",
            self.release,
        )
        self.assertNotIn(
            "updater_key_conf=src-tauri/tauri.beta.conf.json",
            self.release,
        )
        self.assertIn("--uploaded-signature uploaded-setup.sig", self.release)
        self.assertIn(
            '--setup-exe-name "${{ steps.staged_assets.outputs.setup_name }}"',
            self.release,
        )
        self.assertIn(
            'Where-Object { $_.name -like "*.exe.sig" }',
            self.release,
        )

    def test_release_assets_metadata_persists_raw_github_json(self):
        export = self.release.split("Export draft release assets metadata", 1)[1]
        export = export.split("Download staged draft manifest", 1)[0]
        self.assertIn("Invoke-WebRequest", export)
        self.assertIn("$response.Content", export)
        self.assertNotIn("ConvertTo-Json -InputObject $assets", export)

    def test_all_third_party_actions_are_full_sha_pinned(self):
        refs = []
        for match in USES_RE.finditer(self.release):
            uses = match.group(1)
            self.assertIn("@", uses, uses)
            action, ref = uses.rsplit("@", 1)
            if action.startswith("./"):
                continue
            refs.append((action, ref))
            self.assertRegex(ref, FULL_SHA_RE, msg=f"{action} is not pinned to a full SHA")
            self.assertFalse(ref.startswith("v"), msg=f"{action} uses floating tag {ref}")
            self.assertNotIn(ref, {"stable", "main", "master"})
        actions = {action for action, _ref in refs}
        self.assertIn("dtolnay/rust-toolchain", actions)
        self.assertIn("Swatinem/rust-cache", actions)
        self.assertIn(f"tauri-apps/tauri-action@{TAURI_ACTION_SHA}", self.release)

    def test_release_preflight_uses_no_cache(self):
        self.assertIn("python scripts/preflight.py --no-cache", self.release)

    def test_sidecar_is_prepared_with_existing_build_script(self):
        self.assertIn(
            '.\\scripts\\build-app.ps1 -Channel "${{ steps.channel.outputs.channel }}" '
            "-SkipInstall -SkipFrontend -SkipInstaller -ForceBackend",
            self.release,
        )

    def test_signing_secret_names_are_present_without_values(self):
        for name in (
            "TAURI_SIGNING_PRIVATE_KEY",
            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
        ):
            self.assertIn(name, self.release)
            self.assertNotIn(f"{name}=", self.release)


class PreflightReuseResolutionTests(unittest.TestCase):
    SHA = "a" * 40

    def run_row(self, run_id: int, **overrides) -> dict:
        row = {
            "id": run_id,
            "path": ".github/workflows/preflight.yml",
            "name": "CellXplorer preflight",
            "head_sha": self.SHA,
            "event": "push",
            "head_branch": "main",
            "status": "completed",
            "conclusion": "success",
            "created_at": f"2026-08-16T12:00:{run_id:02d}Z",
        }
        row.update(overrides)
        return row

    def jobs(self, conclusion: str = "success", **overrides) -> dict:
        job = {
            "id": 123,
            "name": "Clean Windows preflight",
            "status": "completed",
            "conclusion": conclusion,
        }
        job.update(overrides)
        return {"jobs": [job]}

    def test_trusted_runs_require_exact_path_name_sha_push_and_main(self):
        valid = self.run_row(1)
        rows = [
            valid,
            self.run_row(2, path=".github/workflows/other.yml"),
            self.run_row(3, name="Other workflow"),
            self.run_row(4, head_sha="b" * 40),
            self.run_row(5, event="workflow_dispatch"),
            self.run_row(6, head_branch="feature/test"),
        ]
        result = resolve_preflight_reuse.trusted_runs(
            {"workflow_runs": rows}, sha=self.SHA
        )
        self.assertEqual([row["id"] for row in result], [1])

    def test_completed_job_success_is_reusable_even_if_cache_helper_failed(self):
        outcome, reason = resolve_preflight_reuse.classify_completed_run(
            self.run_row(1, conclusion="failure"), self.jobs()
        )
        self.assertEqual(outcome, "success")
        self.assertIn("canonical job succeeded", reason)

    def test_failed_canonical_job_blocks_release(self):
        outcome, reason = resolve_preflight_reuse.classify_completed_run(
            self.run_row(1), self.jobs("failure")
        )
        self.assertEqual(outcome, "failure")
        self.assertIn("failure", reason)

    def test_cancelled_or_missing_canonical_job_uses_full_fallback(self):
        cancelled, _ = resolve_preflight_reuse.classify_completed_run(
            self.run_row(1), self.jobs("cancelled")
        )
        missing, _ = resolve_preflight_reuse.classify_completed_run(
            self.run_row(1), {"jobs": []}
        )
        self.assertEqual(cancelled, "fallback")
        self.assertEqual(missing, "fallback")

    def test_active_run_is_polled_until_the_canonical_job_succeeds(self):
        active = self.run_row(1, status="in_progress", conclusion=None)
        completed = self.run_row(1, status="completed", conclusion="success")
        run_payloads = [{"workflow_runs": [active]}, {"workflow_runs": [completed]}]
        job_payloads = [
            self.jobs(status="in_progress", conclusion=None),
            self.jobs(),
        ]

        def api(endpoint: str):
            if "/jobs?" in endpoint:
                return job_payloads.pop(0)
            return run_payloads.pop(0)

        result = resolve_preflight_reuse.resolve_preflight(
            repository="owner/repo",
            sha=self.SHA,
            wait_seconds=30,
            poll_seconds=1,
            api_call=api,
            sleep=lambda _seconds: None,
            clock=lambda: 0.0,
        )
        self.assertEqual(result["reuse_preflight"], "true")
        self.assertEqual(result["preflight_run_id"], "1")

    def test_active_run_timeout_is_fail_closed(self):
        active = self.run_row(1, status="in_progress", conclusion=None)

        def api(endpoint: str):
            if "/jobs?" in endpoint:
                return self.jobs(status="in_progress", conclusion=None)
            return {"workflow_runs": [active]}

        with self.assertRaises(resolve_preflight_reuse.PreflightResolutionError):
            resolve_preflight_reuse.resolve_preflight(
                repository="owner/repo",
                sha=self.SHA,
                wait_seconds=0,
                api_call=api,
                sleep=lambda _seconds: None,
                clock=lambda: 0.0,
            )

    def test_missing_trusted_run_uses_full_fallback(self):
        result = resolve_preflight_reuse.resolve_preflight(
            repository="owner/repo",
            sha=self.SHA,
            api_call=lambda _endpoint: {"workflow_runs": []},
        )
        self.assertEqual(result["reuse_preflight"], "false")
        self.assertIn("no trusted main-push preflight run", result["preflight_reason"])

    def test_active_workflow_reuses_completed_canonical_job_without_waiting_for_cache_helper(self):
        active = self.run_row(1, status="in_progress", conclusion=None)
        jobs = {
            "jobs": [
                {
                    "name": "Clean Windows preflight",
                    "status": "completed",
                    "conclusion": "success",
                },
                {
                    "name": "Warm Windows release Rust cache",
                    "status": "in_progress",
                    "conclusion": None,
                },
            ]
        }
        sleeps: list[float] = []
        result = resolve_preflight_reuse.resolve_preflight(
            repository="owner/repo",
            sha=self.SHA,
            api_call=lambda endpoint: jobs if "/jobs?" in endpoint else {"workflow_runs": [active]},
            sleep=sleeps.append,
        )
        self.assertEqual(result["reuse_preflight"], "true")
        self.assertEqual(sleeps, [])

    def test_active_workflow_canonical_failure_blocks_without_waiting_for_cache_helper(self):
        active = self.run_row(1, status="in_progress", conclusion=None)
        jobs = {
            "jobs": [
                {
                    "name": "Clean Windows preflight",
                    "status": "completed",
                    "conclusion": "failure",
                },
                {
                    "name": "Warm Windows release Rust cache",
                    "status": "in_progress",
                    "conclusion": None,
                },
            ]
        }
        with self.assertRaises(resolve_preflight_reuse.PreflightResolutionError):
            resolve_preflight_reuse.resolve_preflight(
                repository="owner/repo",
                sha=self.SHA,
                api_call=lambda endpoint: jobs if "/jobs?" in endpoint else {"workflow_runs": [active]},
                sleep=lambda _seconds: self.fail("cache helper must not delay canonical failure"),
            )

    def test_missing_github_cli_fails_closed(self):
        with mock.patch.object(
            resolve_preflight_reuse.subprocess,
            "run",
            side_effect=FileNotFoundError("gh"),
        ):
            with self.assertRaises(resolve_preflight_reuse.PreflightResolutionError) as error:
                resolve_preflight_reuse.github_api("owner/repo", "repos/owner/repo")
        self.assertIn("GitHub CLI is unavailable", str(error.exception))


class VerifyUpdaterManifestTests(unittest.TestCase):
    def test_accepts_tauri_action_v1_api_asset_manifest(self):
        verify_updater_manifest.verify_manifest(
            sample_manifest(),
            expected_version="v0.15.0",
            expected_notes=NOTES,
            expected_owner=OWNER,
            expected_repo=REPO,
            release_assets=sample_assets(),
            setup_exe_name=SETUP_EXE,
            pubkey_b64=PUBKEY,
            uploaded_signature_text=SIGNATURE,
        )

    def test_rejects_browser_download_url_shape(self):
        manifest = sample_manifest()
        manifest["platforms"]["windows-x86_64"]["url"] = (
            f"https://github.com/{OWNER}/{REPO}/releases/download/v0.15.0/{SETUP_EXE}"
        )
        with self.assertRaises(verify_updater_manifest.ManifestVerificationError):
            verify_updater_manifest.verify_manifest(
                manifest,
                expected_version="0.15.0",
                expected_notes=NOTES,
                expected_owner=OWNER,
                expected_repo=REPO,
                release_assets=sample_assets(),
            )

    def test_rejects_wrong_owner_repo_or_asset_name(self):
        with self.assertRaises(verify_updater_manifest.ManifestVerificationError):
            verify_updater_manifest.verify_manifest(
                sample_manifest(),
                expected_version="0.15.0",
                expected_notes=NOTES,
                expected_owner="other-owner",
                expected_repo=REPO,
                release_assets=sample_assets(),
            )
        with self.assertRaises(verify_updater_manifest.ManifestVerificationError):
            verify_updater_manifest.verify_manifest(
                sample_manifest(),
                expected_version="0.15.0",
                expected_notes=NOTES,
                expected_owner=OWNER,
                expected_repo=REPO,
                release_assets=sample_assets(name="wrong-setup.exe"),
            )

    def test_rejects_missing_latest_json_asset(self):
        assets = [
            {"id": ASSET_ID, "name": SETUP_EXE},
            {"id": ASSET_ID + 1, "name": f"{SETUP_EXE}.sig"},
        ]
        with self.assertRaises(verify_updater_manifest.ManifestVerificationError):
            verify_updater_manifest.verify_manifest(
                sample_manifest(),
                expected_version="0.15.0",
                expected_notes=NOTES,
                expected_owner=OWNER,
                expected_repo=REPO,
                release_assets=assets,
            )

    def test_rejects_uploaded_signature_mismatch(self):
        with self.assertRaises(verify_updater_manifest.ManifestVerificationError):
            verify_updater_manifest.verify_manifest(
                sample_manifest(),
                expected_version="0.15.0",
                expected_notes=NOTES,
                expected_owner=OWNER,
                expected_repo=REPO,
                release_assets=sample_assets(),
                uploaded_signature_text=encode_tauri_sig(OTHER_KEY_ID),
            )

    def test_rejects_mismatched_signing_key_identity(self):
        with self.assertRaises(verify_updater_manifest.ManifestVerificationError):
            verify_updater_manifest.verify_manifest(
                sample_manifest(),
                expected_version="0.15.0",
                expected_notes=NOTES,
                expected_owner=OWNER,
                expected_repo=REPO,
                release_assets=sample_assets(),
                pubkey_b64=encode_tauri_pubkey(OTHER_KEY_ID),
                uploaded_signature_text=SIGNATURE,
            )

    def test_rejects_missing_sig_wrong_version_notes_or_empty_signature(self):
        assets_without_sig = [
            {"id": ASSET_ID, "name": SETUP_EXE},
            {"id": ASSET_ID + 2, "name": "latest.json"},
        ]
        with self.assertRaises(verify_updater_manifest.ManifestVerificationError):
            verify_updater_manifest.verify_manifest(
                sample_manifest(),
                expected_version="0.15.0",
                expected_notes=NOTES,
                expected_owner=OWNER,
                expected_repo=REPO,
                release_assets=assets_without_sig,
            )

        bad_version = sample_manifest(version="0.15.1")
        with self.assertRaises(verify_updater_manifest.ManifestVerificationError):
            verify_updater_manifest.verify_manifest(
                bad_version,
                expected_version="0.15.0",
                expected_notes=NOTES,
                expected_owner=OWNER,
                expected_repo=REPO,
                release_assets=sample_assets(),
            )

        bad_notes = sample_manifest(notes="- Different notes.\n")
        with self.assertRaises(verify_updater_manifest.ManifestVerificationError):
            verify_updater_manifest.verify_manifest(
                bad_notes,
                expected_version="0.15.0",
                expected_notes=NOTES,
                expected_owner=OWNER,
                expected_repo=REPO,
                release_assets=sample_assets(),
            )

        empty_sig = sample_manifest()
        empty_sig["platforms"]["windows-x86_64"]["signature"] = "   "
        with self.assertRaises(verify_updater_manifest.ManifestVerificationError):
            verify_updater_manifest.verify_manifest(
                empty_sig,
                expected_version="0.15.0",
                expected_notes=NOTES,
                expected_owner=OWNER,
                expected_repo=REPO,
                release_assets=sample_assets(),
            )

    def test_cli_accepts_fixture_files_offline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = root / "latest.json"
            notes_path = root / "notes.md"
            assets_path = root / "assets.json"
            sig_path = root / "setup.sig"
            conf_path = root / "tauri.conf.json"
            manifest_path.write_text(
                __import__("json").dumps(sample_manifest()),
                encoding="utf-8",
            )
            notes_path.write_text(NOTES, encoding="utf-8")
            assets_path.write_text(
                __import__("json").dumps(sample_assets()),
                encoding="utf-8",
            )
            sig_path.write_text(SIGNATURE, encoding="utf-8")
            conf_path.write_text(
                __import__("json").dumps({"plugins": {"updater": {"pubkey": PUBKEY}}}),
                encoding="utf-8",
            )
            code = verify_updater_manifest.main(
                [
                    "--manifest",
                    str(manifest_path),
                    "--expected-version",
                    "v0.15.0",
                    "--notes-file",
                    str(notes_path),
                    "--owner",
                    OWNER,
                    "--repo",
                    REPO,
                    "--release-assets",
                    str(assets_path),
                    "--tauri-conf",
                    str(conf_path),
                    "--uploaded-signature",
                    str(sig_path),
                ]
            )
            self.assertEqual(code, 0)

    def test_beta_cli_uses_inherited_base_public_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest_path = root / "latest.json"
            notes_path = root / "notes.md"
            assets_path = root / "assets.json"
            sig_path = root / "setup.sig"
            base_conf_path = root / "tauri.conf.json"

            manifest_path.write_text(
                __import__("json").dumps(
                    sample_manifest(version="0.16.0-beta.1")
                ),
                encoding="utf-8",
            )
            notes_path.write_text(NOTES, encoding="utf-8")
            assets_path.write_text(
                __import__("json").dumps(
                    sample_assets(name=BETA_SETUP_EXE)
                ),
                encoding="utf-8",
            )
            sig_path.write_text(SIGNATURE, encoding="utf-8")
            base_conf_path.write_text(
                __import__("json").dumps(
                    {"plugins": {"updater": {"pubkey": PUBKEY}}}
                ),
                encoding="utf-8",
            )

            arguments = [
                "--manifest",
                str(manifest_path),
                "--expected-version",
                "v0.16.0-beta.1",
                "--notes-file",
                str(notes_path),
                "--owner",
                OWNER,
                "--repo",
                REPO,
                "--release-assets",
                str(assets_path),
                "--tauri-conf",
                str(base_conf_path),
                "--uploaded-signature",
                str(sig_path),
                "--channel",
                "beta",
                "--expected-product-name",
                "CellXplorer Beta",
            ]
            self.assertEqual(verify_updater_manifest.main(arguments), 0)

            base_conf_path.write_text(
                __import__("json").dumps(
                    {
                        "plugins": {
                            "updater": {
                                "pubkey": encode_tauri_pubkey(OTHER_KEY_ID)
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(verify_updater_manifest.main(arguments), 1)

    def test_load_release_assets_unwraps_powershell_nested_array(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "assets.json"
            path.write_text(
                __import__("json").dumps([sample_assets()]),
                encoding="utf-8",
            )
            loaded = verify_updater_manifest.load_release_assets(path)
            self.assertEqual(loaded, sample_assets())

    def test_load_release_assets_rejects_stringified_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "assets.json"
            path.write_text('["@{name=latest.json}"]', encoding="utf-8")
            with self.assertRaises(verify_updater_manifest.ManifestVerificationError) as ctx:
                verify_updater_manifest.load_release_assets(path)
            self.assertIn("index 0", str(ctx.exception))
            self.assertIn("ConvertTo-Json", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
