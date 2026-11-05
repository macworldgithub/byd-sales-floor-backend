# Sales Floor browsing

The Sales Floor frontend uses authenticated `GET /api/floor/leads`,
`/api/floor/today`, `/api/floor/calendar` and `/api/floor/calendar.ics`.

Staff browse the active assigned site, falling back to their stored home site.
Missing site assignments fail closed. Leads include colleagues' records at the
same site. Admin, site_admin and super_admin accounts browse all sites by default.
This administrative exception applies only to Sales Floor reads; CRM access,
platform grants and write permissions remain enforced by their existing rules.

Lead filters and totals are calculated before server pagination. Search uses
literal text and remains combined with the site condition. Date ranges use
Australia/Melbourne, including daylight saving. Calendar events combine actual
appointments, opportunity follow-ups and delivery clients with stable source IDs.
Calendar export includes every matching page and requires authentication.

Today returns complete counts alongside a paginated day schedule and live
priority leads. The frontend refreshes Today on focus, every minute while
visible, and after a saved appointment. Calendar filters and navigation issue
new requests. Failed requests display errors; empty data does not load demos.

Floor events are saved as appointments with an optional floorCategory. Test
drives use live Virtual Yard lookups and the existing idempotent booking service.

Tests: `node --test tests/*.test.js`.
