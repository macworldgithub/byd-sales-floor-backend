# BYD vehicle checks and post-delivery journey

Updated 6 November 2026. Applies to the active Expo app and `/api/mobile`. I-Appraise is outside this change.

## Current activation status

- Vehicle verification: **not live**. The user confirmed there is no vehicle-data provider account or API contract available. The server has an explicit REST broker contract and app handling, but no named vendor adapter or provider credentials have been validated. Setting arbitrary URLs is not sufficient to activate government searches.
- Journey: configuration, preview, enrollment, staff approval, cancellation and delivery-receipt code are implemented and tested locally. The scope supplies congratulations, welcome, helpful videos and BYD day-21 satisfaction; it does not supply a site, actual video URLs, a survey form or a vehicle-data provider.
- No new live SMS or paid vehicle checks were sent for this change. The separately documented congratulations SMS test was previously confirmed delivered to the user-provided number. Four-step live acceptance remains outstanding.

## Vehicle provider contract

Obtain an approved commercial provider/broker account before activation. The Australian government's direct PPSR B2G service uses versioned web services, not this application's JSON `/search` broker contract: [PPSR B2G technical resources](https://www.ppsr.gov.au/b2g-hub/b2g-technical-resources). Adapt the chosen vendor's documented API to this contract or replace the transport after its actual documentation and credentials are available.

Keep credentials in the backend environment:

```dotenv
NEVDIS_API_URL=
NEVDIS_API_KEY=
PPSR_API_URL=
PPSR_API_KEY=
```

Both base URLs must be HTTPS without embedded credentials, query parameters or fragments. The current broker transport sends `Authorization: Bearer <API_KEY>`, disallows redirects and uses a 20-second timeout. It performs no automatic retries.

| Check | Broker request | Required response |
| --- | --- | --- |
| Rego/VIN | `GET <NEVDIS_API_URL>/lookup?rego=<plate>&state=<state>` | `success: true`, `vehicle` or `data` containing a matching registration/state if supplied, a valid 17-character VIN, make, model and a plausible numeric year. |
| PPSR | `POST <PPSR_API_URL>/search`, JSON `{ "vin": "<VIN>" }` | `success: true`, `data` (or the top-level result) with `status` exactly `Clear` or `Encumbered`, and `certificateNumber` or `searchCertificateNumber`. A supplied VIN must match. Optional `certificateUrl` must be HTTPS. |

This is an application broker contract, not a claim that every NEVDIS/PPSR vendor supports these endpoints. Test/sandbox/simulated responses, missing certificates, mismatched vehicles and unknown/error statuses never produce a verified vehicle or clearance.

The app sends a stable `requestId` for each check. The API authorizes the lead and deal before any provider call, then creates a durable request claim. A repeated completed request returns its recorded result without rebilling or resetting a later PPSR clearance. An uncertain submission is held for provider-history review; it is never automatically retried. A changed vehicle or customer cannot reuse a request ID. Customer, lead and explicit deal receive structured results; new deals inherit the customer's trade data. Customer history is visible to its authorized current consultant even if a previous consultant performed the check. A registration change clears the previous certificate on the linked entities.

`GET /api/mobile/vehicle/status` returns configuration flags without secrets; configuration is not live validation. History is `GET /api/mobile/vehicle/checks?leadId=<id>`. The app exposes checks in prospect creation, customer details and deal creation. Legacy `/api/vehicles` and the excluded I-Appraise screen retain their older behavior; they are not the verified mobile workflow.

Before rollout, use a vehicle you are authorized to check and verify the real provider reference, returned VIN and certificate. Exercise clear, encumbered, rejected and timeout cases in the provider's approved test environment. Do not use the unit-test fixture VINs as live customer data.

## Configure the BYD journey

Open **Site settings → Messaging and BYD journey** under the intended BYD site:

1. Load and select an active approved SMS sender, then save it with site settings. Live sends also require the existing MobileMessage server credentials with simulation disabled.
2. Edit the four message templates. Supported variables are `{firstName}`, `{name}`, `{vehicle}`, `{site}`, `{videoLinks}`, `{surveyUrl}` and `{contact}`. Unsupported or malformed placeholders are rejected. Rendered messages must be 1–4000 characters.
3. Congratulations is day 0 and satisfaction is day 21. Welcome and helpful videos default to days 1 and 3; managers can change those days in sequence between day 0 and day 21. Day 1/day 3 are implementation defaults; the scope does not prescribe them. Due times are elapsed days from the recorded handover timestamp.
4. Enter actual HTTPS video URLs. Optional model video sets override general links for the matching delivered model. No approved URL has been invented or seeded. A missing video link holds the affected message in `needs_configuration`. Include `{videoLinks}` in its template.
5. A survey URL is optional when the satisfaction message includes usable `{contact}` text. The default asks the customer to contact their BYD team; replace it with site-specific details where appropriate. Branded alpha senders such as HARMONY cannot receive replies, so the default never instructs customers to reply to that sender.
6. Use **Validate and preview journey** to inspect personalized content, missing configuration and example due dates without enrollment or SMS. Preview checks content and sender selection; it does not claim provider delivery or validate the actual video contents. Save the site settings to activate those templates for subsequent handovers and refresh existing pending items.

Signed contract, PDI and accessory completion proofs remain prerequisites for handover. Replaying handover produces the same four items anchored to the original delivery timestamp. Configuration updates refresh only pending/configuration-held items at the selected site; sent, cancelled and in-flight items retain their history. Each due message requires an explicit staff approval. Customer/client/lead SMS opt-outs block sending. There is no automatic SMS worker.

Approval atomically claims a draft across staff members and uses a journey-wide durable SMS request ID. A review token binds approval to the body, recipient and due time actually loaded in the app; a changed template or customer mobile requires a fresh review. Uncertain submissions cannot be sent again from the queue. **Check SMS delivery** can recover a provider-confirmed send whose queue update was interrupted, then query its matching provider history. A provider acceptance or ticket alone is not delivery confirmation. Pending messages can be cancelled with a recorded reason and staff identity; cancelled messages are not revived by configuration refreshes.

## Validation evidence

- Backend: 166 tests passed, including 19 new provider/journey/HTTP cases. Providers and databases were mocked; no real searches or SMS occurred in these tests.
- App: 9 tests passed; TypeScript passed; lint passed with 0 errors and 59 existing warnings.
- Android and iOS JavaScript/Hermes exports passed. No signed native build was produced.
- Live prerequisites remain: contracted vehicle provider and mapped vendor API; approved site video content/contact details; four-step acceptance using the authorized test mobile. No production data was seeded or migrated.
