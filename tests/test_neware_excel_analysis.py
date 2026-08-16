from tests.test_neware_excel import NewareExcelAnalysisIntegrationTests


_CASES = (
    "test_registered_excel_feeds_cycles_time_capacity_and_repeated_steps",
    "test_registered_excel_dcir_fixture_uses_current_detector_and_occurrences",
    "test_registered_excel_rate_fixture_is_detected_and_extracted",
    "test_registered_excel_without_conditions_reports_chargeability_no_match",
)


def load_tests(loader, _tests, _pattern):
    return loader.loadTestsFromNames(
        [
            f"tests.test_neware_excel.NewareExcelAnalysisIntegrationTests.{name}"
            for name in _CASES
        ]
    )
