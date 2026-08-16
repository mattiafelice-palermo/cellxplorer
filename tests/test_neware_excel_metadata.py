from tests.test_neware_excel import NewareExcelParserTests


_CASES = (
    "test_metadata_information_block_extracts_units_and_provenance",
    "test_missing_test_sheet_degrades_protocol_capability_without_blocking_raw_parse",
    "test_metadata_protocol_plan_maps_explicit_fields_and_controls",
    "test_metadata_units_are_not_silently_reinterpreted",
    "test_metadata_value_groups_do_not_bleed_into_neighboring_labels",
    "test_metadata_blank_group_does_not_consume_unsupported_neighbor_label",
    "test_unit_optional_times_do_not_bleed_into_neighboring_labels",
    "test_numeric_record_date_is_rejected",
    "test_numeric_record_date_string_is_rejected",
    "test_fast_and_reference_paths_match_exactly",
    "test_calamine_and_reference_paths_match_exactly",
    "test_calamine_falls_back_when_unavailable",
    "test_calamine_native_duration_representation_falls_back_to_openpyxl",
    "test_calamine_open_failure_falls_back_to_openpyxl",
    "test_fast_path_rejects_ambiguous_normalized_record_sheets",
)


def load_tests(loader, _tests, _pattern):
    return loader.loadTestsFromNames(
        [f"tests.test_neware_excel.NewareExcelParserTests.{name}" for name in _CASES]
    )
