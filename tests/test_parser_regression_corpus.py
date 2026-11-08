"""Archive integrity and frozen-expectation controls, without private inputs."""
from backend.app.services.filesystem_cleanup import TemporaryDirectory
from pathlib import Path
import json
import stat
import tempfile
import unittest
from unittest.mock import patch

from scripts import parser_regression_corpus as corpus


class CorpusTests(unittest.TestCase):
    def setUp(self):
        self.temp=TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'archive'
        self.source=Path(self.temp.name)/'original.mpr'
        self.source.write_bytes(b'private-source-bytes')
        corpus.register(self.root,'case-one',self.source,'pair')
        self.manifest=corpus.read_manifest(self.root)

    def test_original_copy_is_immutable_and_checksum_verified(self):
        self.assertEqual(corpus.checked_sources(self.root,self.manifest)['case-one'].read_bytes(),self.source.read_bytes())
        with self.assertRaises(ValueError):corpus.register(self.root,'case-one',self.source,'pair')
        with self.assertRaises(ValueError):corpus.register(self.root,'../escape',self.source,'pair')
        stored=self.root/self.manifest['cases'][0]['file']
        stored.chmod(stat.S_IREAD|stat.S_IWRITE)
        stored.write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError,'Checksum'):corpus.checked_sources(self.root,self.manifest)

    def test_missing_sources_and_path_escapes_fail(self):
        self.manifest['cases'][0]['file']='missing.mpr'
        with self.assertRaisesRegex(ValueError,'Missing'):corpus.checked_sources(self.root,self.manifest)
        self.manifest['cases'][0]['file']='../original.mpr'
        with self.assertRaisesRegex(ValueError,'Missing'):corpus.checked_sources(self.root,self.manifest)

    def test_verify_never_creates_or_replaces_expectations(self):
        science={'chains':{'pair':{'cycles':{'rows':[[1.,.9,90.]]}}}}
        with patch.object(corpus,'scientific_snapshot',return_value=science) as compute:
            with self.assertRaisesRegex(ValueError,'Missing expectations'):corpus.run(self.root,'verify')
            compute.assert_not_called()
            corpus.run(self.root,'snapshot')
            before=(self.root/'expected.json').read_bytes()
            self.assertTrue(corpus.run(self.root,'verify')['verified'])
            with self.assertRaisesRegex(ValueError,'already exist'):corpus.run(self.root,'snapshot')
            compute.return_value={'chains':{}}
            with self.assertRaisesRegex(ValueError,'Scientific regression'):corpus.run(self.root,'verify')
            self.assertEqual(before,(self.root/'expected.json').read_bytes())
            corpus.run(self.root,'snapshot',replace=True)
            self.assertNotEqual(before,(self.root/'expected.json').read_bytes())

    def test_membership_change_requires_explicit_baseline_capture(self):
        with patch.object(corpus,'scientific_snapshot',return_value={'chains':{}}):
            corpus.run(self.root,'snapshot')
            corpus.register(self.root,'case-two',self.source,'pair')
            with self.assertRaisesRegex(ValueError,'membership'):corpus.run(self.root,'verify')

    def test_mode_change_cannot_reuse_safe_scientific_baseline(self):
        with patch.object(corpus,'scientific_snapshot',return_value={'chains':{}}) as compute:
            corpus.run(self.root,'snapshot')
            manifest=corpus.read_manifest(self.root)
            manifest['cases'][0]['read_mode']='permissive'
            corpus.write_json(self.root/'manifest.json',manifest)
            compute.reset_mock()
            with self.assertRaisesRegex(ValueError,'read modes'):corpus.run(self.root,'verify')
            compute.assert_not_called()
            corpus.run(self.root,'snapshot',replace=True)
            self.assertTrue(corpus.run(self.root,'verify')['verified'])

    def test_invalid_modes_do_not_copy_sources(self):
        with self.assertRaisesRegex(ValueError,'read mode'):
            corpus.register(self.root,'invalid-mode',self.source,'pair',read_mode='guess')
        self.assertFalse((self.root/'sources'/'invalid-mode.mpr').exists())
        self.manifest['cases'][0]['read_mode']='guess'
        corpus.write_json(self.root/'manifest.json',self.manifest)
        with self.assertRaisesRegex(ValueError,'read mode'):corpus.read_manifest(self.root)

    def tearDown(self):
        for path in self.root.rglob('*.mpr'):path.chmod(stat.S_IREAD|stat.S_IWRITE)


if __name__=='__main__':unittest.main()
