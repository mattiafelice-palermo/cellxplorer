from tests.test_neware_excel import NewareExcelParserTests


_CASES = (
    "test_fast_path_does_not_ignore_rows_populated_outside_projection",
    "test_fast_path_rejects_integer_identifier_overflow",
    "test_numeric_metadata_start_time_is_rejected",
    "test_shared_metadata_normalization_and_capabilities",
    "test_protocol_reconstruction_and_signature_use_excel_flattened_plan",
    "test_three_rate_excel_plan_reaches_rate_capability_pairing_seam",
    "test_metadata_read_does_not_parse_large_record_sheet",
    "test_parser_dispatch_preserves_binary_and_excel_boundaries",
    "test_parser_bundle_version_is_deterministic_and_persistable",
    "test_cycle_summary_validation_accepts_rounded_values",
    "test_cycle_summary_rejects_non_finite_calculated_values_even_at_zero",
    "test_cycle_summary_rejects_nan_calculated_capacity_even_at_zero",
    "test_cycle_summary_identity_capacity_energy_and_time_mismatches_fail",
    "test_missing_cycle_summary_is_explicitly_non_validating",
    "test_cache_build_and_write_behind_validate_excel_before_publication",
    "test_cycle_cache_derivation_from_existing_raw_does_not_reopen_excel",
)


def load_tests(loader, _tests, _pattern):
    return loader.loadTestsFromNames(
        [f"tests.test_neware_excel.NewareExcelParserTests.{name}" for name in _CASES]
    )
