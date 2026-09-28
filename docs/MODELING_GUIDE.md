# Shop Inventory Management — Operational SOP

**Document owner:** Development / Operations owner

**Applies to:** `Dev-India-Inventory-Management` and `Main-India-Inventory-Management`

**Repository role:** This is the development repository

**Last reviewed:** 2026-09-18

**Primary technical reference:** [Complete Project Documentation](./COMPLETE_PROJECT_DOCUMENTATION.md)
**Database reference:** [Database Schema Reference](./DATABASE_SCHEMA_REFERENCE.md)

---

## 1. Purpose and operating rule

This is the standard operating procedure (SOP) for running, changing, testing,
deploying, and recovering the Shop Inventory Management application.

**Non-negotiable rule:** Dev and Main are separate systems. A successful Dev
change is required before a Main release. Main must never be used for feature
experiments.

The application is one Node.js service: Express serves static pages and API
routes, validates requests, then stores permanent business data in PostgreSQL.

```text
Browser / Android WebView
        ↓ cookie-authenticated HTTPS requests
Node.js + Express (`server.js`)
        ↓ validation, permissions, transactions
PostgreSQL (`db.js` connection pool)
        ↓
Owner-scoped business tables
```

---

## 2. System inventory

| Area               | Dev                                       | Main / Production                               |
| ------------------ | ----------------------------------------- | ----------------------------------------------- |
| Railway project    | `Dev-India-Inventory-Management`          | `Main-India-Inventory-Management`               |
| Application source | Current development repository            | Separate main repository / approved branch      |
| PostgreSQL service | Dev Railway PostgreSQL                    | Main Railway PostgreSQL                         |
| Data               | Dummy/test owner and development data     | Real business/customer data                     |
| Permitted work     | Feature work, debugging, schema rehearsal | Approved release and urgent production fix only |

Both services may show the PostgreSQL database name `railway`. They are still
separate databases because they belong to separate Railway projects/services.
Always verify the Railway project and connection host before running SQL or
changing variables.

---

## 3. Roles and access boundaries

| Role                    | May do                                               | Must not do                                   |
| ----------------------- | ---------------------------------------------------- | --------------------------------------------- |
| Development owner       | Change Dev code, inspect Dev DB/logs, deploy Dev     | Experiment in Main or expose secrets          |
| Production owner        | Approve Main releases, manage Main backups/variables | Run unreviewed destructive SQL                |
| Shop owner              | Full control of own workspace                        | Share account/session access                  |
| Staff                   | Use assigned pages                                   | Delete owner-only records or cross-owner data |
| Developer support admin | Use support inbox                                    | Access business APIs as an owner              |

Every business table is owner-scoped. A client-supplied `user_id` must never be
trusted; the owner comes from the authenticated session.

---

## 4. Module map

| Module                  | Frontend                  | Backend               | Main tables                           | Critical rule                       |
| ----------------------- | ------------------------- | --------------------- | ------------------------------------- | ----------------------------------- |
| Accounts and staff      | `login.html`              | `routes/auth.js`      | `users`, `staff_accounts`, `settings` | HTTP-only cookie sessions only      |
| Purchases and suppliers | Dashboard                 | `routes/business.js`  | suppliers, purchases, lines, items    | Purchase + stock is one transaction |
| Stock, reports, due     | Dashboard                 | `routes/inventory.js` | items, sales, debts, serials          | Owner scope on every query          |
| Invoice and payment     | `invoice.html`            | `routes/invoices.js`  | invoices, lines, sales, debts         | Invoice reduces stock atomically    |
| Support                 | Dashboard/developer pages | `routes/support.js`   | support tables, developer admins      | Developer session remains separate  |
| Export and operations   | Dashboard/health pages    | exports/ops routes    | queue + DB summaries                  | Export jobs are owner-scoped        |

For exact APIs, columns, relationships, and route behavior, use the two
reference documents linked above. This document controls the operating process.

---

## 5. Daily operating checklist

### Start of day

1. Open Dev and Main Railway dashboards.
2. Confirm each service is running/healthy.
3. Open the following endpoints in each environment:

   ```text
   /live     — Node process responds
   /health   — PostgreSQL readiness is complete
   ```

4. For mobile/network reports, also open `/network-check` before changing code.
5. Review logs for repeated 5xx responses, DB connection failures, export
   failures, or startup errors.

### Before changing code

1. Write the intended outcome.
2. Identify the frontend page, API route, middleware, tables, reports, and
   permissions involved.
3. Decide whether money, stock, serial status, or a due ledger will change.
4. If business data changes, identify the transaction boundary and rollback
   outcome.
5. Make the change in Dev only.

### After changing Dev code

1. Check syntax for changed server-side files.
2. Deploy/restart Dev.
3. Confirm `/live` and `/health`.
4. Test the affected flow using Dev dummy data.
5. Check browser console, Network responses, Railway logs, and relevant DB rows.
6. Only then prepare a Main release.

---

## 6. Standard development procedure

### 6.1 Change classification

| Type                 | Examples                                  | Minimum verification                              |
| -------------------- | ----------------------------------------- | ------------------------------------------------- |
| UI-only              | Text, spacing, display                    | Desktop and mobile visual check                   |
| Read-only API/report | Search, filter, report field              | Owner scope, pagination, performance              |
| Auth/permission      | Login, staff access, Google OAuth         | Owner, allowed staff, blocked staff, logout/login |
| Transactional rule   | Purchase, invoice, payment, stock, serial | Positive path, invalid path, rollback path        |
| Schema/index         | New table, field, index, constraint       | Dev backup, SQL review, schema + app flow         |
| Deployment/security  | Railway variable, JWT, CSP, cache         | Dev deploy and relevant regression checks         |

### 6.2 Required change map

Create this note before a non-trivial change:

```text
Goal:
Frontend files:
Backend route/middleware:
Database tables/columns/indexes:
Owner/staff permission:
Transaction required: yes/no
Dev verification steps:
Rollback method:
```

### 6.3 Safe editing rules

1. Inspect existing code before editing; do not rewrite a large file for a small
   change.
2. Update UI validation and server validation together when input changes.
3. Keep SQL parameterized; never concatenate browser values into SQL.
4. Keep `getUserId(req)`/session owner scope on business queries.
5. Protect destructive actions with `requireOwner`.
6. Protect staff business features with `requirePermission(...)`.
7. Invalidate/refresh affected cache/report data after writes.
8. Update technical documentation for schema, behavior, or variable changes.

---

## 7. Business-data SOP

### 7.1 Purchase and stock-in

```text
Supplier → purchase header → purchase lines → item stock update → optional serial rows
```

Before approving a purchase change, verify:

- supplier is created/used under the authenticated owner;
- bill total, paid, and due values are valid;
- each line has valid quantity and rates;
- item quantity rises correctly;
- serialized items have one serial per whole-number unit when required;
- duplicate owner serials are rejected;
- a failure rolls back bill, stock, and serial changes together.

Do not add an independent stock-add workflow. Stock creation/replenishment must
continue through `POST /api/purchases`.

### 7.2 Invoice, sale, and due collection

```text
Invoice header → invoice lines → stock reduction → sales rows → serial status → debt ledger if due
```

Before approving an invoice change, verify:

- invoice totals are calculated on the server;
- stock cannot become negative;
- selected serials are owner-scoped, in stock, and protected from double sale;
- sales rows, invoice lines, and item quantity stay consistent;
- due invoices create/resync the debt ledger correctly;
- payment collection updates both invoice and ledger;
- PDF values match saved invoice values.

### 7.3 Deletion and rollback actions

1. Confirm owner-only UI and backend protection.
2. Check foreign-key/dependency behavior.
3. Confirm stock rollback cannot create invalid quantity.
4. Confirm sold serials block invalid purchase reversal.
5. Confirm debt/invoice totals resync after related deletion.
6. Test only with Dev dummy data before any Main action.

---

## 8. Authentication and security SOP

### Session and token rules

- Use HTTP-only cookies; do not store readable sessions in local storage.
- New owner/staff sessions, developer sessions, Google OAuth state, onboarding,
  and Android transfer tokens carry a distinct JWT purpose, issuer, and audience.
- `JWT_CLAIMS_ENFORCEMENT` is `compat` during rollout. After the three-day
  legacy session window, set `strict` in Dev, verify login flows, then set it in
  Main.
- Never expose JWTs, cookies, passwords, database URLs, or mail keys in logs,
  screenshots, commits, or chat.

### Railway variable procedure

Keep secrets separately in Dev and Main Railway Variables:

```text
DATABASE_URL
JWT_SECRET
BASE_URL
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
MAIL_RELAY_URL / MAIL_RELAY_KEY
DEVELOPER_REGISTRATION_KEY
```

For a variable/security change:

1. Change Dev first.
2. Deploy/restart and test the impacted flow.
3. Record the reason and verification result.
4. Copy to Main only after approval.
5. Never exchange Dev and Main database URLs.

### Monthly access review

1. Review active staff accounts and their permissions.
2. Disable/delete accounts no longer required.
3. Review active developer-support accounts.
4. Rotate any leaked or compromised secret immediately.

---

## 9. Database and index SOP

### Source of truth

- Fresh schema: `migrations/full_updated_schema.sql`
- Existing-db compatibility: `db.js`
- Table/relationship detail: `DATABASE_SCHEMA_REFERENCE.md`

`db.js` contains compatibility statements, not a migration-history system.
Treat every schema change as a reviewed operational release.

### Schema-change procedure

1. Identify affected tables, foreign keys, indexes, payloads, reports, and PDFs.
2. Take/confirm a Dev backup or snapshot.
3. Update the full schema file for fresh environments.
4. Prepare a reviewed incremental SQL change for the existing Dev DB.
5. Apply in Dev, inspect schema, then test read/write paths.
6. Before Main, confirm a Main backup and a rollback plan.

### Index procedure

Indexes already support frequent owner-scoped lookup, reports, invoice/customer
search, supplier history, serial lookup, and support queues. Add an index only
after checking a real query:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT ...;
```

To inspect usage:

```sql
SELECT relname AS table_name, indexrelname AS index_name, idx_scan AS times_used
FROM pg_stat_user_indexes
ORDER BY idx_scan DESC, relname, indexrelname;
```

Do not delete a zero-use index based on one report. Stats reset on restart, and
small tables can correctly use sequential scans.

### Database safety rules

- Never run unreviewed `DELETE`, `UPDATE`, `DROP`, or `TRUNCATE` in Main.
- Use a transaction for exploratory write SQL and inspect before `COMMIT`.
- Never copy Main credentials, dumps, or customer data into Dev without approval.
- PDF/Excel exports are not backups.
- Test restores in an isolated database before relying on backups.

---

## 10. Release SOP: Dev to Main

### Dev release gate

Complete each applicable item:

- [ ] Code was reviewed/read through.
- [ ] Changed server files pass syntax checks.
- [ ] Dev Railway deployment is healthy.
- [ ] `/live` and `/health` return expected responses.
- [ ] Affected owner flow passes with Dev data.
- [ ] Relevant staff allow/deny cases pass.
- [ ] Browser console and Railway logs have no unexpected errors.
- [ ] Stock, invoice, due, serial, or supplier balances are checked when relevant.
- [ ] Documentation and variables are updated.
- [ ] Rollback action is known.

### Main deployment

1. Confirm Dev passed the release gate.
2. Confirm the selected Railway project/database is Main.
3. Take/confirm a backup before schema or high-risk business changes.
4. Move only the approved change to the Main repository/branch.
5. Deploy through the normal Railway/GitHub workflow.
6. Monitor deployment logs until the service is healthy.
7. Check `/live`, `/health`, login, and the changed workflow.
8. Monitor Main logs during the initial operating period.
9. Record deployment time, change, variables, schema action, and rollback point.

### Rollback

1. Stop further change activity and capture logs/request IDs.
2. For application-only errors, redeploy the last known-good Main commit.
3. For schema/data errors, do not blindly restore over Main; use the reviewed
   rollback plan or first restore into isolation.
4. Recheck health, authentication, and the affected workflow afterward.

---

## 11. Incident response SOP

| Symptom                           | First checks                                     | Safe response                                    |
| --------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| `/live` fails                     | Railway status/deployment/logs                   | Restart or redeploy last known-good service      |
| `/live` works but `/health` fails | PostgreSQL service, `DATABASE_URL`, startup logs | Fix DB connectivity; do not alter business data  |
| One mobile network fails          | `/network-check`, domain/DNS/SSL path            | Investigate network/DNS before changing API code |
| Repeated `503`                    | DB pool waiting count, slow queries              | Reduce load and investigate DB pressure          |
| Export fails                      | Job status/route logs                            | Diagnose; never expose another owner's export    |

### Wrong stock, invoice, or due balance

1. Do not manually edit several related tables first.
2. Record owner, transaction number, timestamp, and exact wrong value.
3. Review header, lines, stock, sales, serials, and debts together.
4. Reproduce with Dev dummy data if possible.
5. Prepare one reviewed corrective transaction or application fix.
6. Back up/record affected Main rows before correction.
7. Verify totals and reports after correction.

### Suspected session/credential compromise

1. Rotate the affected password/secret immediately.
2. Rotating `JWT_SECRET` logs every session out; plan and announce this.
3. Disable suspicious staff/developer accounts.
4. Review logs without copying secret values into an incident note.

---

## 12. Cache, mobile, and browser SOP

The service worker is a cleanup/rollback worker; it intentionally does not
serve business API data from offline cache.

For stale UI/cache reports:

1. Load a normal app page once so the cleanup helper runs.
2. Use `/cache-repair` only through the normal app flow or directed diagnosis.
3. Change `APP_CACHE_VERSION` only for an explicit cache-repair rollout.
4. Test Chrome desktop, Android Chrome, and Android WebView after login,
   service-worker, camera, dropdown, or upload changes.

Serial scanning must always retain manual entry as a fallback. Test camera
allowed and denied paths when scanner code changes.

---

## 13. Manual regression checklist

Run the relevant subset after each meaningful Dev release:

1. Owner register/login/logout and current-session check.
2. Staff login with one permitted and one blocked page.
3. Google login/onboarding if OAuth changed.
4. Create supplier and purchase; verify stock rises.
5. Add serials and reject a duplicate serial.
6. Create paid invoice; verify stock and sale movement.
7. Create due invoice, collect payment, and verify ledger.
8. Verify guarded delete/rollback behavior using Dev dummy data.
9. Load stock, sales, GST, purchase, due, and expense reports.
10. Download an invoice PDF and a report export.
11. Send/reply to support if support changed.
12. Check `/live`, `/health`, and `/network-check`.

---

## 14. Change and incident record templates

### Change record

```text
Date/time:
Environment: Dev / Main
Goal:
Files/routes/tables changed:
Environment variables changed:
Schema/index change:
Dev verification completed:
Main approval:
Rollback plan:
Deployed by:
```

### Incident record

```text
Date/time:
Environment:
User-visible symptom:
Affected owner/module/record reference:
Health status: /live, /health
Railway request ID/log summary:
Immediate containment:
Root cause:
Correction:
Verification:
Follow-up prevention:
```

---

## 15. Quick decision guide

```text
UI change?
  → Update page + browser JS; verify responsive/mobile behavior.

Business-rule change?
  → Update UI validation + route validation + transaction behavior.

New field/table/index?
  → Update schema + compatibility plan + route/UI/docs; rehearse in Dev.

Security/variable change?
  → Apply in Dev Railway, verify, document, then apply in Main.

Production data fix?
  → Investigate + back up + use reviewed transaction; never improvise broad SQL.

Main deployment?
  → Pass Dev release gate, confirm project/database, deploy, monitor health/logs.
```

---

## 16. Reference hierarchy

When information differs, use this priority:

1. Current application code and deployed Railway configuration.
2. `migrations/full_updated_schema.sql` for a fresh schema.
3. `db.js` for compatibility behavior on an existing database.
4. `COMPLETE_PROJECT_DOCUMENTATION.md` for technical implementation detail.
5. `DATABASE_SCHEMA_REFERENCE.md` for table/relationship detail.
6. This SOP for operating process and release discipline.

Update this SOP when deployment paths, high-risk workflows, security controls,
environment variables, or recovery procedures change.
