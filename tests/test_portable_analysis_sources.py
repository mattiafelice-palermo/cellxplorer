from tests.test_portable_analysis import PortableAnalysisTests


_CASES = (
    "test_source_preflight_detects_changed_and_unavailable_originals",
    "test_source_update_adopts_stable_bytes_and_makes_preflight_ready",
    "test_strict_export_refuses_to_silently_omit_changed_original",
    "test_linked_round_trip_reuses_recorded_path_and_rebuilds_caches",
    "test_round_trip_with_original_extracts_online_source",
    "test_original_xlsx_source_is_embedded_with_normal_provenance",
    "test_linked_import_marks_missing_source_offline",
)


def load_tests(loader, _tests, _pattern):
    return loader.loadTestsFromNames(
        [f"tests.test_portable_analysis.PortableAnalysisTests.{name}" for name in _CASES]
    )
