from tests.test_portable_analysis import PortableAnalysisTests


_CASES = (
    "test_portable_import_preserves_metadata_only_source_and_skips_available_original_build",
    "test_portable_import_ignores_embedded_metadata_only_cache_descriptors",
    "test_portable_report_cannot_downgrade_an_existing_canonical_source",
    "test_portable_report_cannot_upgrade_an_existing_metadata_only_source",
    "test_multi_source_portable_round_trip_preserves_cell_order_and_one_test",
    "test_inspection_reports_exact_match_and_import_reuses_library_cell",
    "test_possible_update_requires_explicit_choice_and_can_use_library_cell",
)


def load_tests(loader, _tests, _pattern):
    return loader.loadTestsFromNames(
        [f"tests.test_portable_analysis.PortableAnalysisTests.{name}" for name in _CASES]
    )
