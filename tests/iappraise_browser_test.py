import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('iappraise_browser', Path(__file__).parents[1] / 'scripts' / 'prepare-iappraise-browser.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class BrowserMigrationTests(unittest.TestCase):
    def test_only_reviewed_https_source_buckets_can_be_downloaded(self):
        self.assertTrue(module.public_source_media('https://s3-ap-southeast-2.amazonaws.com/iappraise-cache/x1080/2026/47/source.jpg'))
        self.assertTrue(module.public_source_media('https://iappraise-images.s3.amazonaws.com/2026/47/source.jpg'))
        for url in ['http://iappraise-images.s3.amazonaws.com/a.jpg', 'https://iappraise-images.s3.amazonaws.com.evil.invalid/a',
                    'https://user:secret@iappraise-images.s3.amazonaws.com/a', 'https://127.0.0.1/a',
                    'https://s3-ap-southeast-2.amazonaws.com/another-bucket/a', 'file:///etc/passwd']:
            self.assertFalse(module.public_source_media(url), url)

    def test_redirects_cannot_leave_the_source_buckets(self):
        with self.assertRaisesRegex(ValueError, 'redirected outside'):
            module.SourceRedirects().redirect_request(None, None, 302, '', {}, 'http://169.254.169.254/latest/meta-data/')

    def test_inline_original_bytes_are_preserved_and_bad_cache_metadata_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'media').mkdir()
            value = module.download('data:image/png;base64,c291cmNlLWJ5dGVz', root, 100)
            self.assertEqual((root / value['path']).read_bytes(), b'source-bytes')
            self.assertEqual(value['sourceId'], 'inline:' + module.digest(b'source-bytes'))
            url = 'https://iappraise-images.s3.amazonaws.com/source.jpg'
            metadata = root / 'media' / (module.digest(url.encode()) + '.json')
            metadata.write_text(json.dumps({'path': '../private-file', 'sourceId': url}))
            with self.assertRaisesRegex(ValueError, 'checkpoint metadata'):
                module.download(url, root, 100)

    def test_source_identity_site_and_checksum_must_match_the_browser_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'captures').mkdir()
            record = {'url': 'https://iappraise.net.au/form-1234', 'text': 'Evaluation Ref #: 1234', 'sourceReference': '1234', 'audit': {'captured': True, 'rows': []},
                      'tables': [[['Dealership', 'BYD Melbourne'], ['Department', 'Fairfield - NEW']]], 'images': []}
            data = json.dumps(record).encode()
            checksum = module.digest(data)
            (root / 'captures' / (checksum + '.json')).write_bytes(data)
            checkpoint = root / 'checkpoint.json'
            checkpoint.write_text(json.dumps({'account': 'BYD Melbourne', 'current': {'1234': {'sha256': checksum}}}))
            _, records = module.load_records(checkpoint)
            self.assertEqual(records[0]['site'], 'BYD Fairfield')
            (root / 'captures' / (checksum + '.json')).write_bytes(data + b' ')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                module.load_records(checkpoint)

    def test_stale_rendered_record_is_rejected_even_when_the_url_has_changed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'captures').mkdir()
            record = {'url': 'https://iappraise.net.au/form-1234', 'text': 'Evaluation Ref #: 5678',
                      'tables': [[['Dealership', 'BYD Melbourne'], ['Department', 'Fairfield - NEW']]],
                      'audit': {'captured': True, 'rows': []}}
            data = json.dumps(record).encode()
            checksum = module.digest(data)
            (root / 'captures' / (checksum + '.json')).write_bytes(data)
            checkpoint = root / 'checkpoint.json'
            checkpoint.write_text(json.dumps({'account': 'BYD Melbourne', 'current': {'1234': {'sha256': checksum}}}))
            with self.assertRaisesRegex(ValueError, 'Rendered appraisal reference'):
                module.load_records(checkpoint)

    def test_preparation_preserves_source_bytes_audit_and_explicit_media_gaps(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'captures').mkdir()
            record = {'url': 'https://iappraise.net.au/form-1234', 'text': 'Evaluation Ref #: 1234',
                      'tables': [[['Dealership', 'BYD Melbourne'], ['Department', 'Fairfield - NEW']]],
                      'audit': {'captured': True, 'rows': [['source audit event']]},
                      'images': [{'src': 'data:image/png;base64,c291cmNlLWJ5dGVz'}, {'src': 'blob:https://iappraise.net.au/missing'}],
                      'originalUnknownField': {'retained': True}}
            data = json.dumps(record).encode()
            source_hash = module.digest(data)
            (root / 'captures' / (source_hash + '.json')).write_bytes(data)
            checkpoint = root / 'checkpoint.json'
            checkpoint.write_text(json.dumps({'account': 'BYD Melbourne', 'expectedRecords': 9, 'current': {'1234': {'sha256': source_hash}}}))
            output = root / 'prepared'
            report = module.prepare(checkpoint, output, workers=1)
            manifest = json.loads((output / 'manifest.json').read_text())
            raw = json.loads((output / manifest['records'][0]['path']).read_text())
            self.assertEqual((output / 'originals' / (source_hash + '.json')).read_bytes(), data)
            self.assertEqual(raw['originalUnknownField'], {'retained': True})
            self.assertEqual(raw['audit'], record['audit'])
            self.assertEqual(report['retrievedUniqueMedia'], 1)
            self.assertEqual(report['pendingUniqueMedia'], 1)
            self.assertEqual(report['auditEvents'], 1)
            self.assertEqual(raw['migrationCoverage']['pendingMedia'][0]['sourceId'], 'blob:https://iappraise.net.au/missing')
            self.assertFalse(manifest['completeSourceVerified'])
            for item in manifest['records'] + manifest['sourceFiles'] + manifest['records'][0]['media']:
                target = output / item['path']
                self.assertEqual(module.checksum(target), item['sha256'])
                self.assertEqual(target.stat().st_mode & 0o077, 0)

if __name__ == '__main__':
    unittest.main()
