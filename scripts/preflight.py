#!/usr/bin/env python3
"""Run the canonical CellXplorer local verification checks."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
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
            "Backend tests",
            [python_executable, "-m", "unittest", "discover", "tests", "-v"],
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


def run_preflight(
    root: Path | None = None,
    *,
    python_executable: str | None = None,
    node_executable: str | None = None,
    npm_executable: str | None = None,
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
        )
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="cellxplorer-preflight-") as temp_data_dir:
        env = os.environ.copy()
        env["CELLXPLORER_DATA"] = temp_data_dir

        completed = 0
        for stage in stages:
            print(f"[{stage.number}/{STAGE_COUNT}] {stage.name}")
            try:
                exit_code = run_command(stage.command, root, env)
            except KeyboardInterrupt:
                print("\nPreflight cancelled.")
                return 130

            if exit_code != 0:
                print(f"FAIL: command exited with code {exit_code}", file=sys.stderr)
                print(
                    "\nPreflight stopped. Later stages were not run.",
                    file=sys.stderr,
                )
                return exit_code if exit_code > 0 else 1

            print(f"PASS: {stage.name}")
            completed += 1

    print("=" * 40)
    print("PREFLIGHT PASSED")
    print(f"{completed}/{STAGE_COUNT} stages completed successfully")
    print("=" * 40)
    return 0


def main() -> int:
    return run_preflight()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nPreflight cancelled.")
        raise SystemExit(130) from None
