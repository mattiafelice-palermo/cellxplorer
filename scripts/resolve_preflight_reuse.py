#!/usr/bin/env python3
"""Resolve whether a release may reuse the exact-SHA Windows preflight."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any


DEFAULT_WORKFLOW_PATH = ".github/workflows/preflight.yml"
DEFAULT_WORKFLOW_NAME = "CellXplorer preflight"
DEFAULT_JOB_NAME = "Clean Windows preflight"
ACTIVE_RUN_STATUSES = frozenset(
    {"queued", "in_progress", "waiting", "requested", "pending"}
)
FALLBACK_JOB_CONCLUSIONS = frozenset({"cancelled", "skipped", "neutral", "stale"})
FAILED_JOB_CONCLUSIONS = frozenset(
    {"failure", "timed_out", "startup_failure", "action_required"}
)

ApiCall = Callable[[str], Any]
Sleep = Callable[[float], None]
Clock = Callable[[], float]


class PreflightResolutionError(RuntimeError):
    """Raised when the exact-SHA result cannot be trusted safely."""


def _mapping(value: Any, *, context: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PreflightResolutionError(f"GitHub returned an invalid {context} payload.")
    return value


def _run_id(run: Mapping[str, Any]) -> int:
    value = run.get("id")
    if isinstance(value, bool):
        raise PreflightResolutionError("GitHub returned an invalid preflight run id.")
    try:
        return int(value)
    except (TypeError, ValueError) as error:
        raise PreflightResolutionError(
            "GitHub returned an invalid preflight run id."
        ) from error


def trusted_runs(
    payload: Any,
    *,
    sha: str,
    workflow_path: str = DEFAULT_WORKFLOW_PATH,
    workflow_name: str = DEFAULT_WORKFLOW_NAME,
) -> list[Mapping[str, Any]]:
    """Return only canonical main-push runs for the exact commit, newest first."""

    data = _mapping(payload, context="workflow-runs")
    rows = data.get("workflow_runs")
    if not isinstance(rows, list):
        raise PreflightResolutionError("GitHub workflow-runs payload has no run list.")

    trusted: list[Mapping[str, Any]] = []
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        if (
            row.get("path") == workflow_path
            and row.get("name") == workflow_name
            and row.get("head_sha") == sha
            and row.get("event") == "push"
            and row.get("head_branch") == "main"
        ):
            trusted.append(row)

    return sorted(
        trusted,
        key=lambda row: (str(row.get("created_at", "")), _run_id(row)),
        reverse=True,
    )


def _jobs(payload: Any) -> list[Mapping[str, Any]]:
    data = _mapping(payload, context="workflow-jobs")
    rows = data.get("jobs")
    if not isinstance(rows, list):
        raise PreflightResolutionError("GitHub workflow-jobs payload has no job list.")
    return [row for row in rows if isinstance(row, Mapping)]


def classify_completed_run(
    run: Mapping[str, Any],
    jobs_payload: Any,
    *,
    job_name: str = DEFAULT_JOB_NAME,
) -> tuple[str, str]:
    """Classify a completed run as reusable, fallback, or release-blocking."""

    matching_jobs = [job for job in _jobs(jobs_payload) if job.get("name") == job_name]
    if len(matching_jobs) != 1:
        return "fallback", f"canonical job {job_name!r} is missing or ambiguous"

    job = matching_jobs[0]
    if job.get("status") != "completed":
        return "fallback", f"canonical job status is {job.get('status')!r}"

    conclusion = job.get("conclusion")
    if conclusion == "success":
        overall = run.get("conclusion") or "unknown"
        return "success", f"canonical job succeeded (workflow conclusion: {overall})"
    if conclusion in FALLBACK_JOB_CONCLUSIONS:
        return "fallback", f"canonical job conclusion is {conclusion!r}"
    if conclusion in FAILED_JOB_CONCLUSIONS:
        return "failure", f"canonical job conclusion is {conclusion!r}"
    return "fallback", f"canonical job conclusion is {conclusion!r}"


def _inspect_latest(
    *,
    repository: str,
    sha: str,
    workflow_path: str,
    workflow_name: str,
    job_name: str,
    api_call: ApiCall,
) -> tuple[str, str, int | None]:
    workflow_file = workflow_path.rsplit("/", 1)[-1]
    runs_endpoint = (
        f"repos/{repository}/actions/workflows/{workflow_file}/runs"
        f"?head_sha={sha}&event=push&per_page=100"
    )
    runs = trusted_runs(
        api_call(runs_endpoint),
        sha=sha,
        workflow_path=workflow_path,
        workflow_name=workflow_name,
    )
    if not runs:
        return "fallback", "no trusted main-push preflight run exists", None

    run = runs[0]
    run_id = _run_id(run)
    status = run.get("status")
    if status in ACTIVE_RUN_STATUSES:
        return "active", f"trusted run {run_id} is {status}", run_id
    if status != "completed":
        raise PreflightResolutionError(
            f"Trusted preflight run {run_id} has unexpected status {status!r}."
        )

    jobs_payload = api_call(f"repos/{repository}/actions/runs/{run_id}/jobs?per_page=100")
    outcome, reason = classify_completed_run(run, jobs_payload, job_name=job_name)
    return outcome, f"run {run_id}: {reason}", run_id


def resolve_preflight(
    *,
    repository: str,
    sha: str,
    workflow_path: str = DEFAULT_WORKFLOW_PATH,
    workflow_name: str = DEFAULT_WORKFLOW_NAME,
    job_name: str = DEFAULT_JOB_NAME,
    wait_seconds: int = 600,
    poll_seconds: int = 15,
    api_call: ApiCall,
    sleep: Sleep = time.sleep,
    clock: Clock = time.monotonic,
) -> dict[str, str | int]:
    """Resolve the exact-SHA reuse decision, waiting only for an active run."""

    if not repository or not sha:
        raise PreflightResolutionError("Repository and exact commit SHA are required.")
    if wait_seconds < 0 or poll_seconds <= 0:
        raise ValueError("wait_seconds must be non-negative and poll_seconds must be positive")

    outcome, reason, run_id = _inspect_latest(
        repository=repository,
        sha=sha,
        workflow_path=workflow_path,
        workflow_name=workflow_name,
        job_name=job_name,
        api_call=api_call,
    )
    deadline = clock() + wait_seconds
    while outcome == "active":
        remaining = deadline - clock()
        if remaining <= 0:
            raise PreflightResolutionError(
                f"Timed out waiting for the exact-SHA canonical preflight ({reason})."
            )
        sleep(min(float(poll_seconds), remaining))
        outcome, reason, run_id = _inspect_latest(
            repository=repository,
            sha=sha,
            workflow_path=workflow_path,
            workflow_name=workflow_name,
            job_name=job_name,
            api_call=api_call,
        )

    if outcome == "failure":
        raise PreflightResolutionError(
            f"The exact-SHA canonical Windows preflight failed; release is blocked ({reason})."
        )

    return {
        "reuse_preflight": "true" if outcome == "success" else "false",
        "preflight_run_id": str(run_id or ""),
        "preflight_reason": reason,
    }


def github_api(repository: str, endpoint: str) -> Any:
    """Read one GitHub REST endpoint through the preinstalled GitHub CLI."""

    try:
        completed = subprocess.run(
            ["gh", "api", endpoint],
            capture_output=True,
            text=True,
            check=False,
            env=os.environ.copy(),
        )
    except OSError as error:
        raise PreflightResolutionError(
            "GitHub CLI is unavailable; exact-SHA preflight reuse cannot be resolved."
        ) from error
    if completed.returncode != 0:
        detail = completed.stderr.strip() or "no error details"
        raise PreflightResolutionError(
            f"GitHub API query failed for {endpoint}: {detail}"
        )
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise PreflightResolutionError(
            f"GitHub API returned invalid JSON for {endpoint}."
        ) from error


def write_outputs(path: Path, values: Mapping[str, str | int]) -> None:
    """Append safe single-line outputs for GitHub Actions."""

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as output:
        for key, value in values.items():
            safe_value = str(value).replace("\r", " ").replace("\n", " ")
            output.write(f"{key}={safe_value}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workflow-path", default=DEFAULT_WORKFLOW_PATH)
    parser.add_argument("--workflow-name", default=DEFAULT_WORKFLOW_NAME)
    parser.add_argument("--job-name", default=DEFAULT_JOB_NAME)
    parser.add_argument("--wait-seconds", type=int, default=600)
    parser.add_argument("--poll-seconds", type=int, default=15)
    args = parser.parse_args(argv)

    try:
        result = resolve_preflight(
            repository=args.repository,
            sha=args.sha,
            workflow_path=args.workflow_path,
            workflow_name=args.workflow_name,
            job_name=args.job_name,
            wait_seconds=args.wait_seconds,
            poll_seconds=args.poll_seconds,
            api_call=lambda endpoint: github_api(args.repository, endpoint),
        )
        write_outputs(args.output, result)
    except (PreflightResolutionError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(
        f"Exact-SHA preflight decision: reuse={result['reuse_preflight']} "
        f"run={result['preflight_run_id'] or 'none'} ({result['preflight_reason']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
