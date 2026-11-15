# Harmony CRM further updates

Companion to the Delivery Centre `shaun-backend` / `shaun-frontend` release and `byd-sales-crm-layer`.

- `GET /api/crm/post-delivery-followups` exposes due day-3 reminders from the shared Delivery database. Salespeople see their own tasks; managers see their permitted team/site tasks. Site selection and existing platform permissions remain enforced.
- `POST /api/crm/post-delivery-followups/:id/complete` requires call notes, a call outcome and a text action. Completion and retry projection use the persisted winner, with deterministic customer timeline/comment identities.
- To Delivery accepts an explicit `vin_tba: true`. This records `TBA`, clears stock/order associations and does not invent a factory-order VIN.
- When inventory is selected, the server loads the authoritative VIN, verifies the dealership, rejects sold/withdrawn/missing-VIN stock and another deal's active hold, and persists make/model for the Delivery SMS placeholders.
- Inventory search is literal, supports VIN/stock/model queries and retains server pagination. The picker also serves the inline Delivery-tab handoff.

Deploy this API and the Delivery backend before their frontends. No customer SMS is issued by the reminder list/completion endpoints. Optional salesperson texts use the existing explicit manual send action.

## Sales Floor parity

Sales Floor-only accounts can use the same inventory search and reminder records through authenticated `/api/customer-delivery/inventory`, `GET /api/customer-delivery/post-delivery-followups` and `POST /api/customer-delivery/post-delivery-followups/:id/complete`. Site and salesperson restrictions remain enforced; a separate CRM grant is not required. Completion is shared across both applications and records the originating platform in the timeline. The existing Sold handoff endpoint accepts the authoritative inventory stock reference or explicit `vin_tba`.
