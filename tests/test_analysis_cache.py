from __future__ import annotations

from copy import deepcopy
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("CELLXPLORER_DATA", str(ROOT / ".test-cellxplorer"))
sys.path.insert(0, str(ROOT / "backend"))

from app.services import analysis_cache, analysis_engine


class AnalysisCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.patchers = [
            patch.object(analysis_cache, "_ROOT", root),
            patch.object(analysis_cache, "_RESULTS", root / "results"),
            patch.object(analysis_cache, "_ARTIFACTS", root / "artifacts"),
            patch.object(analysis_cache, "_THUMBNAILS", root / "thumbnails"),
            patch.object(analysis_cache, "_THUMBNAIL_INDEXES", root / "thumbnail-index"),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temporary.cleanup()

    def test_result_cache_survives_memory_lifetimes(self):
        value = {"cell_traces": [{"x": [1, 2], "y": [3.25, 4.5]}]}
        analysis_cache.store_result("time_capacity", "a" * 64, value)

        loaded = analysis_cache.load_result("time_capacity", "a" * 64)

        self.assertEqual(loaded["cell_traces"], value["cell_traces"])
        self.assertEqual(loaded["cache_status"], "hit")

    def test_artifacts_are_signature_scoped_and_removable(self):
        svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'
        artifact = {
            "svg": svg,
            "thumbnail": "data:image/png;base64,iVBORw0KGgo=",
            "preview_thumbnail": "data:image/webp;base64,UklGRg==",
            "figure": {"data": [], "layout": {}, "config": {}},
            "summary": [{"label": "Cell A", "cycles": 3, "status": "Visible"}],
        }
        analysis_cache.store_artifact(
            7,
            "plot-one",
            "signature-a",
            artifact,
            client_signature="client-signature-a",
        )

        self.assertEqual(analysis_cache.load_artifact(7, "plot-one", "signature-a"), artifact)
        self.assertEqual(
            analysis_cache.load_thumbnail(7, "plot-one", "signature-a"),
            artifact["thumbnail"],
        )
        self.assertEqual(
            analysis_cache.load_preview_thumbnail(7, "plot-one", "signature-a"),
            artifact["preview_thumbnail"],
        )
        self.assertEqual(
            analysis_cache.load_indexed_thumbnail(7, "plot-one", "client-signature-a"),
            artifact["thumbnail"],
        )
        self.assertTrue(analysis_cache.has_indexed_thumbnails(7, "plot-one"))
        self.assertEqual(
            analysis_cache.load_latest_thumbnail(7, "plot-one"),
            artifact["thumbnail"],
        )
        self.assertEqual(
            analysis_cache.load_latest_thumbnail(7, "plot-one", "preview"),
            artifact["preview_thumbnail"],
        )
        self.assertIsNone(analysis_cache.load_artifact(7, "plot-one", "signature-b"))

        refreshed = {
            "svg": '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>',
            "thumbnail": None,
            "figure": {"data": [{"x": [1], "y": [2]}], "layout": {}, "config": {}},
            "summary": [{"label": "Cell A", "cycles": 4, "status": "Visible"}],
        }
        analysis_cache.store_artifact(7, "plot-one", "signature-a", refreshed)
        merged = analysis_cache.load_artifact(7, "plot-one", "signature-a")
        self.assertEqual(merged["thumbnail"], artifact["thumbnail"])
        self.assertEqual(merged["svg"], refreshed["svg"])

        analysis_cache.delete_analysis_artifacts(7)
        self.assertIsNone(analysis_cache.load_artifact(7, "plot-one", "signature-a"))
        self.assertIsNone(analysis_cache.load_thumbnail(7, "plot-one", "signature-a"))
        self.assertIsNone(
            analysis_cache.load_indexed_thumbnail(7, "plot-one", "client-signature-a")
        )
        self.assertFalse(analysis_cache.has_indexed_thumbnails(7, "plot-one"))

    def test_lru_pruning_preserves_saved_plot_thumbnails(self):
        analysis_cache.store_artifact(
            8,
            "plot-two",
            "signature-b",
            {
                "svg": '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
                "thumbnail": "data:image/png;base64,iVBORw0KGgo=",
                "preview_thumbnail": "data:image/webp;base64,UklGRg==",
                "figure": {"data": [{"x": list(range(100)), "y": list(range(100))}]},
                "summary": [],
            },
            client_signature="client-signature-b",
        )

        with analysis_cache._lock:
            analysis_cache._prune_locked(limit_bytes=1)

        self.assertIsNone(analysis_cache.load_artifact(8, "plot-two", "signature-b"))
        self.assertEqual(
            analysis_cache.load_indexed_thumbnail(8, "plot-two", "client-signature-b"),
            "data:image/png;base64,iVBORw0KGgo=",
        )

    def test_indexed_thumbnail_rejects_changed_scientific_data_signature(self):
        thumbnail = "data:image/png;base64,iVBORw0KGgo="
        preview = "data:image/webp;base64,UklGRg=="
        analysis_cache.store_artifact(
            9,
            "plot-source-change",
            "client-signature:source-old",
            {
                "svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
                "thumbnail": thumbnail,
                "preview_thumbnail": preview,
                "figure": {"data": [], "layout": {}, "config": {}},
                "summary": [],
            },
            client_signature="client-signature",
            data_signature="source-old",
        )

        self.assertEqual(
            analysis_cache.load_indexed_thumbnail(
                9,
                "plot-source-change",
                "client-signature",
                expected_data_signature="source-old",
            ),
            thumbnail,
        )
        # The saved plot signature is unchanged, but a source hash/parser or
        # capability change produces a new scientific data identity. The old
        # image must not be served under that new identity.
        self.assertIsNone(
            analysis_cache.load_indexed_thumbnail(
                9,
                "plot-source-change",
                "client-signature",
                expected_data_signature="source-new",
            )
        )

    def test_webp_thumbnail_is_persisted(self):
        thumbnail = "data:image/webp;base64,UklGRg=="
        preview = "data:image/png;base64,iVBORw0KGgo="
        analysis_cache.store_thumbnail(
            7, "plot-webp", "signature-webp", thumbnail, preview
        )
        analysis_cache.store_indexed_thumbnail(
            7, "plot-webp", "client-webp", thumbnail, preview
        )

        self.assertEqual(
            analysis_cache.load_thumbnail(7, "plot-webp", "signature-webp"),
            thumbnail,
        )
        self.assertEqual(
            analysis_cache.load_indexed_thumbnail(7, "plot-webp", "client-webp"),
            thumbnail,
        )
        self.assertEqual(
            analysis_cache.load_preview_thumbnail(7, "plot-webp", "signature-webp"),
            preview,
        )

    def test_incomplete_thumbnail_pair_is_not_treated_as_prepared(self):
        thumbnail = "data:image/webp;base64,UklGRg=="
        analysis_cache.store_thumbnail(7, "plot-partial", "signature", thumbnail)
        analysis_cache.store_indexed_thumbnail(7, "plot-partial", "client", thumbnail)

        self.assertIsNone(analysis_cache.load_thumbnail(7, "plot-partial", "signature"))
        self.assertIsNone(
            analysis_cache.load_indexed_thumbnail(7, "plot-partial", "client")
        )

    def test_steps_view_does_not_change_scientific_cache_spec(self):
        base = {
            "selection": {"units": [{"kind": "cell", "ref_id": 7}]},
            "computation": {
                "steps": {
                    "series": [
                        {"id": "s1", "cell_id": 7, "segment_id": "fast-charge"}
                    ],
                    "mode": "union",
                }
            },
            "aggregation": {},
            "protocol_segments": [],
            "presentation": {
                "steps_view": {
                    "quantity": "time",
                    "direction": "charge",
                    "include_rest": False,
                    "x_axis": "occurrence",
                }
            },
        }
        changed_view = {
            **base,
            "presentation": {
                "steps_view": {
                    "quantity": "voltage",
                    "direction": "total",
                    "include_rest": True,
                    "x_axis": "time",
                }
            },
        }

        self.assertEqual(
            analysis_cache._scientific_spec(base),
            analysis_cache._scientific_spec(changed_view),
        )

    def test_steps_series_and_mode_change_scientific_cache_spec(self):
        base = {
            "selection": {"units": [{"kind": "cell", "ref_id": 7}]},
            "computation": {
                "steps": {
                    "series": [
                        {"id": "s1", "cell_id": 7, "segment_id": "fast-charge"}
                    ],
                    "mode": "union",
                }
            },
            "aggregation": {},
            "protocol_segments": [],
            "presentation": {},
        }
        changed_series = {
            **base,
            "computation": {
                "steps": {
                    "series": [
                        {"id": "s2", "cell_id": 7, "segment_id": "formation"}
                    ],
                    "mode": "union",
                }
            },
        }
        changed_mode = {
            **base,
            "computation": {
                "steps": {
                    "series": base["computation"]["steps"]["series"],
                    "mode": "contiguous",
                }
            },
        }

        self.assertNotEqual(
            analysis_cache._scientific_spec(base),
            analysis_cache._scientific_spec(changed_series),
        )
        self.assertNotEqual(
            analysis_cache._scientific_spec(base),
            analysis_cache._scientific_spec(changed_mode),
        )

    def test_time_capacity_voltage_channel_changes_scientific_cache_spec(self):
        # Spec 040.4: the artifact/query key must distinguish a channel
        # selection so an old cached artifact for primary voltage is never
        # served for a newly selected electrode potential.
        base = {
            "selection": {"units": [{"kind": "cell", "ref_id": 7}]},
            "computation": {"time_capacity": {"voltage_channel": "voltage"}},
            "aggregation": {},
            "protocol_segments": [],
            "presentation": {},
        }
        working = deepcopy(base)
        working["computation"]["time_capacity"]["voltage_channel"] = "working_potential"
        counter = deepcopy(base)
        counter["computation"]["time_capacity"]["voltage_channel"] = "counter_potential"
        legacy = deepcopy(base)
        del legacy["computation"]["time_capacity"]["voltage_channel"]

        specs = analysis_cache._scientific_spec(base)
        specs_working = analysis_cache._scientific_spec(working)
        specs_counter = analysis_cache._scientific_spec(counter)
        specs_legacy = analysis_cache._scientific_spec(legacy)

        self.assertNotEqual(specs, specs_working)
        self.assertNotEqual(specs, specs_counter)
        self.assertNotEqual(specs_working, specs_counter)
        # An old spec with no voltage_channel key at all is a distinct
        # (but harmless — see engine.time_capacity_settings) raw JSON shape.
        self.assertNotEqual(specs, specs_legacy)

    def test_time_capacity_result_schema_version_only_invalidates_time_capacity_results(self):
        spec = {
            "selection": {"units": []},
            "computation": {},
            "aggregation": {},
            "presentation": {},
        }
        db = object()
        with (
            patch.object(analysis_engine, "resolve_selection", return_value=([], [])),
            patch.object(analysis_engine, "preload_cell_sources"),
            patch.object(analysis_engine, "load_scalar_metadata", return_value={}),
        ):
            cycles_before = analysis_cache.result_key(
                db, "cycles", spec, None, use_current_versions=True
            )
            time_capacity_before = analysis_cache.result_key(
                db, "time_capacity", spec, None, use_current_versions=True
            )
            with patch.dict(
                analysis_cache.RESULT_SCHEMA_VERSIONS,
                {"time_capacity": analysis_cache.RESULT_SCHEMA_VERSIONS["time_capacity"] + 1},
            ):
                cycles_after = analysis_cache.result_key(
                    db, "cycles", spec, None, use_current_versions=True
                )
                time_capacity_after = analysis_cache.result_key(
                    db, "time_capacity", spec, None, use_current_versions=True
                )

        self.assertEqual(cycles_before, cycles_after)
        self.assertNotEqual(time_capacity_before, time_capacity_after)

    def test_protocol_target_resolution_generation_invalidates_old_results(self):
        spec = {
            "selection": {"units": []},
            "computation": {},
            "aggregation": {},
            "presentation": {},
        }
        db = object()
        with (
            patch.object(analysis_engine, "resolve_selection", return_value=([], [])),
            patch.object(analysis_engine, "preload_cell_sources"),
            patch.object(analysis_engine, "load_scalar_metadata", return_value={}),
        ):
            current_key = analysis_cache.result_key(
                db, "dcir", spec, None, use_current_versions=True
            )
            with patch.object(
                analysis_cache,
                "ANALYSIS_CACHE_VERSION",
                analysis_cache.ANALYSIS_CACHE_VERSION - 1,
            ):
                legacy_key = analysis_cache.result_key(
                    db, "dcir", spec, None, use_current_versions=True
                )

        self.assertNotEqual(current_key, legacy_key)

    def test_dcir_view_does_not_change_scientific_cache_spec(self):
        base = {
            "selection": {"units": [{"kind": "cell", "ref_id": 7}]},
            "computation": {
                "dcir": {
                    "series": [
                        {"id": "s1", "cell_id": 7, "segment_id": "dcir-discharge"}
                    ]
                }
            },
            "aggregation": {},
            "protocol_segments": [],
            "dcir_segments": [
                {
                    "id": "dcir-discharge",
                    "name": "Discharge pulse",
                    "targets": [
                        {
                            "protocol_signature": "protocol-a",
                            "rest_step_index": 12,
                            "pulse_step_index": 13,
                        }
                    ],
                }
            ],
            "presentation": {
                "dcir_view": {
                    "quantity": "absolute",
                    "x_axis": "occurrence",
                    "candidate_filter": {
                        "min_rest_s": 600,
                        "max_pulse_s": 120,
                        "min_ratio": 10,
                    },
                }
            },
        }
        changed_view = deepcopy(base)
        changed_view["presentation"]["dcir_view"] = {
            "quantity": "relative",
            "x_axis": "time",
            "candidate_filter": {
                "min_rest_s": 1800,
                "max_pulse_s": 30,
                "min_ratio": 60,
            },
        }

        self.assertEqual(
            analysis_cache._scientific_spec(base),
            analysis_cache._scientific_spec(changed_view),
        )

    def test_dcir_series_and_private_targets_change_scientific_cache_spec(self):
        base = {
            "selection": {"units": [{"kind": "cell", "ref_id": 7}]},
            "computation": {
                "dcir": {
                    "series": [
                        {"id": "s1", "cell_id": 7, "segment_id": "dcir-discharge"}
                    ]
                }
            },
            "aggregation": {},
            "protocol_segments": [
                {
                    "id": "shared-rpt",
                    "name": "Shared RPT",
                    "targets": [],
                }
            ],
            "dcir_segments": [
                {
                    "id": "dcir-discharge",
                    "name": "Discharge pulse",
                    "targets": [
                        {
                            "protocol_signature": "protocol-a",
                            "rest_step_index": 12,
                            "pulse_step_index": 13,
                        }
                    ],
                }
            ],
            "presentation": {},
        }
        changed_series = deepcopy(base)
        changed_series["computation"]["dcir"]["series"][0]["cell_id"] = 8
        changed_target = deepcopy(base)
        changed_target["dcir_segments"][0]["targets"][0]["pulse_step_index"] = 15

        self.assertNotEqual(
            analysis_cache._scientific_spec(base),
            analysis_cache._scientific_spec(changed_series),
        )
        self.assertNotEqual(
            analysis_cache._scientific_spec(base),
            analysis_cache._scientific_spec(changed_target),
        )

    def test_editor_only_protocol_group_provenance_does_not_change_cache_identity(self):
        base = {
            "selection": {"units": [{"kind": "cell", "ref_id": 7}]},
            "computation": {
                "steps": {
                    "series": [{"id": "s1", "cell_id": 7, "segment_id": "shared-rpt"}],
                    "mode": "union",
                },
                "dcir": {
                    "series": [{"id": "d1", "cell_id": 7, "segment_id": "dcir-discharge"}]
                },
            },
            "aggregation": {},
            "protocol_segments": [
                {
                    "id": "shared-rpt",
                    "name": "Shared RPT",
                    "protocol_group_id": "group-a",
                    "targets": [
                        {"protocol_signature": "protocol-a", "step_indices": [12, 13]}
                    ],
                }
            ],
            "dcir_segments": [
                {
                    "id": "dcir-discharge",
                    "name": "Discharge pulse",
                    "protocol_group_id": "group-a",
                    "targets": [
                        {
                            "protocol_signature": "protocol-a",
                            "rest_step_index": 12,
                            "pulse_step_index": 13,
                        }
                    ],
                }
            ],
            "presentation": {},
        }
        changed_provenance = deepcopy(base)
        changed_provenance["protocol_segments"][0]["protocol_group_id"] = "group-b"
        changed_provenance["dcir_segments"][0]["protocol_group_id"] = "group-b"

        self.assertEqual(
            analysis_cache._scientific_spec(base),
            analysis_cache._scientific_spec(changed_provenance),
        )

        changed_target = deepcopy(base)
        changed_target["protocol_segments"][0]["targets"][0]["step_indices"] = [12, 14]
        changed_target["dcir_segments"][0]["targets"][0]["pulse_step_index"] = 15
        self.assertNotEqual(
            analysis_cache._scientific_spec(base),
            analysis_cache._scientific_spec(changed_target),
        )

        db = object()
        with (
            patch.object(analysis_engine, "resolve_selection", return_value=([], [])),
            patch.object(analysis_engine, "preload_cell_sources"),
            patch.object(analysis_engine, "load_scalar_metadata", return_value={}),
        ):
            for kind in ("steps", "dcir"):
                self.assertEqual(
                    analysis_cache.result_key(
                        db, kind, base, None, use_current_versions=True
                    ),
                    analysis_cache.result_key(
                        db, kind, changed_provenance, None, use_current_versions=True
                    ),
                )
                self.assertNotEqual(
                    analysis_cache.result_key(
                        db, kind, base, None, use_current_versions=True
                    ),
                    analysis_cache.result_key(
                        db, kind, changed_target, None, use_current_versions=True
                    ),
                )

    def test_steps_result_schema_version_only_invalidates_steps_results(self):
        spec = {
            "selection": {"units": []},
            "computation": {},
            "aggregation": {},
            "presentation": {},
        }
        db = object()
        with (
            patch.object(analysis_engine, "resolve_selection", return_value=([], [])),
            patch.object(analysis_engine, "preload_cell_sources"),
            patch.object(analysis_engine, "load_scalar_metadata", return_value={}),
        ):
            cycles_before = analysis_cache.result_key(
                db, "cycles", spec, None, use_current_versions=True
            )
            steps_before = analysis_cache.result_key(
                db, "steps", spec, None, use_current_versions=True
            )
            with patch.dict(
                analysis_cache.RESULT_SCHEMA_VERSIONS,
                {"steps": analysis_cache.RESULT_SCHEMA_VERSIONS["steps"] + 1},
            ):
                cycles_after = analysis_cache.result_key(
                    db, "cycles", spec, None, use_current_versions=True
                )
                steps_after = analysis_cache.result_key(
                    db, "steps", spec, None, use_current_versions=True
                )

        self.assertEqual(cycles_before, cycles_after)
        self.assertNotEqual(steps_before, steps_after)


class ResultBodySplitTests(AnalysisCacheTests):
    """Results are stored as an immutable body plus a tiny badge sidecar.

    A cache hit is then served by splicing bytes rather than parsing megabytes
    of JSON, so the splice must reproduce the old payload exactly.
    """

    RESULT = {
        "calc_version": "1.0",
        "cell_series": [{"label": "c1", "x": [1, 2, 3]}],
        "badges": [
            {"kind": "newer_calc", "detail": "keep me"},
            {"kind": "source_offline", "detail": "rebuild me"},
        ],
    }

    def test_round_trip_matches_the_parsing_path(self):
        import json

        analysis_cache.store_result("cycles", "k1", self.RESULT)

        # Availability badges are never replayed; everything else survives.
        loaded = analysis_cache.load_result("cycles", "k1")
        self.assertEqual(loaded["badges"], [{"kind": "newer_calc", "detail": "keep me"}])
        self.assertEqual(loaded["cache_status"], "hit")
        self.assertEqual(loaded["cell_series"], self.RESULT["cell_series"])

        body, kept = analysis_cache.load_result_body("cycles", "k1")
        fresh = [{"kind": "source_offline", "detail": "fresh"}]
        spliced = json.loads(analysis_cache.splice_result_body(body, kept + fresh, "hit"))
        self.assertEqual(spliced, {**loaded, "badges": kept + fresh})

    def test_entries_without_a_sidecar_fall_back_and_then_upgrade(self):
        """Existing caches must keep working and then get the fast path."""
        analysis_cache.store_result("cycles", "k2", self.RESULT)
        analysis_cache._sidecar_path("cycles", "k2").unlink()

        # No sidecar -> no fast path, but the slow path still reads correctly.
        self.assertIsNone(analysis_cache.load_result_body("cycles", "k2"))
        recovered = analysis_cache.load_result("cycles", "k2")
        self.assertEqual(recovered["cell_series"], self.RESULT["cell_series"])

        analysis_cache.upgrade_result_format("cycles", "k2", recovered)
        self.assertIsNotNone(analysis_cache.load_result_body("cycles", "k2"))

    def test_pruning_a_body_removes_its_sidecar(self):
        analysis_cache.store_result("cycles", "k3", self.RESULT)
        sidecar = analysis_cache._sidecar_path("cycles", "k3")
        self.assertTrue(sidecar.is_file())

        with analysis_cache._lock:
            analysis_cache._prune_locked(limit_bytes=0)

        self.assertFalse(analysis_cache._result_path("cycles", "k3").is_file())
        self.assertFalse(sidecar.is_file(), "sidecar outlived the body it describes")


if __name__ == "__main__":
    unittest.main()
