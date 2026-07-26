"""Shared helpers for the golden analysis regression corpus (Spec 015)."""
from __future__ import annotations

import hashlib
import importlib
import json
import math
import os
import shutil
import tempfile
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.models import Cell, CellMetadata, SourceFile, Test, TestFile
from app.config import CALC_VERSION
from app.services import analysis_engine as engine
from app.services import chargeability, parsing, rate_capability

FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "golden_analysis"
MANIFEST_PATH = FIXTURE_ROOT / "manifest.json"

VOLATILE_RESULT_KEYS = {
    "computed_at",
    "cache_status",
    "current_parser_version",
    "current_calc_version",
    "progress",
    "job",
}

DEFAULT_PROFILE = {
    "relative_tolerance": 1e-7,
    "absolute_tolerance": 1e-9,
}

ALLOWED_CELL_METADATA_KEYS = (
    "active_material_mg",
    "active_mass_mg",
    "nominal_capacity_mah",
    "electrode_area_cm2",
    "override.electrode_area_cm2",
)

# Production absolute cycle quantities (ALL_QUANTITIES minus mass-normalized).
CYCLES_ABSOLUTE_QUANTITIES = {
    "charge_capacity_mah",
    "discharge_capacity_mah",
    "coulombic_efficiency_pct",
    "charge_energy_mwh",
    "discharge_energy_mwh",
    "energy_efficiency_pct",
    "mean_charge_voltage_v",
    "mean_discharge_voltage_v",
    "cycle_duration_h",
    "charge_time_h",
    "discharge_time_h",
    "cv_charge_time_h",
    "cv_charge_capacity_mah",
    "cv_charge_fraction_pct",
    "cv_charge_event_count",
    "cv_reached",
    "voltaic_efficiency_pct",
    "polarization_v",
    "polarization_pct",
    "capacity_retention_pct",
    "discharge_capacity_loss_mah",
    "charge_capacity_loss_mah",
}

CYCLES_SPECIFIC_QUANTITIES = {
    "charge_capacity_mah_g",
    "discharge_capacity_mah_g",
    "charge_energy_mwh_g",
    "discharge_energy_mwh_g",
    "charge_capacity_loss_mah_g_cycle",
    "discharge_capacity_loss_mah_g_cycle",
    "cv_charge_capacity_mah_g",
}

# Absolute scientific context retained in the normalization projection.
CYCLES_NORMALIZATION_CONTEXT_QUANTITIES = CYCLES_ABSOLUTE_QUANTITIES - {
    "charge_capacity_mah",
    "discharge_capacity_mah",
    "charge_energy_mwh",
    "discharge_energy_mwh",
    "charge_capacity_loss_mah",
    "discharge_capacity_loss_mah",
    "cv_charge_capacity_mah",
}

CYCLES_ABSOLUTE_METRICS = {
    "n_cycles",
    "max_discharge_capacity_mah",
    "mean_discharge_capacity_mah",
    "first_cycle_ce_pct",
    "mean_ce_pct",
    "mean_ee_pct",
    "mean_ve_pct",
    "last_cycle",
    "retention_last_pct",
    "discharge_loss_mah_per_cycle",
    "charge_loss_mah_per_cycle",
    "discharge_loss_pct_per_cycle",
    "cycles_to_80_pct",
    "total_duration_h",
    "mean_cycle_duration_h",
    "mean_charge_time_h",
    "mean_discharge_time_h",
    "cv_reached_cycles",
    "cv_reached_pct",
    "cv_charge_event_count",
    "mean_cv_charge_time_h",
    "median_cv_charge_time_h",
    "mean_cv_charge_capacity_mah",
    "median_cv_charge_capacity_mah",
    "mean_cv_charge_fraction_pct",
}

REQUIRED_CYCLES_BASELINE_QUANTITIES = {
    "charge_capacity_mah",
    "discharge_capacity_mah",
    "charge_energy_mwh",
    "discharge_energy_mwh",
    "coulombic_efficiency_pct",
    "energy_efficiency_pct",
    "mean_charge_voltage_v",
    "mean_discharge_voltage_v",
    "cv_charge_time_h",
    "cv_charge_capacity_mah",
    "capacity_retention_pct",
    "polarization_v",
}

REQUIRED_CYCLES_BASELINE_METRICS = {
    "n_cycles",
    "max_discharge_capacity_mah",
    "mean_ce_pct",
    "mean_ee_pct",
    "retention_last_pct",
    "total_duration_h",
}

REQUIRED_CYCLES_NORMALIZATION_QUANTITIES = {
    "charge_capacity_mah_g",
    "discharge_capacity_mah_g",
    "capacity_retention_pct",
    "coulombic_efficiency_pct",
    "polarization_v",
}


class GoldenAnalysisError(Exception):
    """Base error for golden corpus problems."""


class ManifestError(GoldenAnalysisError):
    pass


class ComparisonError(GoldenAnalysisError):
    def __init__(self, message: str, *, path: str, expected: Any, actual: Any) -> None:
        super().__init__(message)
        self.path = path
        self.expected = expected
        self.actual = actual


# Rebound by bind_isolated_data_root() before any cache I/O.
cache = importlib.import_module("app.services.cache")
scanner = importlib.import_module("app.services.scanner")


def resolved_data_root_from_env(env_value: str | None = None) -> Path:
    """Resolve the production data root from an environment value or the current process."""
    if env_value is None:
        env_value = os.environ.get("CELLXPLORER_DATA")
    if env_value:
        return Path(env_value).resolve()
    return (Path.home() / ".cellxplorer").resolve()


def bind_isolated_data_root(data_root: Path) -> None:
    """Point production cache/config modules at an isolated data directory."""
    global cache, scanner

    data_root = data_root.resolve()
    data_root.mkdir(parents=True, exist_ok=True)
    (data_root / "cache").mkdir(parents=True, exist_ok=True)
    (data_root / "imports").mkdir(parents=True, exist_ok=True)
    (data_root / "logs").mkdir(parents=True, exist_ok=True)
    os.environ["CELLXPLORER_DATA"] = str(data_root)

    from app import config as config_mod

    importlib.reload(config_mod)
    cache = importlib.reload(importlib.import_module("app.services.cache"))
    scanner = importlib.reload(importlib.import_module("app.services.scanner"))


def restore_data_root_binding(saved_env: str | None) -> None:
    """Restore config/cache/scanner module bindings to the prior data root."""
    if saved_env is None:
        os.environ.pop("CELLXPLORER_DATA", None)
        target = Path.home() / ".cellxplorer"
    else:
        os.environ["CELLXPLORER_DATA"] = saved_env
        target = Path(saved_env)
    bind_isolated_data_root(target)


class CandidateOutputPathError(GoldenAnalysisError):
    """Raised when a candidate corpus path would overwrite committed fixtures."""


def path_is_equal_or_descendant(path: Path, ancestor: Path) -> bool:
    path = path.resolve()
    ancestor = ancestor.resolve()
    if path == ancestor:
        return True
    return path.is_relative_to(ancestor)


def validate_candidate_output_path(
    output: Path,
    *,
    committed: Path | None = None,
    source: Path | None = None,
) -> Path:
    """Reject candidate output paths that would pollute committed or source trees."""
    output = output.resolve()
    committed_root = (committed or FIXTURE_ROOT).resolve()
    if path_is_equal_or_descendant(output, committed_root):
        raise CandidateOutputPathError(
            "Refusing candidate output equal to or under the committed fixture tree "
            f"({committed_root}). Export/refresh to a separate directory, then copy after review."
        )
    if source is not None:
        source_root = source.resolve()
        if path_is_equal_or_descendant(output, source_root):
            raise CandidateOutputPathError(
                "Refusing candidate output equal to or inside the selected source tree "
                f"({source_root}). Choose an output directory outside the source tree."
            )
    return output


PRIVACY_REVIEW_RAW_KEYWORDS = (
    "guid",
    "remark",
    "creator",
    "devid",
    "chlid",
    "unitid",
    "operator",
    "device",
    "barcode",
)


def _flatten_metadata(
    value: Any,
    *,
    path: str = "$",
) -> list[dict[str, str]]:
    """Return every metadata leaf with a stable path and printable value."""
    if isinstance(value, dict):
        flattened: list[dict[str, str]] = []
        for key in sorted(value, key=str):
            flattened.extend(
                _flatten_metadata(value[key], path=f"{path}.{key}")
            )
        return flattened
    if isinstance(value, (list, tuple)):
        flattened = []
        for index, item in enumerate(value):
            flattened.extend(_flatten_metadata(item, path=f"{path}[{index}]"))
        return flattened
    return [
        {
            "path": path,
            "value": "" if value is None else str(value),
            "value_type": type(value).__name__,
        }
    ]


def inspect_binary_privacy(manifest: dict[str, Any], root: Path | None = None) -> dict[str, Any]:
    """Collect the complete flattened header for one-time privacy review."""
    from app.services import parsing

    root = root or fixture_root()
    sources: list[dict[str, Any]] = []
    for source in manifest.get("sources", []):
        binary = (root / source["binary_path"]).resolve()
        meta = parsing.read_header_metadata(binary)
        flattened = _flatten_metadata(meta)
        sensitive_hits = [
            item
            for item in flattened
            if any(
                keyword in f"{item['path']} {item['value']}".lower()
                for keyword in PRIVACY_REVIEW_RAW_KEYWORDS
            )
        ]
        sources.append(
            {
                "key": source["key"],
                "binary_path": source["binary_path"],
                "sha256": source["sha256"],
                "flattened_header_fields": flattened,
                "flattened_header_field_count": len(flattened),
                "sensitive_field_hits": sensitive_hits,
                "sensitive_field_hit_count": len(sensitive_hits),
            }
        )
    return {
        "schema_version": 2,
        "scope": "complete flattened output of parsing.read_header_metadata",
        "source_count": len(sources),
        "flattened_header_field_count": sum(
            source["flattened_header_field_count"] for source in sources
        ),
        "sources": sources,
    }


def collect_json_diffs(
    expected: Any,
    actual: Any,
    *,
    path: str = "$",
    max_entries: int = 100,
) -> list[dict[str, Any]]:
    """Collect structured JSON differences for candidate review."""
    diffs: list[dict[str, Any]] = []

    def add(entry: dict[str, Any]) -> None:
        if len(diffs) < max_entries:
            diffs.append(entry)

    def walk(exp: Any, act: Any, current_path: str) -> None:
        if len(diffs) >= max_entries:
            return

        if type(exp) is not type(act):
            add(
                {
                    "path": current_path,
                    "kind": "type_mismatch",
                    "expected_type": type(exp).__name__,
                    "actual_type": type(act).__name__,
                    "expected": exp,
                    "actual": act,
                }
            )
            return

        if isinstance(exp, bool):
            if exp is not act:
                add({"path": current_path, "kind": "changed", "expected": exp, "actual": act})
            return

        if isinstance(exp, int) and isinstance(act, int):
            if exp != act:
                add({"path": current_path, "kind": "changed", "expected": exp, "actual": act})
            return

        if _is_number(exp) and _is_number(act):
            if not math.isclose(float(exp), float(act), rel_tol=0.0, abs_tol=0.0):
                abs_diff = abs(float(act) - float(exp))
                rel_diff = abs_diff / max(abs(float(exp)), 1e-30)
                add(
                    {
                        "path": current_path,
                        "kind": "numeric_changed",
                        "expected": exp,
                        "actual": act,
                        "abs_diff": abs_diff,
                        "rel_diff": rel_diff,
                    }
                )
            return

        if isinstance(exp, str):
            if exp != act:
                add({"path": current_path, "kind": "changed", "expected": exp, "actual": act})
            return

        if exp is None or act is None:
            if exp is not act:
                add({"path": current_path, "kind": "changed", "expected": exp, "actual": act})
            return

        if isinstance(exp, list):
            if len(exp) != len(act):
                add(
                    {
                        "path": current_path,
                        "kind": "length_mismatch",
                        "expected_length": len(exp),
                        "actual_length": len(act),
                    }
                )
                limit = min(len(exp), len(act), 5)
                for index in range(limit):
                    walk(exp[index], act[index], f"{current_path}[{index}]")
                return
            for index, (exp_item, act_item) in enumerate(zip(exp, act)):
                walk(exp_item, act_item, f"{current_path}[{index}]")
            return

        if isinstance(exp, dict):
            exp_keys = set(exp)
            act_keys = set(act)
            for key in sorted(exp_keys - act_keys):
                add({"path": f"{current_path}.{key}", "kind": "removed", "expected": exp[key]})
            for key in sorted(act_keys - exp_keys):
                add({"path": f"{current_path}.{key}", "kind": "added", "actual": act[key]})
            for key in sorted(exp_keys & act_keys):
                walk(exp[key], act[key], f"{current_path}.{key}")
            return

        if exp != act:
            add({"path": current_path, "kind": "changed", "expected": exp, "actual": act})

    walk(expected, actual, path)
    return diffs


def summarize_scientific_diff(
    committed: Path,
    candidate: Path,
    *,
    manifest: dict[str, Any] | None = None,
    max_entries_per_case: int = 100,
) -> dict[str, Any]:
    """Build a structured scientific diff report for candidate expected JSON."""
    committed = committed.resolve()
    candidate = candidate.resolve()
    manifest = manifest or load_manifest(candidate / "manifest.json")
    cases: list[dict[str, Any]] = []

    for case in manifest.get("cases", []):
        case_id = case["id"]
        rel = Path(case["expected_path"]).name
        committed_path = committed / case["expected_path"]
        candidate_path = candidate / case["expected_path"]
        digest_same = (
            committed_path.is_file()
            and candidate_path.is_file()
            and sha256_file(committed_path) == sha256_file(candidate_path)
        )
        entry: dict[str, Any] = {
            "case_id": case_id,
            "expected_file": rel,
            "digest_status": "SAME" if digest_same else "DIFF",
            "changed_path_count": 0,
            "sample_diffs": [],
        }
        if committed_path.is_file() and candidate_path.is_file() and not digest_same:
            expected = json.loads(committed_path.read_text(encoding="utf-8"))
            actual = json.loads(candidate_path.read_text(encoding="utf-8"))
            diffs = collect_json_diffs(expected, actual, max_entries=max_entries_per_case)
            entry["changed_path_count"] = len(diffs)
            entry["sample_diffs"] = diffs[:20]
        elif not committed_path.is_file() and candidate_path.is_file():
            entry["digest_status"] = "NEW"
        cases.append(entry)

    return {
        "schema_version": 1,
        "committed_root": str(committed),
        "candidate_root": str(candidate),
        "cases": cases,
    }


def write_scientific_diff_report(
    committed: Path,
    candidate: Path,
    report_path: Path | None = None,
    *,
    manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Write and return a machine-readable scientific diff report."""
    report = summarize_scientific_diff(committed, candidate, manifest=manifest)
    if report_path is not None:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def trim_cell_metadata(metadata: dict[str, str] | None) -> dict[str, str]:
    if not metadata:
        return {}
    allowed = set(ALLOWED_CELL_METADATA_KEYS)
    return {key: str(value) for key, value in metadata.items() if key in allowed and value not in (None, "")}


def fixture_root() -> Path:
    return FIXTURE_ROOT


def load_manifest(path: Path | None = None) -> dict[str, Any]:
    manifest_path = path or MANIFEST_PATH
    if not manifest_path.is_file():
        raise ManifestError(f"Manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1:
        raise ManifestError(f"Unsupported manifest schema: {manifest.get('schema_version')!r}")
    return manifest


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_source_binaries(manifest: dict[str, Any], root: Path | None = None) -> None:
    root = root or fixture_root()
    for source in manifest.get("sources", []):
        rel = source["binary_path"]
        path = root / rel
        if not path.is_file():
            raise ManifestError(f"Missing source binary: {rel}")
        digest = sha256_file(path)
        expected = source["sha256"]
        if digest != expected:
            raise ManifestError(
                f"Checksum mismatch for {rel}: expected {expected}, got {digest}"
            )


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def compare_values(
    expected: Any,
    actual: Any,
    *,
    path: str = "$",
    profile: dict[str, float] | None = None,
) -> None:
    profile = profile or DEFAULT_PROFILE
    rel = profile["relative_tolerance"]
    abs_tol = profile["absolute_tolerance"]

    if expected is None or actual is None:
        if expected is not actual:
            raise ComparisonError(
                f"{path}: expected {expected!r}, got {actual!r}",
                path=path,
                expected=expected,
                actual=actual,
            )
        return

    if isinstance(expected, bool) or isinstance(actual, bool):
        if expected is not actual:
            raise ComparisonError(
                f"{path}: expected {expected!r}, got {actual!r}",
                path=path,
                expected=expected,
                actual=actual,
            )
        return

    if isinstance(expected, int) and isinstance(actual, int):
        if expected != actual:
            raise ComparisonError(
                f"{path}: expected {expected}, got {actual}",
                path=path,
                expected=expected,
                actual=actual,
            )
        return

    if _is_number(expected) and _is_number(actual):
        if not math.isfinite(actual):
            raise ComparisonError(
                f"{path}: non-finite actual value {actual!r}",
                path=path,
                expected=expected,
                actual=actual,
            )
        if not math.isclose(float(expected), float(actual), rel_tol=rel, abs_tol=abs_tol):
            diff = abs(float(actual) - float(expected))
            raise ComparisonError(
                (
                    f"{path}: expected {expected}, got {actual} "
                    f"(abs diff {diff}, tol rel={rel} abs={abs_tol})"
                ),
                path=path,
                expected=expected,
                actual=actual,
            )
        return

    if isinstance(expected, str) or isinstance(actual, str):
        if expected != actual:
            raise ComparisonError(
                f"{path}: expected {expected!r}, got {actual!r}",
                path=path,
                expected=expected,
                actual=actual,
            )
        return

    if isinstance(expected, list):
        if not isinstance(actual, list):
            raise ComparisonError(
                f"{path}: expected list, got {type(actual).__name__}",
                path=path,
                expected=expected,
                actual=actual,
            )
        if len(expected) != len(actual):
            raise ComparisonError(
                f"{path}: expected length {len(expected)}, got {len(actual)}",
                path=path,
                expected=expected,
                actual=actual,
            )
        for index, (exp_item, act_item) in enumerate(zip(expected, actual)):
            compare_values(exp_item, act_item, path=f"{path}[{index}]", profile=profile)
        return

    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            raise ComparisonError(
                f"{path}: expected dict, got {type(actual).__name__}",
                path=path,
                expected=expected,
                actual=actual,
            )
        if set(expected.keys()) != set(actual.keys()):
            raise ComparisonError(
                f"{path}: key mismatch expected={sorted(expected.keys())} actual={sorted(actual.keys())}",
                path=path,
                expected=expected,
                actual=actual,
            )
        for key in sorted(expected.keys()):
            compare_values(expected[key], actual[key], path=f"{path}.{key}", profile=profile)
        return

    if expected != actual:
        raise ComparisonError(
            f"{path}: expected {expected!r}, got {actual!r}",
            path=path,
            expected=expected,
            actual=actual,
        )


def _filter_mapping(mapping: dict[str, Any], allowed: set[str]) -> dict[str, Any]:
    return {key: mapping[key] for key in sorted(mapping) if key in allowed}


def _apply_cycles_projection(projected: dict[str, Any], mode: str) -> dict[str, Any]:
    if mode == "cycles_absolute":
        quantity_keys = CYCLES_ABSOLUTE_QUANTITIES
        metric_keys = CYCLES_ABSOLUTE_METRICS
    elif mode == "cycles_specific":
        # Keep absolute scientific context; replace absolute capacity/energy with
        # mass-normalized counterparts so the case remains distinct.
        quantity_keys = CYCLES_NORMALIZATION_CONTEXT_QUANTITIES | CYCLES_SPECIFIC_QUANTITIES
        metric_keys = CYCLES_ABSOLUTE_METRICS
    else:
        return projected

    for series in projected.get("cell_series") or []:
        quantities = series.get("quantities") or {}
        series["quantities"] = _filter_mapping(quantities, quantity_keys)
        metrics = series.get("metrics") or {}
        series["metrics"] = _filter_mapping(metrics, metric_keys)
        series.pop("active_mass_mg", None)
    for series in projected.get("group_series") or []:
        quantities = series.get("quantities") or {}
        series["quantities"] = _filter_mapping(quantities, quantity_keys)
    projected.pop("group_metrics", None)
    return projected


class NonFiniteProjectionError(GoldenAnalysisError):
    """Raised when a production result contains NaN or Infinity."""


def project_result(
    result: dict[str, Any],
    *,
    projection: str | None = None,
    path: str = "$",
) -> dict[str, Any]:
    """Reduce a production compute response to a stable scientific projection."""

    def walk(value: Any, current_path: str) -> Any:
        if isinstance(value, dict):
            projected: dict[str, Any] = {}
            for key, item in value.items():
                if key in VOLATILE_RESULT_KEYS:
                    continue
                if key in {"path", "source_path", "thumbnail", "thumbnail_svg"}:
                    continue
                projected[key] = walk(item, f"{current_path}.{key}")
            return projected
        if isinstance(value, list):
            return [walk(item, f"{current_path}[{index}]") for index, item in enumerate(value)]
        if isinstance(value, float) and not math.isfinite(value):
            raise NonFiniteProjectionError(
                f"{current_path}: non-finite scientific value {value!r} is not allowed in golden projections"
            )
        return value

    projected = walk(deepcopy(result), path)
    if isinstance(projected, dict):
        projected.pop("sources", None)
        for traces_key in ("cell_traces", "cell_series"):
            traces = projected.get(traces_key)
            if isinstance(traces, list):
                for trace in traces:
                    if isinstance(trace, dict):
                        trace.pop("label", None)
        if projection:
            projected = _apply_cycles_projection(projected, projection)
    return projected


def load_case_spec(root: Path, case: dict[str, Any]) -> dict[str, Any]:
    spec_path = root / case["spec_path"]
    if not spec_path.is_file():
        raise ManifestError(f"Missing spec for case {case['id']}: {spec_path}")
    return json.loads(spec_path.read_text(encoding="utf-8"))


def load_case_expected(root: Path, case: dict[str, Any]) -> dict[str, Any]:
    expected_path = root / case["expected_path"]
    if not expected_path.is_file():
        raise ManifestError(f"Missing expected output for case {case['id']}: {expected_path}")
    return json.loads(expected_path.read_text(encoding="utf-8"))


def comparison_profile(manifest: dict[str, Any], case: dict[str, Any]) -> dict[str, float]:
    profiles = manifest.get("comparison_profiles") or {}
    name = case.get("comparison_profile") or "scientific_default"
    profile = profiles.get(name)
    if not profile:
        return DEFAULT_PROFILE
    return {
        "relative_tolerance": float(profile.get("relative_tolerance", DEFAULT_PROFILE["relative_tolerance"])),
        "absolute_tolerance": float(profile.get("absolute_tolerance", DEFAULT_PROFILE["absolute_tolerance"])),
    }


def dispatch_case(db: Session, case: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    kind = case["kind"]
    provenance = None
    if kind == "cycles":
        return engine.compute(db, spec, provenance)
    if kind == "time_capacity":
        options = case.get("request_options") or {}
        return engine.compute_time_capacity(
            db,
            spec,
            provenance,
            viewport_width=options.get("viewport_width", 1200),
            precision=options.get("precision", "full"),
            compact=options.get("compact", False),
        )
    if kind == "steps":
        return engine.compute_steps(db, spec, provenance)
    if kind == "dcir":
        return engine.compute_dcir(db, spec, provenance)
    if kind == "chargeability":
        return chargeability.compute(db, spec, provenance)
    if kind == "rate_capability":
        return rate_capability.compute(db, spec, provenance)
    raise ManifestError(f"Unsupported case kind: {kind!r}")


def required_raw_columns() -> list[str]:
    return [
        "cycle",
        "step",
        "time_s",
        "voltage_v",
        "current_ma",
        "charge_capacity_mah",
        "discharge_capacity_mah",
        "status",
    ]


def required_raw_dtype_families() -> dict[str, str]:
    """Expected pandas dtype family for each required raw column."""
    return {
        "cycle": "integer",
        "step": "integer",
        "time_s": "floating",
        "voltage_v": "floating",
        "current_ma": "floating",
        "charge_capacity_mah": "floating",
        "discharge_capacity_mah": "floating",
        "status": "string",
    }


def assert_raw_frame_schema(raw, *, source_key: str) -> None:
    import pandas as pd

    missing = [column for column in required_raw_columns() if column not in raw.columns]
    if missing:
        raise ManifestError(f"Raw cache for {source_key} missing columns: {missing}")
    for column, family in required_raw_dtype_families().items():
        dtype = raw[column].dtype
        if family == "integer" and not pd.api.types.is_integer_dtype(dtype):
            raise ManifestError(
                f"Raw cache for {source_key} column {column!r} expected integer dtype, got {dtype}"
            )
        if family == "floating" and not pd.api.types.is_float_dtype(dtype):
            raise ManifestError(
                f"Raw cache for {source_key} column {column!r} expected floating dtype, got {dtype}"
            )
        if family == "string" and not (
            pd.api.types.is_string_dtype(dtype)
            or pd.api.types.is_object_dtype(dtype)
        ):
            raise ManifestError(
                f"Raw cache for {source_key} column {column!r} expected string-like dtype, got {dtype}"
            )


@dataclass
class GoldenFixtureEnvironment:
    manifest: dict[str, Any]
    root: Path
    data_root: Path
    db: Session
    parse_counts: dict[str, int] = field(default_factory=dict)
    timeseries_parse_counts: dict[str, int] = field(default_factory=dict)
    _temp_dir: tempfile.TemporaryDirectory[str] | None = field(default=None, repr=False)
    _owns_data_root: bool = field(default=True, repr=False)

    @classmethod
    def create(
        cls,
        manifest_path: Path | None = None,
        *,
        data_root: Path | None = None,
    ) -> "GoldenFixtureEnvironment":
        from unittest import mock

        manifest = load_manifest(manifest_path)
        root = manifest_path.parent if manifest_path else fixture_root()
        verify_source_binaries(manifest, root)

        temp: tempfile.TemporaryDirectory[str] | None
        owns_data_root = data_root is None
        if data_root is None:
            temp = tempfile.TemporaryDirectory(prefix="cellxplorer-golden-")
            data_root = Path(temp.name)
        else:
            temp = None
            data_root = data_root.resolve()

        bind_isolated_data_root(data_root)
        env = cls(
            manifest=manifest,
            root=root,
            data_root=data_root,
            db=cls._make_db(),
            _temp_dir=temp,
            _owns_data_root=owns_data_root,
        )
        try:
            env.install_entities()
            original = parsing.parse_timeseries

            def _counting_parse(path, *args, **kwargs):
                digest = sha256_file(Path(path))
                env.timeseries_parse_counts[digest] = env.timeseries_parse_counts.get(digest, 0) + 1
                return original(path, *args, **kwargs)

            with mock.patch.object(parsing, "parse_timeseries", side_effect=_counting_parse):
                # cache.build imports parsing at call time via module reference
                with mock.patch("app.services.cache.parsing.parse_timeseries", side_effect=_counting_parse):
                    env.ensure_sources_parsed()
        except Exception:
            env.close()
            raise
        return env

    @staticmethod
    def _make_db() -> Session:
        eng = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )

        @event.listens_for(eng, "connect")
        def _pragma(dbapi_connection, _connection_record) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

        Base.metadata.create_all(eng)
        return sessionmaker(bind=eng, autoflush=False, expire_on_commit=False)()

    def close(self) -> None:
        self.db.close()
        if self._temp_dir is not None:
            self._temp_dir.cleanup()
            self._temp_dir = None
        elif self._owns_data_root and self.data_root.exists():
            shutil.rmtree(self.data_root, ignore_errors=True)

    def __enter__(self) -> "GoldenFixtureEnvironment":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def install_entities(self) -> None:
        entities = self.manifest.get("entities") or {}
        for cell in entities.get("cells", []):
            row = Cell(id=cell["id"], name=cell["name"], description=cell.get("description"))
            self.db.add(row)
            metadata = trim_cell_metadata(cell.get("metadata") or {})
            for key, value in metadata.items():
                self.db.add(CellMetadata(cell_id=cell["id"], key=key, value=str(value)))
        self.db.flush()

        source_files_by_hash: dict[str, SourceFile] = {}
        tests_by_cell: dict[int, Test] = {}

        for source in self.manifest.get("sources", []):
            binary = (self.root / source["binary_path"]).resolve()
            digest = source["sha256"]
            sf = source_files_by_hash.get(digest)
            if sf is None:
                sf = scanner.ingest_path(self.db, binary, parse_now=False)
                source_files_by_hash[digest] = sf

            cell_id = source["fixture_cell_id"]
            test = tests_by_cell.get(cell_id)
            if test is None:
                test = Test(cell_id=cell_id, name=f"golden-{source['key']}")
                self.db.add(test)
                self.db.flush()
                tests_by_cell[cell_id] = test
                self.db.add(TestFile(test_id=test.id, file_id=sf.id, position=0))
        self.db.commit()

    def ensure_sources_parsed(self) -> None:
        seen_hashes: set[str] = set()
        for source in self.manifest.get("sources", []):
            key = source["key"]
            digest = source["sha256"]
            if digest in seen_hashes:
                continue
            seen_hashes.add(digest)
            sf = self.db.query(SourceFile).filter(SourceFile.hash == digest).one()
            if not sf.header_meta:
                raise ManifestError(f"Missing parsed header metadata for source {key}")
            if sf.parse_status != "parsed":
                scanner.parse_file(self.db, sf)
                self.db.refresh(sf)
            self.parse_counts[key] = self.parse_counts.get(key, 0) + 1
            if source.get("row_count") is not None and sf.row_count != source["row_count"]:
                raise ManifestError(
                    f"Row count mismatch for {key}: manifest={source['row_count']} parsed={sf.row_count}"
                )
            if source.get("cycle_count") is not None and sf.cycle_count != source["cycle_count"]:
                raise ManifestError(
                    f"Cycle count mismatch for {key}: manifest={source['cycle_count']} parsed={sf.cycle_count}"
                )
            cycles = cache.load_cycles(sf.hash, sf.parser_version or parsing.PARSER_VERSION, CALC_VERSION)
            if cycles is None or cycles.empty:
                raise ManifestError(f"Per-cycle cache missing for source {key}")
            raw = cache.load_raw(sf.hash, sf.parser_version or parsing.PARSER_VERSION)
            if raw is None or raw.empty:
                raise ManifestError(f"Raw cache missing for source {key}")
            assert_raw_frame_schema(raw, source_key=key)

    def run_case(self, case: dict[str, Any]) -> dict[str, Any]:
        spec = load_case_spec(self.root, case)
        result = dispatch_case(self.db, case, spec)
        projection = case.get("projection")
        return project_result(result, projection=projection)
