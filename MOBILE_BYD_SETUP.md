# BYD mobile setup and integration contracts

Implemented 5 November 2026. The mobile client now uses `/api/mobile` for the BYD sales workflow. Existing desktop APIs remain available. I-Appraise and other-brand integrations are outside this change.

## Server and storage

Use the existing JWT/account configuration and the Lead Centre and Delivery Centre MongoDB connections. The mobile routes use the existing `leads`, `inventories`, `appointments`, `deals`, `customers`, `clients`, `users`, `messages`, and `timelineevents` collections. New supporting collections use the `floor_` prefix; business records use `businesses` and targets use `crmtargets`. No destructive migration is required. Imported data still needs correct site and salesperson identities to appear in the correct silo.

Configure persistent storage for these server-only paths. They must survive restarts and be shared or consistently routed if the API has multiple instances:

```dotenv
# Public API origin, WITHOUT /api. Used in recipient media links.
PUBLIC_API_URL=https://your-api.example
FLOOR_MEDIA_DIR=/persistent/sales-floor/media
FLOOR_PRIVATE_MEDIA_DIR=/persistent/sales-floor/licences
VIRTUALYARD_SESSION_FILE=/persistent/sales-floor/virtualyard-session.json
```

Media links contain opaque bearer tokens for SMS recipients. Licence images are private and have no public link. Configure storage backup, retention and proxy upload limits for the deployment; uploads accept up to 65 MB. Video validation reads the MP4/MOV container duration and rejects videos over 180 seconds. A single API process runs the alert worker every minute; database claims prevent duplicate push submissions between processes.

## Native Virtual Yard test drives

The app follows `byd-sales-crm-layer`: live yard/demo-vehicle/salesperson/driver lookups and refresh, automatic selection of the chosen demo vehicle's authorized yard, one stable booking request ID, explicit Melbourne booking time and sync status. It closes only on confirmed VY success; a saved but unsynced booking remains visible. Both API paths call the same `appointmentBooking.book` service. Test drives use the existing native Virtual Yard POST `/save/save.php?page=test-drive&auto=add`; they do not require the optional gateways below.

Connect a real Virtual Yard session through the existing administrator session control in Site settings, or supply `VIRTUALYARD_COOKIE` server-side. Never put the cookie in an Expo public variable. Expired sessions require reconnection. See [VIRTUALYARD.md](VIRTUALYARD.md).

The reference CRM selects existing drivers; it does not create a new driver. The app additionally offers **Find by mobile or create this customer in Virtual Yard**. The backend reuses an exact phone match in the selected yard, refuses ambiguous matches, retains hidden form tokens, stores the returned customer ID, and blocks blind retries after an uncertain POST. Confirm the actual customer form/save paths and field names for the connected VY account before enabling this path for staff:

```dotenv
# These default paths have NOT been validated against a live customer form.
VIRTUALYARD_CUSTOMER_FORM_PATH=/render.php?page=customers&params=&auto=add
VIRTUALYARD_CUSTOMER_SAVE_PATH=/save/save.php?page=customers&auto=add
# Optional JSON mapping: name, firstName, lastName, phone, email, locationId.
VIRTUALYARD_CUSTOMER_FIELDS={}
```

Mapping values must be actual names in the retrieved form. An unknown required field stops creation. Confirmed saves must return a native array containing `{"class":"customer","id":123}` (or `customers`). Do not clear `virtualyard_customer_requests` in Lead Centre to retry an uncertain creation without checking the actual VY customer first.

## Other Virtual Yard writes and signed contracts

The repository contains no verified native save contract for general appointments, calls or deals. The new adapters expect an existing HTTPS connector with the following contract; simply supplying a VY page URL will not implement it:

```dotenv
VIRTUALYARD_APPOINTMENT_API_URL=https://connector.example/appointments
VIRTUALYARD_CALL_API_URL=https://connector.example/calls
VIRTUALYARD_DEAL_API_URL=https://connector.example/deals
VIRTUALYARD_API_TOKEN=
VIRTUALYARD_CONTRACT_WEBHOOK_SECRET=
```

Each outbound request is a JSON POST of the canonical appointment, timeline call event or deal. `Authorization: Bearer …` and a stable `Idempotency-Key` are supplied. The connector must honor that key across retries, perform the real VY operation and return `{"success":true,"externalId":"actual-upstream-id"}`. Missing configuration or missing external confirmation remains a visible failure. A local call/appointment/deal is retained. Calls retain their sync result in the customer timeline. General appointment/deal failures can be retried from Calendar/Deals. Do not manually retry an ambiguous upstream write unless the connector guarantees idempotency.

After a real deal has an external order ID, register the trusted connector to POST `/api/mobile/virtualyard/contract-signed` with `Authorization: Bearer <VIRTUALYARD_CONTRACT_WEBHOOK_SECRET>`:

```json
{
  "eventId": "unique-provider-event-id",
  "externalOrderId": "actual-external-order-id",
  "contractId": "actual-signed-contract-id",
  "signedAt": "2026-11-20T10:00:00+11:00"
}
```

Only a known external order can create a delivery job. Replayed events reuse the delivery; pushing a deal alone does not create one. The webhook must be wired to genuine signed-contract events; no upstream subscription is installed by this code change.

## Vehicle verification and licence OCR

These are adapter contracts for an approved broker/provider, not assertions about a vendor's native API:

```dotenv
NEVDIS_API_URL=https://vehicle-broker.example
NEVDIS_API_KEY=
PPSR_API_URL=https://ppsr-broker.example
PPSR_API_KEY=
# Optional: OCR suggestions; manual licence review also works without OCR.
LICENCE_OCR_API_URL=https://ocr-broker.example/licence
LICENCE_OCR_API_TOKEN=
```

- Rego: `GET <NEVDIS_API_URL>/lookup?rego=…&state=…`, bearer API key. Return `{"success":true,"vehicle":{"vin":"17-character-VIN","make":"…","model":"…","year":2026}}`.
- PPSR: `POST <PPSR_API_URL>/search` with `{"vin":"…"}`, bearer API key. Return `{"success":true,"data":{"status":"Clear","certificateNumber":"real-certificate-reference"}}`; `Encumbered` is also accepted. Errors never become Clear.
- OCR: POST raw image bytes with the image content type and bearer token. Return `fullName`, `licenceNumber`, `state`, `expiryDate` (YYYY-MM-DD). Staff must review the actual image/details before attaching the licence.

Provider checks are stored and linked to the authorized lead/customer/deal. New prospect VIN data is accepted through a server-stored lookup token, rather than trusting client-supplied verification fields.

## SMS, AI and BYD journey

Use the existing MobileMessage credentials (`MOBILEMESSAGE_USERNAME`, `MOBILEMESSAGE_PASSWORD` or API key), with simulation disabled. Load actual approved senders and select the verified sender separately for each BYD site in Site settings. An explicit site sender takes precedence over the deployment default in the new workflow. The new path refuses simulated SMS. Customer consent/opt-out is enforced. Stable request IDs prevent resubmission after an uncertain provider response and repair interrupted local message projections after confirmed sending. Each journey item can check a matching live provider message-history result; submission acceptance is not treated as delivery. See [live communications test results](COMMUNICATIONS_TESTING.md).

For optional AI suggestions:

```dotenv
AI_DRAFT_API_URL=https://your-provider.example/fact-selection
AI_DRAFT_API_TOKEN=
```

The provider receives the customer's question and approved OEM/dealer facts and must return `{"factIds":["0:0"]}`. The server constructs the draft from those exact facts; arbitrary generated prose is rejected. Pricing/trade sentences are excluded. AI never sends autonomously. Human messages/calls activate takeover; managers can configure explicit re-enabling or an inactivity interval. Add approved source content through Site settings.

Configure all four templates, actual helpful video HTTPS links, optional model video sets, contact text and the survey URL per site. Handover requires a signed contract, PDI and completion photos for all fitted accessories, then creates four staff-approval items: congratulations now, welcome in 1 day, helpful videos in 3 days, satisfaction in 21 days. Managers can adjust welcome/video timing; day 1/day 3 are implementation defaults. Missing video configuration holds that item until links are configured. Use the validation/preview controls before saving. Saving refreshes pending items; sent/cancelled messages retain their history. Staff approval is required when due; concurrent approvals cannot create a second SMS. The worker does not send SMS. See [vehicle and journey setup](VEHICLE_AND_JOURNEY_SETUP.md) for the provider contract, activation limits and validation evidence.

## Device location and push

Managers configure the actual dealership latitude, longitude and radius in Site settings. Team presence uses a foreground device GPS reading and shows its timestamp/freshness. It is not continuous background location tracking. Contractor completion photos require current coordinates inside that site's configured geofence and belong to the assigned accessory job.

Set `EXPO_PUBLIC_API_URL` to the reachable backend URL **including `/api`** and `EXPO_PUBLIC_EAS_PROJECT_ID` to the real Expo project UUID before building the app; set the API's `EXPO_PROJECT_ID` to the same UUID. Configure APNs/FCM credentials in that Expo project. `EXPO_ACCESS_TOKEN` is optional for server push security. Staff enroll a device from Alerts, including a supported Android emulator with Google Play services in a native app build. The server distinguishes Expo submission, APNs/FCM receipt and actual app acknowledgment; invalid tokens are disabled. Rebuild the native app after installing the added native modules. No EAS build, signing or store submission has been performed. Expo Go can test local notification display but cannot enroll for this app's remote push. A development-only `/notification-test` route supports emulator display/tap verification without staff login.

## Acceptance before rollout

Local checks use mocked providers/databases. Demonstrate with authorized test accounts: prospect/customer persistence and duplicates; existing and new VY driver booking; one real external booking ID; calls/general appointments/deals via the verified connector; signed contract creating exactly one delivery; contractor GPS and photo proof; completed handover; approved journey messages and opt-out; actual Rego/PPSR; role/site isolation; physical-device push. Run the manager pilot before team rollout. Desktop parity, training, source migration and production acceptance remain separate operational work.
