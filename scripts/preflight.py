#!/usr/bin/env python3
"""Run the canonical CellXplorer local verification checks."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path


RunCommand = Callable[[list[str], Path, dict[str, str]], int]

PREFLIGHT_CACHE_FILE = ".preflight-cache.json"
SKIP_FRONTEND_BUILD_MESSAGE = (
    "SKIP: frontend build (unchanged since last successful run)"
)
SKIP_FRONTEND_POLICY_TESTS_MESSAGE = (
    "SKIP: frontend policy tests (unchanged since last successful run)"
)


@dataclass(frozen=True)
class Stage:
    number: int
    name: str
    command: list[str] | None = None
    skipped: bool = False
    cwd: Path | None = None


def repo_root(start: Path | None = None) -> Path:
    return (start or Path(__file__).resolve()).parents[1]


def preflight_cpu_budget() -> int:
    raw = os.environ.get("CELLXPLORER_PREFLIGHT_CPU_BUDGET")
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return os.cpu_count() or 4


def default_backend_jobs() -> int:
    return max(1, min(16, preflight_cpu_budget()))


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


def cache_disabled(*, no_cache: bool) -> bool:
    if no_cache:
        return True
    env = os.environ.get("CELLXPLORER_PREFLIGHT_NO_CACHE", "").strip().lower()
    return env in {"1", "true", "yes", "on"}


def iter_frontend_build_inputs(root: Path) -> Iterable[Path]:
    explicit = [
        root / "frontend" / "index.html",
        root / "frontend" / "package.json",
        root / "frontend" / "package-lock.json",
        root / "frontend" / "vite.config.ts",
        root / "frontend" / "tsconfig.json",
        root / "scripts" / "preflight.py",
    ]
    for path in explicit:
        if path.is_file():
            yield path
    src_root = root / "frontend" / "src"
    if src_root.is_dir():
        for path in sorted(src_root.rglob("*")):
            if path.is_file():
                yield path
    public_root = root / "frontend" / "public"
    if public_root.is_dir():
        for path in sorted(public_root.rglob("*")):
            if path.is_file():
                yield path


def iter_frontend_policy_inputs(root: Path) -> Iterable[Path]:
    explicit = [
        root / "frontend" / "package.json",
        root / "frontend" / "package-lock.json",
        root / "frontend" / "tsconfig.json",
        root / "scripts" / "preflight.py",
        root / "scripts" / "run_backend_tests.py",
    ]
    for path in explicit:
        if path.is_file():
            yield path
    for directory in (
        root / "frontend" / "src",
        root / "frontend" / "tests",
    ):
        if directory.is_dir():
            for path in sorted(directory.rglob("*")):
                if path.is_file():
                    yield path


def frontend_toolchain_fingerprint(root: Path) -> str:
    parts: list[str] = []
    node_executable = find_node_executable()
    if node_executable:
        try:
            completed = subprocess.run(
                [node_executable, "--version"],
                capture_output=True,
                text=True,
                check=False,
                shell=False,
            )
            if completed.stdout.strip():
                parts.append(f"node={completed.stdout.strip()}")
        except OSError:
            parts.append("node=unavailable")

    installed_lock = root / "frontend" / "node_modules" / ".package-lock.json"
    if installed_lock.is_file():
        parts.append(f"installed-lock={hashlib.sha256(installed_lock.read_bytes()).hexdigest()}")

    for package in ("typescript", "vite"):
        package_json = root / "frontend" / "node_modules" / package / "package.json"
        if package_json.is_file():
            try:
                version = json.loads(package_json.read_text(encoding="utf-8")).get("version")
            except (OSError, json.JSONDecodeError):
                version = None
            if isinstance(version, str) and version:
                parts.append(f"{package}={version}")
    return "\n".join(parts)


def frontend_build_input_hash(root: Path) -> str:
    digest = hashlib.sha256()
    for path in iter_frontend_build_inputs(root):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(relative)
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    toolchain = frontend_toolchain_fingerprint(root)
    if toolchain:
        digest.update(b"toolchain\0")
        digest.update(toolchain.encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def frontend_policy_input_hash(root: Path) -> str:
    digest = hashlib.sha256()
    for path in iter_frontend_policy_inputs(root):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(relative)
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    toolchain = frontend_toolchain_fingerprint(root)
    if toolchain:
        digest.update(b"toolchain\0")
        digest.update(toolchain.encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def read_preflight_cache(root: Path) -> dict[str, object] | None:
    path = root / PREFLIGHT_CACHE_FILE
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def write_preflight_cache(
    root: Path,
    *,
    frontend_hash: str,
    passed: bool,
    frontend_policy_hash: str | None = None,
) -> None:
    path = root / PREFLIGHT_CACHE_FILE
    payload: dict[str, object] = {}
    payload.update(
        {
            "frontend_build_hash": frontend_hash,
            "frontend_policy_test_hash": frontend_policy_hash
            or frontend_policy_input_hash(root),
            "last_run_passed": passed,
        }
    )
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def should_skip_frontend_build(root: Path, *, no_cache: bool) -> bool:
    if cache_disabled(no_cache=no_cache):
        return False
    cache = read_preflight_cache(root)
    if not cache:
        return False
    if cache.get("last_run_passed") is not True:
        return False
    cached_hash = cache.get("frontend_build_hash")
    if not isinstance(cached_hash, str) or not cached_hash:
        return False
    return cached_hash == frontend_build_input_hash(root)


def should_skip_frontend_policy_tests(root: Path, *, no_cache: bool) -> bool:
    if cache_disabled(no_cache=no_cache):
        return False
    cache = read_preflight_cache(root)
    if not cache or cache.get("last_run_passed") is not True:
        return False
    cached_hash = cache.get("frontend_policy_test_hash")
    if not isinstance(cached_hash, str) or not cached_hash:
        return False
    return cached_hash == frontend_policy_input_hash(root)


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


def npm_exec_command(
    npm_executable: str,
    *args: str,
) -> list[str]:
    return [npm_executable, "--prefix", "frontend", "exec", "--", *args]


def build_stages(
    root: Path,
    *,
    python_executable: str | None = None,
    node_executable: str | None = None,
    npm_executable: str | None = None,
    backend_jobs: int | None = None,
    skip_frontend_build: bool = False,
    skip_frontend_policy_tests: bool = False,
) -> list[Stage]:
    python_executable = python_executable or sys.executable
    node_executable = node_executable or find_node_executable()
    npm_executable = npm_executable or find_npm_executable()
    if node_executable is None or npm_executable is None:
        raise RuntimeError("Node.js and npm must be available to build preflight stages.")

    jobs = backend_jobs if backend_jobs is not None else default_backend_jobs()
    test_command = [
        python_executable,
        str(root / "scripts" / "run_backend_tests.py"),
        "--jobs",
        str(jobs),
        "--node",
        node_executable,
    ]
    if skip_frontend_policy_tests:
        test_command.append("--skip-frontend-tests")

    stages = [
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
            f"Backend + frontend tests ({jobs} workers)",
            test_command,
        ),
        Stage(
            3,
            "Frontend type check",
            npm_exec_command(npm_executable, "tsc", "-b"),
            skipped=skip_frontend_build,
            cwd=root / "frontend",
        ),
        Stage(
            4,
            "Frontend production bundle",
            npm_exec_command(npm_executable, "vite", "build"),
            skipped=skip_frontend_build,
            cwd=root / "frontend",
        ),
    ]
    return stages


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
    stage_count: int,
    root: Path,
    env: dict[str, str],
    run_command: RunCommand,
) -> tuple[Stage, int, float]:
    print(f"[{stage.number}/{stage_count}] {stage.name}")
    if stage.skipped:
        print(SKIP_FRONTEND_BUILD_MESSAGE)
        print(f"PASS: {stage.name} (skipped, 0.00 s)")
        return stage, 0, 0.0
    if stage.command is None:
        raise RuntimeError(f"Stage {stage.name!r} has no command.")
    started = time.monotonic()
    try:
        exit_code = run_command(stage.command, stage.cwd or root, env)
    except KeyboardInterrupt:
        raise
    duration = time.monotonic() - started
    if exit_code != 0:
        print(
            f"FAIL: {stage.name} exited with code {exit_code} ({duration:.2f} s)",
            file=sys.stderr,
        )
    else:
        print(f"PASS: {stage.name} ({duration:.2f} s)")
    return stage, exit_code, duration


def print_preflight_timings(
    stage_timings: list[tuple[Stage, float]],
    *,
    started: float,
) -> None:
    print("\nPreflight timings:")
    for stage, duration in sorted(stage_timings, key=lambda item: item[0].number):
        print(f"{stage.name}: {duration:.2f} s")
    print(f"Total preflight wall time: {time.monotonic() - started:.2f} s")


def run_preflight(
    root: Path | None = None,
    *,
    python_executable: str | None = None,
    node_executable: str | None = None,
    npm_executable: str | None = None,
    backend_jobs: int | None = None,
    no_cache: bool = False,
    run_command: RunCommand | None = None,
) -> int:
    started = time.monotonic()
    root = root or repo_root()
    run_command = run_command or default_run_command

    if error := validate_prerequisites(
        root,
        node_executable=node_executable,
        npm_executable=npm_executable,
    ):
        print(error, file=sys.stderr)
        print_preflight_timings([], started=started)
        return 1

    skip_frontend_build = should_skip_frontend_build(root, no_cache=no_cache)
    skip_frontend_policy_tests = should_skip_frontend_policy_tests(root, no_cache=no_cache)

    try:
        stages = build_stages(
            root,
            python_executable=python_executable,
            node_executable=node_executable,
            npm_executable=npm_executable,
            backend_jobs=backend_jobs,
            skip_frontend_build=skip_frontend_build,
            skip_frontend_policy_tests=skip_frontend_policy_tests,
        )
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        print_preflight_timings([], started=started)
        return 1

    stage_count = len(stages)
    stage_timings: list[tuple[Stage, float]] = []

    with tempfile.TemporaryDirectory(prefix="cellxplorer-preflight-") as temp_data_dir:
        env = os.environ.copy()
        env["CELLXPLORER_DATA"] = temp_data_dir
        # Vite and the backend test pool run concurrently. Keep an assets mount
        # available while Rolldown replaces the ignored build output, and let
        # the Vite config retain the existing output during this verification
        # wave. Direct/package builds still use Vite's normal clean output.
        (root / "frontend" / "dist" / "assets").mkdir(parents=True, exist_ok=True)
        env["CELLXPLORER_PREFLIGHT_BUILD"] = "1"
        if "CELLXPLORER_PREFLIGHT_CPU_BUDGET" not in env:
            env["CELLXPLORER_PREFLIGHT_CPU_BUDGET"] = str(preflight_cpu_budget())

        version_stage = stages[0]
        try:
            _, version_code, version_duration = run_stage(
                version_stage,
                stage_count=stage_count,
                root=root,
                env=env,
                run_command=run_command,
            )
            stage_timings.append((version_stage, version_duration))
        except KeyboardInterrupt:
            print("\nPreflight cancelled.")
            return 130

        if version_code != 0:
            write_preflight_cache(
                root,
                frontend_hash=frontend_build_input_hash(root),
                frontend_policy_hash=frontend_policy_input_hash(root),
                passed=False,
            )
            print("\nPreflight stopped. Later stages were not run.", file=sys.stderr)
            print_preflight_timings(stage_timings, started=started)
            return version_code if version_code > 0 else 1

        parallel_stages = stages[1:]
        failures: list[tuple[Stage, int]] = []

        print(
            f"Running {len(parallel_stages)} verification stages in parallel "
            f"(shared backend/frontend test pool, frontend type check, frontend bundle)."
        )
        try:
            with ThreadPoolExecutor(max_workers=len(parallel_stages)) as pool:
                futures = {
                    pool.submit(
                        run_stage,
                        stage,
                        stage_count=stage_count,
                        root=root,
                        env=env,
                        run_command=run_command,
                    ): stage
                    for stage in parallel_stages
                }
                for future in as_completed(futures):
                    stage, exit_code, duration = future.result()
                    stage_timings.append((stage, duration))
                    if exit_code != 0:
                        failures.append((stage, exit_code))
        except KeyboardInterrupt:
            print("\nPreflight cancelled.")
            return 130

        if failures:
            write_preflight_cache(
                root,
                frontend_hash=frontend_build_input_hash(root),
                frontend_policy_hash=frontend_policy_input_hash(root),
                passed=False,
            )
            print("\nPreflight failed:", file=sys.stderr)
            for stage, exit_code in sorted(failures, key=lambda item: item[0].number):
                print(f"- {stage.name} (exit {exit_code})", file=sys.stderr)
            print_preflight_timings(stage_timings, started=started)
            return next(code for _stage, code in failures if code != 0)

        write_preflight_cache(
            root,
            frontend_hash=frontend_build_input_hash(root),
            frontend_policy_hash=frontend_policy_input_hash(root),
            passed=True,
        )

    print_preflight_timings(stage_timings, started=started)
    print("=" * 40)
    print("PREFLIGHT PASSED")
    print(f"{stage_count}/{stage_count} stages completed successfully")
    print("=" * 40)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="Always run frontend policy tests, type-check, and bundle stages.",
    )
    args = parser.parse_args(argv)
    jobs = os.environ.get("CELLXPLORER_PREFLIGHT_JOBS")
    backend_jobs = int(jobs) if jobs else None
    return run_preflight(
        backend_jobs=backend_jobs,
        no_cache=args.no_cache,
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nPreflight cancelled.")
        raise SystemExit(130) from None
