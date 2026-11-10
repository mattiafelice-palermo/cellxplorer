import unittest
from types import SimpleNamespace
from unittest.mock import patch
from backend.app.services.analysis_engine import availability_badges, refresh_availability_badges

class AnalysisSourceLimitationsTests(unittest.TestCase):
    def context(self, interpretation):
        source = SimpleNamespace(id=12, hash="a"*64, ext="mpr", filename="source.mpr", location_status="online", parser_version="bm:gcpl12:r1:p1", parse_status="parsed",
            header_meta={"mpr_interpretation":interpretation,"mpr_diagnostics":[{"code":"clock","message":"Curves split at backward acquisition clocks","count":2,"examples":[{"record_index":14}]}]})
        return SimpleNamespace(units=[{"cell":SimpleNamespace(id=7,name="Renamed Cell")}],files_by_cell={7:[source]})
    def test_verified_permissive_has_no_analysis_warning(self):
        self.assertEqual(availability_badges(None,{},request_context=self.context("verified")),[])

    def test_pending_non_mpr_source_has_no_mpr_interpretation_notice(self):
        context = self.context("pending")
        source = context.files_by_cell[7][0]
        source.ext = "ndax"
        source.filename = "source.ndax"
        source.parser_version = "nw:test"
        source.parse_status = "pending"
        source.header_meta = {}
        self.assertEqual(availability_badges(None, {}, request_context=context), [])
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

    def test_verified_mb_retains_concrete_eis_exclusion_in_either_read_mode(self):
        warning={"code":"biologic_mb_eis_exclusion","message":"EIS executions are excluded; acquisition gaps are preserved.","count":30}
        for mode in ("safe", "permissive"):
            context=self.context("verified")
            context.files_by_cell[7][0].parser_version="bm:mb:r1" + (":p1" if mode == "permissive" else "")
            with patch("backend.app.services.analysis_engine.cache.load_parser_warnings",return_value=[warning]):
                result=availability_badges(None,{},request_context=context)
            self.assertEqual(len(result),1)
            self.assertEqual(result[0]["limitations"],[warning])
            self.assertIn("EIS executions are excluded",result[0]["detail"])
