#!/usr/bin/env python3
"""Preserve original CSV bytes and every row in an importable JSON snapshot.

The site mapping is reviewed separately. A CSV is not a full inspection export.
Usage: python3 scripts/prepare-iappraise-csv.py report.csv export.json
"""
import csv
import hashlib
import json
import os
import sys
from pathlib import Path

source, target = map(Path, sys.argv[1:3])
original = source.read_bytes()
with source.open(encoding='utf-8-sig', newline='') as stream:
    reader = csv.DictReader(stream)
    columns = reader.fieldnames or []
    if not columns or len(columns) != len(set(columns)):
        raise ValueError('Missing or duplicate CSV headers.')
    records = list(reader)
    if any(None in row or any(value is None for value in row.values()) for row in records):
        raise ValueError('Malformed source CSV row. No export written.')
data = {'source': 'https://iappraise.net.au/search', 'sourceFile': source.name,
        'sourceSha256': hashlib.sha256(original).hexdigest(), 'recordCount': len(records),
        'columns': columns, 'coverage': {'allCsvRowsPreserved': True, 'completeUpstreamBackup': False,
                                      'includesPhotosOrVideos': False, 'includesFullOfferHistory': False},
        'records': records}
with target.open('x', encoding='utf8') as stream:
    json.dump(data, stream, ensure_ascii=False, indent=2)
os.chmod(target, 0o600)
print(json.dumps({'records': len(records), 'sourceSha256': data['sourceSha256'], 'output': str(target)}))
