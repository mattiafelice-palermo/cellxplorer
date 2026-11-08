import json, tempfile, unittest, os
from pathlib import Path
from unittest.mock import patch
from backend.app.services.import_search_diagnostics import trace, trace_message
class DiagnosticsTests(unittest.TestCase):
 def test_message_omits_metadata_values(self):
  with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, CELLXPLORER_INDEX_TRACE=d):
   trace_message('worker_message', {'kind':'batch','facts':[{'path':'sample.mpr','metadata':{'barcode':'PRIVATE'},'search_text':'PRIVATE'}]}, 'spool')
   raw=next(Path(d).glob('*.jsonl')).read_text()
   self.assertNotIn('PRIVATE',raw)
   self.assertEqual(json.loads(raw)['facts'][0]['metadata_fields'],['barcode'])
 def test_bad_destination_does_not_break_scan(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'file';p.write_text('x')
   with patch.dict(os.environ,CELLXPLORER_INDEX_TRACE=str(p)):trace('test')
 def test_disabled_does_not_touch_filesystem(self):
  with patch.dict(os.environ,CELLXPLORER_INDEX_TRACE=''), patch('backend.app.services.import_search_diagnostics.Path') as p:
   trace('test'); trace_message('message',{},'spool'); p.assert_not_called()
if __name__=='__main__':unittest.main()
