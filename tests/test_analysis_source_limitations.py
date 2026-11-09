import unittest
from types import SimpleNamespace
from backend.app.services.analysis_engine import availability_badges, refresh_availability_badges

class AnalysisSourceLimitationsTests(unittest.TestCase):
    def context(self, interpretation):
        source = SimpleNamespace(id=12, filename="source.mpr", location_status="online", parser_version="bm:gcpl12:r1:p1", parse_status="parsed",
            header_meta={"mpr_interpretation":interpretation,"mpr_diagnostics":[{"code":"clock","message":"Curves split at backward acquisition clocks","count":2,"examples":[{"record_index":14}]}]})
        return SimpleNamespace(units=[{"cell":SimpleNamespace(id=7,name="Renamed Cell")}],files_by_cell={7:[source]})
    def test_verified_permissive_has_no_analysis_warning(self):
        self.assertEqual(availability_badges(None,{},request_context=self.context("verified")),[])
    def test_exploratory_warning_explains_consequence_and_preserves_evidence(self):
        result=availability_badges(None,{},request_context=self.context("exploratory"))[0]
        self.assertEqual(result["source_id"],12)
        self.assertEqual(result["cell_name"],"Renamed Cell")
        self.assertIn("FEC are unavailable",result["detail"])
        self.assertEqual(result["limitations"][0]["count"],2)
    def test_cached_stale_permissive_warning_is_removed_but_other_badges_remain(self):
        result={"badges":[{"kind":"exploratory_mpr","detail":"obsolete"},{"kind":"newer_parser","detail":"keep"}]}
        refresh_availability_badges(None,{},result,request_context=self.context("verified"))
        self.assertEqual(result["badges"],[{"kind":"newer_parser","detail":"keep"}])
