#!/usr/bin/env python3
"""Compare complete backend test runner architectures on one clean machine.

The benchmark is intentionally diagnostic.  Architecture A is the current
per-module subprocess runner and is the correctness reference.  Architecture
B runs normal unittest discovery in one fresh interpreter.  Architecture C
uses long-lived workers, but reloads CellXplorer and test modules and gives
each module a private data root before it starts.  C is not canonical merely
because it is faster: its isolation results and focused regression tests must
be reviewed first.
"""

from __future__ import annotations

import argparse
import contextlib
import gc
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from statistics import mean, median
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
ARCHITECTURES = {"A", "B", "C"}
FAILURE_LINE = re.compile(r"^(?:FAIL|ERROR):\s+(.+?)\s*$", re.MULTILINE)


def discover_backend_modules(root: Path) -> list[str]:
    return sorted(f"tests.{path.stem}" for path in (root / "tests").glob("test_*.py"))


def discover_backend_case_count(root: Path) -> int:
    """Retained for small callers; benchmark mode uses isolated counting."""
    return unittest.defaultTestLoader.discover(str(root / "tests")).countTestCases()


def cpu_budget() -> int:
    raw = os.environ.get("CELLXPLORER_PREFLIGHT_CPU_BUDGET")
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return os.cpu_count() or 4


def effective_jobs(requested: int) -> int:
    return max(1, min(requested, 16, cpu_budget()))


def effective_shards(requested: int, module_count: int) -> int:
    requested = requested or (os.cpu_count() or 4)
    return max(1, min(requested, module_count, cpu_budget()))


def merge_output(stdout: str, stderr: str) -> str:
    if stdout and stderr:
        return f"{stdout}\n{stderr}"
    return stdout or stderr


def failure_ids(output: str) -> list[str]:
    return FAILURE_LINE.findall(output)


def configure_test_environment(data_root: Path, backend_jobs: int) -> None:
    os.environ["CELLXPLORER_DATA"] = str(data_root)
    os.environ["CELLXPLORER_BACKEND_TEST_PARALLEL"] = "1"
    os.environ["CELLXPLORER_BACKEND_TEST_JOBS"] = str(max(1, backend_jobs))
    reserve = max(1, backend_jobs) + 2
    ndax_cap = max(1, min(12, cpu_budget() - reserve))
    os.environ["CELLXPLORER_NDAX_MAX_WORKERS"] = str(ndax_cap)


class RecordingResult(unittest.TestResult):
    """Small uninstrumented result collector for B and C."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__()
        self.failure_ids: list[str] = []
        self.error_ids: list[str] = []
        self.skip_ids: list[str] = []
        self.unexpected_success_ids: list[str] = []

    def addFailure(self, test: unittest.case.TestCase, err: Any) -> None:  # noqa: N802
        self.failure_ids.append(test.id())
        super().addFailure(test, err)

    def addError(self, test: unittest.case.TestCase, err: Any) -> None:  # noqa: N802
        self.error_ids.append(test.id())
        super().addError(test, err)

    def addSkip(self, test: unittest.case.TestCase, reason: str) -> None:  # noqa: N802
        self.skip_ids.append(test.id())
        super().addSkip(test, reason)

    def addUnexpectedSuccess(self, test: unittest.case.TestCase) -> None:  # noqa: N802
        self.unexpected_success_ids.append(test.id())
        super().addUnexpectedSuccess(test)

    def failure_summary(self) -> list[str]:
        return self.failure_ids + self.error_ids + self.unexpected_success_ids


def run_unittest_suite(
    suite: unittest.TestSuite, *, verbosity: int = 1
) -> tuple[RecordingResult, str]:
    stream = io.StringIO()
    runner = unittest.TextTestRunner(
        stream=stream, verbosity=verbosity, resultclass=RecordingResult
    )
    with contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
        result = runner.run(suite)
    return result, stream.getvalue()


def run_architecture_a(
    *, root: Path, python_executable: str, data_root: Path, jobs: int
) -> dict[str, Any]:
    started = time.perf_counter()
    completed = subprocess.run(
        [
            python_executable,
            str(root / "scripts" / "run_backend_tests.py"),
            "--jobs",
            str(jobs),
            "--skip-frontend-tests",
            "--data-root",
            str(data_root),
        ],
        cwd=root,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        shell=False,
    )
    output = merge_output(completed.stdout, completed.stderr)
    failures = failure_ids(output)
    if completed.returncode != 0 and not failures:
        failures = [f"architecture A exited with code {completed.returncode}"]
    return {
        "architecture": "A",
        "wall_seconds": time.perf_counter() - started,
        "exit_code": completed.returncode,
        "successful": completed.returncode == 0,
        "failures": failures,
        "output": output,
        "data_root": str(data_root),
        "worker_count": jobs,
    }


def run_one_interpreter_child(
    *,
    root: Path,
    data_root: Path,
    backend_jobs: int,
    reverse_modules: bool,
    result_path: Path,
) -> int:
    configure_test_environment(data_root, backend_jobs)
    sys.path.insert(0, str(root))
    started = time.perf_counter()
    started_cpu = time.process_time()
    modules = discover_backend_modules(root)
    if reverse_modules:
        modules.reverse()
    loaded_suites = [
        unittest.defaultTestLoader.loadTestsFromName(module) for module in modules
    ]
    suite = unittest.TestSuite(loaded_suites)
    discovered = sum(item.countTestCases() for item in loaded_suites)
    result, output = run_unittest_suite(suite)
    payload = {
        "architecture": "B",
        "case_count": discovered,
        "tests_run": result.testsRun,
        "wall_seconds": time.perf_counter() - started,
        "cpu_seconds": time.process_time() - started_cpu,
        "successful": result.wasSuccessful(),
        "failures": result.failure_summary(),
        "errors": result.error_ids,
        "skips": result.skip_ids,
        "runner_output": output,
        "data_root": str(data_root),
    }
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return 0 if result.wasSuccessful() else 1


def count_backend_cases_child(
    *, root: Path, data_root: Path, result_path: Path
) -> int:
    os.environ["CELLXPLORER_DATA"] = str(data_root)
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / "backend"))
    counts = {
        module: unittest.defaultTestLoader.loadTestsFromName(module).countTestCases()
        for module in discover_backend_modules(root)
    }
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(
        json.dumps(
            {
                "module_count": len(counts),
                "case_count": sum(counts.values()),
                "module_case_counts": counts,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return 0


def isolated_backend_case_count(
    *, root: Path, python_executable: str, data_root: Path, result_path: Path
) -> dict[str, Any]:
    completed = subprocess.run(
        [
            python_executable,
            str(Path(__file__).resolve()),
            "--count-only",
            "--root",
            str(root),
            "--data-root",
            str(data_root),
            "--result",
            str(result_path),
        ],
        cwd=root,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        shell=False,
    )
    if completed.returncode != 0 or not result_path.is_file():
        raise RuntimeError(
            "backend case counting failed: "
            + merge_output(completed.stdout, completed.stderr)
        )
    return json.loads(result_path.read_text(encoding="utf-8"))


def run_architecture_b(
    *,
    root: Path,
    python_executable: str,
    data_root: Path,
    jobs: int,
    reverse_modules: bool,
    result_path: Path,
) -> dict[str, Any]:
    started = time.perf_counter()
    command = [
        python_executable,
        str(Path(__file__).resolve()),
        "--one-interpreter",
        "--root",
        str(root),
        "--data-root",
        str(data_root),
        "--jobs",
        str(jobs),
    ]
    if reverse_modules:
        command.append("--reverse-modules")
    command.extend(["--result", str(result_path)])
    completed = subprocess.run(
        command,
        cwd=root,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        shell=False,
    )
    if result_path.is_file():
        payload = json.loads(result_path.read_text(encoding="utf-8"))
    else:
        payload = {
            "architecture": "B",
            "case_count": 0,
            "tests_run": 0,
            "successful": False,
            "failures": [],
            "errors": [],
            "skips": [],
            "runner_output": "",
        }
    payload["process_wall_seconds"] = time.perf_counter() - started
    payload["process_exit_code"] = completed.returncode
    payload["process_output"] = merge_output(completed.stdout, completed.stderr)
    if completed.returncode != 0 and not payload.get("failures"):
        payload["failures"] = [
            f"architecture B exited with code {completed.returncode}"
        ]
    return payload


def dispose_known_state() -> None:
    """Dispose database/session objects before removing app modules."""
    prefixes = ("app", "backend.app", "tests")
    for name, module in list(sys.modules.items()):
        if not module or not any(name == prefix or name.startswith(prefix + ".") for prefix in prefixes):
            continue
        for attribute in ("SessionLocal", "session_factory", "ScopedSession"):
            value = getattr(module, attribute, None)
            remove = getattr(value, "remove", None)
            if callable(remove):
                remove()
        for attribute in ("engine", "async_engine"):
            value = getattr(module, attribute, None)
            dispose = getattr(value, "dispose", None)
            if callable(dispose):
                dispose()


def reset_worker_state(
    *, base_env: dict[str, str], base_cwd: Path, base_sys_path: list[str]
) -> None:
    dispose_known_state()
    os.environ.clear()
    os.environ.update(base_env)
    os.chdir(base_cwd)
    sys.path[:] = base_sys_path
    prefixes = ("app", "backend", "tests")
    for name in list(sys.modules):
        if any(name == prefix or name.startswith(prefix + ".") for prefix in prefixes):
            del sys.modules[name]
    gc.collect()


def run_module_in_worker(
    *,
    root: Path,
    module: str,
    data_root: Path,
    backend_jobs: int,
    base_env: dict[str, str],
    base_cwd: Path,
    base_sys_path: list[str],
) -> dict[str, Any]:
    reset_worker_state(
        base_env=base_env, base_cwd=base_cwd, base_sys_path=base_sys_path
    )
    data_root.mkdir(parents=True, exist_ok=True)
    configure_test_environment(data_root, backend_jobs)
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / "backend"))
    os.chdir(root)
    started = time.perf_counter()
    started_cpu = time.process_time()
    suite = unittest.defaultTestLoader.loadTestsFromName(module)
    discovered = suite.countTestCases()
    result, output = run_unittest_suite(suite)
    return {
        "module": module,
        "case_count": discovered,
        "tests_run": result.testsRun,
        "module_wall_seconds": time.perf_counter() - started,
        "module_cpu_seconds": time.process_time() - started_cpu,
        "successful": result.wasSuccessful(),
        "failures": result.failure_summary(),
        "errors": result.error_ids,
        "skips": result.skip_ids,
        "runner_output": output,
        "data_root": str(data_root),
    }


def worker_loop(*, root: Path, backend_jobs: int) -> int:
    base_env = dict(os.environ)
    base_env.pop("CELLXPLORER_DATA", None)
    base_cwd = Path.cwd()
    base_sys_path = list(sys.path)
    for raw_line in sys.stdin:
        request = json.loads(raw_line)
        if request.get("command") == "stop":
            break
        module = str(request["module"])
        try:
            payload = run_module_in_worker(
                root=root,
                module=module,
                data_root=Path(request["data_root"]),
                backend_jobs=backend_jobs,
                base_env=base_env,
                base_cwd=base_cwd,
                base_sys_path=base_sys_path,
            )
        except BaseException:
            payload = {
                "module": module,
                "case_count": 0,
                "tests_run": 0,
                "module_wall_seconds": 0.0,
                "module_cpu_seconds": 0.0,
                "successful": False,
                "failures": [f"{module}: persistent worker exception"],
                "errors": [],
                "skips": [],
                "runner_output": traceback.format_exc(),
            }
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()
    return 0


def run_worker_shard(
    *,
    root: Path,
    python_executable: str,
    modules: list[str],
    data_root: Path,
    backend_jobs: int,
) -> dict[str, Any]:
    if not modules:
        return {"modules": [], "stderr": "", "exit_code": 0}
    command = [
        python_executable,
        str(Path(__file__).resolve()),
        "--worker",
        "--root",
        str(root),
        "--jobs",
        str(backend_jobs),
    ]
    worker_env = os.environ.copy()
    worker_env.pop("CELLXPLORER_DATA", None)
    process = subprocess.Popen(
        command,
        cwd=root,
        env=worker_env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    results: list[dict[str, Any]] = []
    assert process.stdin is not None
    assert process.stdout is not None
    try:
        for module_index, module in enumerate(modules):
            module_root = data_root / f"m{module_index:02d}"
            process.stdin.write(
                json.dumps({"module": module, "data_root": str(module_root)}) + "\n"
            )
            process.stdin.flush()
            response = process.stdout.readline()
            if not response:
                raise RuntimeError(f"persistent worker exited before {module}")
            results.append(json.loads(response))
        process.stdin.write(json.dumps({"command": "stop"}) + "\n")
        process.stdin.flush()
        process.stdin.close()
        stderr = process.stderr.read() if process.stderr is not None else ""
        exit_code = process.wait()
        process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()
    except BaseException:
        process.kill()
        process.wait()
        raise
    return {"modules": results, "stderr": stderr, "exit_code": exit_code}


def run_architecture_c(
    *,
    root: Path,
    python_executable: str,
    modules: list[str],
    data_root: Path,
    jobs: int,
    shards: int,
    reverse_modules: bool,
) -> dict[str, Any]:
    if reverse_modules:
        modules = list(reversed(modules))
    shard_count = effective_shards(shards, len(modules))
    assignments = [modules[index::shard_count] for index in range(shard_count)]
    started = time.perf_counter()
    shard_results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=shard_count) as pool:
        futures = {
            pool.submit(
                run_worker_shard,
                root=root,
                python_executable=python_executable,
                modules=assignment,
                data_root=data_root / f"s{index}",
                backend_jobs=jobs,
            ): index
            for index, assignment in enumerate(assignments)
        }
        for future in as_completed(futures):
            shard_index = futures[future]
            try:
                shard_results.append(future.result())
            except BaseException:
                shard_results.append(
                    {
                        "modules": [],
                        "stderr": (
                            f"persistent worker shard {shard_index} failed\n"
                            + traceback.format_exc()
                        ),
                        "exit_code": 1,
                    }
                )
    module_results = [
        module
        for shard in sorted(shard_results, key=lambda item: item.get("modules", [{}])[0].get("module", ""))
        for module in shard["modules"]
    ]
    failures = [
        failure
        for module in module_results
        for failure in module.get("failures", [])
    ]
    failures.extend(
        f"persistent worker exited with code {shard['exit_code']}"
        for shard in shard_results
        if shard["exit_code"] != 0
    )
    return {
        "architecture": "C",
        "wall_seconds": time.perf_counter() - started,
        "successful": not failures
        and len(module_results) == len(modules)
        and all(module.get("successful") for module in module_results),
        "failures": failures,
        "worker_count": shard_count,
        "modules": module_results,
        "shards": shard_results,
        "data_root": str(data_root),
    }


def probe_python(
    *, python_executable: str, root: Path, code: str, data_root: Path, repetitions: int
) -> dict[str, Any]:
    durations: list[float] = []
    outputs: list[str] = []
    for index in range(repetitions):
        run_root = data_root / str(index)
        run_root.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env["CELLXPLORER_DATA"] = str(run_root)
        started = time.perf_counter()
        completed = subprocess.run(
            [python_executable, "-c", code],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            shell=False,
        )
        durations.append(time.perf_counter() - started)
        outputs.append(merge_output(completed.stdout, completed.stderr))
        if completed.returncode != 0:
            return {
                "successful": False,
                "durations": durations,
                "failure_index": index,
                "output": outputs[-1],
            }
    return {
        "successful": True,
        "durations": durations,
        "median_seconds": median(durations),
        "mean_seconds": mean(durations),
        "min_seconds": min(durations),
        "max_seconds": max(durations),
    }


def startup_import_probes(
    *, root: Path, python_executable: str, output_dir: Path
) -> dict[str, Any]:
    root_literal = json.dumps(str(root))
    common_import = (
        f"import sys; sys.path.insert(0, {root_literal} + r'\\backend'); "
        "import app.db, app.models; "
        "from app.services import analysis_engine, cache, calc, parsing"
    )
    light_discovery = (
        f"import sys, unittest; sys.path.insert(0, {root_literal}); "
        "unittest.defaultTestLoader.loadTestsFromName('tests.test_app_channels')"
    )
    heavy_discovery = (
        f"import sys, unittest; sys.path.insert(0, {root_literal}); "
        "unittest.defaultTestLoader.loadTestsFromName('tests.test_mixed_parser_integration')"
    )
    probes = {
        "plain_python_startup": "pass",
        "common_backend_import": common_import,
        "light_module_discovery_import": light_discovery,
        "heavy_module_discovery_import": heavy_discovery,
    }
    results = {
        name: probe_python(
            python_executable=python_executable,
            root=root,
            code=code,
            data_root=output_dir / name,
            repetitions=3,
        )
        for name, code in probes.items()
    }
    return {"repetitions": 3, "probes": results}


def parse_order(raw: str) -> list[str]:
    order = [item.strip().upper() for item in raw.split(",") if item.strip()]
    if not order or any(item not in ARCHITECTURES for item in order):
        raise ValueError("order must contain only A, B, and C")
    if not ARCHITECTURES.issubset(order):
        raise ValueError("counterbalanced order must include A, B, and C")
    return order


def run_benchmark(args: argparse.Namespace) -> int:
    root = args.root.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    modules = discover_backend_modules(root)
    jobs = effective_jobs(args.jobs)
    order = parse_order(args.order)
    run_id = f"r{uuid.uuid4().hex[:8]}"
    benchmark_dir = output_dir / run_id
    benchmark_dir.mkdir(parents=True, exist_ok=True)
    case_inventory = isolated_backend_case_count(
        root=root,
        python_executable=args.python,
        data_root=benchmark_dir / "count",
        result_path=benchmark_dir / "case-count.json",
    )
    case_count = int(case_inventory["case_count"])
    summary: dict[str, Any] = {
        "schema": "cellxplorer.spec-048.2.runner-benchmark.v1",
        "run_id": run_id,
        "root": str(root),
        "python": sys.version,
        "logical_cpu_count": os.cpu_count() or 1,
        "cpu_budget": cpu_budget(),
        "requested_jobs": args.jobs,
        "effective_jobs": jobs,
        "requested_shards": args.shards,
        "module_count": len(modules),
        "case_count": case_count,
        "modules": modules,
        "module_case_counts": case_inventory["module_case_counts"],
        "order": order,
        "startup_import_probes": startup_import_probes(
            root=root, python_executable=args.python, output_dir=benchmark_dir / "probes"
        ),
        "passes": [],
    }
    occurrences: dict[str, int] = {}
    for pass_index, architecture in enumerate(order, start=1):
        occurrences[architecture] = occurrences.get(architecture, 0) + 1
        reverse = architecture in {"B", "C"} and occurrences[architecture] > 1
        pass_dir = benchmark_dir / f"p{pass_index:02d}{architecture}"
        pass_dir.mkdir(parents=True, exist_ok=True)
        # Keep cache-bearing data roots short on Windows.  Tests add a
        # 64-character content hash and parquet temporary suffix below this
        # path, so result-directory names must not be part of it.
        data_root = benchmark_dir / f"d{pass_index}{architecture}"
        if architecture == "A":
            result = run_architecture_a(
                root=root,
                python_executable=args.python,
                data_root=data_root,
                jobs=jobs,
            )
        elif architecture == "B":
            result = run_architecture_b(
                root=root,
                python_executable=args.python,
                data_root=data_root,
                jobs=jobs,
                reverse_modules=reverse,
                result_path=pass_dir / "result.json",
            )
        else:
            result = run_architecture_c(
                root=root,
                python_executable=args.python,
                modules=modules,
                data_root=data_root,
                jobs=jobs,
                shards=args.shards,
                reverse_modules=reverse,
            )
        result["pass_index"] = pass_index
        result["architecture"] = architecture
        result["module_order_reversed"] = reverse
        result["case_count"] = case_count
        result["module_count"] = len(modules)
        (pass_dir / "result.json").write_text(
            json.dumps(result, indent=2) + "\n", encoding="utf-8"
        )
        summary["passes"].append(result)
        print(
            f"{pass_index}/{len(order)} {architecture}: "
            f"{result['wall_seconds']:.2f}s "
            f"{'PASS' if result['successful'] else 'FAIL'}",
            flush=True,
        )
    by_architecture: dict[str, dict[str, Any]] = {}
    for architecture in sorted(ARCHITECTURES):
        values = [
            float(item["wall_seconds"])
            for item in summary["passes"]
            if item["architecture"] == architecture
        ]
        if values:
            by_architecture[architecture] = {
                "passes": len(values),
                "median_seconds": median(values),
                "mean_seconds": mean(values),
                "min_seconds": min(values),
                "max_seconds": max(values),
            }
    summary["architecture_statistics"] = by_architecture
    if "A" in by_architecture:
        baseline = by_architecture["A"]["median_seconds"]
        for statistics in by_architecture.values():
            statistics["speedup_vs_A"] = (
                baseline / statistics["median_seconds"]
                if statistics["median_seconds"]
                else 0.0
            )
    summary["all_passes_successful"] = all(
        bool(item["successful"]) for item in summary["passes"]
    )
    summary["baseline_a_successful"] = all(
        bool(item["successful"])
        for item in summary["passes"]
        if item["architecture"] == "A"
    )
    summary_path = benchmark_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"Benchmark summary: {summary_path}")
    # B/C failures are diagnostic evidence about order dependence or
    # insufficient reset semantics.  They must be recorded without stopping
    # the same-job final preflight; only an incomplete harness run or a failed
    # correctness-reference A pass makes the benchmark command itself fail.
    completed = len(summary["passes"]) == len(order)
    return 0 if completed and summary["baseline_a_successful"] else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--output-dir", type=Path, required=False)
    parser.add_argument("--order", default="A,B,C,C,B,A")
    parser.add_argument("--jobs", type=int, default=max(1, min(16, os.cpu_count() or 4)))
    parser.add_argument("--shards", type=int, default=0)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--data-root", type=Path)
    parser.add_argument("--one-interpreter", action="store_true")
    parser.add_argument("--count-only", action="store_true")
    parser.add_argument("--reverse-modules", action="store_true")
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--result", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    if args.one_interpreter:
        if args.data_root is None or args.result is None:
            raise SystemExit("--one-interpreter requires --data-root and --result")
        return run_one_interpreter_child(
            root=root,
            data_root=args.data_root.resolve(),
            backend_jobs=args.jobs,
            reverse_modules=args.reverse_modules,
            result_path=args.result.resolve(),
        )
    if args.count_only:
        if args.data_root is None or args.result is None:
            raise SystemExit("--count-only requires --data-root and --result")
        return count_backend_cases_child(
            root=root,
            data_root=args.data_root.resolve(),
            result_path=args.result.resolve(),
        )
    if args.worker:
        return worker_loop(root=root, backend_jobs=args.jobs)
    if args.output_dir is None:
        raise SystemExit("benchmark mode requires --output-dir")
    return run_benchmark(args)


if __name__ == "__main__":
    raise SystemExit(main())
