#!/usr/bin/env python3
"""Profile every backend unittest case and frontend Node test executed by preflight.

This is diagnostic tooling.  It deliberately records timings without changing the
canonical runner or the assertions under test.  Backend modules are still isolated
in one fresh Python process per module, while one child process records every case
inside that module.  Frontend files are timed with Node's native TAP reporter.
"""

from __future__ import annotations

import argparse
import contextvars
import io
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[1]
ACTIVE_TIMING: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "profile_active_timing", default=None
)


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * weight


def duration_statistics(values: list[float]) -> dict[str, float | int]:
    return {
        "count": len(values),
        "sum_seconds": sum(values),
        "p50_seconds": percentile(values, 0.50),
        "p90_seconds": percentile(values, 0.90),
        "p95_seconds": percentile(values, 0.95),
        "p99_seconds": percentile(values, 0.99),
        "max_seconds": max(values, default=0.0),
    }


def repo_root() -> Path:
    return ROOT


def discover_backend_modules(root: Path) -> list[str]:
    return sorted(f"tests.{path.stem}" for path in (root / "tests").glob("test_*.py"))


def discover_frontend_files(root: Path) -> list[Path]:
    return sorted((root / "frontend" / "tests").glob("*.test.ts"))


def discover_backend_cases(root: Path) -> int:
    loader = unittest.defaultTestLoader
    return loader.discover(str(root / "tests")).countTestCases()


def _phase_wrapper(
    original: Callable[..., Any], phase: str
) -> Callable[..., Any]:
    def wrapped(test_case: unittest.TestCase, *args: Any, **kwargs: Any) -> Any:
        timing = ACTIVE_TIMING.get()
        started = time.perf_counter()
        try:
            return original(test_case, *args, **kwargs)
        finally:
            if timing is not None:
                timing[phase] = timing.get(phase, 0.0) + time.perf_counter() - started

    return wrapped


def install_case_phase_instrumentation() -> None:
    marker = "_cellxplorer_profile_wrapped"
    for method_name, phase in (
        ("_callSetUp", "setup_seconds"),
        ("_callTestMethod", "body_seconds"),
        ("_callTearDown", "teardown_seconds"),
    ):
        original = getattr(unittest.TestCase, method_name, None)
        if original is None or getattr(original, marker, False):
            continue
        wrapped = _phase_wrapper(original, phase)
        setattr(wrapped, marker, True)
        setattr(unittest.TestCase, method_name, wrapped)


class TimingResult(unittest.TextTestResult):
    """A normal unittest result with per-case and phase timings."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        if not args and not kwargs:
            args = (io.StringIO(), True, 1)
        super().__init__(*args, **kwargs)
        self.case_timings: list[dict[str, Any]] = []
        self._by_id: dict[str, dict[str, Any]] = {}
        self._failed: set[str] = set()
        self._skipped: set[str] = set()

    def startTest(self, test: unittest.case.TestCase) -> None:  # noqa: N802
        super().startTest(test)
        test_id = test.id()
        timing = {
            "id": test_id,
            "module": test_id.rsplit(".", 2)[0] if "." in test_id else test_id,
            "class": test_id.rsplit(".", 1)[0] if "." in test_id else test_id,
            "setup_seconds": 0.0,
            "body_seconds": 0.0,
            "teardown_seconds": 0.0,
            "status": "running",
            "started": time.perf_counter(),
        }
        self._by_id[test_id] = timing
        ACTIVE_TIMING.set(timing)

    def stopTest(self, test: unittest.case.TestCase) -> None:  # noqa: N802
        timing = self._by_id.get(test.id())
        if timing is not None:
            timing["duration_seconds"] = time.perf_counter() - timing.pop("started")
            if test.id() in self._failed:
                timing["status"] = "failed"
            elif test.id() in self._skipped:
                timing["status"] = "skipped"
            else:
                timing["status"] = "passed"
            self.case_timings.append(timing)
        ACTIVE_TIMING.set(None)
        super().stopTest(test)

    def addError(self, test: unittest.case.TestCase, err: Any) -> None:  # noqa: N802
        self._failed.add(test.id())
        super().addError(test, err)

    def addFailure(self, test: unittest.case.TestCase, err: Any) -> None:  # noqa: N802
        self._failed.add(test.id())
        super().addFailure(test, err)

    def addSkip(self, test: unittest.case.TestCase, reason: str) -> None:  # noqa: N802
        self._skipped.add(test.id())
        super().addSkip(test, reason)

    def addUnexpectedSuccess(self, test: unittest.case.TestCase) -> None:  # noqa: N802
        self._failed.add(test.id())
        super().addUnexpectedSuccess(test)

    def addSubTest(self, test: unittest.case.TestCase, subtest: Any, err: Any) -> None:  # noqa: N802
        if err is not None:
            self._failed.add(test.id())
        super().addSubTest(test, subtest, err)


def run_backend_module_child(
    *,
    root: Path,
    module: str,
    data_root: Path,
    result_path: Path,
    backend_jobs: int,
) -> int:
    install_case_phase_instrumentation()
    os.environ["CELLXPLORER_DATA"] = str(data_root)
    os.environ["CELLXPLORER_BACKEND_TEST_PARALLEL"] = "1"
    os.environ["CELLXPLORER_BACKEND_TEST_JOBS"] = str(max(1, backend_jobs))
    os.environ["CELLXPLORER_NDAX_MAX_WORKERS"] = str(max(1, backend_jobs))
    sys.path.insert(0, str(root))

    started = time.perf_counter()
    started_cpu = time.process_time()
    suite = unittest.defaultTestLoader.loadTestsFromName(module)
    discovered = suite.countTestCases()
    stream = io.StringIO()
    runner = unittest.TextTestRunner(
        stream=stream, verbosity=1, resultclass=TimingResult
    )
    result = runner.run(suite)
    payload = {
        "module": module,
        "case_count": discovered,
        "module_wall_seconds": time.perf_counter() - started,
        "module_cpu_seconds": time.process_time() - started_cpu,
        "case_timings": result.case_timings,
        "tests_run": result.testsRun,
        "failures": [test.id() for test, _ in result.failures],
        "errors": [test.id() for test, _ in result.errors],
        "skips": [test.id() for test, _ in result.skipped],
        "successful": result.wasSuccessful(),
        "runner_output": stream.getvalue(),
    }
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return 0 if result.wasSuccessful() else 1


def _merge_output(stdout: str, stderr: str) -> str:
    if stdout and stderr:
        return f"{stdout}\n{stderr}"
    return stdout or stderr


def _profile_module_process(
    *, root: Path, module: str, data_root: Path, result_path: Path, backend_jobs: int
) -> dict[str, Any]:
    started = time.perf_counter()
    data_root.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--backend-module",
            module,
            "--data-root",
            str(data_root),
            "--result",
            str(result_path),
            "--jobs",
            str(max(1, backend_jobs)),
        ],
        cwd=root,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        shell=False,
    )
    process_seconds = time.perf_counter() - started
    if result_path.is_file():
        payload = json.loads(result_path.read_text(encoding="utf-8"))
    else:
        payload = {
            "module": module,
            "case_count": 0,
            "module_wall_seconds": process_seconds,
            "module_cpu_seconds": 0.0,
            "case_timings": [],
            "tests_run": 0,
            "failures": [],
            "errors": [],
            "skips": [],
            "successful": False,
            "runner_output": "",
        }
    payload["process_wall_seconds"] = process_seconds
    payload["process_exit_code"] = completed.returncode
    payload["process_output"] = _merge_output(completed.stdout, completed.stderr)
    return payload


def _summarize_backend(
    *,
    root: Path,
    module_payloads: list[dict[str, Any]],
    started: float,
    discovered_cases: int,
) -> dict[str, Any]:
    cases = [case for payload in module_payloads for case in payload["case_timings"]]
    durations = [float(case["duration_seconds"]) for case in cases]
    total_case_seconds = sum(durations)
    total_body_seconds = sum(float(case["body_seconds"]) for case in cases)
    module_rows = []
    for payload in sorted(module_payloads, key=lambda item: item["module"]):
        module_cases = payload["case_timings"]
        body_seconds = sum(float(case["body_seconds"]) for case in module_cases)
        setup_seconds = sum(float(case["setup_seconds"]) for case in module_cases)
        teardown_seconds = sum(float(case["teardown_seconds"]) for case in module_cases)
        module_seconds = float(payload["module_wall_seconds"])
        module_rows.append(
            {
                "module": payload["module"],
                "case_count": int(payload["case_count"]),
                "tests_run": int(payload["tests_run"]),
                "module_wall_seconds": module_seconds,
                "module_cpu_seconds": float(payload.get("module_cpu_seconds", 0.0)),
                "process_wall_seconds": float(payload["process_wall_seconds"]),
                "case_body_seconds": body_seconds,
                "case_setup_seconds": setup_seconds,
                "case_teardown_seconds": teardown_seconds,
                "non_case_residual_seconds": max(0.0, module_seconds - sum(float(case["duration_seconds"]) for case in module_cases)),
                "successful": bool(payload["successful"]),
                "failures": payload["failures"],
                "errors": payload["errors"],
                "skips": payload["skips"],
            }
        )
    top = sorted(cases, key=lambda item: float(item["duration_seconds"]), reverse=True)
    concentrations = {
        str(limit): (sum(float(case["body_seconds"]) for case in top[:limit]) / total_body_seconds if total_body_seconds else 0.0)
        for limit in (10, 25, 50)
    }
    return {
        "schema": "cellxplorer.spec-048.2.backend-profile.v1",
        "python": sys.version,
        "root": str(root),
        "module_count": len(module_payloads),
        "discovered_case_count": discovered_cases,
        "recorded_case_count": len(cases),
        "overall_wall_seconds": time.perf_counter() - started,
        "sum_module_wall_seconds": sum(float(item["module_wall_seconds"]) for item in module_payloads),
        "sum_module_cpu_seconds": sum(float(item.get("module_cpu_seconds", 0.0)) for item in module_payloads),
        "sum_process_wall_seconds": sum(float(item["process_wall_seconds"]) for item in module_payloads),
        "case_duration_seconds": total_case_seconds,
        "case_body_seconds": total_body_seconds,
        "case_duration_statistics": duration_statistics(durations),
        "top_50_cases": top[:50],
        "top_case_concentration": concentrations,
        "top_case_duration_concentration": {
            str(limit): (
                sum(float(case["duration_seconds"]) for case in top[:limit])
                / total_case_seconds
                if total_case_seconds
                else 0.0
            )
            for limit in (10, 25, 50)
        },
        "modules": module_rows,
        "failures": [
            {
                "module": payload["module"],
                "failures": payload["failures"],
                "errors": payload["errors"],
                "process_exit_code": payload["process_exit_code"],
            }
            for payload in module_payloads
            if not payload["successful"] or payload["process_exit_code"] != 0
        ],
        "case_timings": top,
    }


def profile_backend(args: argparse.Namespace) -> int:
    root = args.root.resolve()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output_dir = output.parent / f"{output.stem}-modules"
    output_dir.mkdir(parents=True, exist_ok=True)
    data_root = (args.data_root or output.parent / f"{output.stem}-data").resolve()
    # Keep the private data path short enough for Windows cache paths, which
    # add a 64-character source hash and a parquet temporary suffix.
    data_root = data_root / f"r{uuid.uuid4().hex[:8]}"
    data_root.mkdir(parents=True, exist_ok=True)
    modules = discover_backend_modules(root)
    loader_discovered_cases = discover_backend_cases(root)
    started = time.perf_counter()
    payloads: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max(1, min(args.jobs, len(modules)))) as pool:
        futures = {}
        for module in modules:
            module_result = output_dir / f"{module.replace('.', '-')}.json"
            module_data = data_root / module.replace(".", "-")
            futures[pool.submit(
                _profile_module_process,
                root=root,
                module=module,
                data_root=module_data,
                result_path=module_result,
                backend_jobs=args.jobs,
            )] = module
        for future in as_completed(futures):
            module = futures[future]
            try:
                payload = future.result()
            except BaseException:
                payload = {
                    "module": module,
                    "case_count": 0,
                    "module_wall_seconds": 0.0,
                    "module_cpu_seconds": 0.0,
                    "process_wall_seconds": 0.0,
                    "process_exit_code": 1,
                    "case_timings": [],
                    "tests_run": 0,
                    "failures": [f"profiling worker exception in {module}"],
                    "errors": [],
                    "skips": [],
                    "successful": False,
                    "runner_output": traceback.format_exc(),
                    "process_output": traceback.format_exc(),
                }
            payloads.append(payload)
            print(f"profiled {module}", flush=True)
    # Each isolated child loads one named module before it runs.  That
    # per-module count is the authoritative population here; it avoids a
    # namespace-package/import-cache discrepancy in unittest's aggregate
    # discovery when this script is launched by path on Windows.
    discovered_cases = sum(int(payload["case_count"]) for payload in payloads)
    report = _summarize_backend(
        root=root,
        module_payloads=payloads,
        started=started,
        discovered_cases=discovered_cases,
    )
    report["aggregate_loader_discovered_case_count"] = loader_discovered_cases
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        f"Backend profile: {report['recorded_case_count']}/{discovered_cases} cases; "
        f"{report['overall_wall_seconds']:.2f}s wall; report={output}"
    )
    return 0 if not report["failures"] and report["recorded_case_count"] == discovered_cases else 1


def _parse_tap(output: str) -> tuple[list[dict[str, Any]], bool]:
    cases: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    failed = False
    for line in output.splitlines():
        stripped = line.strip()
        if stripped.startswith("# Subtest:"):
            current = {"id": stripped.split(":", 1)[1].strip(), "status": "passed"}
            cases.append(current)
        elif stripped.startswith("not ok"):
            failed = True
            if current is not None:
                current["status"] = "failed"
        elif current is not None and (
            stripped.startswith("duration_ms:")
            or stripped.startswith("# duration_ms:")
        ):
            try:
                current["duration_seconds"] = (
                    float(stripped.split(":", 1)[1].strip()) / 1000.0
                )
            except ValueError:
                current["duration_seconds"] = 0.0
    for case in cases:
        case.setdefault("duration_seconds", 0.0)
    return cases, failed


def _profile_frontend_file(*, root: Path, node: str, path: Path) -> dict[str, Any]:
    started = time.perf_counter()
    completed = subprocess.run(
        [node, "--test", "--test-reporter=tap", str(path)],
        cwd=root,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        shell=False,
    )
    output = _merge_output(completed.stdout, completed.stderr)
    cases, tap_failed = _parse_tap(output)
    return {
        "file": path.relative_to(root).as_posix(),
        "case_count": len(cases),
        "file_wall_seconds": time.perf_counter() - started,
        "case_timings": cases,
        "successful": completed.returncode == 0 and not tap_failed,
        "exit_code": completed.returncode,
        "output": output,
    }


def profile_frontend(args: argparse.Namespace) -> int:
    root = args.root.resolve()
    output = args.output.resolve()
    node = args.node or shutil.which("node")
    if node is None:
        print("Node.js is not available on PATH.", file=sys.stderr)
        return 1
    files = discover_frontend_files(root)
    started = time.perf_counter()
    rows: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max(1, min(args.jobs, len(files)))) as pool:
        futures = {
            pool.submit(_profile_frontend_file, root=root, node=node, path=path): path
            for path in files
        }
        for future in as_completed(futures):
            rows.append(future.result())
            print(f"profiled {futures[future].relative_to(root).as_posix()}", flush=True)
    cases = [case | {"file": row["file"]} for row in rows for case in row["case_timings"]]
    durations = [float(case["duration_seconds"]) for case in cases]
    top = sorted(cases, key=lambda item: float(item["duration_seconds"]), reverse=True)
    total = sum(durations)
    report = {
        "schema": "cellxplorer.spec-048.2.frontend-profile.v1",
        "node": node,
        "root": str(root),
        "file_count": len(rows),
        "case_count": len(cases),
        "overall_wall_seconds": time.perf_counter() - started,
        "case_duration_statistics": duration_statistics(durations),
        "file_duration_statistics": duration_statistics(
            [float(row["file_wall_seconds"]) for row in rows]
        ),
        "top_50_cases": top[:50],
        "top_50_files": sorted(
            rows, key=lambda item: float(item["file_wall_seconds"]), reverse=True
        )[:50],
        "top_file_concentration": {
            str(limit): (sum(float(row["file_wall_seconds"]) for row in sorted(rows, key=lambda item: item["file_wall_seconds"], reverse=True)[:limit]) / sum(float(row["file_wall_seconds"]) for row in rows) if rows else 0.0)
            for limit in (10, 25, 50)
        },
        "files": sorted(rows, key=lambda item: item["file"]),
        "failures": [row["file"] for row in rows if not row["successful"]],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        f"Frontend profile: {report['case_count']} cases in {report['file_count']} files; "
        f"{report['overall_wall_seconds']:.2f}s wall; report={output}"
    )
    return 0 if not report["failures"] else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--jobs", type=int, default=max(1, min(16, os.cpu_count() or 4)))
    parser.add_argument("--data-root", type=Path)
    parser.add_argument("--node")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--backend", action="store_true")
    group.add_argument("--frontend", action="store_true")
    parser.add_argument("--backend-module")
    parser.add_argument("--result", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.backend_module:
        if args.result is None or args.data_root is None:
            raise SystemExit("--backend-module requires --result and --data-root")
        return run_backend_module_child(
            root=args.root.resolve(),
            module=args.backend_module,
            data_root=args.data_root.resolve(),
            result_path=args.result.resolve(),
            backend_jobs=args.jobs,
        )
    if args.backend:
        if args.output is None:
            raise SystemExit("--backend requires --output")
        return profile_backend(args)
    if args.frontend:
        if args.output is None:
            raise SystemExit("--frontend requires --output")
        return profile_frontend(args)
    raise SystemExit("choose --backend or --frontend")


if __name__ == "__main__":
    raise SystemExit(main())
