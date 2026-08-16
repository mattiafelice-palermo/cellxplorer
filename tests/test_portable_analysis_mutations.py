from tests.test_portable_analysis import PortableAnalysisTests


_CASES = (
    "test_saved_plot_export_rejects_forged_current_view_snapshot",
    "test_portable_export_rejects_snapshot_from_wrong_saved_plot_family",
    "test_portable_export_rechecks_state_after_separate_session_mutation",
    "test_portable_export_rechecks_state_after_final_html_write_mutation",
    "test_portable_export_generates_html_before_acquiring_writer_boundary",
    "test_portable_export_rejects_cell_description_and_metadata_mutation",
    "test_portable_export_rejects_replicate_group_description_and_membership_mutation",
)


def load_tests(loader, _tests, _pattern):
    return loader.loadTestsFromNames(
        [f"tests.test_portable_analysis.PortableAnalysisTests.{name}" for name in _CASES]
    )
