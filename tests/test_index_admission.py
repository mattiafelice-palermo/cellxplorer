import unittest
from unittest.mock import Mock, patch
from backend.app.services.index_admission import IndexAdmission, foreground_request
from backend.app.services import beta_bootstrap
from tests.test_import_search_headers import virtual_header_readers
from backend.app.services.import_search_headers import read_headers


class IndexAdmissionTests(unittest.TestCase):
    def test_startup_setup_and_overlapping_foreground_requests(self):
        clock = Mock(return_value=0.0)
        setup = Mock(return_value=False)
        gate = IndexAdmission(clock=clock, setup_ready=setup)
        self.assertFalse(gate.allowed())
        setup.assert_not_called()
        clock.return_value = 10.0
        self.assertFalse(gate.allowed())
        setup.return_value = True
        clock.return_value = 11.0
        self.assertTrue(gate.allowed())
        with gate.foreground():
            with gate.foreground():
                self.assertFalse(gate.allowed())
            self.assertFalse(gate.allowed())
        self.assertFalse(gate.allowed())
        clock.return_value = 12.0
        self.assertTrue(gate.allowed())
        self.assertEqual(setup.call_count, 2)

    def test_failed_request_releases_admission(self):
        clock = Mock(return_value=0.0)
        gate = IndexAdmission(clock=clock, startup_grace=0)
        with self.assertRaises(ValueError):
            with gate.foreground():
                raise ValueError("request failed")
        clock.return_value = 1.0
        self.assertTrue(gate.allowed())

    def test_polling_does_not_starve_index_but_navigation_does_yield(self):
        for path in ["/api/health", "/api/database/status", "/api/background-jobs", "/api/import-search/settings", "/api/analysis-updates"]:
            self.assertFalse(foreground_request(path), path)
        for path in ["/api/imports/browse", "/api/analyses/1/compute", "/api/tree", "/api/import-search/query", "/api/alpha-bootstrap/status"]:
            self.assertTrue(foreground_request(path), path)

    def test_setup_gate_uses_only_destination_marker(self):
        with patch("backend.app.services.app_channel.is_packaged_application", return_value=True), patch("backend.app.services.app_channel.resolve_app_channel", return_value="alpha"), patch.object(beta_bootstrap, "_read_marker_for", return_value=None), patch.object(beta_bootstrap, "build_alpha_status", side_effect=AssertionError("must not inspect library")):
            self.assertFalse(beta_bootstrap.indexing_setup_ready())
        with patch("backend.app.services.app_channel.resolve_app_channel", return_value="stable"), patch.object(beta_bootstrap, "_read_marker_for", side_effect=AssertionError("no marker needed")):
            self.assertTrue(beta_bootstrap.indexing_setup_ready())

    def test_admission_wait_does_not_consume_a_header_deadline(self):
        with virtual_header_readers() as clock:
            facts = [dict(canonical="a"), dict(canonical="b")]
            result = list(read_headers(facts, readers=2, metadata_enabled=True,
                timeout=2, cancelled=lambda: False, admitted=lambda: clock.now >= 10))
            self.assertEqual([r["canonical"] for r in result], ["a", "b"])
            self.assertTrue(all(t >= 10 for t in clock.dispatches.values()))

    def test_foreground_closes_idle_lanes_but_not_active_deadlines(self):
        with virtual_header_readers() as clock:
            results = list(read_headers([dict(canonical="stall"), dict(canonical="fast"), dict(canonical="later")],
                readers=2, metadata_enabled=True, timeout=2, cancelled=lambda: clock.now >= 3,
                admitted=lambda: clock.now < .02))
            self.assertEqual(set(clock.dispatches), {"stall", "fast"})
            self.assertTrue(any(r["canonical"] == "stall" and r["metadata_state"] == "unavailable" for r in results))
            self.assertLess(clock.now, 3.1)

    def test_three_queued_roots_start_no_workers_until_admitted(self):
        import threading
        from backend.app.services.import_search_index import SearchIndexer, DEFAULT_CONFIG
        roots = [dict(id=str(i), path=f"C:/location{i}", enabled=True) for i in range(3)]
        catalog = Mock()
        catalog.roots.return_value = [dict(id=str(i), status="queued") for i in range(3)]
        blocked_checked, scanned, released = threading.Event(), threading.Event(), threading.Event()
        def admitted():
            blocked_checked.set()
            return released.is_set()
        indexer = SearchIndexer(catalog, monitoring=False, admission=admitted)
        def scan(*args):
            scanned.set()
            indexer.stop_event.set()
        indexer._scan = Mock(side_effect=scan)
        try:
            indexer.start(dict(DEFAULT_CONFIG, roots=roots))
            self.assertTrue(blocked_checked.wait(2))
            self.assertFalse(scanned.is_set())
            self.assertEqual(indexer.pending, ["0", "1", "2"])
            released.set()
            self.assertTrue(scanned.wait(2))
            indexer._scan.assert_called_once()
        finally:
            indexer.stop()

    def test_configuration_never_starts_watchers_on_request_thread(self):
        from backend.app.services.import_search_index import SearchIndexer, DEFAULT_CONFIG
        catalog = Mock()
        indexer = SearchIndexer(catalog, admission=lambda: False)
        indexer.live = Mock()
        indexer.configure(dict(DEFAULT_CONFIG))
        indexer.live.reconcile.assert_called_once_with(False, start_watchers=False)

    def test_browser_development_needs_no_native_setup_marker(self):
        with patch("backend.app.services.app_channel.is_packaged_application", return_value=False), patch.object(beta_bootstrap, "_read_marker_for", side_effect=AssertionError("browser has no setup chooser")):
            self.assertTrue(beta_bootstrap.indexing_setup_ready())

    def test_monitor_keeps_polling_without_spawning_during_foreground(self):
        from backend.app.services.import_search_index import SearchIndexer
        indexer = SearchIndexer(Mock(), admission=lambda: False)
        indexer.live = Mock()
        indexer.live.tick.side_effect = lambda **kwargs: indexer.stop_event.set()
        indexer._monitor()
        indexer.live.tick.assert_called_once_with(start_watchers=False)
