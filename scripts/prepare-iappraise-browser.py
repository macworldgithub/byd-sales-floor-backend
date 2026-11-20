#!/usr/bin/env python3
"""Prepare browser-read iAppraise records and observed public media for import.

No cookies, source credentials, guessed API routes or record-number ranges are
used. Input is the checkpoint produced from the authorised, rendered browser UI.
Failed media remain explicit in the source record and reconciliation report.
"""
import argparse
import base64
import concurrent.futures
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit, unquote_to_bytes
from urllib.request import HTTPRedirectHandler, Request, build_opener

SITES = {'Melbourne - NEW': 'BYD Melbourne City', 'Caroline Springs - NEW': 'BYD Caroline Springs',
         'Nunawading - NEW': 'BYD Nunawading', 'Wodonga - NEW': 'BYD Wodonga', 'Fairfield - NEW': 'BYD Fairfield'}
MIMES = {'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'application/pdf'}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def checksum(filename):
    result = hashlib.sha256()
    with filename.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()

def private_json(filename, value):
    temporary = filename.with_suffix(filename.suffix + '.tmp')
    with temporary.open('w', encoding='utf-8') as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(filename)

def public_source_media(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443):
        return False
    if parsed.hostname == 'iappraise-images.s3.amazonaws.com':
        return bool(parsed.path and parsed.path != '/')
    return parsed.hostname == 's3-ap-southeast-2.amazonaws.com' and parsed.path.startswith('/iappraise-cache/')

class SourceRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        if not public_source_media(newurl):
            raise ValueError('Media redirected outside the observed source buckets')
        return super().redirect_request(request, file, code, message, headers, newurl)

def observed_urls(record):
    urls = []
    for image in record.get('images', []):
        for key in ('src', 'original'):
            value = image.get(key)
            if value and not value.startswith('https://iappraise.net.au/assets/'):
                urls.append(urljoin(record['url'], value))
        if image.get('srcset') and not image['srcset'].startswith('data:'):
            urls.extend(urljoin(record['url'], source.strip().split()[0]) for source in image['srcset'].split(',') if source.strip())
    for video in record.get('videos', []):
        for key in ('src', 'poster'):
            if video.get(key):
                urls.append(urljoin(record['url'], video[key]))
    for link in record.get('links', []):
        if re.search(r'\.(pdf|mp4|mov|jpe?g|png|webp|heic)(\?|$)', link.get('href', ''), re.I):
            urls.append(link['href'])
    return list(dict.fromkeys(urls))

def load_records(checkpoint, only=None):
    root = checkpoint.parent.resolve()
    state = json.loads(checkpoint.read_text())
    if state.get('account') != 'BYD Melbourne':
        raise ValueError('Unexpected source account')
    output = []
    for source_id, item in state['current'].items():
        if only is not None and source_id not in only:
            continue
        if not re.fullmatch(r'\d+', source_id):
            raise ValueError('Invalid original source ID')
        if not re.fullmatch(r'[a-f0-9]{64}', item['sha256']):
            raise ValueError('Invalid captured source checksum')
        source = root / 'captures' / (item['sha256'] + '.json')
        original = source.read_bytes()
        if digest(original) != item['sha256']:
            raise ValueError('Captured source checksum mismatch')
        record = json.loads(original)
        if record.get('url') != 'https://iappraise.net.au/form-' + source_id:
            raise ValueError('Source URL does not match its original appraisal ID')
        rendered_reference = re.search(r'Evaluation Ref #:\s*(\d+)', record.get('text', ''))
        if not rendered_reference or rendered_reference.group(1) != source_id:
            raise ValueError('Rendered appraisal reference does not match its URL')
        if record.get('sourceReference') and record['sourceReference'] != source_id:
            raise ValueError('Rendered appraisal reference does not match its URL')
        fields = {}
        for table in record['tables']:
            for row in table:
                if len(row) == 2:
                    fields.setdefault(row[0], row[1])
        if fields.get('Dealership') != 'BYD Melbourne' or fields.get('Department') not in SITES:
            raise ValueError('Source dealership/site has not been reviewed')
        if record.get('audit', {}).get('captured') is not True:
            raise ValueError('A visible audit capture is required')
        output.append({'sourceId': source_id, 'site': SITES[fields['Department']], 'record': record,
                       'fields': fields, 'original': original, 'urls': observed_urls(record)})
    if only is not None and {r['sourceId'] for r in output} != only:
        raise ValueError('Requested source IDs are absent from the checkpoint')
    if not output:
        raise ValueError('No captured source records selected')
    return state, output

def download(url, root, maximum):
    if url.startswith('data:'):
        header, payload = url.split(',', 1)
        mime = header[5:].split(';')[0]
        if not (mime.startswith('image/') or mime.startswith('video/') or mime == 'application/pdf'):
            raise ValueError('Unsupported inline source media')
        data = base64.b64decode(payload, validate=True) if header.endswith(';base64') else unquote_to_bytes(payload)
        if not data or len(data) > maximum:
            raise ValueError('Invalid inline source file size')
        file_hash = digest(data)
        target = root / 'media' / file_hash
        if target.exists() and checksum(target) != file_hash:
            raise ValueError('Existing inline media checksum mismatch')
        if not target.exists():
            target.write_bytes(data)
            target.chmod(0o600)
        return {'path': 'media/' + file_hash, 'size': len(data), 'sha256': file_hash,
                'contentType': mime if mime in MIMES else 'application/octet-stream',
                'sourceId': 'inline:' + file_hash, 'name': 'inline-' + file_hash[:12],
                'retrievedAt': datetime.now(timezone.utc).isoformat()}
    if not public_source_media(url):
        raise ValueError('Observed media requires browser access or another reviewed source bucket')
    key = digest(url.encode())
    metadata = root / 'media' / (key + '.json')
    if metadata.exists():
        cached = json.loads(metadata.read_text())
        if not re.fullmatch(r'media/[a-f0-9]{64}', cached.get('path', '')) or cached.get('sourceId') != url:
            raise ValueError('Invalid media checkpoint metadata')
        target = root / cached['path']
        if target.is_file() and target.stat().st_size == cached['size'] and checksum(target) == cached['sha256']:
            return cached
    opener = build_opener(SourceRedirects())
    temporary = None
    try:
        with opener.open(Request(url, headers={'User-Agent': 'BYD-authorised-archive/1.0'}), timeout=45) as response:
            with tempfile.NamedTemporaryFile(dir=root / 'media', delete=False) as output:
                temporary = Path(output.name)
                os.chmod(temporary, 0o600)
                size = 0
                sha = hashlib.sha256()
                for block in iter(lambda: response.read(1024 * 1024), b''):
                    size += len(block)
                    if size > maximum:
                        raise ValueError('Source file exceeds the configured migration size limit')
                    output.write(block)
                    sha.update(block)
                if response.headers.get('Content-Length') and size != int(response.headers['Content-Length']):
                    raise ValueError('Source file was truncated')
                if not size:
                    raise ValueError('Source file is empty')
                file_hash = sha.hexdigest()
                content_type = response.headers.get_content_type()
                value = {'path': 'media/' + file_hash, 'size': size, 'sha256': file_hash,
                         'contentType': content_type if content_type in MIMES else 'application/octet-stream',
                         'sourceId': url, 'name': Path(urlsplit(url).path).name,
                         'retrievedAt': datetime.now(timezone.utc).isoformat(),
                         'etag': response.headers.get('ETag'), 'lastModified': response.headers.get('Last-Modified')}
        target = root / value['path']
        if target.exists():
            if checksum(target) != file_hash:
                raise ValueError('Existing media content checksum mismatch')
            temporary.unlink()
        else:
            temporary.replace(target)
        temporary = None
        private_json(metadata, value)
        return value
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

def prepare(checkpoint, output, only=None, workers=4, maximum=536870912):
    state, records = load_records(checkpoint, only)
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in ('media', 'records', 'originals'):
        (output / name).mkdir(mode=0o700, exist_ok=True)
    urls = list(dict.fromkeys(url for record in records for url in record['urls']))
    downloaded, failures = {}, {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(download, url, output, maximum): url for url in urls}
        for future in concurrent.futures.as_completed(futures):
            url = futures[future]
            try:
                downloaded[url] = future.result()
            except Exception as error:
                # Do not include signed source URLs in console output.
                failures[url] = type(error).__name__ + ': ' + str(error).split('?')[0][:180]
    entries, source_files = [], []
    for item in records:
        source_id, fields = item['sourceId'], item['fields']
        pending = [{'sourceId': url, 'reason': failures[url]} for url in item['urls'] if url in failures]
        raw = {**item['record'], 'sourceId': source_id, 'rego': fields.get('Registration number', ''),
               'vin': fields.get('VIN number', ''), 'customerName': fields.get('Name', ''),
               'make': fields.get('Make', ''), 'model': fields.get('Model', ''), 'year': fields.get('Model Year', ''),
               'migrationCoverage': {'renderedRecord': True, 'visibleAuditLog': True,
                                     'observedMedia': len(item['urls']), 'pendingMedia': pending,
                                     'completeUpstreamBackup': False}}
        target = output / 'records' / (source_id + '.json')
        private_json(target, raw)
        entries.append({'kind': 'appraisal', 'sourceId': source_id, 'site': item['site'],
                        'path': 'records/' + target.name, 'size': target.stat().st_size, 'sha256': checksum(target),
                        'media': [downloaded[url] for url in item['urls'] if url in downloaded]})
        original_hash = digest(item['original'])
        original = output / 'originals' / (original_hash + '.json')
        if not original.exists():
            original.write_bytes(item['original'])
            original.chmod(0o600)
        source_files.append({'path': 'originals/' + original.name, 'size': len(item['original']), 'sha256': original_hash})
    report = {'sourceAccount': 'BYD Melbourne', 'expectedAtScanStart': state.get('expectedRecords'),
              'uniqueCapturedRecords': len(state['current']), 'selectedRecords': len(entries),
              'observedUniqueMedia': len(urls), 'retrievedUniqueMedia': len(downloaded),
              'pendingUniqueMedia': len(failures), 'auditEvents': sum(len(r['record']['audit']['rows']) for r in records),
              'completeSourceBackup': False, 'nextSourceUrl': state.get('nextSourceUrl')}
    private_json(output / 'coverage.json', report)
    source_files.append({'path': 'coverage.json', 'size': (output / 'coverage.json').stat().st_size,
                         'sha256': checksum(output / 'coverage.json')})
    manifest = {'version': 1, 'namespace': 'byd-melbourne-iappraise-browser', 'expectedRecords': len(entries),
                'expectedCounts': {'appraisal': len(entries)}, 'expectedMedia': sum(len(e['media']) for e in entries),
                'completeSourceVerified': False, 'records': entries, 'sourceFiles': source_files}
    private_json(output / 'manifest.json', manifest)
    return report

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkpoint', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--ids', type=Path, help='JSON array of original source IDs to prepare')
    parser.add_argument('--workers', type=int, choices=range(1, 9), default=4)
    args = parser.parse_args()
    only = set(json.loads(args.ids.read_text())) if args.ids else None
    print(json.dumps(prepare(args.checkpoint.resolve(), args.output.resolve(), only, args.workers)))

if __name__ == '__main__':
    main()
