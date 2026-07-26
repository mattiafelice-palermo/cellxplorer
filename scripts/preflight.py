#!/usr/bin/env python3
"""Run the canonical CellXplorer local verification checks."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path


RunCommand = Callable[[list[str], Path, dict[str, str]], int]

STAGE_COUNT = 4


@dataclass(frozen=True)
class Stage:
    number: int
    name: str
    command: list[str]


def repo_root(start: Path | None = None) -> Path:
    return (start or Path(__file__).resolve()).parents[1]


def default_backend_jobs() -> int:
    cpu = os.cpu_count() or 4
    return max(1, min(16, cpu))


def discover_frontend_test_files(root: Path) -> list[Path]:
    return sorted((root / "frontend" / "tests").glob("*.test.ts"))


def find_node_executable() -> str | None:
    return shutil.which("node")


def find_npm_executable() -> str | None:
    for name in ("npm", "npm.cmd"):
        path = shutil.which(name)
        if path:
            return path
    return None


def validate_python_version() -> str | None:
    if sys.version_info < (3, 12):
        current = ".".join(str(part) for part in sys.version_info[:3])
        return f"Python 3.12 or newer is required (found {current})."
    return None


def validate_prerequisites(
    root: Path,
    *,
    node_executable: str | None = None,
    npm_executable: str | None = None,
) -> str | None:
    if error := validate_python_version():
        return error
    if node_executable is None:
        node_executable = find_node_executable()
    if node_executable is None:
        return "Node.js is not available on PATH."
    if npm_executable is None:
        npm_executable = find_npm_executable()
    if npm_executable is None:
        return "npm is not available on PATH."
    if not (root / "frontend" / "node_modules").is_dir():
        return (
            "Frontend dependencies are not installed.\n"
            "Run: npm --prefix frontend ci"
        )
    if not discover_frontend_test_files(root):
        return "No frontend policy tests were found in frontend/tests/*.test.ts."
    return None


def build_stages(
    root: Path,
    *,
    python_executable: str | None = None,
    node_executable: str | None = None,
    npm_executable: str | None = None,
    backend_jobs: int | None = None,
) -> list[Stage]:
    python_executable = python_executable or sys.executable
    node_executable = node_executable or find_node_executable()
    npm_executable = npm_executable or find_npm_executable()
    if node_executable is None or npm_executable is None:
        raise RuntimeError("Node.js and npm must be available to build preflight stages.")

    frontend_tests = [
        path.relative_to(root).as_posix().replace("/", os.sep)
        for path in discover_frontend_test_files(root)
    ]
    jobs = backend_jobs if backend_jobs is not None else default_backend_jobs()

    return [
        Stage(
            1,
            "Version consistency",
            [
                python_executable,
                str(root / "scripts" / "check_versions.py"),
            ],
        ),
        Stage(
            2,
            f"Backend tests ({jobs} workers)",
            [
                python_executable,
                str(root / "scripts" / "run_backend_tests.py"),
                "--jobs",
                str(jobs),
            ],
        ),
        Stage(
            3,
            "Frontend policy tests",
            [node_executable, "--test", *frontend_tests],
        ),
        Stage(
            4,
            "Frontend production build",
            [npm_executable, "--prefix", "frontend", "run", "build"],
        ),
    ]


def default_run_command(command: list[str], cwd: Path, env: dict[str, str]) -> int:
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        shell=False,
    )
    return completed.returncode


def run_stage(
    stage: Stage,
    *,
    root: Path,
    env: dict[str, str],
    run_command: RunCommand,
) -> tuple[Stage, int]:
    print(f"[{stage.number}/{STAGE_COUNT}] {stage.name}")
    try:
        exit_code = run_command(stage.command, root, env)
    except KeyboardInterrupt:
        raise
    if exit_code != 0:
        print(f"FAIL: {stage.name} exited with code {exit_code}", file=sys.stderr)
    else:
        print(f"PASS: {stage.name}")
    return stage, exit_code


def run_preflight(
    root: Path | None = None,
    *,
    python_executable: str | None = None,
    node_executable: str | None = None,
    npm_executable: str | None = None,
    backend_jobs: int | None = None,
    run_command: RunCommand | None = None,
) -> int:
    root = root or repo_root()
    run_command = run_command or default_run_command

    if error := validate_prerequisites(
        root,
        node_executable=node_executable,
        npm_executable=npm_executable,
    ):
        print(error, file=sys.stderr)
        return 1

    try:
        stages = build_stages(
            root,
            python_executable=python_executable,
            node_executable=node_executable,
            npm_executable=npm_executable,
            backend_jobs=backend_jobs,
        )
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="cellxplorer-preflight-") as temp_data_dir:
        env = os.environ.copy()
        env["CELLXPLORER_DATA"] = temp_data_dir

        version_stage = stages[0]
        try:
            _, version_code = run_stage(
                version_stage,
                root=root,
                env=env,
                run_command=run_command,
            )
        except KeyboardInterrupt:
            print("\nPreflight cancelled.")
            return 130

        if version_code != 0:
            print("\nPreflight stopped. Later stages were not run.", file=sys.stderr)
            return version_code if version_code > 0 else 1

        parallel_stages = stages[1:]
        completed = 1
        failures: list[tuple[Stage, int]] = []

        print(
            f"Running {len(parallel_stages)} verification stages in parallel "
            f"(backend, frontend tests, frontend build)."
        )
        try:
            with ThreadPoolExecutor(max_workers=len(parallel_stages)) as pool:
                futures = {
                    pool.submit(
                        run_stage,
                        stage,
                        root=root,
                        env=env,
                        run_command=run_command,
                    ): stage
                    for stage in parallel_stages
                }
                for future in as_completed(futures):
                    stage, exit_code = future.result()
                    completed += 1
                    if exit_code != 0:
                        failures.append((stage, exit_code))
        except KeyboardInterrupt:
            print("\nPreflight cancelled.")
            return 130

        if failures:
            print("\nPreflight failed:", file=sys.stderr)
            for stage, exit_code in sorted(failures, key=lambda item: item[0].number):
                print(f"- {stage.name} (exit {exit_code})", file=sys.stderr)
            return next(code for _stage, code in failures if code != 0)

    print("=" * 40)
    print("PREFLIGHT PASSED")
    print(f"{STAGE_COUNT}/{STAGE_COUNT} stages completed successfully")
    print("=" * 40)
    return 0


def main() -> int:
    jobs = os.environ.get("CELLXPLORER_PREFLIGHT_JOBS")
    backend_jobs = int(jobs) if jobs else None
    return run_preflight(backend_jobs=backend_jobs)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nPreflight cancelled.")
        raise SystemExit(130) from None
