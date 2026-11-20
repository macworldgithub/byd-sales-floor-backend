# BYD appraisal workspace

The BYD Sales Floor web app exposes **Appraisals** in the sidebar, More tools and Customer 360. Records are stored in the existing Lead Centre `appraisals` collection. New appraisals resolve an authorised lead and its canonical customer; caller-supplied customer names, owners, approval states and clearance statuses are ignored. Consultants see their own records; management sees its authorised sites. The browser's `X-Site` selection also scopes direct appraisal/detail/media requests for all-site managers; it never overrides an authenticated account's site lock. Delivery-only and contractor accounts cannot enter the workspace.

## Inspection lifecycle

Draft → Pending Inspection → Completed → manager Approved/Declined. Approved records can be marked Traded/Lost; an authorised manager can reopen an inspection. Completion requires vehicle identity, odometer, four condition ratings and Front/Right/Rear/Left/Interior/Odometer/VIN photographs. Revisions reject stale edits. Active drives and loan vehicles must be returned before completion/approval changes.

The workspace captures vehicle details, keys, service history, condition ratings, damage panels/severity, repair estimates, manual override notes, photographs, videos and supporting documents. Videos use their actual MP4/MOV duration and must be at most three minutes. Contracts are private attachments: uploading an already signed document does not execute an agreement or submit a DMS order. Internal drives record the staff member, checkout/return times, odometer readings, distance and notes. Loan agreements preserve the displayed dealership-supplied terms, their checksum, consent, witness, actual drawn PNG signature and return history. A signature cannot be reused for another agreement.

Valuation amounts and approval are manager-controlled. Staff can record customer expectations. Selecting a wholesale offer records an internal valuation; it is not an automatic vehicle purchase or payment. Existing negotiated deal allowances are not overwritten by appraisal propagation.

New deals created by the existing mobile operations service inherit the customer's single unlinked active appraisal. Multiple candidates require an explicit `appraisalId` or `withoutAppraisal`. A concurrent deal cannot claim the same appraisal. The existing desktop Sold → Delivery handoff carries completed/approved appraisal references into its opportunity and Delivery record. Signed Virtual Yard events retain the appraisal link on the contract and resulting Delivery record. External event delivery still depends on the existing Virtual Yard integration being configured and exercised.

## Private media and wholesale valuations

Set these on the production backend, outside release directories:

```dotenv
APPRAISAL_STATE_COLLECTION=idempotency_keys
APPRAISAL_MEDIA_DIR=/var/www/sales-floor/shared/appraisal-media
IAPPRAISE_ARCHIVE_DIR=/var/www/sales-floor/shared/iappraise-archive
APPRAISAL_WEB_URL=https://sales-floor.goodshowroom.com
```

The production Atlas cluster is already at its 500-collection limit. `APPRAISAL_STATE_COLLECTION` therefore uses the existing internal `idempotency_keys` collection for the new logical media, partner, invitation, archive and vehicle-check stores. Every read/update/count includes its immutable `appraisal_namespace`; existing integration checkpoint rows are untouched. The index initializer refuses shared collections with TTL/expiry indexes. Do not add an unscoped TTL index or bulk-prune this shared collection. Keep directories private and include them in server backups together with both MongoDB databases. The Nginx backend upload limit must allow 65 MB requests (70 MB provides headroom). New media are checked by file signature, retained on disk with SHA-256 metadata and served through authenticated, scoped endpoints. PDFs download as attachments; image/video playback supports byte ranges. No public static media directory is created.

Managers maintain site-specific dealer/wholesaler contacts and create recipient-specific valuation links with deadlines up to 30 days. Links are shown at creation for staff to share with their intended recipients. The backend stores only token hashes. The portal submits its token in `X-Appraisal-Token`; the share URL carries the secret in its fragment so it does not enter access-log request URLs. Shared payloads contain vehicle identity, inspection ratings/notes, damage descriptions and inspection media. Customer identities, contact details, internal valuations, repair costs, licences, signatures and private contract documents are excluded. Expired/revoked links cannot retrieve data. Offers have revision checks and retained bid history; selecting an offer freezes that offer against concurrent changes. Creating links does not send SMS/email.

## Provider-dependent services

The legacy `/api/vehicles` simulator has been removed. Rego/PPSR use the existing real-provider service, its stable request IDs, authorisation checks and durable request ledger. The web app retains check IDs across refreshes for each vehicle. VIN changes invalidate prior clearance. Missing providers and failed checks never generate a VIN, price or clearance certificate.

Use the existing `NEVDIS_API_URL`/`NEVDIS_API_KEY` and `PPSR_API_URL`/`PPSR_API_KEY` contracts documented in `VEHICLE_AND_JOURNEY_SETUP.md`. Damage assistance requires `INSPECTION_AI_URL` and `INSPECTION_AI_TOKEN`; the HTTPS endpoint receives vehicle make/model/year and inspection-image base64 payloads, and returns `{findings:[{panel,severity,description,estimatedRepairCost}]}`. Staff must review findings, can edit/dismiss them and can always perform the inspection manually. Configuration presence is not live provider validation. Licensed live pricing/VINTel services and other provider-specific iAppraise products are not reproduced by these adapters.

## Historical migration

Do not confuse a CSV snapshot with a complete iAppraise backup. A previous investigation exported **17,621 South Morang group rows and 68 staff contacts**. That is a different account from the signed-in **Shaun Sumaru BYD account**, whose Appraisals screen showed **1,605 total items** during this task. The older export was validated locally only; it must not be imported as this account's history. Its contacts are staff, not a wholesaler network.

After the initial browser approval usage limit reset, the current account's official CSV was downloaded: **1,605 rows**, matching its displayed total. Verified site partitions are Nunawading 524, Caroline Springs 946, Wodonga 32, Melbourne City 99 and Fairfield 4. Six source VINs are blank and remain blank. The Permissions page contains **86 staff contacts**, including source role and PPSR permissions; these are not a verified external wholesaler directory. Group-only contacts are preserved under a separate source-group scope and shown only to all-site management. The complete inspection/media and external wholesaler exports remain outstanding; a CSV snapshot is not full-source reconciliation. Keep the source account available until every record, attachment and partner count is reconciled and the cutover delta is imported.

### Production preservation evidence — 17 November 2026 (Los Angeles)

The web/backend release is running on `sales-floor.goodshowroom.com` and `sales-floor-backend.goodshowroom.com`. Both MongoDB connections and authenticated appraisal/archive/report endpoints passed live checks. The production services are `byd-sales-floor` and `byd-backend`; unrelated CRM/leads services were not restarted. Prior web build/env/Nginx configuration backups are retained under `/var/www/sales-floor/.releases/`. A private EJSON backup preserved the two existing integration checkpoint rows before archive imports.

The initial **1,605-row snapshot plus 86 staff contacts** reconciled in production. A later source refresh displayed **1,618 total items** and its new official CSV reconciled independently: Caroline Springs 953, Nunawading 529, Wodonga 33, Melbourne City 99, Fairfield 4. The latest original CSV SHA-256 is `167d823eb03e003dd4898a1bd6cea499d15117e20bb764f2768d5642abfd43cf`; the import JSON source hash is `d1749266359a794def4ff46f50eb64fc3d2b38fe449be3a7dba5cd1ee6ead0ff`. Both original CSVs and reconciliation manifests are retained privately in `shared/iappraise-archive`.

Source appraisal **2580601** was additionally captured from its rendered detail page, preserving its inspection tables, comments, visible offers and **29 retrieved images** in a checksum-verified bundle. Of these, 27 are the source's x1080 cached renditions and two are other images exposed in the source record. These are not a claim of complete original-resolution media or all offer/audit revisions. No historical videos or external directory records have yet been retrieved.

The archive therefore contains **3,310 rows/versions**: 1,605 earlier CSV rows, 1,618 refreshed CSV rows, 86 staff rows and one detailed capture. This is **not 3,310 unique appraisals**. Use the archive's import-batch and record-type filters to reconcile a specific snapshot. Batch discovery/counts remain site-scoped, including when a caller guesses another source hash. Nested source fields are displayed as preserved JSON and can be downloaded with the full archive record.

### Production preservation evidence — 20 November 2026 (Los Angeles)

The latest official CSV contains **1,640 rows**: Nunawading 534, Melbourne City 103, Caroline Springs 963, Wodonga 36 and Fairfield 4. It reconciled independently in production; earlier snapshots and the 86 staff contacts remain preserved. The original CSV SHA-256 is `fe8518353c8d7469b46d54323042dcadadc1bba2f19de315df6b2c6b741f3403`, and its import JSON hash is `2fde21ee1ab624383b2dc6d272988e5bef541b0fa3b251ae928e4654942373af`.

Two additional detailed bundles reconciled: **20 records / 251 media references** (`d22516344d41a1be8aaabe5c18ef43cad33b8cd0bcac4da1072290ef792a618e`) and **17 records / 297 media references** (`bc89af2873de912dcf2f5f72efa7da610c8b63b8f3126ab5fc2b28df89112312`). Together they preserve **37 original appraisal IDs**, **548 media references** and **80 visible audit events**, including all four Fairfield records in that CSV. Media references can repeat the same bytes; 548 is not a unique-file count. The earlier 29-image capture remains as a separate version of an overlapping source ID. Unknown source fields, rendered HTML/text, tables and original capture JSON are retained privately.

Production reconciliation verified **585 distinct content-addressed files** for these two bundles, including their record JSON, original captures, coverage reports and media. None of the media observed in these 37 captures are pending retrieval. Authenticated media returned the expected checksum; anonymous access returned 401 and a different active site returned 404. Authenticated archive filters matched both bundles and every site in the latest CSV. The archive now holds **4,987 rows/versions**, comprising the three CSV snapshots, 86 staff records and 38 detailed versions covering 37 original IDs. These are not unique account appraisals. Appraisal/report endpoints and the wholesale portal route also passed live checks.

This remains a partial historical migration. The account continued receiving new records during capture, and one make filter already exceeded its saved CSV count. The private checkpoint records the next observed source URL and per-filter progress for resumption and final delta reconciliation. Browser control became unavailable during the scan, so the remaining detailed records, historical videos and external dealer/wholesaler directory are outstanding. The browser preparer passed six local tests, including stale-page rejection and preservation of explicit media gaps. Provider-dependent services and the remaining acceptance requirements below are unchanged.

### CSV preservation

```sh
python3 scripts/prepare-iappraise-csv.py /private/current-account.csv /private/current-account.json
node scripts/import-iappraise.js /private/current-account.json --mapping /private/reviewed-site-map.json
# Apply only after checking account identity, counts and explicit site assignments:
node scripts/import-iappraise.js /private/current-account.json --mapping /private/reviewed-site-map.json --apply
```

The mapping JSON uses exact `Dealership::Department` keys and canonical BYD site values, for example a verified source dealership and `Nunawading - NEW` department mapped to `BYD Nunawading`. Unmapped dealerships fail before writes. Every blank, original column and repeated source row is retained. Row identities are tied to the exact exported snapshot and original row number because the CSV does not expose upstream appraisal IDs. Preserve the original CSV file too. CSV imports never guess a customer association or manufacture missing inspection media/offer history. Imported group/unclassified records are not exposed through an unrelated site's archive.

### Complete record/media/directory bundles

```sh
node scripts/import-iappraise-bundle.js /private/current-account/manifest.json
node scripts/import-iappraise-bundle.js /private/current-account/manifest.json --apply
node scripts/appraisal-indexes.js
```

The version 1 manifest declares `namespace` (the verified source account), `expectedRecords`, `expectedCounts` for `appraisal`, `dealer`, `wholesaler`, `dealer_staff`, `expectedMedia`, and `records`. Each record has `kind`, original `sourceId`, explicit canonical BYD `site`, and its original JSON `path`, `sha256` and byte `size`. Optional `media` entries include original `sourceId`, relative `path`, SHA-256, byte `size`, `name` and `contentType`. `sourceFiles` may retain original export files with the same path/checksum/size contract. Dealer/wholesaler records require explicit `partner` details: `name`, `company`, `email`, `phone`, `address`, `licence`, `abn`, `notes`, `active`. Original unknown fields remain in the source JSON.

All files/counts are validated before writes. Escaping paths, external symlinks, duplicate upstream IDs and corrupt files fail validation. Imports preserve immutable record/media versions, keep original bytes on private disk, reconcile each attachment checksum and never overwrite staff-edited partner contacts. Rerunning the same bundle is safe. Adding changed media preserves the earlier snapshot. Historical media are preserved even if they exceed new-capture limits. Imported external contacts can receive new valuations through this platform; imported source roles never create login accounts or grant permissions. Archived records/media are manager-only and site-scoped. `completeSourceVerified` is an operator assertion, not a provider completeness guarantee; do not set it from CSV counts alone.

### Browser-captured records when no full export/API is available

The signed-in account exposes detailed records and a **More Options → View Audit Logs** dialog. Preserve the actual `/form-<id>` URL, rendered reference, tables, comments, image/video/document references and visible audit rows. Keep a private checkpoint keyed by the original IDs, with each captured JSON file named by its SHA-256 under `captures/`. The checkpoint's `current[id].sha256` must match those original bytes. Duplicate registrations and VINs remain independent source IDs.

```sh
python3 scripts/prepare-iappraise-browser.py /private/capture/checkpoint.json /private/prepared --workers 4
# To prepare only a new batch, pass a JSON array of its original IDs:
python3 scripts/prepare-iappraise-browser.py /private/capture/checkpoint.json /private/prepared-next --ids /private/new-ids.json
node scripts/import-iappraise-bundle.js /private/prepared/manifest.json
node scripts/import-iappraise-bundle.js /private/prepared/manifest.json --apply
python3 -m unittest discover -s tests -p 'iappraise_browser_test.py'
```

The preparer validates the account, reviewed BYD site mapping, source URL/reference and capture hashes. It downloads only links observed in those records from the reviewed iAppraise S3 buckets, without browser cookies, source passwords or guessed API/record URLs. Redirects to other origins are rejected. It retains inline source-media bytes, checks cached files when resuming, and preserves original capture JSON alongside the import records. Media failures stay explicit in each record's `migrationCoverage.pendingMedia` and in `coverage.json`; a prepared/imported subset is never marked as a full account backup. Other source buckets and authenticated media need their own reviewed browser retrieval before they can be reconciled.

Avoid loading the entire account into the source web app at once: its persisted browser state can exceed the site's storage quota. Bounded make/site filters and the visible pagination controls permit smaller scans. Reconcile each group's original IDs and count against the current official CSV, record capture times, and check for new source records before cutover. Visible wholesaler offers preserve their names, values and history within each appraisal; they are not substitutes for the external contact directory or permission to create partner accounts.

## Verification and remaining acceptance

Backend tests cover access boundaries, canonical customer resolution, idempotent creation, stale revisions, valuation roles, guided completion, private media bytes/ranges, drive/loan records, wholesaler-token privacy, bid revisions, batch isolation, all-site manager selection and source-file reconciliation. **213 backend tests**, the production web build and **8 existing web tests** passed before deployment. The tests substitute providers/databases; they do not establish live Rego/PPSR/AI acceptance or actual-device camera/signature acceptance. This release changes the web app/backend, not native iOS/Android binaries.

Full iAppraise replacement remains conditional on the current account's complete data/media/directory migration, provider-specific parity, manager acceptance and live integration/device tests. The broader combined scope also contains CRM, stock, PULSE, SMS, external systems and delivery rollout requirements; this appraisal release does not certify every item in that entire document.
