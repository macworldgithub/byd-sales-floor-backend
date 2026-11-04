# CRM user management

The **Users & Access** screen is available only to the authenticated `devs@omnisuiteai.com` account with the `super_admin` role. The API checks the current database account on every request; changing a browser role or JWT payload cannot grant administration rights.

`GET /api/admin/users` returns the combined panel and Lead Centre directory plus supported sites, platforms, and roles. `POST /api/admin/users` creates an account. `PATCH /api/admin/users/:id` saves a complete account form and optionally resets its password. `DELETE /api/admin/users/:id` disables and soft-deletes the account in both stores. Deleted accounts are shown by the screen's Deleted users filter and can be restored by editing their access and enabling them. Business records, user IDs, and audit history are retained. The owner cannot be deleted or edited through these controls.

Account forms contain `name`, `email`, `role`, `site` (home site), `all_sites`, `allowed_sites`, `platform_access`, `network_lookup`, and `active`. Creation requires `password`; editing leaves it unchanged unless supplied. Passwords need at least eight characters and may occupy at most 72 UTF-8 bytes. Platform IDs are `crm`, `sales_floor`, `lead_centre`, and `delivery_centre`.

The panel and Lead Centre databases must be on the same MongoDB deployment, accessible through the panel connection. Account changes and the audit event run in one MongoDB transaction. Passwords are hashed with bcrypt, never returned or written to audit metadata. Each change increments `auth_version` in both stores, revoking existing sessions. Authentication checks activity, deletion, current platform grants, and session version against the database.

Accounts with several assigned sites work within one selected site at a time. Clients send `X-Site`; the backends validate it against the assigned sites and enforce that site on requests. Direct record URLs and linked CRM customer references are also checked. Unmanaged legacy accounts retain their existing access until edited; staffing-directory memberships do not grant access.

Deploy the CRM frontend, Sales Floor backend/frontend, Lead Centre backend/frontend, and Delivery Centre backend/frontend together to enable enforcement and site selection throughout the suite. No data migration or new package dependency is required. The Lead Centre's business API now requires authentication; its inbound and delivery-status callbacks keep their existing callback routes. Managed accounts must be edited through the CRM controls so changes remain atomic across both databases.
