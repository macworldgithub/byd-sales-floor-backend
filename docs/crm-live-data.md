# CRM live data

The CRM starts with empty collections and an authenticated user. It does not seed
sample records or substitute demo records when a request fails. Failed reads show
an error and retry action; unknown measurements remain null. Recorded zero is a
valid measurement.

Authenticated runtime endpoints:

- `GET /api/crm/bootstrap`: staff, permitted/observed sites, consultants, sources,
  inventory models/variants/colours and active saved SMS templates. Staff fields
  are explicitly projected; passwords and credentials are never returned.
- `GET /api/crm/boards/me` and `/boards/team`: recorded sales, opportunities,
  allocations and saved monthly targets; use `period=YYYY-MM` for a month.
- `POST /api/crm/targets`: save consultant, site, period and targetUnits. A missing
  target is not inferred. A saved zero is retained.
- `GET /api/crm/reports/summary`: scoped persisted counts and recorded gross.
- `GET /api/crm/audit`: paginated timeline history with search/source filters.
- `GET /api/crm/settings/governance`: saved and effective SLA/hold settings.
- `POST /api/crm/settings/governance`: persist validated policy settings for
  authorized global managers/admins. Existing service defaults are 15 minutes
  for SLA and 48 hours for stock holds until a setting is saved. These defaults
  drive the service itself and are not sample business metrics.
- `POST /api/crm/lead-requests`: persist a pending request for more leads. This
  action does not send a notification or imply that one was sent.

Reference/catalogue data comes from Lead Centre `leads` and `inventories` and
Delivery Centre `users`, `customers`, `opportunities`, `saleslogentries`,
`allocations`, and `templates`. Settings and month-specific targets use
`crmsettings` and `crmtargets`; dated legacy `targets` are also read.
Existing database records are retained, including any historical test records.

Virtual Yard booking vehicle, salesperson, driver and yard lookups remain live
upstream requests through the backend session manager. CRM filters/reference
data and operational records come from the databases at request time.

Optional backend environment variables `LEAD_CENTRE_URL` and
`DELIVERY_CENTRE_URL` enable links to the connected applications. If omitted,
the CRM shows the actual record identifier without inventing a link. The CRM
backend address is configured with `NEXT_PUBLIC_API_URL` at build time.

Successful mutations use confirmed server responses; failed customer/deal/SMS
requests never create local placeholder records or show a success message.
Delivery dates are copied only when actually recorded, not estimated at sale.
Fixed UI labels, workflow stage/status codes, field schemas, and brand assets
remain application definitions, not business data.
