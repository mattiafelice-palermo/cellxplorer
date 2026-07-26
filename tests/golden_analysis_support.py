"""Shared helpers for the golden analysis regression corpus (Spec 015)."""
from __future__ import annotations

import hashlib
import json
import math
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
from app.services import cache, chargeability, parsing, rate_capability, scanner

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


def project_result(result: dict[str, Any]) -> dict[str, Any]:
    """Reduce a production compute response to a stable scientific projection."""

    def walk(value: Any) -> Any:
        if isinstance(value, dict):
            projected: dict[str, Any] = {}
            for key, item in value.items():
                if key in VOLATILE_RESULT_KEYS:
                    continue
                if key in {"path", "source_path", "thumbnail", "thumbnail_svg"}:
                    continue
                projected[key] = walk(item)
            return projected
        if isinstance(value, list):
            return [walk(item) for item in value]
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value

    projected = walk(deepcopy(result))
    if isinstance(projected, dict):
        projected.pop("sources", None)
        for traces_key in ("cell_traces", "cell_series"):
            traces = projected.get(traces_key)
            if isinstance(traces, list):
                for trace in traces:
                    if isinstance(trace, dict):
                        trace.pop("label", None)
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


@dataclass
class GoldenFixtureEnvironment:
    manifest: dict[str, Any]
    root: Path
    data_root: Path
    db: Session
    parse_counts: dict[str, int] = field(default_factory=dict)
    _temp_dir: tempfile.TemporaryDirectory[str] | None = field(default=None, repr=False)

    @classmethod
    def create(cls, manifest_path: Path | None = None) -> "GoldenFixtureEnvironment":
        manifest = load_manifest(manifest_path)
        root = manifest_path.parent if manifest_path else fixture_root()
        verify_source_binaries(manifest, root)
        temp = tempfile.TemporaryDirectory(prefix="cellxplorer-golden-")
        data_root = Path(temp.name)
        env = cls(manifest=manifest, root=root, data_root=data_root, db=cls._make_db(), _temp_dir=temp)
        env.install_entities()
        env.ensure_sources_parsed()
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

    def __enter__(self) -> "GoldenFixtureEnvironment":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def install_entities(self) -> None:
        entities = self.manifest.get("entities") or {}
        for cell in entities.get("cells", []):
            row = Cell(id=cell["id"], name=cell["name"], description=cell.get("description"))
            self.db.add(row)
            for key, value in (cell.get("metadata") or {}).items():
                self.db.add(CellMetadata(cell_id=cell["id"], key=key, value=str(value)))
        self.db.flush()

        source_files_by_hash: dict[str, SourceFile] = {}
        tests_by_cell: dict[int, Test] = {}

        for source in self.manifest.get("sources", []):
            binary = self.root / source["binary_path"]
            digest = source["sha256"]
            sf = source_files_by_hash.get(digest)
            if sf is None:
                sf = SourceFile(
                    hash=digest,
                    path=str(binary.resolve()),
                    filename=binary.name,
                    size=source["file_size_bytes"],
                    ext=binary.suffix.lstrip("."),
                    parse_status="unparsed",
                    row_count=source.get("row_count"),
                    cycle_count=source.get("cycle_count"),
                )
                self.db.add(sf)
                self.db.flush()
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

    def run_case(self, case: dict[str, Any]) -> dict[str, Any]:
        spec = load_case_spec(self.root, case)
        result = dispatch_case(self.db, case, spec)
        return project_result(result)
