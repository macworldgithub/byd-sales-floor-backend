# Unified BYD Sales Floor changes

The existing BYD databases and integrations now serve the unified Sales Floor web workspace as well as the previous clients. A Sales Floor session can use the existing CRM workflows without a second platform login. Saved account roles, site grants and resource guards continue to apply.

Contractor accounts can use authentication and the existing mobile delivery operations, whose scope limits them to assigned work. They cannot use the general CRM, leads, client list or messaging routes.

## Allocation correctness

`leadAllocation.js` resolves an active salesperson with Sales Floor access at the enquiry's dealership. It converts BSON references correctly, updates the exact original enquiry, stores the salesperson's email/account ID and links the customer and opportunity. It uses schema-compatible lead stages and preserves booked/advanced stages.

Projection failures propagate as errors. Repeating an allocation repairs its saved projection rather than creating another enquiry. Accept/reassign operations also update the exact linked enquiry rather than every record matching a phone suffix. Assignment history and notifications use stable IDs.

The Lead Centre frontend no longer fabricates allocation/customer/opportunity IDs after a failed request or trusts old browser-only receipts.

`POST /api/floor/allocations/recover` is restricted to management. With `{ "apply": false }` it previews up to 100 incomplete historical allocations in the selected authorised scope. With `{ "apply": true }` it repairs eligible projections. Missing or archived sources and newer differing assignments remain visible for manual review.

## Existing workflow APIs

The web app uses existing `/api/mobile` operations for PULSE, summary periods, staff presence, lead merges, tasks, media SMS, delivery preparation and validated handover. Existing `/api/crm`, inventory, appointment, appraisal and customer-delivery services provide the remaining workspace functions.

Customer merges now require management and a common dealership. Linked BYD enquiries also use the existing lead-merge workflow so activity and related records follow the surviving customer.

## Dashboard periods and PULSE pagination

Overview active and unactioned lead counts use the selected Melbourne Today, Weekly or MTD received-date range. The received date uses the first valid `leadDate`, `leadCreatedDate`, then `createdAt`, so importing an older enquiry does not make it a new lead today. Native contact timestamps, meaningful legacy `lastContact` values and recorded call/SMS/email counts establish contact; empty or "Never"/"N/A" placeholders do not. Archived enquiries are excluded. Recorded sold enquiries and enquiries explicitly linked to a confirmed sale are converted, including legacy Lead Centre sold states.

`writtenSales.js` reconciles native signed contracts, CRM written opportunities, sales-log entries and Delivery Centre written-order records. Explicit opportunity, sales-log, delivery and external-order IDs deduplicate the same transaction within its site; Dealer Studio and Virtual Yard order namespaces remain distinct. Names, phones and VINs are never used to guess a sale identity. Cancelled projections do not count. Actual signature/sold timestamps take precedence over legacy day-only order dates, interpreted in Melbourne time. Missing sale dates remain unknown and are reported in `salesDataQuality`; import/create/update timestamps do not substitute for them.

The written-sales card counts dated transactions in the period. Lead conversion uses converted, non-archived enquiries divided by all non-archived enquiries received in the period, including lost/closed enquiries. An order without an explicit enquiry link can count as a written sale without being guessed into that conversion numerator. Monthly targets use the current Melbourne month, support `crmtargets` and legacy `targets`, prefer native overrides and preserve a configured zero. An unconfigured target is null.

Overdue leads are the distinct current open-lead backlog, including overdue manager tasks. Multiple tasks on one lead count once; archived and closed leads do not count. Agreed future follow-up dates are respected, and aging uses the latest recorded contact date with the received date as fallback. `overdueTasks` separately reports task counts. Appointments use their scheduled date (including later today), not the import date. Videos use their recorded send-event date. Today's tiles, attention list and calendar use the same BYD site scope; closed enquiries do not appear as attention items.

The web PULSE requests `/api/mobile/pulse?page=1&limit=10&followupPage=1&followupLimit=10`. The consultant table and follow-up list each have independent pagination metadata, stable ordering, full matching totals and page-size limits of 50. Both lists paginate inside MongoDB, without constructing an array of every flagged customer. Out-of-range pages clamp to the final available page. Existing mobile requests without pagination parameters and consultant CSV exports retain their complete legacy response.

PULSE groups recorded enquiry owners, including historical assignments. Its workload is current and its conversion is lifetime enquiry conversion, independently of the overview's period selector. Amber/red follow-up counts respect the same agreed dates and open tasks as overdue metrics, with their configured thresholds. Archived duplicates do not contribute to totals or conversion.

## Media transport

The authenticated upload sequence is:

1. `POST /api/mobile/media/uploads` with subject, byte size and content type.
2. `PUT /api/mobile/media/uploads/:id/:part` with at most 2 MB of raw bytes.
3. `POST /api/mobile/media/uploads/:id/complete` after all parts are stored.

The server checks ownership, exact part sizes, checksums, expiry, complete byte count, content signature and actual container duration. Retries cannot change an existing chunk or repeat a completed upload. Temporary session/chunk records expire after one hour. The original `/api/mobile/media` endpoint remains compatible.

Vercel stores completed media in GridFS in the existing Delivery Centre MongoDB database; VPS deployments retain their configured media directory. Token-protected customer links support byte-range playback. Keep existing `PUBLIC_API_URL` set to the HTTPS backend origin; Vercel's production hostname is an automatic fallback.

## Verification

Run `npm test` for the backend suite. New regressions exercise BSON lead identity, exact assignment/reassignment, failed-write replay, staff/site restrictions, historical recovery and authenticated chunk uploads. Existing suites cover merged history, SMS replay, stock claims, booking sync and handover prerequisites.

On this Windows host, the pre-existing I-Appraise symlink-escape test cannot create its symlink (`EPERM`). Run that test on a host with symlink creation enabled; the application checks were left intact.
