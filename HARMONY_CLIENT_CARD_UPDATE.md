# Harmony customer card and Sold handoff

Implements the Harmony CRM Client Card Update Notes, using the existing Booran customer-card grouping as the reference and Harmony's existing visual tokens.

## User behavior

- Sales Floor web and CRM open a concise Overview with the customer's contact details, enquiry vehicle, stage, consultant, next action and a short summary. Detailed information sits behind seven primary sections: Overview, Activity / Notes, Vehicle & Spec, Finance / Payment, Delivery, Documents and History. CRM retains its existing appointments, customer SMS, internal notes, deal tools and privacy controls as secondary sections. Every section opens with a plain-language summary.
- Sold opens a structured handoff. Promises and expected lead time are required; payment method is selected from Cash, Finance, Lease, Novated lease or Other. Finance/lease selections require a provider. Delivery notes are optional. The existing CRM entry point retains stock selection, VIN/factory-order validation and salesperson attribution.
- The backend persists the handoff on the customer, opportunity and linked Delivery client. New clients receive a stable `id`, estimated booking type and `handoff_status: new`, allowing Delivery staff to open them directly and see new Sold handoffs.
- Sales Floor leads create or reuse a durable canonical customer before Sold. Handoff submission uses a short-lived opportunity lease, reuses the sales log and existing Delivery client on retries, and returns a conflict for concurrent submissions. Lead stage updates stay within the same dealership and verified identity.
- Sales and Delivery exchange internal, attributed, timestamped messages on the Delivery tab/customer profile. These are not SMS and never invoke the customer SMS provider. Chat messages remain in the shared client's `comments` array with `channel: sales_delivery` and appear in CRM customer history. The current thread shows the latest 100 messages; older messages remain stored and available in CRM history.
- Both sales applications display in-app Delivery-reply notifications. Delivery Centre displays new Sold handoffs and unread Sales messages. Read acknowledgements include the viewed message ID so a newer concurrent message is not accidentally cleared. Viewing the profile does not repeatedly issue acknowledgement writes after it is read.
- Unlinked legacy Delivery clients display a linkage message rather than allowing a message that Sales cannot receive. No bulk customer migration, historical event deletion, automatic retention or customer SMS test is part of this change.

## API and storage

Node API, protected by current account/platform and dealership permissions:

```
GET  /api/customer-delivery/delivery-notifications
GET  /api/customer-delivery/profiles/:reference/delivery
POST /api/customer-delivery/profiles/:reference/sold
POST /api/customer-delivery/profiles/:reference/delivery/messages
POST /api/customer-delivery/profiles/:reference/delivery/read
```

The reference can be a canonical CRM customer or a Sales Floor lead. Existing `/api/crm/opportunities/:id/mark-sold` also validates and persists the structured handoff.

Delivery Centre API:

```
GET  /api/clients/handoff-notifications
GET  /api/clients/:id/sales-chat
POST /api/clients/:id/sales-chat
POST /api/clients/:id/sales-chat/read
```

`delivery_handoff` holds promises, lead_time, payment_method, finance_provider, delivery_notes and submission attribution. Existing customer/client/opportunity links provide identity. Internal comments carry server-assigned author, team, timestamp and ID; clients cannot spoof these. Per-team unread counts and last-message IDs support notifications. Both backends read the same Delivery database, so no webhook delivery is required for this chat.

Mongoose's Delivery Client schema matches the retained compound date/site pagination indexes instead of recreating redundant single-field indexes on the storage-constrained shared cluster. No additional chat collection or chat indexes are introduced.

## Verification

- Isolated Node tests exercise validation, full Sold persistence, stable IDs, retries, concurrent submission rejection, cross-site rejection, internal-message attribution and canonical lead linkage. Existing backend regressions remain included.
- Delivery Centre API tests exercise shared handoff visibility, Sales message serialization, attributed Delivery replies, unread notifications, invalid/oversized messages, cross-site denial and race-guarded read markers. Historical tests that mutate production customer data are excluded.
- React interaction tests verify Delivery sees all five handoff fields, acknowledges the viewed message, sends a reply, preserves text after a failed send and links notifications to the correct profile.
- Both Next.js production builds include TypeScript checking. Existing CRM and Sales Floor web test suites are run. Synthetic-data browser checks exercise Overview, both Sold forms, the resulting handoff, chat and desktop/mobile layouts.
- Production smoke verification should create only uniquely identified temporary test records, exercise the two authenticated APIs against their shared database, then remove those exact records. Never send a customer SMS as part of internal-chat verification.

## Deployment

Deploy the Node backend and Delivery Centre backend before the matching frontends. Sales Floor backend/frontend/CRM are under `/var/www/sales-floor` on the existing Sales Floor host; Delivery Centre remains on its existing host under `/var/www/shaun-backend` and `/var/www/shaun-frontend`.

Build candidate frontends separately before switching the running release. Preserve environment files, local uploads and rollback builds. Restart only the affected PM2 applications and `byd-panel.service`. Verify public health, current static assets, handoff visibility and both chat directions after the switch. The prior database-cleanup proposal remains separate and requires its own approval.
