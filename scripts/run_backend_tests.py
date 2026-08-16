#!/usr/bin/env python3
"""Run backend modules and frontend policy files in one bounded test pool."""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path


FRONTEND_POLICY_SKIP_MESSAGE = (
    "SKIP: frontend policy tests (unchanged since last successful run)"
)
PREFLIGHT_CACHE_FILE = ".preflight-cache.json"
TEST_TIMINGS_KEY = "test_timings"
PARTITION_SUPPORT_FILES = {
    "test_neware_excel.py",
    "test_portable_analysis.py",
}


@dataclass(frozen=True)
class TaskResult:
    name: str
    kind: str
    exit_code: int
    output: str
    duration: float
    data_dir: str | None = None


def repo_root(start: Path | None = None) -> Path:
    return (start or Path(__file__).resolve()).parents[1]


def discover_test_modules(tests_dir: Path) -> list[str]:
    return sorted(
        f"tests.{path.stem}"
        for path in tests_dir.glob("test_*.py")
        if path.name not in PARTITION_SUPPORT_FILES
    )


def discover_frontend_test_files(tests_dir: Path) -> list[Path]:
    return sorted(tests_dir.glob("*.test.ts"))


def read_timing_history(root: Path) -> dict[str, float]:
    """Read valid prior durations, failing closed for missing or malformed cache data."""
    path = root / PREFLIGHT_CACHE_FILE
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    raw_history = payload.get(TEST_TIMINGS_KEY)
    if not isinstance(raw_history, dict):
        return {}

    history: dict[str, float] = {}
    for name, duration in raw_history.items():
        if not isinstance(name, str) or isinstance(duration, bool):
            continue
        if not isinstance(duration, (int, float)):
            continue
        numeric_duration = float(duration)
        if math.isfinite(numeric_duration) and numeric_duration >= 0:
            history[name] = numeric_duration
    return history


def task_order_key(name: str, timing_history: dict[str, float]) -> tuple[int, float, str]:
    """Put unknown tasks in the first wave, then known tasks longest-first."""
    duration = timing_history.get(name)
    if duration is None:
        return (0, 0.0, name)
    return (1, -duration, name)


def order_task_names(names: list[str], timing_history: dict[str, float]) -> list[str]:
    return sorted(names, key=lambda name: task_order_key(name, timing_history))


def persist_timing_history(root: Path, results: list["TaskResult"]) -> None:
    """Persist only successful task durations without affecting cache pass state."""
    successful = {
        result.name: result.duration
        for result in results
        if result.exit_code == 0 and math.isfinite(result.duration) and result.duration >= 0
    }
    if not successful:
        return

    cache_path = root / PREFLIGHT_CACHE_FILE
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    timing_history = read_timing_history(root)
    timing_history.update(successful)
    payload[TEST_TIMINGS_KEY] = dict(sorted(timing_history.items()))

    temporary_path = cache_path.with_name(f".{cache_path.name}.{os.getpid()}.tmp")
    try:
        temporary_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary_path, cache_path)
    finally:
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass


def cpu_budget() -> int:
    raw = os.environ.get("CELLXPLORER_PREFLIGHT_CPU_BUDGET")
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return os.cpu_count() or 4


def default_jobs() -> int:
    return max(1, min(16, cpu_budget()))


def effective_test_jobs(requested: int, task_count: int) -> int:
    return max(1, min(requested, task_count, cpu_budget()))


def effective_backend_jobs(requested: int, module_count: int) -> int:
    """Backward-compatible name for callers that used the old backend-only runner."""
    return effective_test_jobs(requested, module_count)


def ndax_worker_budget(test_pool_jobs: int) -> int:
    """Leave room for the shared pool and the two non-test preflight stages."""
    reserve = test_pool_jobs + 2
    return max(1, min(12, cpu_budget() - reserve))


def _merge_output(stdout: str, stderr: str) -> str:
    output = stdout
    if stderr:
        if output and not output.endswith("\n"):
            output += "\n"
        output += stderr
    return output


def run_module(
    *,
    python_executable: str,
    root: Path,
    module: str,
    data_dir: Path,
    backend_jobs: int,
) -> tuple[str, int, str, str]:
    env = os.environ.copy()
    env["CELLXPLORER_DATA"] = str(data_dir)
    env["CELLXPLORER_BACKEND_TEST_PARALLEL"] = "1"
    env["CELLXPLORER_BACKEND_TEST_JOBS"] = str(backend_jobs)
    env["CELLXPLORER_NDAX_MAX_WORKERS"] = str(ndax_worker_budget(backend_jobs))
    try:
        completed = subprocess.run(
            [python_executable, "-m", "unittest", module],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            shell=False,
        )
        output = _merge_output(completed.stdout, completed.stderr)
        exit_code = completed.returncode
    except OSError as exc:
        output = str(exc)
        exit_code = 1
    return module, exit_code, output, str(data_dir)


def run_module_timed(**kwargs) -> tuple[str, int, str, str, float]:
    started = time.monotonic()
    module, exit_code, output, data_dir = run_module(**kwargs)
    return module, exit_code, output, data_dir, time.monotonic() - started


def run_frontend_test(
    *,
    node_executable: str,
    root: Path,
    test_path: Path,
) -> tuple[str, int, str, float]:
    label = test_path.relative_to(root).as_posix()
    started = time.monotonic()
    try:
        completed = subprocess.run(
            [node_executable, "--test", str(test_path)],
            cwd=root,
            env=os.environ.copy(),
            capture_output=True,
            text=True,
            shell=False,
        )
        output = _merge_output(completed.stdout, completed.stderr)
        exit_code = completed.returncode
    except OSError as exc:
        output = str(exc)
        exit_code = 1
    return label, exit_code, output, time.monotonic() - started


def _print_slowest(results: list[TaskResult]) -> None:
    print("\nSlowest test files/modules:")
    for result in sorted(results, key=lambda item: item.duration, reverse=True)[:10]:
        print(f"{result.duration:5.1f} s  {result.name}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--jobs",
        type=int,
        default=default_jobs(),
        help="Maximum parallel backend/frontend test tasks (default: min(16, CPU count)).",
    )
    parser.add_argument(
        "--data-root",
        type=Path,
        default=None,
        help="Base directory for per-module CELLXPLORER_DATA folders.",
    )
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="Python executable used to run backend unittest modules.",
    )
    parser.add_argument(
        "--node",
        default=None,
        help="Node executable used to run frontend policy files (default: PATH).",
    )
    parser.add_argument(
        "--skip-frontend-tests",
        action="store_true",
        help="Skip unchanged frontend policy files after a successful cache hit.",
    )
    args = parser.parse_args(argv)

    root = repo_root()
    modules = discover_test_modules(root / "tests")
    if not modules:
        print("No backend test modules found.", file=sys.stderr)
        return 1

    frontend_files = []
    if not args.skip_frontend_tests:
        frontend_files = discover_frontend_test_files(root / "frontend" / "tests")
        if not frontend_files:
            print("No frontend policy test files found.", file=sys.stderr)
            return 1
    elif discover_frontend_test_files(root / "frontend" / "tests"):
        print(FRONTEND_POLICY_SKIP_MESSAGE)

    node_executable = args.node or shutil.which("node")
    if frontend_files and node_executable is None:
        print("Node.js is not available on PATH.", file=sys.stderr)
        return 1

    data_root = args.data_root or Path(
        os.environ.get("CELLXPLORER_DATA", root / ".test-cellxplorer")
    )
    data_root.mkdir(parents=True, exist_ok=True)

    task_count = len(modules) + len(frontend_files)
    jobs = effective_test_jobs(args.jobs, task_count)
    timing_history = read_timing_history(root)
    task_specs: list[tuple[str, str, Path | None]] = [
        ("backend", module, None) for module in modules
    ]
    task_specs.extend(
        (
            "frontend",
            test_path.relative_to(root).as_posix(),
            test_path,
        )
        for test_path in frontend_files
    )
    task_specs.sort(key=lambda task: task_order_key(task[1], timing_history))
    print(
        f"Running {len(modules)} backend modules and {len(frontend_files)} frontend test files "
        f"with {jobs} workers (CPU budget {cpu_budget()}, "
        f"NDAX cap {ndax_worker_budget(jobs)})."
    )

    results: list[TaskResult] = []
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {}
        for kind, name, test_path in task_specs:
            if kind == "backend":
                future = pool.submit(
                    run_module_timed,
                    python_executable=args.python,
                    root=root,
                    module=name,
                    data_dir=data_root / name.replace(".", "-"),
                    backend_jobs=jobs,
                )
            else:
                assert test_path is not None
                future = pool.submit(
                    run_frontend_test,
                    node_executable=node_executable,
                    root=root,
                    test_path=test_path,
                )
            futures[future] = (kind, name)

        for future in as_completed(futures):
            kind, _requested_name = futures[future]
            if kind == "backend":
                name, exit_code, output, data_dir, duration = future.result()
                result = TaskResult(name, kind, exit_code, output, duration, data_dir)
            else:
                name, exit_code, output, duration = future.result()
                result = TaskResult(name, kind, exit_code, output, duration)
            results.append(result)
            if result.exit_code == 0:
                print(f"PASS {result.name} ({result.duration:.2f} s)")
            else:
                print(
                    f"FAIL {result.name} (exit {result.exit_code}, {result.duration:.2f} s)",
                    file=sys.stderr,
                )

    persist_timing_history(root, results)

    _print_slowest(results)

    failures = [result for result in results if result.exit_code != 0]
    if failures:
        print("\nTest task failures:", file=sys.stderr)
        for result in sorted(failures, key=lambda item: item.name):
            print(f"\n=== {result.name} ===", file=sys.stderr)
            if result.output.strip():
                print(result.output.rstrip(), file=sys.stderr)
            else:
                print("(no output)", file=sys.stderr)
        return 1

    if frontend_files:
        print(f"All {len(results)} backend/frontend test files/modules passed.")
    else:
        print(f"All {len(modules)} backend test modules passed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nBackend/frontend tests cancelled.", file=sys.stderr)
        raise SystemExit(130) from None
