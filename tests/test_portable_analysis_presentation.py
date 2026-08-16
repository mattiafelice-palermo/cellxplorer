from tests.test_portable_analysis import PortableAnalysisTests


_CASES = (
    "test_export_uses_beta_deep_link_scheme_when_channel_is_beta",
    "test_packaged_invalid_channel_fails_for_portable_deep_link",
    "test_desktop_deep_link_accepts_only_existing_local_html",
    "test_saved_plots_reuse_analysis_samples_in_portable_report",
    "test_portable_server_view_fallback_dispatches_each_plot_family",
    "test_draft_plot_is_not_exported",
)


def load_tests(loader, _tests, _pattern):
    return loader.loadTestsFromNames(
        [f"tests.test_portable_analysis.PortableAnalysisTests.{name}" for name in _CASES]
    )
