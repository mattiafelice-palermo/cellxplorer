from tests.test_portable_analysis import PortableAnalysisTests


_CASES = (
    "test_portable_provenance_preserves_per_source_parser_identity_and_remaps_hash",
    "test_legacy_single_scalar_provenance_shape_is_still_importable",
    "test_import_rejects_tampered_payload",
    "test_portable_export_rejects_snapshot_with_stale_scientific_identity",
    "test_saved_plot_export_requires_browser_snapshots",
    "test_strict_portable_chain_decoder_accepts_current_and_single_legacy_shape",
    "test_malformed_portable_chains_fail_identically_before_import_writes",
)


def load_tests(loader, _tests, _pattern):
    return loader.loadTestsFromNames(
        [f"tests.test_portable_analysis.PortableAnalysisTests.{name}" for name in _CASES]
    )
