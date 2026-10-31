# Virtual Yard test-drive integration

CRM **Book Test Drive** now loads live demo vehicles, salespeople, existing drivers,
yards, booking types and statuses from Virtual Yard. Booking creation is supported
through both `/api/crm/appointments` and `/api/appointments`. Other appointment types
remain local. Changes to an existing appointment are currently local; this integration
creates bookings and does not update or delete existing Virtual Yard bookings.

## Session configuration

Set `VIRTUALYARD_COOKIE=PHPSESSID=...` in the backend `.env`, or use **CRM Settings →
Virtual Yard test-drive connection → Connect session** as a site/super administrator.
Cookies never go to the CRM browser after connecting and are not returned by APIs.
The seed in `.env` is used only when no managed session file exists.

The backend runs an authenticated read-only check every five minutes while running,
accepts `Set-Cookie` replacements and saves the session across restarts in
`.runtime/virtualyard-session.json` (owner-only file permissions on Unix). Keep this
directory private. Set `VIRTUALYARD_SESSION_FILE` to an absolute persistent path when
needed. Docker Compose mounts a private named volume for this directory.

Keep-alive can prevent inactivity expiry, but a session cookie is not a refresh token.
If Virtual Yard imposes absolute expiry, logs the account out, or revokes a session,
sign in to Virtual Yard and reconnect the new cookie in CRM Settings. The server
cannot obtain a new authenticated cookie from an expired cookie alone. No passwords,
SMS bypass, or browser-cookie database extraction are used.

`../virtual-yard/Leads/Scraper.js` shares this session manager and reads the backend
`.env`. It no longer requires editing a cookie inside JavaScript. When running the
scraper on another machine/container, configure the same private session file path
and provide filesystem access to it. Keep the backend running for background checks.

## Booking behavior

The frontend submits an idempotency key (`bookingRequestId`) and a `virtualyard`
selection containing `vehicleId`, `userId`, `customerId`, `customerName`, `locationId`,
`bookingType`, and `status`. These selections are validated against live lookup data
and permitted yards. Driver creation is not supported: create new drivers in Virtual
Yard first. The CRM uses explicit driver selection to disambiguate duplicate names.

The form interprets dates in `Australia/Melbourne`, including daylight saving,
independently of the user's computer timezone. It rejects the missing/repeated hour
at daylight-saving transitions. The backend serializes notes as UTF-8 base64 and
posts the same form fields as Virtual Yard's native booking screen.

Appointments are saved before the external POST. `virtualyardSync.state` records:

- `synced`: Virtual Yard returned a `dealerTestDrive` booking ID.
- `failed`: no POST was sent or Virtual Yard explicitly rejected it. An appointment
  detail panel offers a retry after the underlying issue is resolved.
- `sending` / `unknown`: the external result is uncertain. Check Virtual Yard for
  the booking. Automatic retries are intentionally blocked to prevent duplicates.

Repeated submissions with the same request key return the original appointment.
Do not generate a new key when retrying an uncertain HTTP response. Sync metadata
cannot be overwritten through generic appointment PATCH endpoints. Retry uses
`POST /api/crm/appointments/:id/virtualyard-retry` and remains site-scoped.

## Verification

Run `node --test tests/*.test.js` in the backend and
`node node_modules/typescript/bin/tsc --noEmit --incremental false` in the CRM.
Tests mock external writes; they do not create live customer bookings.
On Windows, if Turbopack cannot launch its CSS worker, verify the production bundle
with `node node_modules/next/dist/bin/next build --webpack` in the CRM directory.
