#!/usr/bin/env python3
"""Run backend unittest modules in parallel with isolated CELLXPLORER_DATA."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def repo_root(start: Path | None = None) -> Path:
    return (start or Path(__file__).resolve()).parents[1]


def discover_test_modules(tests_dir: Path) -> list[str]:
    return sorted(f"tests.{path.stem}" for path in tests_dir.glob("test_*.py"))


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


def effective_backend_jobs(requested: int, module_count: int) -> int:
    return max(1, min(requested, module_count, cpu_budget()))


def ndax_worker_budget(backend_jobs: int) -> int:
    """Reserve capacity for parallel backend modules and frontend stages."""
    reserve = backend_jobs + 2
    return max(1, min(12, cpu_budget() - reserve))


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
    completed = subprocess.run(
        [python_executable, "-m", "unittest", module],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        shell=False,
    )
    output = completed.stdout
    if completed.stderr:
        if output and not output.endswith("\n"):
            output += "\n"
        output += completed.stderr
    return module, completed.returncode, output, env["CELLXPLORER_DATA"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--jobs",
        type=int,
        default=default_jobs(),
        help="Maximum parallel unittest modules (default: min(16, CPU count)).",
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
        help="Python executable used to run unittest.",
    )
    args = parser.parse_args(argv)

    root = repo_root()
    modules = discover_test_modules(root / "tests")
    if not modules:
        print("No backend test modules found.", file=sys.stderr)
        return 1

    data_root = args.data_root or Path(os.environ.get("CELLXPLORER_DATA", root / ".test-cellxplorer"))
    data_root.mkdir(parents=True, exist_ok=True)

    jobs = effective_backend_jobs(args.jobs, len(modules))
    print(
        f"Running {len(modules)} backend test modules with {jobs} workers "
        f"(CPU budget {cpu_budget()}, NDAX cap {ndax_worker_budget(jobs)})."
    )

    failures: list[tuple[str, str]] = []
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {
            pool.submit(
                run_module,
                python_executable=args.python,
                root=root,
                module=module,
                data_dir=data_root / module.replace(".", "-"),
                backend_jobs=jobs,
            ): module
            for module in modules
        }
        for future in as_completed(futures):
            module, exit_code, output, _data_dir = future.result()
            if exit_code == 0:
                print(f"PASS {module}")
                continue
            failures.append((module, output))
            print(f"FAIL {module} (exit {exit_code})", file=sys.stderr)

    if failures:
        print("\nBackend test failures:", file=sys.stderr)
        for module, output in sorted(failures):
            print(f"\n=== {module} ===", file=sys.stderr)
            if output.strip():
                print(output.rstrip(), file=sys.stderr)
            else:
                print("(no output)", file=sys.stderr)
        return 1

    print(f"All {len(modules)} backend test modules passed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nBackend tests cancelled.", file=sys.stderr)
        raise SystemExit(130) from None
