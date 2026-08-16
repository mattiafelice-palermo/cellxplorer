from tests.test_neware_excel import NewareExcelParserTests


_CASES = (
    "test_unbounded_clock_duration_is_strict_and_unitless",
    "test_duration_id_and_kw_kwh_aliases_are_normalized_per_sheet",
    "test_duration_dialect_plan_and_millisecond_record_settings_are_read",
    "test_numeric_dialect_cycle_tolerance_remains_locked",
    "test_unitless_numeric_duration_and_ambiguous_aliases_fail_closed",
    "test_unitless_step_duration_is_reconciled",
    "test_numeric_step_duration_keeps_timestamp_span_validation",
    "test_numeric_time_with_kwh_summary_keeps_strict_energy_tolerance",
    "test_valid_workbook_is_recognized",
    "test_unrelated_xlsx_is_rejected",
    "test_metadata_rejects_unrelated_xlsx_before_labeling_source_format",
    "test_missing_record_sheet_is_rejected",
    "test_each_missing_required_record_header_is_rejected",
    "test_duplicate_normalized_headers_are_rejected",
    "test_corrupt_xlsx_is_rejected_with_domain_error",
    "test_canonical_mapping_dtypes_and_auxiliary_columns",
    "test_time_units_and_duplicate_timestamps_are_preserved",
    "test_invalid_required_values_are_rejected",
    "test_verified_statuses_map_to_canonical_values",
    "test_programmed_and_executed_steps_remain_distinct",
    "test_time_reset_alone_starts_a_new_execution",
    "test_energy_counters_reset_at_each_executed_step",
    "test_calc_per_cycle_consumes_excel_frame_without_special_case",
    "test_missing_step_summary_keeps_raw_capability",
    "test_step_summary_count_mismatch_is_rejected",
    "test_step_summary_identity_mismatch_is_rejected",
    "test_step_summary_duration_mismatch_is_rejected",
    "test_step_summary_rounding_uses_declared_record_cadence",
    "test_step_summary_does_not_infer_tolerance_from_sparse_timestamps",
    "test_unknown_status_is_rejected",
    "test_duplicate_datapoint_is_rejected",
    "test_total_time_decrease_is_rejected",
)


def load_tests(loader, _tests, _pattern):
    return loader.loadTestsFromNames(
        [f"tests.test_neware_excel.NewareExcelParserTests.{name}" for name in _CASES]
    )
