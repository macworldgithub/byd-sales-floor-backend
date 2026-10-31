# CRM Leads, Pipeline and Calendar

These read endpoints require the CRM account's normal authentication and site
permissions. Responses are not cached. Each paginated response contains `data`,
`pagination` and `meta.filters`. Page sizes are 1–100. Out-of-range pages are
clamped to the last available page; empty results use page 1. Sorts include `_id`
as a tie-breaker so records do not jump between pages with identical timestamps.

- `GET /api/crm/leads`: Lead Centre `leads`, including records where `isArchived`
  is absent. Filters: `q`, `stage`, `status`, `source`, `platform`, `owner`,
  `leadYard`, `archived` (`true`, `all`, or active by default), `scoreMin`,
  `scoreMax`, `receivedFrom`, `receivedTo` (inclusive Melbourne dates), and `sort`
  (`updated`, `newest`, `oldest`, `score`, `name`). It does not create CRM customers
  or opportunities as a side effect of browsing.
- `GET /api/crm/opportunities?browse=true`: Delivery Centre `opportunities`.
  Filters: `q`, `stage`, `model`, `owner`, `sale_type`, `dealYard`. The metadata
  includes matching counts and values for every stage and the complete filtered
  pipeline value, independently of the selected page.
- `GET /api/crm/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`: Unified events from Lead
  Centre `appointments`, Delivery Centre `opportunities` next-action/expected-close
  dates and scheduled Delivery Centre `clients`. `from` is inclusive and `to`
  exclusive in `Australia/Melbourne`; ranges are limited to 93 days. Optional
  filters: `q`, `category` (`all`, `drive`, `followup`, `delivery`), `consultant`,
  `status`, `eventYard`. Invalid/missing source dates produce no scheduled event;
  no synthetic dates are substituted. Date-only follow-ups default to 09:00 and
  date-only handovers to 11:00 Melbourne time. Callbacks are follow-up events.

`site`/`yard`/`location` select the overall site; account site locks always win.
Additional yard filters narrow that scope. Dropdown options cover the entire
permitted site/range rather than only the loaded page. No writes are made to
Virtual Yard by these endpoints.

The CRM Leads and Pipeline screens request their own pages, reset pagination on
filter/site changes and ignore stale responses. Both Pipeline board and list
views have pagination. Calendar month/week grids follow all server pages for
their visible dates; crowded cells link to the paginated day view. Calendar day
and list views use server pagination. The month picker, date navigation, search,
yard, consultant, status and event-type filters all change the server query.
Calendar exports include all matching events, with real UTC timestamps.

Backend startup installs compound sort indexes for leads and opportunities;
queries also allow disk sorting for large results. Run `node --test tests/*.test.js`
for automated checks, and `node scripts/verify-crm-browsing.js` for read-only
smoke checks against the configured databases. The smoke script prints counts
without contact details. Frontend checks are `node --test tests/*.test.cjs`,
TypeScript and the Next production build.
