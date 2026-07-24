# Shop Inventory Management Documentation

Last verified against the web repository and linked Android wrapper: `2026-07-23`

Verification baseline:

- web repository HEAD: `8484172`
- Android wrapper build snapshot: `versionName 1.2.40`, `versionCode 43`
- active Express router declarations: `84`
- effective PostgreSQL tables: `17`

This is the single merged documentation file for the project. It replaces the earlier split project doc and database schema doc.

Scope note: [`USER_RELATED_DATA_QUERY_GUIDE.md`](./USER_RELATED_DATA_QUERY_GUIDE.md) remains a separate query aid, not the schema source of truth. At this verification baseline it does not yet include `item_serials` or the latest bank/UPI settings fields; use this document, the SQL snapshot, and runtime compatibility code for the complete current model.

## Table Of Contents

- [1. Purpose](#1-purpose)
- [2. Project Snapshot](#2-project-snapshot)
- [3. Technology Stack](#3-technology-stack)
  - [Backend](#backend)
  - [Deployment and runtime](#deployment-and-runtime)
  - [Local setup and verification](#local-setup-and-verification)
  - [Frontend](#frontend)
  - [Data and schema](#data-and-schema)
- [4. Repository Map](#4-repository-map)
  - [Key backend files](#key-backend-files)
  - [Key frontend files](#key-frontend-files)
- [5. High-Level Architecture](#5-high-level-architecture)
  - [Request flow in practice](#request-flow-in-practice)
- [6. Frontend Structure](#6-frontend-structure)
  - [Page responsibilities](#page-responsibilities)
  - [Shared frontend module roles](#shared-frontend-module-roles)
  - [Mobile dropdown and serialized-item UI behavior](#mobile-dropdown-and-serialized-item-ui-behavior)
  - [Service-worker rollback and network behavior](#service-worker-rollback-and-network-behavior)
  - [Frontend storage usage](#frontend-storage-usage)
- [7. Backend Structure](#7-backend-structure)
  - [`server.js`](#serverjs)
  - [`db.js`](#dbjs)
  - [`middleware/cache.js`](#middlewarecachejs)
  - [`middleware/export-queue.js`](#middlewareexport-queuejs)
  - [`middleware/auth.js`](#middlewareauthjs)
  - [`utils/concurrency.js`](#utilsconcurrencyjs)
  - [`utils/runtime-log.js`](#utilsruntime-logjs)
  - [Runtime support utilities](#runtime-support-utilities)
  - [Function catalogue](#function-catalogue)
    - [`server.js` function inventory](#serverjs-function-inventory)
    - [`db.js` function inventory](#dbjs-function-inventory)
    - [`middleware/auth.js` function inventory](#middlewareauthjs-function-inventory)
    - [`middleware/cache.js` function inventory](#middlewarecachejs-function-inventory)
    - [`middleware/export-queue.js` function inventory](#middlewareexport-queuejs-function-inventory)
    - [`routes/auth.js` function inventory](#routesauthjs-function-inventory)
    - [`routes/inventory.js` function inventory](#routesinventoryjs-function-inventory)
    - [`routes/business.js` function inventory](#routesbusinessjs-function-inventory)
    - [`routes/invoices.js` function inventory](#routesinvoicesjs-function-inventory)
    - [`routes/support.js` function inventory](#routessupportjs-function-inventory)
    - [`routes/exports.js` function inventory](#routesexportsjs-function-inventory)
    - [`routes/ops.js` function inventory](#routesopsjs-function-inventory)
    - [`repositories/ops-repository.js` function inventory](#repositoriesops-repositoryjs-function-inventory)
    - [`utils/cache.js` function inventory](#utilscachejs-function-inventory)
    - [`utils/export-queue.js` function inventory](#utilsexport-queuejs-function-inventory)
    - [`utils/monitoring.js` function inventory](#utilsmonitoringjs-function-inventory)
    - [`utils/background-jobs.js` function inventory](#utilsbackground-jobsjs-function-inventory)
    - [`utils/pagination.js` function inventory](#utilspaginationjs-function-inventory)
    - [`public/js/service-worker-register.js` function inventory](#publicjsservice-worker-registerjs-function-inventory)
    - [`public/service-worker.js` function inventory](#publicservice-workerjs-function-inventory)
    - [`public/js/permission-contract.js` function inventory](#publicjspermission-contractjs-function-inventory)
    - [`public/js/app-core.js` function inventory](#publicjsapp-corejs-function-inventory)
    - [`public/js/app-shell.js` function inventory](#publicjsapp-shelljs-function-inventory)
    - [`public/js/dashboard.js` workflow map](#publicjsdashboardjs-workflow-map)
    - [`public/invoice.html` inline controller workflow map](#publicinvoicehtml-inline-controller-workflow-map)
    - [Developer support frontend workflow map](#developer-support-frontend-workflow-map)
- [8. Auth, Session, and Permission Model](#8-auth-session-and-permission-model)
  - [Session model](#session-model)
  - [Google OAuth owner flow](#google-oauth-owner-flow)
  - [Developer support session model](#developer-support-session-model)
  - [Client bootstrap](#client-bootstrap)
  - [Staff permission model](#staff-permission-model)
- [9. Security and Runtime Guardrails](#9-security-and-runtime-guardrails)
  - [Known implementation caveats](#known-implementation-caveats)
- [10. Main Business Workflows](#10-main-business-workflows)
  - [Owner registration](#owner-registration)
  - [Owner login](#owner-login)
  - [Google owner sign-in](#google-owner-sign-in)
  - [Staff login](#staff-login)
  - [Purchase Entry / Add Stock](#purchase-entry--add-stock)
  - [Serialized-item lifecycle](#serialized-item-lifecycle)
  - [Supplier ledger and purchase bill views](#supplier-ledger-and-purchase-bill-views)
  - [Product purchase history](#product-purchase-history)
  - [Invoice creation](#invoice-creation)
  - [Invoice due settlement](#invoice-due-settlement)
  - [Customer due management](#customer-due-management)
  - [Supplier repayment](#supplier-repayment)
  - [Reports and exports](#reports-and-exports)
  - [Ops metrics and cleanup](#ops-metrics-and-cleanup)
  - [Support chat flow](#support-chat-flow)
  - [Developer support inbox flow](#developer-support-inbox-flow)
- [11. API Route Map](#11-api-route-map)
  - [11.1 Auth routes from `routes/auth.js`](#111-auth-routes-from-routesauthjs)
  - [11.2 Inventory routes from `routes/inventory.js`](#112-inventory-routes-from-routesinventoryjs)
  - [11.3 Business routes from `routes/business.js`](#113-business-routes-from-routesbusinessjs)
  - [11.4 Invoice routes from `routes/invoices.js`](#114-invoice-routes-from-routesinvoicesjs)
  - [11.5 Support routes from `routes/support.js`](#115-support-routes-from-routessupportjs)
  - [11.6 Export routes from `routes/exports.js`](#116-export-routes-from-routesexportsjs)
  - [11.7 Ops routes from `routes/ops.js`](#117-ops-routes-from-routesopsjs)
  - [11.8 Health routes from `server.js`](#118-health-routes-from-serverjs)
  - [11.9 Network diagnostic route from `server.js`](#119-network-diagnostic-route-from-serverjs)
  - [11.10 Conditional debug routes from `server.js`](#1110-conditional-debug-routes-from-serverjs)
- [12. Database Schema](#12-database-schema)
  - [12.1 Schema source of truth](#121-schema-source-of-truth)
  - [12.2 Ownership model](#122-ownership-model)
  - [12.3 ER diagram](#123-er-diagram)
  - [12.4 Table summary](#124-table-summary)
  - [12.5 Detailed table guide](#125-detailed-table-guide)
    - [`users`](#users)
    - [`staff_accounts`](#staff_accounts)
    - [`developer_admins`](#developer_admins)
    - [`support_conversations`](#support_conversations)
    - [`support_messages`](#support_messages)
    - [`settings`](#settings)
    - [`items`](#items)
    - [`sales`](#sales)
    - [`debts`](#debts)
    - [`suppliers`](#suppliers)
    - [`purchases`](#purchases)
    - [`purchase_items`](#purchase_items)
    - [`expenses`](#expenses)
    - [`invoices`](#invoices)
    - [`invoice_items`](#invoice_items)
    - [`item_serials`](#item_serials)
    - [`user_invoice_counter`](#user_invoice_counter)
  - [12.6 Full table dictionary](#126-full-table-dictionary)
  - [12.7 Relationship notes and data flow](#127-relationship-notes-and-data-flow)
    - [Direct foreign keys](#direct-foreign-keys)
    - [Important indirect relationships](#important-indirect-relationships)
    - [Main business data flows](#main-business-data-flows)
  - [12.8 Indexes, triggers, and compatibility behavior](#128-indexes-triggers-and-compatibility-behavior)
- [13. Environment Variables](#13-environment-variables)
- [14. Maintenance Guide](#14-maintenance-guide)
  - [Login, reset password, or session behavior](#if-you-want-to-change-login-reset-password-or-session-behavior)
  - [Login banners](#if-you-want-to-change-login-banners)
  - [Shared navigation or permission names](#if-you-want-to-change-shared-navigation-or-permission-names)
  - [Dashboard stock, purchase, report, due, or expense features](#if-you-want-to-change-dashboard-stock-purchase-report-due-or-expense-features)
  - [Play Store, Android install, or browser install behavior](#if-you-want-to-change-play-store-android-install-or-browser-install-behavior)
  - [Invoice flow or PDF output](#if-you-want-to-change-invoice-flow-or-pdf-output)
  - [Support chat or developer portal behavior](#if-you-want-to-change-support-chat-or-developer-portal-behavior)
  - [Database schema](#if-you-want-to-change-database-schema)
  - [Database backup or restore behavior](#if-you-want-to-change-database-backup-or-restore-behavior)
  - [Deployment healthchecks or runtime logging](#if-you-want-to-change-deployment-healthchecks-or-runtime-logging)
  - [Caching, pagination, or queued exports](#if-you-want-to-change-caching-pagination-or-queued-exports)
  - [Owner ops metrics](#if-you-want-to-change-owner-ops-metrics)
- [15. Detailed Architecture Diagram](#15-detailed-architecture-diagram)
  - [Android App Architecture](#android-app-architecture)
- [16. Final Summary](#16-final-summary)

## 1. Purpose

This document is meant to be the current source of truth for:

- what the project does
- how the frontend, backend, and database are organized
- which APIs exist
- which database tables exist and how they relate
- which shared functions, middleware helpers, and runtime primitives exist
- which files to edit for common future changes

Important current-state notes:

- Authentication is cookie-based. The frontend uses `credentials: "include"` and bootstraps sessions through `/api/auth/me`.
- Owner auth now supports password login, staff login, and Google OAuth. Google sign-in has web callbacks, Android deep-link transfer, and a first-time onboarding step that collects shop name and mobile number.
- Developer support authentication is also cookie-based through `/api/developer-auth/*`; the browser no longer stores a readable developer JWT in session storage.
- `localStorage` is still used for UI state and invoice draft storage, but not as the primary auth token store.
- HTML pages are served through [`server.js`](../server.js), which injects a CSP nonce into inline scripts and styles.
- [`server.js`](../server.js) still injects CDN preconnect hints and [`../public/js/service-worker-register.js`](../public/js/service-worker-register.js), but that helper now removes older service-worker registrations and runtime caches instead of installing the low-network app-shell cache.
- [`../public/service-worker.js`](../public/service-worker.js) is currently a rollback worker: it clears old `shop-inventory-runtime-*` / `inventory-runtime-*` caches, unregisters itself, and does not intercept fetches.
- Database schema truth comes from the SQL files in [`migrations/`](../migrations) plus runtime compatibility patches in [`db.js`](../db.js).
- The app now includes an owner/staff support chat plus dedicated developer support login and inbox pages backed by [`../routes/support.js`](../routes/support.js).
- Runtime health and readiness handlers are registered for `/health`, `/api/health`, `/healthz`, `/api/healthz`, `/ready`, `/api/ready`, `/readyz`, `/api/readyz`, `/live`, `/api/live`, `/livez`, and `/api/livez`. Because the `/api` routers are mounted first, only the non-API aliases are reliable public probes in the current route order; see [Section 11.8](#118-health-routes-from-serverjs).
- [`server.js`](../server.js) also serves `/network-check` and `/network-check.html`, a no-store first-party diagnostic page for checking whether a client can reach `/live`, `/health`, and `/api/live` without relying on CDN assets or service-worker cached navigation.
- Owner-only ops endpoints now expose in-process metrics, DB overview, response-cache stats, export-queue stats, and background-job status through [`../routes/ops.js`](../routes/ops.js).
- PDF/Excel export requests can run asynchronously when the frontend adds `_async_export=1`; jobs are stored in the in-memory export queue and downloaded through [`../routes/exports.js`](../routes/exports.js).
- Frequently read JSON endpoints now use short owner-scoped response caching and pagination metadata helpers where list size can grow.
- Structured runtime logs now redact password, token, authorization, cookie, and access-key fields before emitting JSON.
- Deployment healthcheck and start-command defaults are now pinned in [`../railway.json`](../railway.json), and lifecycle/request logging is centralized through [`../utils/runtime-log.js`](../utils/runtime-log.js).
- The standalone Add New Stock page and `POST /api/items` handler are absent from the active code. Stock intake now happens through Purchase Entry; only an obsolete `add_stock` permission comment and a dead `addStockSection` sidebar check remain as cleanup candidates.
- Purchase Entry is now the canonical "Purchase Entry / Add Stock" workflow. It includes supplier autocomplete, bill-wise supplier search, product-wise purchase history, supplier detail autofill, default profit margin handling, and stock updates from saved purchase bills.
- Purchase rows optionally capture one serial/SN per whole-number unit through manual entry or camera barcode/QR scanning. Saved serials are owner-unique, linked to their purchase/item records, and move from `in_stock` to `sold` during invoice creation.
- Supplier ledger detail rows are shown newest-to-oldest, matching Bill View ordering.
- Supplier Ledger "View All" always clears the current supplier search and loads the full supplier balance summary.
- Purchase Desk now has owner-only 3-dot delete actions for supplier ledgers, purchase bills, and purchase bill items. These actions are hidden from staff and protected by `requireOwner` on the backend.
- Customer due ledgers and customer ledger PDFs show recent transactions first while preserving correct running-balance calculation.
- Customer Due now captures optional customer address, uses name/number autocomplete that can fill address, shows saved address under customer names in ledger summaries, and prints mobile number plus address in the customer ledger PDF details block.
- Customer due summary and detail rows now have owner-only 3-dot delete actions for full customer ledgers and individual ledger transactions. Invoice-linked debt deletes resync the linked invoice paid/due state.
- The shared sidebar now includes a refresh icon beside the app title; it reloads the current page while preserving the active dashboard section through `localStorage.activeSection`.
- Login page Android install now points to the Play Store listing (`india.inventory.management`) instead of the old GitHub APK release link. `site.webmanifest` remains available for browser/PWA install prompts.
- The Android wrapper project at `C:\Users\Dipayan\AndroidStudioProjects\IndiaInventoryManagement` is the native shell used for Play Store releases. Because the web service worker is currently rolled back, browser/PWA/WebView traffic should go directly to the network instead of using the previous app-shell cache layer.
- Sale and Invoice now includes customer autocomplete in the Billing details card. The inline invoice controller calls `/api/invoices/customers`, then fills customer name, contact, and address when an existing customer is selected.
- Invoice rows expose a `Sale %` pricing helper. Selecting an inventory item loads its current buying rate, changing Sale % recalculates the selling rate, changing the rate recalculates Sale %, and both helper values remain draft-only rather than becoming invoice API/schema fields.
- Invoice serial inputs can search or scan in-stock serials through `/api/item-serials`; a selected serial supplies its saved sale rate and is validated again transactionally by the backend.
- Long dashboard and invoice dropdowns use mobile scroll guards, click-based selection, and delayed blur hiding so a swipe/scroll does not accidentally select or close an entry.
- The login-page banner carousel is generated from numbered files under `public/images/`, supports keyboard/touch/autoplay behavior, and currently has nine images.
- Invoice shop profile now stores bank account and UPI payment details. Invoice PDFs print saved payment rows and generate a UPI QR block when `upi_id` is available.
- The API layer now applies DB-pool backpressure protection before mounted `/api` route handlers when the PostgreSQL waiting queue reaches `DB_POOL_WAITING_REJECT_THRESHOLD`.

## 2. Project Snapshot

This is a Node.js + Express + PostgreSQL business app for a shop owner.

Main business modules:

- owner registration and login
- Google owner sign-in with shop-profile onboarding for new Google accounts
- staff login with page-level permissions
- owner/staff support chat with a developer inbox
- developer support account registration and login
- purchase entry that also adds/updates stock through supplier bills
- optional serial/SN capture on purchase rows and serialized-unit lookup during billing
- purchase defaults, supplier ledger, supplier repayment tracking, and owner-only purchase deletion with stock rollback
- product-wise purchase history from saved purchase item rows
- sales invoice creation with Sale % assistance, serial selection/scanning, and PDF generation
- invoice history, due settlement, and payment collection
- invoice customer lookup/autofill from existing saved invoices
- shop profile bank/UPI payment details printed on invoice PDFs
- customer due ledger with owner-only ledger/transaction delete controls
- sales, stock, and GST reports
- queued PDF/Excel export delivery for long-running downloads
- owner-only ops metrics and background cleanup status
- expense tracking and net profit visibility
- Play Store Android app access plus browser PWA install metadata, service-worker rollback cleanup, and first-party network diagnostics

Current feature and benefit map:

| Module                     | Current capability                                                                                                                                              | User benefit                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Purchase Entry / Add Stock | Supplier bill entry creates purchase rows, updates item stock/rates, and optionally registers one serial/SN per whole-number unit                               | Inventory and serialized units stay in sync with purchase bills              |
| Supplier Ledger            | Supplier-wise purchases, paid/due totals, repayment capture, newest-first bill history, and owner-only supplier/bill/item deletion                              | Owners can track and clean purchase ledger data safely                       |
| Sale Entry / Invoice       | Invoice creation, Sale %/rate assistance, item and in-stock serial lookup/scan, GST calculation, customer autocomplete, settlement, UPI QR, and PDF             | Faster billing with unit-level serialized-stock control                      |
| Stock View / Report        | Item quantity, buying/selling rates, sold quantity, low-stock, reorder, and slow-moving views                                                                   | Owners can see current inventory health and reorder needs                    |
| Sales View / Report        | Date-wise sales, net-profit card, trend charts, PDF, and Excel                                                                                                  | Sales performance can be reviewed by period                                  |
| GST Report                 | GST row report, monthly comparison, PDF, and Excel                                                                                                              | Tax data is ready for checking and filing                                    |
| Customer Due               | Customer ledger entries with optional address, name/number autocomplete, address-aware due summary, newest-first timeline, PDF, and owner-only delete actions   | Collections become easier to track, share, and correct                       |
| Expenses                   | Expense entry, suggestions, report, and summary                                                                                                                 | Real net profit is clearer because costs are recorded                        |
| Staff Access               | Owner-managed page permissions for staff accounts                                                                                                               | Staff can work only in the modules they are assigned                         |
| Support Chat               | Owner/staff support thread plus developer inbox                                                                                                                 | Support conversations stay tied to the right owner workspace                 |
| Mobile / Android Access    | Responsive web UI, Play Store wrapper, Android Google transfer, PWA manifest, service-worker rollback cleanup, WebView access, and `/network-check` diagnostics | Users can work from phones through browser, installed PWA, or Play Store app |

The system is owner-centric:

- the `users` table stores the real business owner
- `staff_accounts` work under that owner
- almost all business data is stored against `user_id`
- staff actions operate inside the owner's data scope

## 3. Technology Stack

### Backend

- Node.js 18+
- Express
- PostgreSQL via `pg`
- JWT via `jsonwebtoken`
- `bcrypt` for password hashing
- `helmet`, `cors`, `cookie-parser`, `compression`, `express-rate-limit`
- optional `MAIL_RELAY_URL` / `MAIL_RELAY_KEY` reset-email relay, called with Node `fetch`
- `nodemailer` is installed but not imported by the current code; password-reset delivery uses the HTTP relay above
- `pdfkit` for PDF generation
- `exceljs` for Excel export
- native `fetch` from Node 18+ for Google OAuth calls and internal queued-export downloads

### Deployment and runtime

- Railway config-as-code via [`../railway.json`](../railway.json)
- structured JSON lifecycle logging via [`../utils/runtime-log.js`](../utils/runtime-log.js)
- health/readiness/liveness endpoints emitted by [`../server.js`](../server.js)
- owner-only monitoring and background-job status via [`../routes/ops.js`](../routes/ops.js)
- short-lived in-memory response cache and export queue helpers via [`../utils/cache.js`](../utils/cache.js) and [`../utils/export-queue.js`](../utils/export-queue.js)
- current Railway defaults in repo:
  - start command: `node --max-old-space-size=256 server.js`
  - healthcheck path: `/health`
  - healthcheck timeout: `120`
  - restart policy: `ON_FAILURE`
  - max restart retries: `10`

### Local setup and verification

Prerequisites:

- Node.js 18 or newer
- PostgreSQL and a database the application can own
- `psql` or an equivalent SQL client for first-time schema installation

The repository does not load `.env` files and does not include `.env.example`; set variables in the shell, process manager, or deployment platform. For a fresh local database, apply the full SQL snapshot before starting the app. The startup compatibility patch begins with `ALTER TABLE` statements and cannot bootstrap an empty database by itself.

PowerShell example:

```powershell
npm ci
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@localhost:5432/inventory_db'
$env:JWT_SECRET = '<long-random-secret>'
$env:PORT = '4000'
$env:BASE_URL = 'http://localhost:4000'
psql $env:DATABASE_URL -f .\migrations\full_updated_schema.sql
npm start
```

Use port `4000` when opening the app on a `localhost` hostname: [`public/js/app-core.js`](../public/js/app-core.js) intentionally maps localhost API calls to `http://localhost:4000/api`. Using `http://127.0.0.1:8080` keeps same-origin `/api` behavior and can use the server's default port instead.

Basic runtime checks:

```powershell
Invoke-RestMethod http://localhost:4000/live
Invoke-RestMethod http://localhost:4000/health
```

- `/live` proves the HTTP process is responding.
- `/health` returns `200` only after PostgreSQL initialization and compatibility patching complete; it returns `503` while not ready.
- the HTTP listener starts before `pool.readyPromise` settles, so liveness can succeed before readiness.
- only `npm start` is defined. There is no repository test, lint, frontend build, or migration-runner script; browser workflows and inline HTML controllers require manual or separately configured E2E verification.
- PostgreSQL is the durable store. Response-cache entries, rate-limit counters, metrics, Android OAuth callback state, and queued export buffers are process-local and disappear on restart.
- no backup/restore/PITR automation exists in this repository. Configure provider/operator backups separately and test restores; PDF/Excel exports are not database backups.

### Frontend

- static HTML pages in [`public/`](../public)
- vanilla JavaScript
- shared page configuration in [`public/js/app-core.js`](../public/js/app-core.js)
- shared sidebar shell in [`public/js/app-shell.js`](../public/js/app-shell.js)
- permission contract in [`public/js/permission-contract.js`](../public/js/permission-contract.js)
- service-worker cleanup in [`public/js/service-worker-register.js`](../public/js/service-worker-register.js)
- service-worker rollback in [`public/service-worker.js`](../public/service-worker.js)
- generated `/network-check` page from [`server.js`](../server.js) for first-party reachability checks
- charts via vendored [`public/js/chart.min.js`](../public/js/chart.min.js)
- invoice payment profile fields for bank name, account holder, account number, IFSC, and UPI ID live in [`public/invoice.html`](../public/invoice.html)

### Data and schema

- SQL schema snapshots in [`migrations/full_updated_schema.sql`](../migrations/full_updated_schema.sql)
- startup compatibility patching in [`db.js`](../db.js)
- the repository currently has one transactional full-schema snapshot, no migration ledger/runner, and no incremental migration history
- future incremental SQL migrations belong in [`migrations/`](../migrations) when schema changes need to be tracked separately

## 4. Repository Map

| Path                                  | Purpose                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`../server.js`](../server.js)        | app bootstrap, middleware, request logging, maintenance mode, login-banner injection, health/readiness routes, network diagnostics, and HTML serving |
| [`../db.js`](../db.js)                | PostgreSQL pool setup, timeout tuning, readiness state, and schema compatibility patches                                                             |
| [`../railway.json`](../railway.json)  | Railway deployment config: start command, healthcheck path, timeout, restart policy                                                                  |
| [`../middleware/`](../middleware)     | auth and access control middleware                                                                                                                   |
| [`../routes/`](../routes)             | route files grouped by business domain                                                                                                               |
| [`../repositories/`](../repositories) | small DB reader modules used by operational endpoints                                                                                                |
| [`../public/`](../public)             | HTML pages, frontend JS, images, PWA manifest, and service worker                                                                                    |
| [`../utils/`](../utils)               | shared backend helpers such as advisory locking, caching, export jobs, metrics, and structured logging                                               |
| [`../migrations/`](../migrations)     | current transactional full-schema snapshot; no versioned migration runner/history exists                                                             |
| [`../docs/`](.)                       | project documentation, including this merged file and the detailed flow chart                                                                        |

### Key backend files

| File                                                                     | Role                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`../server.js`](../server.js)                                           | Express entrypoint, maintenance responses, login-banner injection, request logging, CSP nonce/bootstrap injection, CORS, backpressure, health/diagnostic routes, static serving |
| [`../db.js`](../db.js)                                                   | DB connection pool, readiness state, SSL selection, startup schema patching, pool timeout/query timeout tuning                                                                  |
| [`../middleware/auth.js`](../middleware/auth.js)                         | JWT verification, role resolution, permission checks                                                                                                                            |
| [`../middleware/cache.js`](../middleware/cache.js)                       | owner-scoped short TTL JSON response cache middleware                                                                                                                           |
| [`../middleware/export-queue.js`](../middleware/export-queue.js)         | async export middleware for queued PDF/Excel downloads                                                                                                                          |
| [`../routes/auth.js`](../routes/auth.js)                                 | register/login/logout, Google OAuth, forgot/reset password, staff management, `/me`                                                                                             |
| [`../routes/support.js`](../routes/support.js)                           | developer auth, owner/staff support chat, developer inbox, conversation status updates                                                                                          |
| [`../routes/exports.js`](../routes/exports.js)                           | export job status and authenticated download endpoints                                                                                                                          |
| [`../routes/ops.js`](../routes/ops.js)                                   | owner-only monitoring metrics and background cleanup endpoints                                                                                                                  |
| [`../routes/inventory.js`](../routes/inventory.js)                       | stock defaults, item/serial lookup, stock and sales reports, GST compare/export, dashboard overview, customer dues, owner-only due deletes                                      |
| [`../routes/business.js`](../routes/business.js)                         | suppliers, purchases that restock inventory/create serial units, product history, repayments, guarded purchase deletes, expenses                                                |
| [`../routes/invoices.js`](../routes/invoices.js)                         | invoice numbering/save, serialized stock sale, customer suggestions, history, payment settlement, PDF, shop info                                                                |
| [`../repositories/ops-repository.js`](../repositories/ops-repository.js) | database overview query used by ops metrics                                                                                                                                     |
| [`../utils/background-jobs.js`](../utils/background-jobs.js)             | periodic cache/export cleanup and heartbeat logging                                                                                                                             |
| [`../utils/cache.js`](../utils/cache.js)                                 | in-memory TTL cache plus owner-cache invalidation helpers                                                                                                                       |
| [`../utils/concurrency.js`](../utils/concurrency.js)                     | normalization helpers and owner-scoped advisory locks                                                                                                                           |
| [`../utils/export-queue.js`](../utils/export-queue.js)                   | in-memory export queue implementation and filename parsing                                                                                                                      |
| [`../utils/monitoring.js`](../utils/monitoring.js)                       | request, cache, export, memory, and DB-pool metric snapshots                                                                                                                    |
| [`../utils/pagination.js`](../utils/pagination.js)                       | shared query pagination parser, response headers, and metadata builder                                                                                                          |
| [`../utils/runtime-log.js`](../utils/runtime-log.js)                     | structured JSON log serializer used by server and DB lifecycle logging                                                                                                          |
| [`../railway.json`](../railway.json)                                     | Railway config-as-code for runtime start and healthcheck defaults                                                                                                               |

### Key frontend files

| File                                                                                 | Role                                                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| [`../public/login.html`](../public/login.html)                                       | landing page, server-injected banner carousel, owner/staff auth, Google onboarding, forgot password, Play Store install link   |
| [`../public/privacy-policy.html`](../public/privacy-policy.html)                     | public privacy policy page                                                                                                     |
| [`../public/account-deletion.html`](../public/account-deletion.html)                 | public account deletion instruction page                                                                                       |
| [`../public/developer-login.html`](../public/developer-login.html)                   | developer account login/register page for the support inbox                                                                    |
| [`../public/developer-support.html`](../public/developer-support.html)               | developer support queue and threaded reply workspace                                                                           |
| [`../public/index.html`](../public/index.html)                                       | dashboard shell with serialized Purchase Entry, supplier/product history, reports, dues, expenses, support, and staff sections |
| [`../public/invoice.html`](../public/invoice.html)                                   | sale workspace with Sale % helper, serial search/scan, customer autocomplete, history, PDF actions, and shop profile           |
| [`../public/images/`](../public/images)                                              | app logo plus numbered login carousel banners (`login_page_banner_1` through `_10` naming convention)                          |
| [`../public/site.webmanifest`](../public/site.webmanifest)                           | browser/PWA install metadata: app name, start URL, standalone display mode, colors, and icon                                   |
| [`../public/reset.html`](../public/reset.html)                                       | reset password page                                                                                                            |
| [`../public/js/developer-login.js`](../public/js/developer-login.js)                 | developer login/register controller                                                                                            |
| [`../public/js/developer-support.js`](../public/js/developer-support.js)             | developer inbox queue, thread, reply, and status update controller                                                             |
| [`../public/js/dashboard.js`](../public/js/dashboard.js)                             | dashboard orchestration, purchase serial capture/scanning, mobile dropdown guards, reports, ledgers, support, and staff UI     |
| [`../public/js/app-core.js`](../public/js/app-core.js)                               | shared constants, permission descriptions, app bootstrap helpers                                                               |
| [`../public/js/app-shell.js`](../public/js/app-shell.js)                             | reusable sidebar shell and page navigation                                                                                     |
| [`../public/js/permission-contract.js`](../public/js/permission-contract.js)         | single permission vocabulary shared by backend and frontend                                                                    |
| [`../public/js/service-worker-register.js`](../public/js/service-worker-register.js) | cleanup helper that unregisters old first-party service workers and deletes old runtime caches                                 |
| [`../public/service-worker.js`](../public/service-worker.js)                         | rollback worker that clears old runtime caches, unregisters itself, and does not intercept fetches                             |

## 5. High-Level Architecture

```mermaid
flowchart LR
  Browser["Browser pages<br/>login.html | developer-login.html | developer-support.html | index.html | invoice.html | reset.html | privacy/account pages"]
  SharedJS["Shared frontend modules<br/>app-core.js | app-shell.js | permission-contract.js | dashboard.js | developer-login.js | developer-support.js"]
  ServiceWorker["Service worker rollback<br/>service-worker.js | service-worker-register.js<br/>cache cleanup | unregister"]
  Server["Express app<br/>server.js"]
  AuthMW["Auth middleware<br/>cookie/session + permission resolution"]
  AuthRoutes["routes/auth.js"]
  SupportRoutes["routes/support.js"]
  ExportRoutes["routes/exports.js"]
  OpsRoutes["routes/ops.js"]
  InventoryRoutes["routes/inventory.js"]
  BusinessRoutes["routes/business.js"]
  InvoiceRoutes["routes/invoices.js"]
  CacheMW["cache + export middleware<br/>middleware/cache.js | middleware/export-queue.js"]
  OpsRuntime["runtime helpers<br/>monitoring | background-jobs | cache | export-queue | pagination"]
  RuntimeLog["Runtime logger<br/>utils/runtime-log.js"]
  DeployCfg["Railway config<br/>railway.json"]
  DB["PostgreSQL"]
  Schema["full_updated_schema.sql snapshot + db.js compatibility patch"]

  Browser --> SharedJS
  Browser -->|"GET HTML pages"| Server
  Browser --> ServiceWorker
  ServiceWorker -->|"cleanup only; no fetch interception"| Server
  SharedJS -->|"fetch /api/*"| Server
  DeployCfg -. deploy defaults .-> Server
  Server --> AuthMW
  Server --> CacheMW
  Server --> AuthRoutes
  Server --> SupportRoutes
  Server --> ExportRoutes
  Server --> OpsRoutes
  Server --> InventoryRoutes
  Server --> BusinessRoutes
  Server --> InvoiceRoutes
  Server --> OpsRuntime
  Server --> RuntimeLog
  AuthMW --> DB
  AuthRoutes --> DB
  SupportRoutes --> DB
  OpsRoutes --> DB
  InventoryRoutes --> DB
  BusinessRoutes --> DB
  InvoiceRoutes --> DB
  CacheMW --> OpsRuntime
  OpsRuntime --> DB
  Schema --> DB
```

### Request flow in practice

1. Browser requests `login.html`, `developer-login.html`, `developer-support.html`, `index.html`, `invoice.html`, or `reset.html`.
2. [`server.js`](../server.js) serves those pages through `sendHtmlTemplate(...)`, injecting login banners on `login.html`, preconnect hints, service-worker cleanup registration, and `__CSP_NONCE__` replacements.
3. [`../public/js/service-worker-register.js`](../public/js/service-worker-register.js) cleans up older first-party service-worker registrations and old runtime caches on secure origins.
4. [`../public/service-worker.js`](../public/service-worker.js) is kept as a rollback worker for already-installed clients: it clears old caches, unregisters itself, and does not intercept navigations, assets, APIs, or diagnostics.
5. Frontend scripts call `/api/...` endpoints with `credentials: "include"`.
6. [`middleware/auth.js`](../middleware/auth.js) resolves the current owner/staff session or developer support session as needed.
7. The matching route file runs business logic and queries PostgreSQL.
8. Non-API health endpoints report readiness or liveness without crossing the `/api` router stack. The registered `/api/*` aliases currently traverse the support readiness gate and broad inventory/business auth middleware before they can reach the health handlers.
9. `/network-check` can be opened from a browser or mobile network to test first-party reachability to `/live`, `/health`, and `/api/live`.
10. PDF and Excel exports are generated directly inside route handlers for normal requests, or queued through `/api/exports/:jobId` when `_async_export=1` is present.
11. Owner-only ops endpoints expose in-process metrics, DB-pool state, response cache stats, export queue stats, and background-job cleanup state.

Current Express route-order consequence:

- use `/health` (or `/ready`) for public readiness and `/live` for public liveness
- unauthenticated `/api/health`, `/api/live`, and their API aliases currently return `401` after the DB gate instead of acting as public probes
- an unknown unauthenticated `/api/*` path can also return `401` before the intended JSON `404`
- business requests pass the inventory router's broad auth guard and then the business guard; invoice requests pass both before their route-level guard, so staff-session DB lookup may repeat when `STAFF_SESSION_CACHE_TTL_MS=0`

## 6. Frontend Structure

### Page responsibilities

| Page                                                                   | What it does                                                                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [`../public/login.html`](../public/login.html)                         | server-injected banner carousel, owner/staff auth, Google onboarding, forgot password, existing-session redirect              |
| [`../public/developer-login.html`](../public/developer-login.html)     | developer account login/register screen for the support inbox                                                                 |
| [`../public/developer-support.html`](../public/developer-support.html) | developer queue and threaded support reply workspace                                                                          |
| [`../public/index.html`](../public/index.html)                         | dashboard for serialized purchases, supplier/product history, stock/sales/GST, dues, expenses, support, and staff controls    |
| [`../public/invoice.html`](../public/invoice.html)                     | invoice builder with Sale %, serial select/scan, draft restore, customer autofill, settlement, shop profile, history, and PDF |
| [`../public/reset.html`](../public/reset.html)                         | password reset using hash-based email/token values with query-string compatibility fallback, followed by history scrubbing    |
| [`../public/privacy-policy.html`](../public/privacy-policy.html)       | public privacy policy content linked from the login page                                                                      |
| [`../public/account-deletion.html`](../public/account-deletion.html)   | public account deletion guidance linked from the login page                                                                   |

### Shared frontend module roles

- [`../public/js/app-core.js`](../public/js/app-core.js)
  - defines the page permission descriptions and sidebar item metadata
  - resolves `apiBase`
  - exposes shared app-level helpers

- [`../public/js/app-shell.js`](../public/js/app-shell.js)
  - renders the sidebar
  - applies page-aware navigation
  - provides the sidebar refresh button that reloads the current page and preserves dashboard section state
  - injects shell styles in a CSP-compatible way

- [`../public/js/permission-contract.js`](../public/js/permission-contract.js)
  - defines the canonical permission keys:
    - `purchase_entry`
    - `sale_invoice`
    - `stock_report`
    - `sales_report`
    - `gst_report`
    - `customer_due`
    - `expense_tracking`
  - defaults new staff accounts to `purchase_entry` and `sale_invoice`
  - keeps legacy aliases normalized where needed, but `add_stock` is no longer an active permission

- [`../public/js/service-worker-register.js`](../public/js/service-worker-register.js)
  - no longer registers a persistent service worker
  - runs after the `load` event when service-worker APIs are available
  - unregisters same-origin service-worker registrations and deletes old inventory runtime caches
  - quietly skips cleanup errors so a service-worker issue cannot block login, dashboard, invoice, or support pages

- [`../public/service-worker.js`](../public/service-worker.js)
  - rollback version: `2026-07-14-disable-low-network-cache-1`
  - deletes old `shop-inventory-runtime-*` and `inventory-runtime-*` caches during install/activation
  - claims existing clients, unregisters itself, and intentionally does not call `respondWith()` in `fetch`
  - sends all navigations, static assets, APIs, and diagnostics directly to the network

- [`../public/js/dashboard.js`](../public/js/dashboard.js)
  - drives most dashboard features
  - loads and submits purchase, supplier ledger, report, due, expense, support, and staff data
  - handles Purchase Entry / Add Stock row logic, optional serial slots and camera scanning, supplier/item dropdowns, product purchase history, owner-only delete menus, popups, section switching, and exports
  - uses scroll-gesture tracking and delayed hide behavior for long item dropdowns on touch devices
  - refreshes the session once after a `403` so stale staff permission state can recover before showing an access-denied popup
  - requests queued exports by adding `_async_export=1`, polls job status, then downloads through `/api/exports/:jobId/download`

- [`../public/invoice.html`](../public/invoice.html)
  - contains the inline invoice page controller
  - manages invoice draft storage, line item autocomplete, Sale %/rate synchronization, serial search/scan, payment preview, invoice search, and PDF actions
  - persists `sale_profit_percent` and the current `buying_rate` only inside the local draft; the final `POST /api/invoices` payload deliberately sends description, quantity, rate, and serial numbers instead
  - loads customer suggestions from `/api/invoices/customers` and fills billing name, contact, and address from selected historical invoices
  - saves shop, GST, bank account, IFSC, and UPI details through `/api/shop-info`
  - uses the same queued-export pattern for invoice PDF downloads when the backend returns `202`

- [`../public/js/developer-login.js`](../public/js/developer-login.js)
  - handles developer sign-in and optional developer account creation
  - normalizes the private developer setup key before submission
  - verifies an existing developer session through `/api/developer-auth/me`

- [`../public/js/developer-support.js`](../public/js/developer-support.js)
  - loads the developer inbox queue and threaded conversation state
  - sends replies, changes conversation status, and refreshes queue counters
  - escapes requester and message content before writing HTML into the inbox UI

### Mobile dropdown and serialized-item UI behavior

Long suggestion lists are intentionally scrollable on phones:

- shared dashboard item dropdowns call `setupScrollableDropdown(...)`, track pointer/mouse/touch movement, suppress the click produced by a swipe, and use `scheduleDropdownHide(...)` so input blur cannot close a list while it is being scrolled
- invoice item and serial dropdowns mark active pointer/scroll interaction, switch selection from `pointerdown` to `click`, and defer blur hiding while the list is active
- `public/index.html` and `public/invoice.html` set `overscroll-behavior: contain`, momentum scrolling, `touch-action: pan-y`, and viewport-bounded list heights

Serialized purchase UI:

- a purchase row can add one serial/SN slot per whole-number quantity
- serials can be typed manually or scanned with `BarcodeDetector` and an environment-facing camera
- camera scan requires a secure context (`HTTPS` or localhost), camera permission, and browser `BarcodeDetector` support; manual entry remains the fallback
- duplicate serials and quantity/count mismatch are rejected before submit and again by the backend

Serialized invoice UI:

- item rows call `GET /api/item-serials` for in-stock suggestions or exact scanned lookup
- selecting/scanning serials synchronizes their saved `sale_rate`; mixed saved rates require an explicit custom line rate or separate rows
- a serialized invoice line must have a positive whole-number quantity equal to its serial count
- invoice history/detail renders serials linked to saved invoice items

### Service-worker rollback and network behavior

The project currently keeps backend response caching, but the browser/WebView service-worker app-shell cache has been rolled back because the low-network smoothing layer caused carrier-specific loading problems.

- Backend JSON response cache:
  - implemented by [`../middleware/cache.js`](../middleware/cache.js) and [`../utils/cache.js`](../utils/cache.js)
  - short-lived, owner-scoped, and used only by routes that explicitly opt in
  - bypassable with `_no_cache=1`
- Browser/WebView service-worker rollback:
  - cleanup helper: [`../public/js/service-worker-register.js`](../public/js/service-worker-register.js)
  - rollback worker: [`../public/service-worker.js`](../public/service-worker.js)
  - deletes old app-shell runtime caches named `shop-inventory-runtime-*` or `inventory-runtime-*`
  - unregisters old same-origin service-worker registrations
  - does not intercept `/api/*`, HTML navigation, JS, CSS, images, health checks, or `/network-check`

The rollback worker version is `2026-07-14-disable-low-network-cache-1`. Updating these web files can ship through normal Railway deployment; changing native WebView behavior still requires a Play Store/AAB release from the Android wrapper project.

### Frontend storage usage

Current frontend storage behavior:

- auth/session:
  - primary auth is cookie-based
  - the app checks `/api/auth/me` instead of relying on a persisted browser token
- developer support:
  - developer pages also use cookie-based auth with `credentials: "include"`
  - developer login no longer depends on a readable token in session or local storage
- `localStorage`:
  - `activeSection` for dashboard section persistence
  - sidebar refresh uses `activeSection` so the same dashboard module opens again after reload
  - legacy `defaultProfitPercent` migration fallback only; `/api/stock-defaults` is authoritative, and a successful server read/write deletes the local key
  - `invoice_page_draft_v4` on `invoice.html`, including customer/payment state, item rate, draft-only Sale %, draft-only buying-rate reference, and serial inputs
  - cleanup of old `token`/`user` keys during logout or invalid session handling
- there is no application use of IndexedDB or `sessionStorage`
- Cache Storage:
  - old service-worker runtime caches are deleted by the cleanup helper and rollback worker
  - no API JSON, auth-sensitive responses, reports, invoices, payments, stock mutations, health checks, or network diagnostics should be stored there

## 7. Backend Structure

### `server.js`

[`server.js`](../server.js) is responsible for:

- creating the Express app
- enabling `trust proxy`
- building the CORS allowlist from `CORS_ALLOWED_ORIGINS` or `BASE_URL`
- creating per-request IDs and response `X-Request-Id` headers
- emitting structured lifecycle and request logs through [`../utils/runtime-log.js`](../utils/runtime-log.js)
- generating a per-request CSP nonce
- applying `helmet`, compression, cookie parsing, JSON parsing, and rate limiting
- allowing first-party service workers through `worker-src 'self'`
- skipping health routes from the API rate limiter
- mounting queued export middleware for async PDF/Excel requests that include `_async_export=1`, `async_export=1`, or `queue_export=1`
- registering route files
- mounting [`../routes/support.js`](../routes/support.js) before auth-locked `/api` routers so public developer auth routes do not get intercepted by owner/staff auth guards
- mounting [`../routes/exports.js`](../routes/exports.js) for export job status/download and [`../routes/ops.js`](../routes/ops.js) for owner-only metrics
- serving HTML pages through nonce-aware template injection
- injecting CDN preconnect hints and `/js/service-worker-register.js` into HTML pages before nonce replacement
- discovering up to 10 numbered `login_page_banner_N` image files, adding file-version query strings, and injecting the generated slides into `login.html`
- caching HTML templates in memory while still sending HTML with `Cache-Control: no-store`
- serving `/service-worker.js` with `Cache-Control: no-cache` and `Service-Worker-Allowed: /` so already-installed clients can receive the rollback worker and clear old runtime caches
- serving `/privacy-policy(.html)` and `/account-deletion(.html)` in addition to the app pages
- serving `/network-check(.html)` as a generated, no-store diagnostic page that uses only first-party resources and tests `/live`, `/health`, and `/api/live`
- exposing readiness routes:
  - `/health`
  - `/api/health`
  - `/healthz`
  - `/api/healthz`
  - `/ready`
  - `/api/ready`
  - `/readyz`
  - `/api/readyz`
- exposing liveness routes:
  - `/live`
  - `/api/live`
  - `/livez`
  - `/api/livez`
- returning health payloads that include DB readiness, shutdown state, uptime, and memory usage
- exposing debug routes only when:
  - `NODE_ENV !== "production"`
  - `ENABLE_DEBUG_ROUTES === "true"`
- rejecting non-health `/api` requests with `503` and `Retry-After: 3` when `pool.waitingCount` reaches `DB_POOL_WAITING_REJECT_THRESHOLD`
- when `MAINTENANCE_MODE` is enabled, returning no-store `503` HTML or JSON with a configurable message and `Retry-After`, while allowing health paths through
- configuring server shutdown behavior with:
  - `keepAliveTimeout`
  - `headersTimeout`
  - `requestTimeout`
- handling `SIGTERM`, `SIGINT`, `unhandledRejection`, and `uncaughtException`
- starting/stopping background jobs that clean expired response-cache entries and export jobs, and emit periodic monitor heartbeat logs

### `db.js`

[`db.js`](../db.js) is responsible for:

- validating `DATABASE_URL`
- choosing SSL automatically unless overridden by `DB_SSL`
- reading connection-pool, timeout, and application-name tuning from `PG_*` environment variables
- creating the shared PostgreSQL pool
- maintaining `dbState`, `pool.isReady()`, and `pool.readyPromise`
- emitting structured startup and pool-error logs through [`../utils/runtime-log.js`](../utils/runtime-log.js)
- applying schema compatibility patches at startup

Compatibility patching currently ensures:

- Google OAuth columns on `users`: `google_sub`, `google_email_verified`, and `google_picture_url`
- `settings.default_profit_percent`
- invoice payment profile columns on `settings`: `bank_name`, `account_holder_name`, `account_number`, `ifsc_code`, and `upi_id`
- `sales.cost_price`
- `sales.gst_amount`
- `debts.customer_address`
- invoice payment columns on `invoices`
- `debts.invoice_id`
- creation of `suppliers`, `purchases`, `purchase_items`, `expenses`
- creation and indexing of `item_serials`, plus `sale_rate` addition/backfill from purchase/item selling rates
- creation of `developer_admins`, `support_conversations`, and `support_messages`
- supporting indexes for those newer tables
- duplicate/invalid developer admin rows are reconciled before enforcing the normalized email unique index
- optional developer support bootstrap via `SUPPORT_ADMIN_*` environment variables

### `middleware/cache.js`

[`../middleware/cache.js`](../middleware/cache.js) provides owner-scoped short TTL caching for `GET` JSON endpoints.

Important behavior:

- cache keys include the authenticated owner ID, namespace, and original request URL
- callers can bypass cache with `_no_cache=1`
- successful cached responses restore pagination headers such as `X-Total-Count`, `X-Limit`, `X-Offset`, and `X-Has-More`
- route writes invalidate owner cache through [`../utils/cache.js`](../utils/cache.js)

### `middleware/export-queue.js`

[`../middleware/export-queue.js`](../middleware/export-queue.js) intercepts authenticated `GET` requests ending in `/pdf` or `/excel` when the query asks for async export.

Important behavior:

- supported flags: `_async_export=1`, `async_export=1`, or `queue_export=1`
- authenticated owner and actor IDs are read from the session JWT
- the original export route is fetched internally with `x-export-queue-bypass: 1`
- callers receive `202` with `status_url` and `download_url`
- queue timeout is controlled by `EXPORT_QUEUE_TIMEOUT_MS`

### `middleware/auth.js`

[`middleware/auth.js`](../middleware/auth.js) does the following:

- reads the session token from the `token` cookie
- supports `Authorization: Bearer ...` as a fallback
- reads the developer support session from the `developer_support_token` cookie for developer-only routes
- verifies the JWT using `JWT_SECRET`
- resolves active staff permissions from the database, with an optional in-memory cache controlled by `STAFF_SESSION_CACHE_TTL_MS`
- verifies active developer inbox sessions through `developerAuthMiddleware`
- uses a staff-session cache with:
  - TTL: `0` ms by default, which disables caching and reloads active staff state from PostgreSQL on every auth pass
  - configurable TTL: `STAFF_SESSION_CACHE_TTL_MS`
  - max entries: `200` when enabled
- invalidates cached staff session data when staff login, permission updates, or staff deletion occurs
- exposes helpers:
  - `authMiddleware`
  - `developerAuthMiddleware`
  - `getUserId(req)`
  - `getActorId(req)`
  - `getDeveloperId(req)`
  - `requireOwner`
  - `requirePermission(...)`
  - `allowRoles(...)`

### `utils/concurrency.js`

[`../utils/concurrency.js`](../utils/concurrency.js) provides:

- text normalization helpers for consistent lookup keys
- owner-scoped advisory locks via `pg_advisory_xact_lock`

Those locks are used to reduce race conditions for:

- supplier lookup/create flows
- invoice numbering and settlement-adjacent resource updates
- customer due operations

### `utils/runtime-log.js`

[`../utils/runtime-log.js`](../utils/runtime-log.js) provides:

- structured JSON log output with:
  - `ts`
  - `level`
  - `event`
- sanitization for nested objects, arrays, dates, and `Error` instances
- a shared log writer that routes `info`, `warn`, and `error` entries to the appropriate console method

It is currently used by:

- [`../server.js`](../server.js) for startup, health, request, and shutdown events
- [`../db.js`](../db.js) for DB initialization and pool lifecycle events

### Runtime support utilities

Additional runtime utility files:

| File                                                                     | Purpose                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [`../utils/cache.js`](../utils/cache.js)                                 | in-memory TTL cache, owner cache key helpers, invalidation, and cache stats                       |
| [`../utils/export-queue.js`](../utils/export-queue.js)                   | in-memory bounded queue for async export jobs, status serialization, and filename parsing         |
| [`../utils/monitoring.js`](../utils/monitoring.js)                       | request counters, route timing aggregates, memory stats, DB-pool stats, cache stats, export stats |
| [`../utils/background-jobs.js`](../utils/background-jobs.js)             | periodic cleanup for expired cache/export entries plus heartbeat logs                             |
| [`../utils/pagination.js`](../utils/pagination.js)                       | shared `limit`, `page`, and `offset` parser, pagination metadata, and pagination headers          |
| [`../repositories/ops-repository.js`](../repositories/ops-repository.js) | small PostgreSQL overview query used by `/api/ops/metrics`                                        |

### Function catalogue

This catalogue covers named top-level helpers, middleware factories, and shared frontend/runtime primitives.

Important scope note:

- anonymous Express route handlers are catalogued in [Section 11](#11-api-route-map) by endpoint path instead of function name
- one-off nested closures inside long PDF builders or UI event binders are described by their parent function instead of being listed one-by-one
- page-heavy frontend logic in [`../public/js/dashboard.js`](../public/js/dashboard.js) is grouped by workflow family because the file acts as a full page controller rather than a reusable utility module

#### `server.js` function inventory

| Function                                      | Purpose                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `readPositiveInt(value, fallback)`            | parses positive integer env values such as request timeout and slow-log threshold               |
| `normalizeOrigin(value)`                      | normalizes a raw URL into a clean `origin` for CORS checks                                      |
| `buildAllowedOrigins()`                       | builds the final CORS allowlist from `CORS_ALLOWED_ORIGINS`, `BASE_URL`, or localhost defaults  |
| `nonceDirective(_req, res)`                   | returns the CSP nonce directive used by `helmet`                                                |
| `normalizePathname(value)`                    | strips query strings and trailing slashes from incoming paths                                   |
| `escapeHtml(value)`                           | escapes dynamic values used in server-rendered maintenance and Android-return HTML              |
| `getRequestPath(req)`                         | derives a canonical path string from the Express request                                        |
| `isHealthRoutePath(pathname)`                 | identifies readiness/liveness routes for special logging rules                                  |
| `roundTo(value, decimals)`                    | rounds numeric values used in health and timing payloads                                        |
| `getMemoryUsageMb()`                          | returns current Node.js memory usage in MB                                                      |
| `buildDbHealth()`                             | reads DB readiness and last-error state from the shared pool                                    |
| `buildHealthPayload(kind)`                    | assembles the JSON body returned by readiness/liveness endpoints                                |
| `sendHealthResponse(res, kind)`               | sends a no-cache health payload with the correct HTTP status                                    |
| `getHtmlTemplate(fileName)`                   | reads and caches HTML templates from `public/`                                                  |
| `applyHtmlCacheHeaders(res)`                  | forces HTML responses to bypass browser/proxy caching                                           |
| `injectPerformanceBootstrap(html)`            | adds CDN preconnect hints and service-worker registration to served HTML if not already present |
| `getLoginBannerFiles()`                       | discovers, versions, sorts, and caps numbered login-banner image files                          |
| `buildLoginBannerSlides()`                    | renders responsive login carousel slide markup from the discovered images                       |
| `injectLoginBanners(html)`                    | replaces the login-page banner placeholder with generated slide markup                          |
| `setStaticAssetCacheHeaders(res, filePath)`   | applies cache rules for HTML, service worker, images, fonts, and other static assets            |
| `sendHtmlTemplate(res, fileName, statusCode)` | injects performance bootstrap tags plus the CSP nonce into cached HTML and sends it             |
| `sendMaintenancePage(req, res)`               | renders no-store HTML or JSON maintenance responses when maintenance mode is enabled            |
| `sendNetworkCheckPage(req, res)`              | renders the no-store first-party network diagnostic page served at `/network-check(.html)`      |
| `getAuthTokenFromRequest(req)`                | reads a session token from cookie or bearer header for rate-limit identity                      |
| `getRateLimitKey(req)`                        | builds user/actor-aware rate-limit keys, falling back to IP when unauthenticated                |
| `shutdown(signal)`                            | performs graceful server shutdown for `SIGTERM` and `SIGINT`                                    |

#### `db.js` function inventory

| Function                                           | Purpose                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `shouldUseSsl(databaseUrl)`                        | auto-decides whether PostgreSQL SSL should be enabled                                    |
| `readPositiveInt(value, fallback)`                 | parses positive integer pool-tuning env values                                           |
| `readNonNegativeInt(value, fallback)`              | parses timeout values that may intentionally be disabled with `0`                        |
| `normalizeEmail(value)`                            | canonicalizes developer-support email values during bootstrap reconciliation             |
| `isTruthyEnvFlag(value)`                           | reads boolean-style environment flags for optional bootstrap behavior                    |
| `buildArchivedDeveloperEmail(normalizedEmail, id)` | creates a deterministic archived email for duplicate developer admin records             |
| `ensureSchemaCompatibility()`                      | applies runtime schema patching so older databases can satisfy current code expectations |
| `initializeDatabase()`                             | tests connectivity, runs compatibility patching, and updates exported readiness state    |

`ensureSchemaCompatibility()` also contains `reconcileDeveloperAdmins()`, a nested helper that archives duplicate developer admin emails before the normalized unique index is enforced.

#### `middleware/auth.js` function inventory

| Function                                      | Purpose                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `readNonNegativeInt(value, fallback)`         | parses the optional staff-session cache TTL, including the disabled value `0`         |
| `normalizeSessionRole(value)`                 | constrains raw JWT role values to supported session roles                             |
| `getStaffSessionCacheKey(staffId)`            | normalizes a staff ID into a safe cache key                                           |
| `getCachedStaffSession(staffId)`              | returns a non-expired cached staff session if available                               |
| `setCachedStaffSession(staffId, sessionData)` | writes a staff session into the in-memory cache with TTL enforcement                  |
| `invalidateStaffSessionCache(staffId)`        | removes one staff session from cache after permission or status changes               |
| `loadStaffSession(staffId)`                   | reloads current staff metadata and permissions from PostgreSQL                        |
| `authMiddleware(req, res, next)`              | validates the JWT cookie/header and attaches normalized session context to `req.user` |
| `loadDeveloperSession(developerId)`           | reloads one developer support account from PostgreSQL                                 |
| `developerAuthMiddleware(req, res, next)`     | validates the developer support JWT cookie/header and attaches `req.developer`        |
| `getUserId(req)`                              | returns the owner-scoped `user_id` used by all business queries                       |
| `getActorId(req)`                             | returns the acting account ID for audit-aware flows                                   |
| `getDeveloperId(req)`                         | returns the current developer support account ID                                      |
| `isOwnerSession(req)`                         | checks whether the current session belongs to the owner                               |
| `hasPermission(req, ...permissions)`          | checks whether the current session satisfies at least one requested permission        |
| `requireOwner(req, res, next)`                | blocks non-owner sessions from owner-only routes                                      |
| `requirePermission(...permissions)`           | returns middleware that enforces one or more page permissions                         |
| `allowRoles(...roles)`                        | returns middleware that allows only a selected set of roles                           |
| `requireDeveloperSupport(req, res, next)`     | blocks requests that do not carry a developer support session                         |

#### `middleware/cache.js` function inventory

| Function                           | Purpose                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `readPositiveInt(value, fallback)` | parses positive TTL values with a fallback                               |
| `cacheJsonResponse(options)`       | creates owner-scoped `GET` JSON cache middleware with optional namespace |

#### `middleware/export-queue.js` function inventory

| Function                                | Purpose                                                          |
| --------------------------------------- | ---------------------------------------------------------------- |
| `readPositiveInt(value, fallback)`      | parses timeout configuration values                              |
| `getAuthToken(req)`                     | reads session token from cookie or bearer header                 |
| `getTokenSubject(req)`                  | decodes owner/actor identity for queued export ownership         |
| `shouldQueueExport(req)`                | decides whether a request should be queued                       |
| `buildInternalExportUrl(req, port)`     | builds the localhost URL used to run the original export route   |
| `fetchExportBuffer(internalUrl, req)`   | calls the original export route and returns file buffer metadata |
| `createQueuedExportMiddleware(options)` | creates middleware that returns `202` export job payloads        |

#### `routes/auth.js` function inventory

Route handlers in this file cover registration, owner login, Google OAuth login/onboarding, staff login, logout, password reset, staff CRUD, and current-session lookup.

| Function                                                        | Purpose                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `normalizeBaseUrl(value)`                                       | validates and normalizes the configured public base URL                |
| `resolvePublicBaseUrl(req)`                                     | resolves the effective app base URL for password reset and OAuth links |
| `getSessionCookieOptions()`                                     | returns shared cookie flags for login and logout                       |
| `setTemporaryCookie(res, name, value, maxAge)`                  | writes short-lived Google OAuth state/onboarding cookies               |
| `clearGoogleOAuthStateCookie(res)`                              | clears the Google OAuth state cookie                                   |
| `clearGoogleOnboardingCookie(res)`                              | clears the Google onboarding cookie                                    |
| `hashResetToken(token)`                                         | hashes raw reset tokens before storing them in the database            |
| `markSensitiveResponse(res)`                                    | marks auth-sensitive responses as `no-store`                           |
| `normalizeName(value)`                                          | trims and de-duplicates whitespace in person names                     |
| `normalizeEmail(value)`                                         | canonicalizes email values to lowercase                                |
| `normalizeMobileNumber(value)`                                  | converts mobile numbers into the app's 10-digit format                 |
| `isValidMobileNumber(value)`                                    | validates the normalized mobile format                                 |
| `normalizeUsername(value)`                                      | strips spaces and lowercases staff usernames                           |
| `signSession(payload)`                                          | signs the JWT used for owner and staff sessions                        |
| `normalizeGoogleOAuthClient(value)`                             | distinguishes web Google OAuth from Android wrapper OAuth              |
| `signGoogleOAuthState(client)`                                  | signs the Google OAuth state token                                     |
| `readGoogleOAuthState(state)`                                   | validates a Google OAuth state token and returns client mode           |
| `pruneAndroidGoogleCallbackResults()`                           | removes expired entries from the process-local Android callback map    |
| `rememberAndroidGoogleCallbackResult(state, transferToken)`     | stores a short-lived Android transfer result for callback recovery     |
| `readAndroidGoogleCallbackResult(state)`                        | consumes a matching Android callback transfer result                   |
| `signAndroidGoogleTransfer(payload)`                            | signs short-lived Android deep-link transfer data                      |
| `verifyAndroidGoogleTransfer(token)`                            | validates the Android transfer token                                   |
| `signGoogleOnboarding(profile)`                                 | signs short-lived first-time Google onboarding profile data            |
| `verifyGoogleOnboardingToken(token)`                            | validates Google onboarding cookie data                                |
| `setSessionCookie(res, token)`                                  | writes the signed session token into the `token` cookie                |
| `clearSessionCookie(res)`                                       | clears the current login cookie                                        |
| `getGoogleOAuthConfig(req)`                                     | reads Google client settings and callback URL                          |
| `buildLoginRedirectUrl(req, params)`                            | creates login-page redirects with Google result/error flags            |
| `buildAndroidGoogleDeepLink(req, transferToken)`                | creates the Android wrapper deep-link URL                              |
| `buildAndroidGoogleOpenUrl(req, transferToken)`                 | creates the first-party browser fallback URL for Android return        |
| `escapeHtml(value)`                                             | escapes values interpolated into Android return pages                  |
| `scriptJson(value)`                                             | safely serializes values embedded in an inline return-page script      |
| `buildAndroidGoogleIntentLink(req, transferToken)`              | builds the Android intent URL with a browser fallback                  |
| `sendAndroidGoogleReturnPage(req, res, transferToken)`          | renders the transient page that launches the Android deep link         |
| `renderAndroidGoogleOpenPage(req, res, transferToken)`          | renders the manual Android-open fallback page                          |
| `exchangeGoogleCodeForTokens(code, config)`                     | exchanges OAuth code for Google tokens                                 |
| `fetchGoogleUserProfile(accessToken)`                           | loads and validates Google user profile data                           |
| `normalizeSessionRole(value)`                                   | normalizes session roles before client-facing serialization            |
| `buildOwnerSession(user)`                                       | creates the normalized owner session payload                           |
| `buildStaffSession(staff)`                                      | creates the normalized staff session payload with permissions          |
| `toClientUser(session)`                                         | reshapes a server session into the frontend-safe user object           |
| `getOwnersByIdentifier(identifier)`                             | looks up owner accounts by email or mobile number                      |
| `getStaffByUsername(username)`                                  | looks up one staff account plus owner metadata                         |
| `getOwnerByGoogleProfile(profile)`                              | finds an owner by Google subject or verified email                     |
| `linkGoogleProfileToOwner(user, profile)`                       | stores Google subject/email verification metadata on an existing owner |
| `createOwnerFromGoogleProfile(profile, shopName, mobileNumber)` | creates a new owner/settings pair after Google onboarding              |

#### `routes/inventory.js` function inventory

Route handlers in this file cover stock defaults for Purchase Entry, shared item and in-stock serial lookup, item reporting, low-stock analysis, reorder planning, slow-moving stock analysis, sales/GST reports, customer dues, dashboard cards, and trend APIs. There is no active or commented `POST /api/items` handler; live stock intake is handled by `POST /api/purchases` in [`../routes/business.js`](../routes/business.js).

| Function                                                        | Purpose                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `formatCurrency(value)`                                         | formats numeric values for report output using Indian number formatting         |
| `formatIstDate(value)`                                          | formats a timestamp in the `Asia/Kolkata` timezone                              |
| `getCurrentIstYear()`                                           | returns the current year in the IST timezone for trend filters                  |
| `safeFilePart(value)`                                           | sanitizes user input for downloadable file names                                |
| `sanitizeExcelCell(value)`                                      | prevents formula injection in Excel exports                                     |
| `parseNonNegativeNumber(value)`                                 | validates non-negative numeric input                                            |
| `getInvoicePaymentStatus(amountPaid, amountDue)`                | derives invoice `paid`, `partial`, or `due` state after ledger changes          |
| `syncInvoiceBalancesFromDebtLedger(client, userId, invoiceIds)` | recalculates invoice paid/due totals after invoice-linked debt rows are deleted |
| `getShopName(userId)`                                           | resolves the current owner's shop name from `settings`                          |
| `drawPdfBanner(doc, title, shopName, subtitle, rightText)`      | renders the shared PDF report header block                                      |
| `drawPdfTableHeader(doc, columns)`                              | renders the shared PDF table header row                                         |
| `ensurePdfSpace(doc, heightNeeded, onNewPage)`                  | adds a new PDF page before content would overflow                               |
| `getLowStockStatus(daysLeft)`                                   | maps days-of-cover values into low-stock severity labels                        |
| `getReorderPriority(daysLeft)`                                  | maps days-of-cover values into reorder priority labels                          |
| `getSlowMovingPriority(sold30Days, daysCover)`                  | classifies slow-moving inventory rows                                           |
| `getSlowMovingFocusNote(sold30Days, daysCover)`                 | writes the operator-facing message for slow-moving items                        |
| `fetchGstReportRows(userId, from, to)`                          | loads invoice-based GST rows for the selected date range                        |
| `summarizeGstRows(rows)`                                        | aggregates GST totals for report summaries                                      |

#### `routes/business.js` function inventory

Route handlers in this file cover supplier lookup, purchase entry, product-wise purchase history, purchase reporting, supplier ledger views, repayment capture, owner-only purchase/supplier ledger deletion, and expenses.

| Function                                                            | Purpose                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `parseNonNegativeNumber(value)`                                     | validates numeric inputs that may be zero                            |
| `parsePositiveNumber(value)`                                        | validates numeric inputs that must be greater than zero              |
| `normalizeMobileNumber(value)`                                      | canonicalizes supplier mobile numbers                                |
| `normalizePaymentMode(value, fallback)`                             | constrains purchase/expense payment modes to supported values        |
| `parseDateInput(value)`                                             | normalizes a raw date into `YYYY-MM-DD` form                         |
| `toIstStartTimestamp(value)`                                        | converts a date into an IST day-start timestamp                      |
| `toIstDateRange(from, to)`                                          | returns an inclusive IST date-range object for reports               |
| `buildPaymentSnapshot(subtotal, paidInput, fallbackMode)`           | computes purchase payment status, paid amount, and due amount        |
| `buildPurchasePaymentStatus(amountPaid, amountDue)`                 | recalculates saved purchase status after a bill item delete          |
| `normalizeSerialNumber(value)`                                      | trims and normalizes one purchase serial/SN for display              |
| `normalizeSerialNumberKey(value)`                                   | creates the case-insensitive owner-unique serial lookup key          |
| `parseSerialNumbers(value)`                                         | parses, normalizes, and deduplicates serial input collections        |
| `applyPurchaseStockReversal(client, userId, purchaseItems)`         | rolls back item stock for deleted purchase bills or bill items       |
| `deletePurchaseBillsWithStockRollback(client, userId, purchaseIds)` | deletes purchase bills after locking rows and reversing stock safely |
| `findOrCreateSupplier(client, userId, payload)`                     | performs locked supplier lookup/create/update inside a transaction   |

#### `routes/invoices.js` function inventory

Route handlers in this file cover invoice preview, invoice creation, customer autocomplete, invoice search/history, invoice detail, due settlement, PDF export with optional UPI QR, and shop/payment profile settings.

| Function                                                                           | Purpose                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `padSerial(n)`                                                                     | zero-pads the daily invoice serial number                                       |
| `parsePositiveNumber(value)`                                                       | validates payment inputs that must be greater than zero                         |
| `parseNonZeroNumber(value)`                                                        | validates invoice quantity inputs that may be positive or negative but not zero |
| `parseNonNegativeNumber(value)`                                                    | validates invoice payment inputs that may be zero                               |
| `normalizeMobileNumber(value)`                                                     | canonicalizes customer contact numbers                                          |
| `normalizeSerialNumber(value)`                                                     | trims and normalizes one invoice serial/SN                                      |
| `normalizeSerialNumberKey(value)`                                                  | creates the normalized serial lookup/lock key                                   |
| `parseSerialNumbers(value)`                                                        | parses and deduplicates invoice serial input                                    |
| `normalizeInvoicePaymentMode(value)`                                               | constrains invoice payment modes to supported values                            |
| `appendQrBits(bits, value, length)`                                                | writes QR bit segments for the built-in UPI QR encoder                          |
| `getQrDataCodewordCount(version)`                                                  | returns QR data capacity metadata for a QR version                              |
| `getQrByteCapacity(version)`                                                       | computes byte capacity for the QR version                                       |
| `findQrVersion(byteLength)`                                                        | selects the smallest supported QR version for the UPI payload                   |
| `qrGfMultiply(x, y)`                                                               | multiplies values in the QR Reed-Solomon finite field                           |
| `qrReedSolomonDivisor(degree)`                                                     | builds the Reed-Solomon generator polynomial                                    |
| `qrReedSolomonRemainder(data, divisor)`                                            | calculates QR error-correction bytes                                            |
| `addQrErrorCorrection(version, dataCodewords)`                                     | interleaves QR data and error-correction codewords                              |
| `getQrMaskBit(mask, x, y)`                                                         | evaluates the QR mask pattern for one module                                    |
| `getQrFormatBits(mask)`                                                            | builds QR format metadata bits                                                  |
| `getQrVersionBits(version)`                                                        | builds QR version metadata bits                                                 |
| `createQrCodeMatrix(text)`                                                         | creates a QR module matrix for the UPI payment URI                              |
| `buildUpiPaymentUri(upiId, payeeName)`                                             | builds a UPI payment URI from saved shop payment details                        |
| `calculateSaleGstAmount(baseAmount, gstRate)`                                      | computes line-level GST stored with sales rows                                  |
| `buildInvoicePaymentSnapshot(totalAmount, amountPaidInput, paymentModeInput)`      | computes initial invoice payment totals and status                              |
| `buildInvoiceSettlementSnapshot(invoiceRow, paymentAmountInput, paymentModeInput)` | computes the next payment state when collecting an outstanding due              |
| `isRetryableInvoiceWriteError(error)`                                              | identifies PostgreSQL errors that justify retrying invoice creation             |
| `generateInvoiceNoWithClient(client, userId)`                                      | allocates the next owner-scoped invoice number using `user_invoice_counter`     |

Nested PDF helper functions such as `drawHeader()`, `drawPaymentDetails()`, `drawQrCode()`, and `drawTableHeader()` live inside the invoice PDF route because they are only used for that single response path.

#### `routes/support.js` function inventory

Route handlers in this file cover developer registration/login, owner or staff support-thread messaging, developer inbox views, reply posting, and conversation status changes.

| Function                                                | Purpose                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `getSessionCookieOptions()`                             | returns shared cookie flags for developer support login/logout                        |
| `markSensitiveResponse(res)`                            | marks support and developer-auth responses as `no-store`                              |
| `normalizeEmail(value)`                                 | canonicalizes developer email values to lowercase                                     |
| `normalizeName(value)`                                  | trims and collapses whitespace for names                                              |
| `normalizeDeveloperAccessKey(value)`                    | normalizes the developer setup key by removing invisible/mobile copy-paste characters |
| `normalizeSupportMessage(value)`                        | trims support message text and removes carriage returns                               |
| `normalizeConversationStatus(value)`                    | constrains conversation status to `open` or `closed`                                  |
| `signDeveloperSession(payload)`                         | signs the developer support JWT                                                       |
| `setDeveloperSessionCookie(res, token)`                 | writes the developer support cookie                                                   |
| `clearDeveloperSessionCookie(res)`                      | clears the current developer support cookie                                           |
| `serializeDeveloperSession(admin)`                      | reshapes a developer admin row into a frontend-safe session object                    |
| `getRequesterContext(req)`                              | resolves owner/staff sender identity for support-thread writes                        |
| `serializeSupportConversation(row)`                     | normalizes support conversation rows for the frontend                                 |
| `serializeSupportMessage(row)`                          | normalizes support message rows for the frontend                                      |
| `getDeveloperByEmail(email)`                            | loads one developer admin account by normalized email                                 |
| `createDeveloperAccount({ name, email, passwordHash })` | inserts a new developer admin row                                                     |
| `getRequesterConversation(client, requester)`           | loads the owner/staff support thread for the current requester                        |
| `upsertRequesterConversation(client, requester)`        | finds or creates the per-requester support conversation                               |
| `loadConversationMessages(client, conversationId)`      | loads the message list for one support thread                                         |
| `loadDeveloperConversationById(client, conversationId)` | loads one support conversation for the developer inbox                                |
| `loadDeveloperConversationList(client)`                 | loads the developer inbox queue ordered by unread/latest activity                     |

#### `routes/exports.js` function inventory

Route handlers in this file cover authenticated export job lookup and file download.

| Function                     | Purpose                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `getAuthorizedJob(req, res)` | loads an export job and hides it unless it belongs to the owner    |
| `safeAttachmentName(value)`  | sanitizes generated filenames before writing `Content-Disposition` |

#### `routes/ops.js` function inventory

Route handlers in this file are owner-only and cover monitoring metrics plus background cleanup controls.

| Endpoint handler area               | Purpose                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `GET /ops/metrics`                  | combines request metrics, DB overview, cache stats, export stats, and job status |
| `GET /ops/background-jobs`          | returns cleanup/heartbeat status without mutating state                          |
| `POST /ops/background-jobs/cleanup` | runs immediate cleanup for expired cache entries and export jobs                 |

#### `repositories/ops-repository.js` function inventory

| Function                     | Purpose                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `loadDatabaseOverview(pool)` | returns database name, user, version, and timestamp for ops UI |

#### `utils/concurrency.js` function inventory

| Function                                                     | Purpose                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `normalizeLookupText(value)`                                 | normalizes lookup strings for case-insensitive locking and querying           |
| `normalizeDisplayText(value)`                                | collapses whitespace while preserving user-facing capitalization              |
| `hashTextToInt(value)`                                       | hashes text into a deterministic 32-bit integer lock key                      |
| `lockScopedResource(client, ownerId, namespace, resourceId)` | acquires an owner-scoped PostgreSQL advisory lock for the current transaction |

#### `utils/cache.js` function inventory

| Function                                          | Purpose                                                     |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `readPositiveInt(value, fallback)`                | parses cache-size and TTL values                            |
| `TtlCache`                                        | bounded in-memory TTL cache implementation                  |
| `getUserCachePrefix(userId)`                      | creates a stable owner cache prefix                         |
| `makeUserCacheKey(userId, namespace, requestUrl)` | creates owner + namespace + URL cache keys                  |
| `invalidateUserCache(userId, namespace)`          | deletes cached entries for one owner and optional namespace |

#### `utils/export-queue.js` function inventory

| Function                                              | Purpose                                               |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `readPositiveInt(value, fallback)`                    | parses export queue size, concurrency, and TTL values |
| `parseFilenameFromDisposition(disposition, fallback)` | extracts a safe filename from response headers        |
| `ExportQueue`                                         | bounded in-memory async export queue implementation   |

#### `utils/monitoring.js` function inventory

| Function                             | Purpose                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| `roundTo(value, decimals)`           | formats metric numbers                                               |
| `getMemoryUsageMb()`                 | reports current process memory usage                                 |
| `normalizeRoutePath(pathname)`       | redacts numeric, phone, and UUID route segments for grouping         |
| `getRouteStatsKey(method, pathname)` | builds a normalized metric key per route                             |
| `incrementBucket(bucket, key)`       | increments one in-memory monitoring counter                          |
| `markHttpRequestStarted()`           | increments active request count                                      |
| `markHttpRequestFinished()`          | decrements active request count                                      |
| `recordHttpRequest(details)`         | records status, duration, slow-request, and per-route counters       |
| `buildMonitoringSnapshot(pool)`      | returns the combined service, request, DB, cache, and export metrics |

#### `utils/background-jobs.js` function inventory

| Function                           | Purpose                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| `readPositiveInt(value, fallback)` | parses cleanup and heartbeat interval configuration     |
| `getMemoryUsageMb()`               | creates the memory snapshot used in heartbeat data      |
| `getPoolStats(pool)`               | normalizes DB-pool counts for heartbeat/status payloads |
| `runCleanup()`                     | prunes expired response-cache entries and export jobs   |
| `startBackgroundJobs(options)`     | starts cleanup and heartbeat timers                     |
| `stopBackgroundJobs()`             | stops cleanup and heartbeat timers during shutdown      |
| `getBackgroundJobStatus(pool)`     | returns job state plus cache, export, and DB-pool stats |

#### `utils/pagination.js` function inventory

| Function                                                  | Purpose                                                |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `parsePagination(query, defaultLimit, maxLimit, options)` | normalizes `limit`, `page`, and `offset` values        |
| `buildPaginationMeta(pagination, total, rowCount)`        | builds JSON pagination metadata for enabled pagination |
| `setPaginationHeaders(res, pagination, total, rowCount)`  | writes pagination headers on list responses            |

#### `utils/runtime-log.js` function inventory

| Function                       | Purpose                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `isSensitiveKey(key)`          | detects log keys that must be redacted                      |
| `normalizeError(error)`        | converts native `Error` objects into JSON-safe log metadata |
| `sanitizeValue(value, depth)`  | recursively sanitizes log metadata and limits deep nesting  |
| `logEvent(level, event, meta)` | writes structured JSON logs to `stdout` or `stderr`         |

#### `public/js/service-worker-register.js` function inventory

| Function                             | Purpose                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `cleanupInventoryServiceWorker()`    | starts service-worker/cache cleanup after page load                     |
| `isInventoryRuntimeCache(cacheName)` | identifies old inventory app-shell runtime caches                       |
| `clearRuntimeCaches()`               | deletes old `shop-inventory-runtime-*` and `inventory-runtime-*` caches |
| `unregisterInventoryWorkers()`       | unregisters same-origin service-worker registrations                    |

#### `public/service-worker.js` function inventory

| Function                             | Purpose                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `isInventoryRuntimeCache(cacheName)` | identifies old inventory app-shell runtime caches                       |
| `clearInventoryRuntimeCaches()`      | deletes old `shop-inventory-runtime-*` and `inventory-runtime-*` caches |

The rollback worker also listens for `install`, `activate`, and `fetch`. It clears old caches during install/activate, unregisters itself during activation, and intentionally leaves `fetch` without `respondWith()` so browser requests go directly to the network.

#### `public/js/permission-contract.js` function inventory

| Function                       | Purpose                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `createPermissionContract()`   | constructs the shared permission configuration object used by backend and frontend |
| `normalizePermissions(values)` | deduplicates and validates permission keys against the supported contract          |

#### `public/js/app-core.js` function inventory

| Function                                        | Purpose                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `bootstrapInventoryApp(global)`                 | initializes the shared frontend application contract and publishes `window.InventoryApp` |
| `escapeHtml(value)`                             | safely escapes HTML before injecting text into the DOM                                   |
| `normalizePermissions(values)`                  | normalizes permission arrays using the shared contract when available                    |
| `getPermissionOption(permission)`               | returns the UI metadata for one permission key                                           |
| `formatPermissionSummary(permissions, options)` | converts permission arrays into a short human-readable summary                           |
| `clearStoredSession()`                          | removes legacy session artifacts from `localStorage`                                     |
| `isMobileLayout()`                              | checks whether the UI is currently in mobile layout                                      |
| `normalizeSessionRole(value)`                   | constrains client-side session role values to owner or staff                             |
| `isOwnerUser(user)`                             | identifies owner sessions on the client side                                             |
| `getUserPermissions(user)`                      | returns the current permission set for a user                                            |
| `canAccessPermission(user, ...permissions)`     | answers whether a user can access a given permission area                                |
| `canAccessSection(user, sectionId)`             | maps a dashboard section ID to the correct permission check                              |

#### `public/js/app-shell.js` function inventory

| Function                                  | Purpose                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `bootstrapInventoryShell(global)`         | initializes the reusable sidebar shell controller                                                          |
| `syncAndroidSidebarGestureLock(isLocked)` | coordinates sidebar gesture locking with the Android wrapper bridge                                        |
| `ensureStyles()`                          | injects sidebar CSS once into the document head                                                            |
| `ensureShell()`                           | creates or reuses the sidebar/toggle DOM shell                                                             |
| `syncFooterText()`                        | refreshes footer text from the current app contract                                                        |
| `buildDashboardButton(item)`              | renders one dashboard navigation button                                                                    |
| `buildInvoiceButton(item)`                | renders the invoice-page navigation button                                                                 |
| `getElements()`                           | returns cached references to the shell's core DOM nodes                                                    |
| `renderSidebar(pageType)`                 | rebuilds the sidebar markup for the current page type                                                      |
| `setupSidebar(pageType, options)`         | wires sidebar rendering, refresh-page action, open/close behavior, scroll locking, and selection callbacks |

#### `public/js/dashboard.js` workflow map

[`../public/js/dashboard.js`](../public/js/dashboard.js) is the largest page controller in the project. Instead of acting as a shared helper library, it orchestrates the full dashboard screen. Its named functions are best understood in workflow groups:

- session/bootstrap: `hideElement`, `showElement`, `markDashboardReady`, `authHeaders`, `handleSessionExpiry`, `checkAuth`
- formatting/search helpers: `formatCount`, `formatNumber`, `formatCurrency`, `formatDate`, `normalizeSearchKey`, `buildStringSearchIndex`, `getSearchMatches`, `debounce`
- touch-safe dropdown helpers: `setupScrollableDropdown`, `scheduleDropdownHide`, `renderDropdown`, `renderItemNameDropdown`, `setupFilterInput`
- shared purchase pricing defaults: `normalizeProfitPercentValue`, `applySharedProfitPercent`, `saveProfitPercentDefault`, `queueProfitPercentSave`, `loadProfitPercentDefault`
- serialized purchase capture: `normalizeSerialEntry`, `parseSerialNumbersInput`, `findDuplicateSerialNumber`, `stopSerialCameraScanner`, `ensureSerialScannerModal`, `createSerialBarcodeDetector`, `startSerialCameraScan`
- purchase and stock-intake workflow: `purchaseRows`, `getPurchaseDefaultProfitPercent`, `refreshPurchaseAutoRates`, `updatePurchaseSummary`, `addPurchaseItemRow`, `loadSupplierSuggestions`, `renderSupplierDropdown`, `loadPurchaseSearchSuggestions`, `renderPurchaseSearchDropdown`, `loadProductPurchaseHistory`, `renderProductPurchaseHistory`, `loadPurchaseReport`, `openPurchaseDetail`, `submitPurchaseRepayment`, `searchSupplierLedger`, `showAllSupplierSummary`, `deleteSupplierLedger`, `deletePurchaseBill`, `deletePurchaseItem`, `refreshPurchaseViewsAfterDelete`, `submitPurchase`
- expense workflow: `renderExpenseReport`, `loadExpenseReport`, `submitExpense`
- report/export workflow: `renderItemReport`, `loadItemReport`, `loadLowStock`, `renderReorderPlanner`, `renderSlowMovingPlanner`, `renderSalesReport`, `loadSalesReport`, `loadGstReport`, `downloadItemReportPDF`, `downloadSalesPDF`, `downloadSalesExcel`, `downloadGstPDF`, `downloadGstExcel`
- due ledger workflow: `getDueFormSnapshot`, `updateCustomerDuePreview`, `loadCustomerSuggestions`, `renderCustomerDropdown`, `applyCustomerDueSuggestion`, `searchLedger`, `showAllDues`, `refreshCurrentDueView`, `deleteLedgerCustomer`, `deleteLedgerEntry`, `submitDebt`
- shared owner-only action menu workflow: `isOwnerSession`, `renderLedgerActionMenu`, `bindLedgerActionMenus`, `closeLedgerActionMenus`, `getLedgerMenuHostClass`, `getLedgerMenuPrimaryClass`
- dashboard analytics: `loadDashboardOverview`, `loadBusinessTrend`, `renderBusinessTrend`, `loadLast13MonthsChart`, `renderLast13MonthsChart`, `loadSalesNetProfitCard`
- staff/owner workflow: `renderStaffPermissionGrid`, `readStaffPermissionSelection`, `setStaffPermissionSelection`, `renderStaffList`, `loadStaffAccounts`, `createStaffAccount`
- event wiring: `bindPopupEvents`, `bindPurchaseEvents`, `bindReportEvents`, `bindCustomerDueEvents`, `bindExpenseEvents`, `bindSupportEvents`, `bindStaffEvents`

#### `public/invoice.html` inline controller workflow map

[`../public/invoice.html`](../public/invoice.html) contains a large page-local controller. Its main named workflow groups are:

- session and permissions: `loadSession`, `applySessionAccess`, `redirectAwayFromInvoiceIfNeeded`, `canAccessInvoicePage`, `logoutAndRedirect`
- confirmation and downloads: `showPopup`, `downloadInvoice`, queued export polling helpers, `setBusy`, `withButtonState`
- draft and totals: `rowData`, `getCurrentPaymentSnapshot`, `updatePaymentPreview`, `buildDraft`, `saveDraft`, `queueDraft`, `restoreDraft`, `recalcTotals`
- serialized item capture: `normalizeSerialEntry`, `parseSerialNumbersInput`, `findDuplicateSerialNumber`, `stopSerialCameraScanner`, `ensureSerialScannerModal`, `createSerialBarcodeDetector`, `startSerialCameraScan`
- dropdown/search: `setupScrollableDropdown`, `scheduleDropdownHide`, `renderDropdown`, `loadCustomerSuggestions`, `renderCustomerDropdown`, `renderInvoiceSuggestionDropdown`, `loadItemNames`, `loadInvoiceSuggestions`
- invoice line controller: `addItemRow(...)` owns item lookup, quantity/serial slot rendering, serial-specific rate synchronization, buying-rate tracking, Sale % to rate calculation, rate to Sale % calculation, total/GST calculation, and line validation
- invoice history and settlement: `renderDetail`, `renderList`, `loadExact`, `receiveInvoicePayment`, `performSearch`
- save path: `loadShopInfo`, `saveShopProfile`, `payload`, `preCheck`, `submitInvoice`, `resetInvoice`

Important payload boundary: `rowData(...)` contains `sale_profit_percent` and `buying_rate` so a draft can restore the pricing helper, but `payload()` strips those helper properties before `POST /api/invoices`. Only the final `rate` and selected `serial_numbers` affect saved invoice/business rows.

#### Developer support frontend workflow map

- [`../public/js/developer-login.js`](../public/js/developer-login.js):
  - login/register state: `setMode`, `setStatus`, `handleLoginSubmit`, `handleRegisterSubmit`
  - input normalization: `normalizeName`, `normalizeEmail`, `normalizeDeveloperAccessKey`
  - shared request helper: `requestJSON`
  - page boot: `checkExistingSession`, `clearRegisterAccessKey`, `bindPasswordToggles`, `bindModeSwitch`
- [`../public/js/developer-support.js`](../public/js/developer-support.js):
  - shared request helper: `requestJSON`
  - queue/search rendering: `renderFilterState`, `getFilteredConversations`, `renderConversationSearchDropdown`, `renderConversationList`
  - thread rendering: `renderDetailCard`, `renderThread`, `renderThreadEmpty`, `updateHeroStats`, `setReplyEnabled`
  - developer actions: `loadConversations`, `loadConversation`, `refreshInbox`, `submitReply`, `updateConversationStatus`, `logoutDeveloper`
  - page lifecycle: `bootstrapPage` plus a quiet polling interval that refreshes the active inbox

## 8. Auth, Session, and Permission Model

### Session model

- Owner login happens through `POST /api/auth/login`.
- Google owner login starts at `GET /api/auth/google/start` and finishes through `GET /api/auth/google/callback`.
- Staff login happens through `POST /api/auth/staff/login`.
- On success, [`routes/auth.js`](../routes/auth.js) signs a JWT and stores it in an `httpOnly` cookie named `token`.
- Cookie settings:
  - `httpOnly: true`
  - `sameSite: "lax"`
  - `secure: true` only in production
  - max age: 1 day
- Password reset links use `BASE_URL` when available.
- In production, password reset flow effectively requires `BASE_URL` to be configured.

### Google OAuth owner flow

Current Google sign-in behavior:

- `GET /api/auth/google/start` creates a signed state token, stores it in the `google_oauth_state` cookie for 10 minutes, and redirects to Google.
- `GET /api/auth/google/callback` validates the state, exchanges the code with Google, fetches the verified profile, and either links or logs in the owner.
- Existing owners are matched by `google_sub` first, then by verified email; successful matches refresh `users.google_sub`, `google_email_verified`, and `google_picture_url`.
- New Google owners receive a short-lived `google_onboarding` cookie and are redirected to `login.html?google_onboarding=1`.
- `GET /api/auth/google/onboarding` lets the login page read the pending Google email/name without exposing the full token.
- `POST /api/auth/google/complete-profile` requires shop name and 10-digit mobile number, creates the owner and `settings` row, clears onboarding, and sets the normal `token` cookie.
- Android wrapper mode uses `client=android`, signs a 5-minute transfer token, and targets the `indiainventory://google-auth` deep link. `/api/auth/google/android-open` renders an intent/manual-open fallback page, while `/api/auth/google/android-transfer` converts the transfer back into the web cookie flow.

### Developer support session model

- Developer account registration happens through `POST /api/developer-auth/register`.
- Developer inbox login happens through `POST /api/developer-auth/login`.
- On success, [`routes/support.js`](../routes/support.js) signs a JWT and stores it in an `httpOnly` cookie named `developer_support_token`.
- Developer inbox pages verify access through `GET /api/developer-auth/me`.
- Current first-party developer pages do not persist a readable developer token in browser storage.
- The developer registration key can be configured through `DEVELOPER_REGISTRATION_KEY`, with the current code keeping the older built-in fallback for backward compatibility.

### Client bootstrap

- `login.html` checks `/api/auth/me` to detect an active session.
- `login.html` also handles Google return flags, opens the first-time Google profile modal, and removes `google_onboarding` / `google_error` query parameters from browser history.
- `reset.html` prefers the generated URL-hash email/token form, accepts query parameters as a compatibility fallback, and then removes both forms from browser history.
- `index.html` and `invoice.html` use cookie-based requests with `credentials: "include"`.
- Dashboard and invoice fetch helpers handle one stale-permission case by refreshing `/api/auth/me` after a `403`, reapplying section access, and retrying/redirecting only when the refreshed permissions still do not allow the action.
- Frontend code no longer depends on a token response body to stay logged in.

### Staff permission model

Staff access is page-scoped and shared between backend and frontend through [`../public/js/permission-contract.js`](../public/js/permission-contract.js).

Important rules:

- staff accounts belong to an owner account
- max 2 staff accounts per owner is enforced in application logic
- owners always have all permissions
- staff page permissions come from `staff_accounts.page_permissions`
- active staff session data can be cached in memory when `STAFF_SESSION_CACHE_TTL_MS` is greater than `0`; the default `0` disables the cache and reloads staff state on each auth pass
- frontend uses the same permission contract to hide or show sections
- backend uses `requirePermission(...)` to enforce actual access control
- destructive ledger and purchase cleanup actions use owner-only `requireOwner` routes, so staff cannot delete customer ledgers, supplier ledgers, purchase bills, or purchase bill items even if they have page access
- active staff permissions are:
  - `purchase_entry`
  - `sale_invoice`
  - `stock_report`
  - `sales_report`
  - `gst_report`
  - `customer_due`
  - `expense_tracking`
- default staff permissions are `purchase_entry` and `sale_invoice`
- `purchase_entry` is labelled "Purchase Entry / Add Stock" because stock creation and replenishment now happen from purchase bills
- the old `add_stock` key is retired from the active contract and schema defaults; old aliases are not exposed in the staff UI

## 9. Security and Runtime Guardrails

Current hardening that is visible in the codebase:

- CSP with per-request nonce in [`../server.js`](../server.js)
- `worker-src 'self'` allows only first-party service workers
- `script-src-attr 'none'` and `style-src-attr 'none'`
- `x-powered-by` disabled
- `helmet.frameguard`, `helmet.noSniff`, and `helmet.referrerPolicy`
- request-body limits default to `1mb` JSON and `200kb` URL-encoded data
- CORS allowlist instead of open production fallback
- API-wide rate limit of `500` requests per `15` minutes
- health/readiness/liveness routes are exempt from the API rate limiter
- login limiter in [`../routes/auth.js`](../routes/auth.js):
  - `10` attempts per `15` minutes
  - skips successful requests
- password reset limiter:
  - `5` attempts per `15` minutes
- password reset tokens are hashed before being stored in `users.reset_token`
- reset links place the token in the URL hash, so the token is not sent back to the server as a query parameter during initial page load
- Google OAuth state and onboarding data are short-lived signed JWT cookies
- Google OAuth only creates accounts after verified Google email plus required shop name and 10-digit mobile number
- auth-sensitive responses mark `Cache-Control: no-store`
- `/service-worker.js` is served with `Cache-Control: no-cache` and `Service-Worker-Allowed: /` so updates are checked while preserving root scope
- the current service-worker rollback path does not intercept fetches, so authenticated JSON, exports, invoice PDFs, report data, stock data, payment state, and diagnostics are never fulfilled from browser Cache Storage
- old app-shell runtime caches are deleted by both the cleanup helper and rollback worker
- `/network-check(.html)` is generated with `Cache-Control: no-store`, `Pragma: no-cache`, and `X-Robots-Tag: noindex, nofollow`
- developer support login now relies on the `developer_support_token` cookie rather than returning a browser-readable token in the response body
- owner-only delete routes for customer ledgers, supplier ledgers, purchase bills, and purchase items are protected with `requireOwner`; the frontend also hides their 3-dot menus from staff sessions
- Excel export sanitizes formula-like cell values in [`../routes/inventory.js`](../routes/inventory.js)
- invoice PDF downloads now rely on the authenticated cookie-based fetch path used by the first-party frontend
- queued export jobs are owner-scoped; `/api/exports/:jobId` returns `404` if another owner tries to read the job
- cached JSON responses are owner-scoped and can be bypassed with `_no_cache=1`
- DB-pool backpressure returns `503` before regular API processing when the PostgreSQL waiting queue is saturated
- list endpoints using pagination emit `X-Total-Count`, `X-Limit`, `X-Offset`, and `X-Has-More`
- every response gets an `X-Request-Id` header
- health endpoints emit `Cache-Control: no-store`
- maintenance mode emits no-store `503` responses with `Retry-After` while leaving health paths available
- runtime emits structured JSON logs for:
  - app bootstrap
  - DB initialization
  - readiness
  - shutdown
  - uncaught process errors
  - slow requests, 5xx responses, and optionally all requests
- structured logs redact password, token, authorization, cookie, and access-key fields before serialization
- graceful shutdown uses explicit server timeouts and closes the PostgreSQL pool before exit
- PostgreSQL pool diagnostics include statement timeout, query timeout, idle-in-transaction timeout, and pool waiting counts in startup/ops data

### Known implementation caveats

These are current code facts and follow-up items, not security guarantees:

- **JWT role separation:** `authMiddleware` special-cases only `staff` and rewrites any other valid token as an owner session. Developer-support tokens use the same `JWT_SECRET`; if one is manually supplied as a Bearer token, it can be misclassified as an owner ID. The main middleware should explicitly allow only owner/admin/staff token purposes.
- **Developer registration:** `DEVELOPER_REGISTRATION_KEY` has a built-in fallback. Production must set a private value; a future hardening change should fail closed when it is absent.
- **OAuth state binding:** the Google callback accepts a valid signed state or a matching cookie rather than requiring both, so browser-to-login binding is weaker than a strict state-cookie check.
- **Shared signing secret:** owner/staff sessions, developer sessions, OAuth state, onboarding, and Android transfer tokens share one secret and do not enforce issuer/audience/purpose claims.
- **Session revocation:** staff and developer accounts are checked against PostgreSQL, but a normal owner JWT is accepted for its one-day lifetime without a fresh owner-status lookup.
- **Route ordering:** broad middleware mounted on the inventory/business routers intercepts later `/api` routes. API health aliases are not public, unknown API paths can return `401`, and business/invoice calls may repeat authentication. Use non-API health probes until the route scopes/order are fixed.
- **CSRF model:** state-changing endpoints do not use an explicit CSRF token and rely mainly on `SameSite=Lax` cookies plus origin/CORS behavior.
- **Single-process state:** the rate limiter, response cache, metrics, Android callback map, and export queue are memory-local; they reset on restart and are not coordinated across replicas.
- **External request timeouts:** Google token/profile calls and the password-reset mail relay use `fetch` without explicit timeouts.
- **Process recovery:** `unhandledRejection` and `uncaughtException` are logged but do not terminate the process, so the deployment restart policy may not activate after a fatal runtime state.
- **Database transport and tenancy:** enabled PostgreSQL SSL uses `rejectUnauthorized: false`, and the database has no row-level security/composite tenant constraints; owner separation relies on application queries.
- **Developer logout defect:** `logoutDeveloper()` calls undefined `clearStoredDeveloperToken()` before redirecting. The server cookie is cleared, but the resulting `ReferenceError` can prevent the expected client redirect.
- **Reset compatibility URL:** generated reset links use a hash, but `reset.html` also accepts a query-string token; query tokens can appear in the initial request URL and intermediary logs.
- **PWA/privacy metadata:** `site.webmanifest` declares the 1254x1254 `app_logo.png` as `512x512`, and the privacy page does not yet explicitly describe stored serial numbers, bank/UPI profile data, or optional camera-based serial scanning.

## 10. Main Business Workflows

### Owner registration

```text
login.html
  -> POST /api/auth/register
  -> users row created
  -> user returns to login
```

### Owner login

```text
login.html
  -> POST /api/auth/login
  -> token cookie set
  -> GET /api/auth/me succeeds
  -> redirect to index.html
```

### Google owner sign-in

```text
login.html
  -> GET /api/auth/google/start
  -> Google account picker
  -> GET /api/auth/google/callback
  -> if owner already exists, token cookie is set and user goes to index.html
  -> if owner is new, google_onboarding cookie is set
  -> login.html opens Google profile modal
  -> POST /api/auth/google/complete-profile with shop name + mobile
  -> users and settings rows are created
  -> token cookie is set and user goes to index.html
```

### Staff login

```text
login.html
  -> POST /api/auth/staff/login
  -> token cookie set
  -> GET /api/auth/me returns staff session + permissions
  -> dashboard/invoice UI hides unauthorized sections
```

### Purchase Entry / Add Stock

The old standalone Add New Stock page is retired. Stock is now added or replenished through supplier purchase bills.

```text
index.html purchase section
  -> GET /api/stock-defaults loads default Profit % for purchase rows
  -> GET /api/suppliers while typing supplier name
  -> selecting a supplier fills name, mobile number, and address
  -> item rows use /api/items/names autocomplete and /api/items/info where prior item pricing is needed
  -> optional whole-number item quantities create matching manual/camera serial slots
  -> POST /api/purchases
  -> supplier record is found or created
  -> purchases header is saved
  -> purchase_items rows are saved
  -> items stock quantity and rates are updated
  -> optional item_serials rows are saved with purchase/item links and status in_stock
  -> supplier due remains tracked through purchase payment fields
```

Important implementation notes:

- `POST /api/items` is absent; there is no preserved retired handler or retired HTML template
- only a commented `add_stock` permission entry in [`../routes/inventory.js`](../routes/inventory.js) and a dead `addStockSection` check in [`../public/js/app-shell.js`](../public/js/app-shell.js) remain as cleanup candidates
- default profit percent still lives in `settings.default_profit_percent`, but access is now tied to `purchase_entry`

### Serialized-item lifecycle

```text
Purchase Entry
  -> one optional serial/SN per whole-number purchased unit
  -> frontend rejects duplicate/count mismatch
  -> POST /api/purchases normalizes and owner-locks every serial key
  -> owner-unique item_serials rows are inserted with purchase, purchase_item, item, and sale_rate
  -> status starts as in_stock

Invoice Entry
  -> GET /api/item-serials searches up to 25 in-stock units
  -> user selects, types, or camera-scans one serial per sold unit
  -> POST /api/invoices locks and verifies owner, item name, status, uniqueness, and quantity/count
  -> stock and sales rows are written atomically
  -> serial status becomes sold and invoice, invoice_item, sale, and sold_at are recorded
```

Important rules:

- serial normalization is case-insensitive for owner-level uniqueness, while `serial_no` preserves display text
- serialized purchase and invoice quantities must be positive whole numbers and equal the serial count
- a sold serial cannot be selected again
- serialized returns are not supported by the serial path; negative return-style invoice lines use non-serial stock handling
- purchase/bill/item deletion is rejected if any linked serial is already sold; this is stricter than the aggregate stock-quantity check
- deleting unsold purchase data cascades its linked serial rows through the schema

### Supplier ledger and purchase bill views

```text
index.html Purchase Desk
  -> Bills View calls GET /api/purchases/report with date and search filters
  -> Supplier Ledger search calls GET /api/suppliers and GET /api/suppliers/:supplierId/ledger
  -> Bill View search and Supplier Ledger search both provide supplier dropdown selection
  -> Supplier Ledger View All clears the search input and calls GET /api/suppliers/summary without a q filter
  -> Supplier Ledger detail rows are ordered by purchase_date DESC, id DESC
  -> clicking a bill row opens GET /api/purchases/:purchaseId
  -> supplier repayment posts to /api/purchases/:purchaseId/repayment
  -> owner 3-dot actions call DELETE /api/suppliers/:supplierId/ledger, DELETE /api/purchases/:purchaseId, or DELETE /api/purchase-items/:itemId
```

Important delete behavior:

- supplier ledger delete removes the supplier's purchase bills but keeps the supplier master row
- purchase bill delete removes the bill and cascades line items through the schema
- purchase item delete recalculates the parent bill subtotal, paid amount, due amount, and payment status
- purchase item delete is blocked for the last remaining item; delete the full bill instead
- all purchase delete paths roll back stock by matching normalized purchase item names to `items.name`
- all purchase delete paths stop if a linked `item_serials` row has status `sold`
- deletes fail safely if the current stock quantity is lower than the quantity being reversed
- these delete actions are owner-only; staff users can view assigned purchase pages but cannot see or call the delete controls

### Product purchase history

```text
index.html Product Purchase History card
  -> product input reuses item-name autocomplete
  -> GET /api/purchases/product-history?item_name=...
  -> purchase_items rows are joined to purchases and suppliers
  -> dashboard renders latest buy rate, total units, total amount, and bill rows
  -> clicking a row opens the original purchase detail card
```

### Invoice creation

```text
invoice.html
  -> GET /api/invoices/new
  -> GET /api/invoices/customers while typing customer name
  -> selecting a customer fills customer name, contact number, and address
  -> selecting an item loads buying rate and current selling rate
  -> Sale % can calculate the line rate, or a rate edit recalculates Sale %
  -> optional serial search/scan calls GET /api/item-serials and fills serial-specific rates
  -> user adds customer info and item rows
  -> optional payment mode / amount paid decides paid, partial, due, or return status
  -> POST /api/invoices
  -> invoice_no generated
  -> invoices row inserted
  -> invoice_items rows inserted
  -> sales rows inserted
  -> selected item_serials rows marked sold and linked to invoice/invoice_items/sales
  -> items quantity reduced, or increased for return lines
  -> optional PDF download action includes saved shop bank/UPI rows and generated UPI QR when available
```

`Sale %` and its buying-rate reference are browser-side pricing/draft helpers only. The final API payload saves the resulting line `rate` plus any `serial_numbers`; no Sale % or buying-rate column is added to `invoice_items`.

### Invoice due settlement

```text
invoice history / detail view
  -> POST /api/invoices/:invoiceNo/payment
  -> invoices.amount_paid / amount_due updated
  -> debts row inserted as settlement ledger entry
```

### Customer due management

```text
dashboard due section
  -> POST /api/debts for new ledger entries
  -> optional address can be saved from the Due Entry card
  -> name and mobile inputs call GET /api/debts/customers for address-aware autocomplete
  -> GET /api/debts/:number for one customer ledger
  -> GET /api/debts/:number/pdf for customer ledger PDF
  -> GET /api/debts for all due summary
  -> summary rows show the latest saved address under the customer name when available
  -> PDF Customer Details shows Customer, Mobile Number, and Address
  -> owner 3-dot actions call DELETE /api/debts/customers/:number or DELETE /api/debts/entries/:id
  -> ledger rows render newest first in the UI and PDF, after chronological balance calculation
```

Important delete behavior:

- full customer ledger delete removes all `debts` rows for the selected customer number
- individual transaction delete removes one `debts` row
- if deleted debt rows were linked to invoices, invoice paid/due totals and payment status are recalculated from the remaining debt ledger rows
- delete actions are hidden from staff and blocked by owner-only backend guards

### Supplier repayment

```text
dashboard purchase section
  -> POST /api/purchases/:purchaseId/repayment
  -> purchase amount_paid / amount_due updated
  -> payment mode may become mixed
  -> purchase note gets repayment stamp context
```

### Reports and exports

```text
dashboard report sections
  -> stock report PDF
  -> sales report PDF + Excel
  -> GST report compare + PDF + Excel
  -> sales trend charts
  -> purchase and expense reports in dashboard UI
  -> frontend appends _async_export=1 for PDF/Excel downloads
  -> middleware/export-queue.js creates an in-memory export job
  -> frontend polls /api/exports/:jobId
  -> frontend downloads through /api/exports/:jobId/download after completion
```

### Ops metrics and cleanup

```text
owner session
  -> GET /api/ops/metrics
  -> routes/ops.js combines monitoring snapshot, DB overview, and background job state
  -> GET /api/ops/background-jobs reads cleanup/heartbeat status
  -> POST /api/ops/background-jobs/cleanup prunes expired response-cache and export-queue entries immediately
```

### Support chat flow

```text
index.html support chat section
  -> GET /api/support/thread
  -> POST /api/support/messages
  -> support_conversations row is created or reused per owner/staff requester
  -> support_messages rows store the full thread
  -> unread_for_developer increments until a developer opens the thread
```

### Developer support inbox flow

```text
developer-login.html
  -> POST /api/developer-auth/login or /api/developer-auth/register
  -> developer_support_token cookie set on login
  -> GET /api/developer-auth/me confirms active developer session
  -> developer-support.html loads /api/developer-support/conversations
  -> developer replies via /api/developer-support/conversations/:conversationId/reply
  -> conversation status updates via /api/developer-support/conversations/:conversationId/status
```

## 11. API Route Map

Most endpoints below are mounted under either `/api/auth` or `/api`; health and diagnostic routes also exist at non-API paths for deployment probes and mobile-network troubleshooting. The seven route files declare 84 live router endpoints: auth 17, inventory 27, business 14, invoices 11, support 10, exports 2, and ops 3.

Access legend:

- `Public`: no session; global API rate limiting still applies
- `Session`: owner or active staff cookie/Bearer JWT
- `Owner`: `Session` plus `requireOwner`
- permission names such as `purchase_entry`: active session plus `requirePermission(...)`; owners automatically pass
- `Developer`: active `developer_support_token` or developer Bearer JWT

Domain guard summary:

| Domain                                        | Effective access                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| auth start/login/register/reset/Google routes | Public, with endpoint-specific login/reset limiters and temporary cookies                |
| staff list/create/update/delete               | Owner                                                                                    |
| inventory lookup/report/debt routes           | Session plus the relevant page permission; dashboard overview and debt deletes are Owner |
| purchases/suppliers                           | `purchase_entry`; destructive supplier/purchase/item deletes are Owner                   |
| expenses                                      | `expense_tracking`                                                                       |
| invoices and shop-info read                   | `sale_invoice`; shop-info write is Owner                                                 |
| owner/staff support thread                    | Session                                                                                  |
| developer inbox                               | Developer                                                                                |
| exports                                       | Session and owner-workspace job ownership                                                |
| ops                                           | Owner                                                                                    |

### 11.1 Auth routes from `routes/auth.js`

| Method   | Path                                   | Purpose                                         |
| -------- | -------------------------------------- | ----------------------------------------------- |
| `GET`    | `/api/auth/google/start`               | start Google OAuth login                        |
| `GET`    | `/api/auth/google/callback`            | finish Google OAuth callback                    |
| `GET`    | `/api/auth/google/android-open`        | render Android intent/manual-open fallback page |
| `GET`    | `/api/auth/google/android-transfer`    | convert Android Google transfer token           |
| `GET`    | `/api/auth/google/onboarding`          | read pending first-time Google profile          |
| `POST`   | `/api/auth/google/complete-profile`    | finish first-time Google owner setup            |
| `POST`   | `/api/auth/register`                   | create owner account                            |
| `POST`   | `/api/auth/login`                      | owner login by email or mobile                  |
| `POST`   | `/api/auth/staff/login`                | staff login by username                         |
| `POST`   | `/api/auth/logout`                     | clear session cookie                            |
| `POST`   | `/api/auth/forgot-password`            | create reset token and send reset email         |
| `POST`   | `/api/auth/reset-password`             | validate reset token and update password        |
| `GET`    | `/api/auth/staff`                      | list staff accounts for current owner           |
| `POST`   | `/api/auth/staff`                      | create a staff account                          |
| `PATCH`  | `/api/auth/staff/:staffId/permissions` | update page permissions                         |
| `DELETE` | `/api/auth/staff/:staffId`             | permanently delete a staff account row          |
| `GET`    | `/api/auth/me`                         | return normalized current session               |

### 11.2 Inventory routes from `routes/inventory.js`

| Method   | Path                             | Purpose                                                        |
| -------- | -------------------------------- | -------------------------------------------------------------- |
| `GET`    | `/api/stock-defaults`            | load Purchase Entry default profit percent                     |
| `PUT`    | `/api/stock-defaults`            | save Purchase Entry default profit percent                     |
| `GET`    | `/api/items/names`               | item name autocomplete for purchase, invoice, and stock report |
| `GET`    | `/api/items/info`                | item detail lookup by name for purchase and invoice flows      |
| `GET`    | `/api/item-serials`              | search up to 25 in-stock serials by item/query or exact serial |
| `GET`    | `/api/items/report`              | stock report rows                                              |
| `GET`    | `/api/items/low-stock`           | low stock list                                                 |
| `GET`    | `/api/items/reorder-suggestions` | reorder planner                                                |
| `GET`    | `/api/items/slow-moving`         | slow-moving stock planner                                      |
| `GET`    | `/api/items/report/pdf`          | stock report PDF                                               |
| `GET`    | `/api/sales/report`              | sales report rows                                              |
| `GET`    | `/api/sales/report/pdf`          | sales report PDF                                               |
| `GET`    | `/api/sales/report/excel`        | sales report Excel                                             |
| `GET`    | `/api/gst/report`                | GST report rows                                                |
| `GET`    | `/api/gst/compare`               | month-by-month GST comparison                                  |
| `GET`    | `/api/gst/report/pdf`            | GST report PDF                                                 |
| `GET`    | `/api/gst/report/excel`          | GST report Excel                                               |
| `POST`   | `/api/debts`                     | add customer due ledger entry with optional address            |
| `DELETE` | `/api/debts/customers/:number`   | owner-only delete of all due rows for one customer             |
| `DELETE` | `/api/debts/entries/:id`         | owner-only delete of one due ledger transaction                |
| `GET`    | `/api/debts/customers`           | search customers by name, number, or address                   |
| `GET`    | `/api/debts/:number/pdf`         | customer ledger PDF with mobile number and address details     |
| `GET`    | `/api/debts/:number`             | load one customer ledger with saved address values             |
| `GET`    | `/api/debts`                     | summary of all dues, including latest saved customer address   |
| `GET`    | `/api/dashboard/overview`        | owner dashboard summary cards                                  |
| `GET`    | `/api/sales/monthly-trend`       | monthly sales chart data                                       |
| `GET`    | `/api/sales/last-13-months`      | rolling 13-month sales chart data                              |

Retired inventory route note:

- `POST /api/items` is not defined. Active stock creation/update happens through `POST /api/purchases`; the only old backend trace is a commented `add_stock` permission name near shared item lookup.

### 11.3 Business routes from `routes/business.js`

| Method   | Path                                   | Purpose                                                                |
| -------- | -------------------------------------- | ---------------------------------------------------------------------- |
| `GET`    | `/api/suppliers`                       | supplier search and quick lookup                                       |
| `POST`   | `/api/purchases`                       | save purchase, restock inventory, and register optional serial units   |
| `GET`    | `/api/purchases/report`                | purchase report list                                                   |
| `GET`    | `/api/purchases/product-history`       | product-wise purchase item history                                     |
| `GET`    | `/api/purchases/:purchaseId`           | purchase detail with line items and linked serials                     |
| `DELETE` | `/api/purchases/:purchaseId`           | owner-only purchase bill delete with stock rollback                    |
| `DELETE` | `/api/purchase-items/:itemId`          | owner-only bill item delete with stock rollback and bill recalculation |
| `POST`   | `/api/purchases/:purchaseId/repayment` | record supplier repayment                                              |
| `GET`    | `/api/suppliers/summary`               | supplier balance summary                                               |
| `DELETE` | `/api/suppliers/:supplierId/ledger`    | owner-only delete of all purchase bills for one supplier               |
| `GET`    | `/api/suppliers/:supplierId/ledger`    | supplier ledger / purchase history, newest first                       |
| `POST`   | `/api/expenses`                        | save expense entry                                                     |
| `GET`    | `/api/expenses/suggestions`            | expense title/category suggestions                                     |
| `GET`    | `/api/expenses/report`                 | expense report and summary                                             |

### 11.4 Invoice routes from `routes/invoices.js`

| Method | Path                               | Purpose                                                        |
| ------ | ---------------------------------- | -------------------------------------------------------------- |
| `GET`  | `/api/invoices/new`                | preview next invoice number                                    |
| `POST` | `/api/invoices`                    | atomically create invoice and update stock/sales/serial status |
| `GET`  | `/api/invoices/customers`          | customer autocomplete for billing                              |
| `GET`  | `/api/invoices/suggestions`        | invoice search dropdown suggestions                            |
| `GET`  | `/api/invoices/numbers`            | invoice number list                                            |
| `GET`  | `/api/invoices`                    | invoice history list                                           |
| `GET`  | `/api/invoices/:invoiceNo`         | full invoice, line, serial, and settlement detail              |
| `POST` | `/api/invoices/:invoiceNo/payment` | receive invoice due payment                                    |
| `GET`  | `/api/invoices/:invoiceNo/pdf`     | invoice PDF download                                           |
| `POST` | `/api/shop-info`                   | save owner shop, GST, bank, and UPI profile                    |
| `GET`  | `/api/shop-info`                   | load shop, GST, bank, and UPI profile                          |

### 11.5 Support routes from `routes/support.js`

| Method  | Path                                                            | Purpose                                           |
| ------- | --------------------------------------------------------------- | ------------------------------------------------- |
| `POST`  | `/api/developer-auth/register`                                  | create a developer support account                |
| `POST`  | `/api/developer-auth/login`                                     | developer support login                           |
| `GET`   | `/api/developer-auth/me`                                        | return normalized current developer session       |
| `POST`  | `/api/developer-auth/logout`                                    | clear developer support session cookie            |
| `GET`   | `/api/support/thread`                                           | load the current owner/staff support thread       |
| `POST`  | `/api/support/messages`                                         | send an owner/staff support message               |
| `GET`   | `/api/developer-support/conversations`                          | load the developer inbox queue                    |
| `GET`   | `/api/developer-support/conversations/:conversationId/messages` | load one developer inbox thread                   |
| `POST`  | `/api/developer-support/conversations/:conversationId/reply`    | send a developer reply                            |
| `PATCH` | `/api/developer-support/conversations/:conversationId/status`   | update a conversation between `open` and `closed` |

### 11.6 Export routes from `routes/exports.js`

| Method | Path                           | Purpose                                     |
| ------ | ------------------------------ | ------------------------------------------- |
| `GET`  | `/api/exports/:jobId`          | read queued export status for current owner |
| `GET`  | `/api/exports/:jobId/download` | download completed queued export file       |

### 11.7 Ops routes from `routes/ops.js`

All ops routes require an owner session.

| Method | Path                               | Purpose                                                    |
| ------ | ---------------------------------- | ---------------------------------------------------------- |
| `GET`  | `/api/ops/metrics`                 | request, memory, DB, cache, export, and background metrics |
| `GET`  | `/api/ops/background-jobs`         | background cleanup and heartbeat status                    |
| `POST` | `/api/ops/background-jobs/cleanup` | run cleanup immediately                                    |

### 11.8 Health routes from `server.js`

| Method | Path group                                                                            | Current behavior                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`, `/healthz`, `/ready`, `/readyz`                                            | public readiness with DB state; `200` ready or `503` not ready                                                                                                                                              |
| `GET`  | `/live`, `/livez`                                                                     | public process liveness without DB-ready gating                                                                                                                                                             |
| `GET`  | `/api/health`, `/api/healthz`, `/api/ready`, `/api/readyz`, `/api/live`, `/api/livez` | handlers are registered, but current router order first crosses the support DB gate and broad API auth guards; unauthenticated calls return `401` after DB readiness rather than the intended probe payload |

Railway correctly uses non-API `/health`. Do not configure a platform or load-balancer probe to an `/api/*` health alias until the route registration/guard scopes are corrected.

### 11.9 Network diagnostic route from `server.js`

| Method | Path group                              | Purpose                                                                          |
| ------ | --------------------------------------- | -------------------------------------------------------------------------------- |
| `GET`  | `/network-check`, `/network-check.html` | no-store browser diagnostic page that checks `/live`, `/health`, and `/api/live` |

The `/api/live` row in this diagnostic currently also reveals the API-route-order problem: an unauthenticated browser can see `401` there even while `/live` and `/health` prove the service is healthy.

### 11.10 Conditional debug routes from `server.js`

These non-API routes are registered only when `NODE_ENV` is not `production` and `ENABLE_DEBUG_ROUTES=true`. They have no session guard, so enable them only in a controlled development environment; maintenance mode can still intercept them.

| Method | Path         | Purpose                                                                                                    |
| ------ | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `GET`  | `/debug-env` | report selected runtime configuration as set/missing indicators without returning configured secret values |
| `GET`  | `/debug-db`  | run `SELECT NOW()` to test direct database connectivity                                                    |

## 12. Database Schema

### 12.1 Schema source of truth

Primary schema references:

- [`../migrations/full_updated_schema.sql`](../migrations/full_updated_schema.sql)
- runtime compatibility patching in [`../db.js`](../db.js)
- any future incremental migration files added under [`../migrations/`](../migrations)

Current migration boundary:

- `full_updated_schema.sql` is the only SQL migration file and is a transactional full snapshot, not a versioned history
- there is no package script, migration runner, or migration ledger table
- [`../db.js`](../db.js) applies a sequence of individually autocommitted compatibility statements; failure can leave a partial patch
- startup compatibility cannot initialize an empty database because it begins by altering existing core tables, and `IF NOT EXISTS` does not repair a drifted existing definition
- install the full snapshot for a fresh database, then let startup compatibility handle supported older deployments

### 12.2 Ownership model

This app uses an owner-scoped model:

- `users` is the root business owner table
- `staff_accounts.owner_user_id` points back to the owner
- almost every business record, including `item_serials`, stores `user_id`
- backend code uses `getUserId(req)` so staff always operate in owner scope

That means:

- one owner account controls one business data space
- staff do not get separate stock, invoice, or report databases
- deleting the owner cascades through most business tables

### 12.3 ER diagram

```mermaid
erDiagram
  users ||--o{ staff_accounts : owns
  users ||--o{ support_conversations : opens
  users ||--o| settings : configures
  users ||--o{ items : owns
  users ||--o{ sales : records
  users ||--o{ debts : tracks
  users ||--o{ suppliers : owns
  users ||--o{ purchases : creates
  users ||--o{ expenses : logs
  users ||--o{ invoices : creates
  users ||--o{ item_serials : owns
  users ||--o{ user_invoice_counter : increments

  items ||--o{ sales : sold_as
  suppliers ||--o{ purchases : supplies
  purchases ||--o{ purchase_items : contains
  invoices ||--o{ invoice_items : contains
  items ||--o{ item_serials : identifies
  purchases o|--o{ item_serials : sources
  purchase_items o|--o{ item_serials : contains_units
  invoices o|--o{ item_serials : sells
  invoice_items o|--o{ item_serials : assigns
  sales o|--o{ item_serials : records
  invoices o|--o{ debts : linked_settlements
  support_conversations ||--o{ support_messages : contains
```

### 12.4 Table summary

| Table                   | Purpose                                             | Main feature area      |
| ----------------------- | --------------------------------------------------- | ---------------------- |
| `users`                 | owner accounts                                      | auth                   |
| `staff_accounts`        | staff credentials and page permissions              | auth/staff             |
| `developer_admins`      | developer support login accounts                    | developer support auth |
| `support_conversations` | per-requester support thread headers                | support                |
| `support_messages`      | threaded support chat messages                      | support                |
| `settings`              | shop profile, GST/profit defaults, payment profile  | invoice/settings/stock |
| `items`                 | current stock master                                | inventory              |
| `sales`                 | item-level sales movement history                   | sales/reporting        |
| `debts`                 | customer due ledger and invoice settlement log      | dues                   |
| `suppliers`             | supplier master data                                | purchases              |
| `purchases`             | purchase header records                             | purchases              |
| `purchase_items`        | purchase line items                                 | purchases              |
| `expenses`              | expense ledger                                      | finance                |
| `invoices`              | invoice header records                              | billing                |
| `invoice_items`         | invoice line items                                  | billing                |
| `item_serials`          | owner-unique serialized units from purchase to sale | inventory/billing      |
| `user_invoice_counter`  | per-user daily invoice serial counter               | billing                |

### 12.5 Detailed table guide

#### `users`

Purpose:

- stores owner accounts
- supports registration, login, and password reset
- owns all business data

Key columns:

- `id`
- `name`
- `email`
- `mobile_number`
- `password_hash`
- `google_sub`
- `google_email_verified`
- `google_picture_url`
- `reset_token`
- `reset_token_expires`
- `created_at`
- `updated_at`

Notes:

- `is_verified` and `verify_token` exist in schema, but current core flows are centered on password login, Google OAuth, and reset rather than a full email-verification workflow
- Google OAuth profile data is optional. When present, `google_sub` is indexed uniquely so the same Google account cannot attach to multiple owners.

#### `staff_accounts`

Purpose:

- stores sub-users under one owner account
- keeps page-level access rules

Key columns:

- `id`
- `owner_user_id`
- `name`
- `username`
- `password_hash`
- `page_permissions`
- `is_active`
- `created_at`
- `updated_at`

Notes:

- max 2 staff accounts per owner is enforced in app logic, not with a DB constraint
- `page_permissions` defaults to `purchase_entry` and `sale_invoice`
- `add_stock` is no longer part of the active permission contract; stock-add capability is represented by `purchase_entry`

#### `developer_admins`

Purpose:

- stores developer support login accounts
- supports developer inbox login and optional registration
- keeps only one active normalized email identity after startup reconciliation

Key columns:

- `id`
- `name`
- `email`
- `password_hash`
- `is_active`
- `last_login_at`
- `created_at`
- `updated_at`

Notes:

- startup compatibility logic archives duplicates and enforces a normalized unique index on `LOWER(BTRIM(email))`
- `SUPPORT_ADMIN_*` environment variables can create or refresh a bootstrap developer account

#### `support_conversations`

Purpose:

- stores the thread header for each owner/staff requester
- tracks unread counters and conversation status for the developer inbox

Key columns:

- `id`
- `owner_user_id`
- `requester_actor_id`
- `requester_role`
- `requester_name`
- `requester_identifier`
- `status`
- `unread_for_user`
- `unread_for_developer`
- `last_message_at`
- `created_at`
- `updated_at`

Notes:

- one requester gets one thread per owner via the unique `(owner_user_id, requester_actor_id, requester_role)` constraint
- `status` is limited to `open` or `closed`

#### `support_messages`

Purpose:

- stores individual support-thread messages from either the requester or the developer team

Key columns:

- `id`
- `conversation_id`
- `sender_type`
- `sender_actor_id`
- `sender_role`
- `sender_name`
- `message_text`
- `created_at`

Notes:

- `sender_type` is constrained to `user` or `developer`
- blank messages are blocked by a DB check constraint and by route validation

#### `settings`

Purpose:

- stores at most one settings row per owner; local password registration can leave it absent until a settings endpoint upserts it
- shared business defaults and invoice header details

Key columns:

- `user_id`
- `shop_name`
- `shop_address`
- `gst_no`
- `gst_rate`
- `default_profit_percent`
- `bank_name`
- `account_holder_name`
- `account_number`
- `ifsc_code`
- `upi_id`

Notes:

- used by invoice shop profile and PDF payment detail block
- used by stock and purchase flows for default profit calculations
- `upi_id` is converted into a UPI payment URI and rendered as a QR code on invoice PDFs when possible

#### `items`

Purpose:

- current live stock master table

Key columns:

- `user_id`
- `name`
- `quantity`
- `buying_rate`
- `selling_rate`
- `created_at`
- `updated_at`

Notes:

- purchase flow increases quantity
- invoice flow reduces quantity
- return-style negative invoice quantity can increase quantity back

#### `sales`

Purpose:

- stores item-wise sales movement
- acts as historical transaction data for reports

Key columns:

- `user_id`
- `item_id`
- `quantity`
- `cost_price`
- `selling_price`
- `total_price`
- `gst_amount`
- `created_at`

Notes:

- `cost_price` is ensured and backfilled from `items.buying_rate` where possible by the [`../db.js`](../db.js) startup compatibility patch
- there is no direct `invoice_id` foreign key here; for serialized sales, `item_serials.sale_id` plus its invoice links provide a unit-level bridge

#### `debts`

Purpose:

- customer due ledger
- used both for manual due entries and invoice-linked collections

Key columns:

- `user_id`
- `customer_name`
- `customer_number`
- `customer_address`
- `total`
- `credit`
- generated column `balance`
- `remark`
- `invoice_id`
- `created_at`
- `updated_at`

Notes:

- `invoice_id` is nullable
- settlement rows can reference an invoice
- manual due entries can exist without invoice linkage
- `customer_address` is optional; manual Due Entry can save it and invoice-created due rows copy `invoices.address`
- customer name and mobile autocomplete returns name, number, and address; selecting a match fills the Due Entry address field
- due summary rows include the latest saved customer address and render it below the customer name when available
- customer ledger PDF details label the number as `Mobile Number` and print `Address` directly below it
- owner-only debt delete routes remove rows from this table; when removed rows reference invoices, the linked invoice paid/due totals are recalculated from remaining `debts` rows

#### `suppliers`

Purpose:

- supplier master records for purchase workflow
- source data for Supplier purchase entry autocomplete

Key columns:

- `user_id`
- `name`
- `mobile_number`
- `address`
- `created_at`
- `updated_at`

Notes:

- supplier lookup uses normalized name/mobile matching
- supplier creation/update is protected with advisory locks
- selecting a supplier in the purchase form fills name, mobile number, and address
- supplier ledger delete keeps this master supplier row and deletes the supplier's purchase bills instead

#### `purchases`

Purpose:

- purchase header or bill records

Key columns:

- `user_id`
- `supplier_id`
- `bill_no`
- `purchase_date`
- `subtotal`
- `amount_paid`
- `amount_due`
- `payment_mode`
- `payment_status`
- `note`
- `created_at`
- `updated_at`

Notes:

- repayment updates are written back into this row
- payment mode can become `mixed`
- owner-only purchase bill delete removes the purchase header after reversing stock for all linked `purchase_items`
- supplier ledger delete deletes multiple purchase headers for a supplier after the same stock rollback check

#### `purchase_items`

Purpose:

- line items for one purchase
- source data for the Product Purchase History dashboard card

Key columns:

- `purchase_id`
- `item_name`
- `quantity`
- `buying_rate`
- `selling_rate`
- `line_total`

Notes:

- this stores a snapshot of purchase data
- there is no direct foreign key to `items`
- `/api/purchases/product-history` joins purchase items to purchases and suppliers by product name
- owner-only item delete removes one line, reverses stock by normalized item name, and recalculates the parent purchase totals
- deleting the last item row is blocked; the full bill delete path should be used instead
- optional `item_serials.purchase_item_id` rows preserve the individual units captured for this line

#### `expenses`

Purpose:

- tracks business expenses for net profit visibility

Key columns:

- `user_id`
- `title`
- `category`
- `amount`
- `payment_mode`
- `expense_date`
- `note`
- `created_at`
- `updated_at`

#### `invoices`

Purpose:

- invoice header records
- source data for Billing details customer autocomplete on `invoice.html`

Key columns:

- `user_id`
- `invoice_no`
- `gst_no`
- `customer_name`
- `contact`
- `address`
- `date`
- `subtotal`
- `gst_amount`
- `total_amount`
- `payment_mode`
- `payment_status`
- `amount_paid`
- `amount_due`
- `created_at`
- `updated_at`

Notes:

- invoice numbers follow the pattern `INV-YYYYMMDD-userId-####`
- payment state is stored directly on the invoice
- `/api/invoices/customers` reads previous customer name, contact, and address values from this table

#### `invoice_items`

Purpose:

- line items for a saved invoice

Key columns:

- `invoice_id`
- `description`
- `quantity`
- `rate`
- `amount`

Notes:

- serialized invoice lines are linked through `item_serials.invoice_item_id`

#### `item_serials`

Purpose:

- stores one owner-unique serial/SN unit created by a purchase
- links the physical unit to its item, purchase lineage, and eventual invoice/sale lineage
- provides the `in_stock` lookup used by invoice serial autocomplete/scanning

Key columns:

- `id`
- `user_id`
- `item_id`
- `purchase_id`
- `purchase_item_id`
- `invoice_id`
- `invoice_item_id`
- `sale_id`
- `serial_no`
- `serial_no_norm`
- `sale_rate`
- `status`
- `created_at`
- `sold_at`

Notes:

- `(user_id, serial_no_norm)` is unique, so case/whitespace-normalized serials cannot be reused inside one owner workspace
- `status` is constrained to `in_stock` or `sold`
- purchase save records `sale_rate`; runtime compatibility backfills older rows from purchase-line or item selling rates
- invoice save locks matching rows, verifies owner/item/status, marks them sold, and sets invoice/invoice-item/sale links atomically
- purchase deletion is blocked when a linked serial is already sold
- purchase and item lineage use cascading deletes; invoice, invoice-item, and sale links use `ON DELETE SET NULL`

#### `user_invoice_counter`

Purpose:

- keeps the next per-user daily invoice serial number

Key columns:

- `user_id`
- `date_key`
- `next_no`
- `created_at`

Notes:

- primary key is `(user_id, date_key)`
- this is the core table behind invoice number generation

### 12.6 Full table dictionary

The dictionary below reflects the current effective schema from [`../migrations/full_updated_schema.sql`](../migrations/full_updated_schema.sql) plus compatibility patching in [`../db.js`](../db.js) for older deployments.

#### `users`

| Column                  | Type           | Null | Default  | Details                                      |
| ----------------------- | -------------- | ---- | -------- | -------------------------------------------- |
| `id`                    | `SERIAL`       | no   | sequence | primary key                                  |
| `name`                  | `VARCHAR(50)`  | no   | none     | owner display name                           |
| `email`                 | `VARCHAR(100)` | no   | none     | unique login identifier                      |
| `mobile_number`         | `VARCHAR(10)`  | yes  | none     | optional 10-digit mobile number              |
| `password_hash`         | `VARCHAR(255)` | no   | none     | bcrypt hash                                  |
| `is_verified`           | `BOOLEAN`      | yes  | `FALSE`  | currently not central to active auth flow    |
| `google_sub`            | `VARCHAR(255)` | yes  | none     | Google account subject identifier            |
| `google_email_verified` | `BOOLEAN`      | no   | `FALSE`  | whether the linked Google email was verified |
| `google_picture_url`    | `TEXT`         | yes  | none     | Google profile image URL                     |
| `verify_token`          | `VARCHAR(255)` | yes  | none     | legacy email verification token              |
| `reset_token`           | `VARCHAR(255)` | yes  | none     | hashed password reset token                  |
| `reset_token_expires`   | `TIMESTAMP`    | yes  | none     | reset token expiry                           |
| `created_at`            | `TIMESTAMPTZ`  | yes  | `NOW()`  | creation timestamp                           |
| `updated_at`            | `TIMESTAMPTZ`  | yes  | `NOW()`  | updated by trigger                           |

Constraints, indexes, and triggers:

- primary key on `id`
- unique key on `email`
- `mobile_number` must match a 10-digit numeric pattern when present
- schema index `idx_users_email` also covers direct email lookup
- runtime compatibility ensures `idx_users_email_lookup` on `LOWER(email)`
- runtime compatibility ensures `idx_users_google_sub_unique` for non-empty Google subject values
- trigger `update_users_timestamp` calls shared `update_timestamp()` before update

#### `staff_accounts`

| Column             | Type           | Null | Default                                           | Details                                            |
| ------------------ | -------------- | ---- | ------------------------------------------------- | -------------------------------------------------- |
| `id`               | `SERIAL`       | no   | sequence                                          | primary key                                        |
| `owner_user_id`    | `INT`          | no   | none                                              | foreign key to `users.id` with `ON DELETE CASCADE` |
| `name`             | `VARCHAR(80)`  | no   | none                                              | staff display name                                 |
| `username`         | `VARCHAR(50)`  | no   | none                                              | staff login identifier                             |
| `password_hash`    | `VARCHAR(255)` | no   | none                                              | bcrypt hash                                        |
| `page_permissions` | `TEXT[]`       | no   | `ARRAY['purchase_entry', 'sale_invoice']::TEXT[]` | page-level access contract                         |
| `is_active`        | `BOOLEAN`      | no   | `TRUE`                                            | staff availability flag                            |
| `created_at`       | `TIMESTAMPTZ`  | yes  | `NOW()`                                           | creation timestamp                                 |
| `updated_at`       | `TIMESTAMPTZ`  | yes  | `NOW()`                                           | updated by trigger                                 |

Constraints, indexes, and triggers:

- primary key on `id`
- foreign key `owner_user_id -> users.id`
- check `staff_accounts_name_length` enforces trimmed name length `>= 2`
- check `staff_accounts_username_length` enforces trimmed username length `>= 3`
- indexes: `idx_staff_accounts_owner_user_id`, `idx_staff_accounts_username_unique`, plus runtime compatibility index `idx_staff_accounts_username_lookup`
- trigger `update_staff_accounts_timestamp` calls shared `update_timestamp()`

#### `developer_admins`

| Column          | Type           | Null | Default  | Details                                |
| --------------- | -------------- | ---- | -------- | -------------------------------------- |
| `id`            | `SERIAL`       | no   | sequence | primary key                            |
| `name`          | `VARCHAR(120)` | no   | none     | developer support display name         |
| `email`         | `VARCHAR(120)` | no   | none     | developer support login email          |
| `password_hash` | `VARCHAR(255)` | no   | none     | bcrypt hash                            |
| `is_active`     | `BOOLEAN`      | no   | `TRUE`   | developer support account availability |
| `last_login_at` | `TIMESTAMPTZ`  | yes  | none     | latest successful login timestamp      |
| `created_at`    | `TIMESTAMPTZ`  | yes  | `NOW()`  | creation timestamp                     |
| `updated_at`    | `TIMESTAMPTZ`  | yes  | `NOW()`  | updated by trigger                     |

Constraints, indexes, and triggers:

- primary key on `id`
- schema-level unique key on `email`
- runtime compatibility reconciles duplicate normalized emails before enforcing `idx_developer_admins_email_normalized_unique`
- indexes: `idx_developer_admins_email_lookup`, `idx_developer_admins_email_normalized_unique`
- trigger `update_developer_admins_timestamp` calls shared `update_timestamp()`

#### `support_conversations`

| Column                 | Type           | Null | Default  | Details                                            |
| ---------------------- | -------------- | ---- | -------- | -------------------------------------------------- |
| `id`                   | `SERIAL`       | no   | sequence | primary key                                        |
| `owner_user_id`        | `INT`          | no   | none     | foreign key to `users.id` with `ON DELETE CASCADE` |
| `requester_actor_id`   | `INT`          | no   | none     | owner/staff actor ID within the owner workspace    |
| `requester_role`       | `VARCHAR(20)`  | no   | none     | `owner` or `staff`                                 |
| `requester_name`       | `VARCHAR(120)` | no   | none     | display name shown in support queues               |
| `requester_identifier` | `VARCHAR(120)` | yes  | none     | email, username, or other requester identifier     |
| `status`               | `VARCHAR(20)`  | no   | `'open'` | conversation state: `open` or `closed`             |
| `unread_for_user`      | `INT`          | no   | `0`      | replies waiting for the owner/staff requester      |
| `unread_for_developer` | `INT`          | no   | `0`      | requester messages waiting for developer support   |
| `last_message_at`      | `TIMESTAMPTZ`  | yes  | none     | latest message timestamp for inbox sorting         |
| `created_at`           | `TIMESTAMPTZ`  | yes  | `NOW()`  | creation timestamp                                 |
| `updated_at`           | `TIMESTAMPTZ`  | yes  | `NOW()`  | updated by trigger                                 |

Constraints, indexes, and triggers:

- primary key on `id`
- foreign key `owner_user_id -> users.id`
- check `support_conversations_requester_role_check` limits requester roles to `owner` or `staff`
- check `support_conversations_status_check` limits status to `open` or `closed`
- unique key `support_conversations_unique_requester` keeps one support thread per owner/requester/role
- indexes: `idx_support_conversations_owner_lookup`, `idx_support_conversations_queue`, `idx_support_conversations_unread_queue`
- trigger `update_support_conversations_timestamp` calls shared `update_timestamp()`

#### `support_messages`

| Column            | Type           | Null | Default  | Details                                                |
| ----------------- | -------------- | ---- | -------- | ------------------------------------------------------ |
| `id`              | `SERIAL`       | no   | sequence | primary key                                            |
| `conversation_id` | `INT`          | no   | none     | foreign key to `support_conversations.id` with cascade |
| `sender_type`     | `VARCHAR(20)`  | no   | none     | `user` or `developer`                                  |
| `sender_actor_id` | `INT`          | no   | none     | sender ID in the relevant actor table                  |
| `sender_role`     | `VARCHAR(30)`  | no   | none     | more specific role label recorded with the message     |
| `sender_name`     | `VARCHAR(120)` | no   | none     | sender display name snapshot                           |
| `message_text`    | `TEXT`         | no   | none     | support message body                                   |
| `created_at`      | `TIMESTAMPTZ`  | yes  | `NOW()`  | creation timestamp                                     |

Constraints, indexes, and triggers:

- primary key on `id`
- foreign key `conversation_id -> support_conversations.id`
- check `support_messages_sender_type_check` limits sender type to `user` or `developer`
- check `support_messages_message_not_blank` blocks blank messages
- index `idx_support_messages_conversation_created`
- no update trigger exists because messages are append-only thread entries

#### `settings`

| Column                   | Type           | Null | Default  | Details                                                   |
| ------------------------ | -------------- | ---- | -------- | --------------------------------------------------------- |
| `id`                     | `SERIAL`       | no   | sequence | primary key                                               |
| `user_id`                | `INT`          | no   | none     | unique foreign key to `users.id` with `ON DELETE CASCADE` |
| `shop_name`              | `VARCHAR(150)` | yes  | none     | invoice and report branding                               |
| `shop_address`           | `TEXT`         | yes  | none     | invoice header address                                    |
| `gst_no`                 | `VARCHAR(20)`  | yes  | none     | business GST number                                       |
| `gst_rate`               | `NUMERIC(5,2)` | no   | `18.00`  | default GST rate for invoices                             |
| `default_profit_percent` | `NUMERIC(8,2)` | no   | `30.00`  | shared stock/purchase default margin                      |
| `bank_name`              | `VARCHAR(150)` | yes  | none     | bank name printed in invoice payment details              |
| `account_holder_name`    | `VARCHAR(150)` | yes  | none     | account holder printed in invoice payment details         |
| `account_number`         | `VARCHAR(64)`  | yes  | none     | account number printed in invoice payment details         |
| `ifsc_code`              | `VARCHAR(20)`  | yes  | none     | IFSC code printed in invoice payment details              |
| `upi_id`                 | `VARCHAR(120)` | yes  | none     | UPI ID printed on invoice PDF and used for the UPI QR URI |

Constraints, indexes, and triggers:

- primary key on `id`
- unique key on `user_id`
- foreign key `user_id -> users.id`
- no `updated_at` trigger exists on this table

#### `items`

| Column         | Type            | Null | Default  | Details                                            |
| -------------- | --------------- | ---- | -------- | -------------------------------------------------- |
| `id`           | `SERIAL`        | no   | sequence | primary key                                        |
| `user_id`      | `INT`           | no   | none     | foreign key to `users.id` with `ON DELETE CASCADE` |
| `name`         | `VARCHAR(255)`  | no   | none     | item name                                          |
| `quantity`     | `NUMERIC(12,2)` | yes  | `0`      | current quantity on hand                           |
| `buying_rate`  | `NUMERIC(10,2)` | yes  | `0`      | latest cost basis snapshot                         |
| `selling_rate` | `NUMERIC(10,2)` | yes  | `0`      | latest sale rate snapshot                          |
| `created_at`   | `TIMESTAMPTZ`   | yes  | `NOW()`  | creation timestamp                                 |
| `updated_at`   | `TIMESTAMPTZ`   | yes  | `NOW()`  | updated by trigger                                 |

Constraints, indexes, and triggers:

- primary key on `id`
- foreign key `user_id -> users.id`
- indexes: `idx_items_user_name`, `idx_items_user_id`, plus runtime compatibility index `idx_items_user_name_lookup`
- trigger `update_items_timestamp` calls shared `update_timestamp()`
- schema allows nullable numeric rate/quantity columns, but application logic treats them as required inputs

#### `sales`

| Column          | Type            | Null | Default  | Details                                                               |
| --------------- | --------------- | ---- | -------- | --------------------------------------------------------------------- |
| `id`            | `SERIAL`        | no   | sequence | primary key                                                           |
| `user_id`       | `INT`           | no   | none     | foreign key to `users.id` with `ON DELETE CASCADE`                    |
| `item_id`       | `INT`           | no   | none     | foreign key to `items.id` with `ON DELETE CASCADE`                    |
| `quantity`      | `NUMERIC(12,2)` | no   | none     | sold quantity; negative quantity is possible for return-style entries |
| `cost_price`    | `NUMERIC(10,2)` | no   | `0`      | stored cost basis for margin reporting                                |
| `selling_price` | `NUMERIC(10,2)` | no   | none     | unit selling rate                                                     |
| `total_price`   | `NUMERIC(12,2)` | no   | none     | line total                                                            |
| `gst_amount`    | `NUMERIC(12,2)` | no   | `0`      | line-level GST amount written during invoice creation                 |
| `created_at`    | `TIMESTAMPTZ`   | yes  | `NOW()`  | sale timestamp                                                        |

Constraints, indexes, and triggers:

- primary key on `id`
- foreign keys `user_id -> users.id`, `item_id -> items.id`
- indexes: `idx_sales_user_date`, `idx_sales_user_id`, plus runtime compatibility indexes `idx_sales_user_date_desc`, `idx_sales_user_item_date`
- no update trigger because this table is append-oriented movement history

#### `debts`

| Column             | Type            | Null      | Default                                | Details                                                         |
| ------------------ | --------------- | --------- | -------------------------------------- | --------------------------------------------------------------- |
| `id`               | `SERIAL`        | no        | sequence                               | primary key                                                     |
| `user_id`          | `INT`           | no        | none                                   | foreign key to `users.id` with `ON DELETE CASCADE`              |
| `customer_name`    | `VARCHAR(100)`  | no        | none                                   | customer display name                                           |
| `customer_number`  | `VARCHAR(10)`   | no        | none                                   | 10-digit customer mobile number                                 |
| `customer_address` | `TEXT`          | yes       | none                                   | optional customer address captured from due entry or invoice    |
| `total`            | `NUMERIC(12,2)` | yes       | `0`                                    | debit amount added to the ledger                                |
| `credit`           | `NUMERIC(12,2)` | yes       | `0`                                    | amount collected against the ledger row                         |
| `balance`          | `NUMERIC(12,2)` | generated | `GENERATED ALWAYS AS (total - credit)` | stored generated balance                                        |
| `remark`           | `TEXT`          | yes       | none                                   | free-text note                                                  |
| `invoice_id`       | `INT`           | yes       | none                                   | optional foreign key to `invoices.id` with `ON DELETE SET NULL` |
| `created_at`       | `TIMESTAMPTZ`   | yes       | `NOW()`                                | creation timestamp                                              |
| `updated_at`       | `TIMESTAMPTZ`   | yes       | `NOW()`                                | updated by trigger                                              |

Constraints, indexes, and triggers:

- primary key on `id`
- foreign keys `user_id -> users.id`, `invoice_id -> invoices.id`
- `customer_number` must match a 10-digit numeric pattern
- indexes: `idx_debts_user_id`, `idx_debts_user_number_created`, `idx_debts_invoice_id`, plus runtime compatibility index `idx_debts_user_customer_summary`
- trigger `update_debts_timestamp` calls shared `update_timestamp()`
- owner-only delete routes resync linked invoice balances after deleting invoice-linked debt rows

#### `suppliers`

| Column          | Type           | Null | Default  | Details                                            |
| --------------- | -------------- | ---- | -------- | -------------------------------------------------- |
| `id`            | `SERIAL`       | no   | sequence | primary key                                        |
| `user_id`       | `INT`          | no   | none     | foreign key to `users.id` with `ON DELETE CASCADE` |
| `name`          | `VARCHAR(120)` | no   | none     | supplier name                                      |
| `mobile_number` | `VARCHAR(10)`  | yes  | none     | optional supplier contact number                   |
| `address`       | `TEXT`         | yes  | none     | supplier address                                   |
| `created_at`    | `TIMESTAMPTZ`  | yes  | `NOW()`  | creation timestamp                                 |
| `updated_at`    | `TIMESTAMPTZ`  | yes  | `NOW()`  | updated by trigger                                 |

Constraints, indexes, and triggers:

- primary key on `id`
- foreign key `user_id -> users.id`
- check `suppliers_mobile_number_format` enforces 10-digit mobile when present
- indexes: `idx_suppliers_user_name`, `idx_suppliers_user_mobile`, `idx_suppliers_user_id`
- trigger `update_suppliers_timestamp` calls shared `update_timestamp()`
- `GET /api/suppliers` powers supplier ledger search and Purchase Entry supplier autofill
- owner-only supplier ledger delete removes related `purchases` rows but keeps this supplier record

#### `purchases`

| Column           | Type            | Null | Default  | Details                                                |
| ---------------- | --------------- | ---- | -------- | ------------------------------------------------------ |
| `id`             | `SERIAL`        | no   | sequence | primary key                                            |
| `user_id`        | `INT`           | no   | none     | foreign key to `users.id` with `ON DELETE CASCADE`     |
| `supplier_id`    | `INT`           | no   | none     | foreign key to `suppliers.id` with `ON DELETE CASCADE` |
| `bill_no`        | `VARCHAR(80)`   | yes  | none     | supplier bill/reference number                         |
| `purchase_date`  | `TIMESTAMPTZ`   | yes  | `NOW()`  | purchase timestamp                                     |
| `subtotal`       | `NUMERIC(12,2)` | no   | `0`      | purchase amount before payment split                   |
| `amount_paid`    | `NUMERIC(12,2)` | no   | `0`      | amount already paid                                    |
| `amount_due`     | `NUMERIC(12,2)` | no   | `0`      | remaining supplier due                                 |
| `payment_mode`   | `VARCHAR(20)`   | no   | `'cash'` | payment channel                                        |
| `payment_status` | `VARCHAR(20)`   | no   | `'paid'` | `paid`, `partial`, or `due` style state                |
| `note`           | `TEXT`          | yes  | none     | optional operator note                                 |
| `created_at`     | `TIMESTAMPTZ`   | yes  | `NOW()`  | creation timestamp                                     |
| `updated_at`     | `TIMESTAMPTZ`   | yes  | `NOW()`  | updated by trigger                                     |

Constraints, indexes, and triggers:

- primary key on `id`
- foreign keys `user_id -> users.id`, `supplier_id -> suppliers.id`
- indexes: `idx_purchases_user_date`, `idx_purchases_supplier_id`, `idx_purchases_user_id`, plus runtime compatibility indexes `idx_purchases_user_date_id_desc`, `idx_purchases_user_supplier_date`
- trigger `update_purchases_timestamp` calls shared `update_timestamp()`
- owner-only bill delete reverses stock and deletes this row; linked `purchase_items` are removed through `ON DELETE CASCADE`

#### `purchase_items`

| Column         | Type            | Null | Default  | Details                                                |
| -------------- | --------------- | ---- | -------- | ------------------------------------------------------ |
| `id`           | `SERIAL`        | no   | sequence | primary key                                            |
| `purchase_id`  | `INT`           | no   | none     | foreign key to `purchases.id` with `ON DELETE CASCADE` |
| `item_name`    | `VARCHAR(200)`  | no   | none     | line-level item name snapshot                          |
| `quantity`     | `NUMERIC(12,2)` | no   | `0`      | purchased quantity                                     |
| `buying_rate`  | `NUMERIC(12,2)` | no   | `0`      | line buying rate                                       |
| `selling_rate` | `NUMERIC(12,2)` | no   | `0`      | suggested selling rate snapshot                        |
| `line_total`   | `NUMERIC(12,2)` | no   | `0`      | line amount                                            |

Constraints, indexes, and triggers:

- primary key on `id`
- foreign key `purchase_id -> purchases.id`
- indexes: `idx_purchase_items_purchase`, plus runtime compatibility index `idx_purchase_items_item_lookup`
- no trigger exists because rows are immutable line snapshots
- product purchase history reads these rows and opens the original bill through `purchase_id`
- owner-only item delete removes one row, reverses stock, and recalculates the parent `purchases` totals

#### `expenses`

| Column         | Type            | Null | Default  | Details                                            |
| -------------- | --------------- | ---- | -------- | -------------------------------------------------- |
| `id`           | `SERIAL`        | no   | sequence | primary key                                        |
| `user_id`      | `INT`           | no   | none     | foreign key to `users.id` with `ON DELETE CASCADE` |
| `title`        | `VARCHAR(160)`  | no   | none     | expense label                                      |
| `category`     | `VARCHAR(80)`   | no   | none     | expense category                                   |
| `amount`       | `NUMERIC(12,2)` | no   | `0`      | expense amount                                     |
| `payment_mode` | `VARCHAR(20)`   | no   | `'cash'` | payment channel                                    |
| `expense_date` | `TIMESTAMPTZ`   | yes  | `NOW()`  | business expense timestamp                         |
| `note`         | `TEXT`          | yes  | none     | optional note                                      |
| `created_at`   | `TIMESTAMPTZ`   | yes  | `NOW()`  | creation timestamp                                 |
| `updated_at`   | `TIMESTAMPTZ`   | yes  | `NOW()`  | updated by trigger                                 |

Constraints, indexes, and triggers:

- primary key on `id`
- foreign key `user_id -> users.id`
- indexes: `idx_expenses_user_date`, `idx_expenses_user_id`, plus runtime compatibility indexes `idx_expenses_user_date_id_desc`, `idx_expenses_user_title_lookup`, `idx_expenses_user_category_lookup`
- trigger `update_expenses_timestamp` calls shared `update_timestamp()`

#### `invoices`

| Column           | Type            | Null | Default  | Details                                            |
| ---------------- | --------------- | ---- | -------- | -------------------------------------------------- |
| `id`             | `SERIAL`        | no   | sequence | primary key                                        |
| `user_id`        | `INT`           | no   | none     | foreign key to `users.id` with `ON DELETE CASCADE` |
| `invoice_no`     | `VARCHAR(40)`   | no   | none     | unique invoice identifier                          |
| `gst_no`         | `VARCHAR(20)`   | yes  | none     | invoice-specific GST number snapshot               |
| `customer_name`  | `VARCHAR(150)`  | yes  | none     | billed customer name                               |
| `contact`        | `VARCHAR(20)`   | yes  | none     | customer contact                                   |
| `address`        | `TEXT`          | yes  | none     | billing address                                    |
| `date`           | `TIMESTAMPTZ`   | yes  | `NOW()`  | invoice timestamp                                  |
| `subtotal`       | `NUMERIC(12,2)` | yes  | `0`      | amount before GST                                  |
| `gst_amount`     | `NUMERIC(12,2)` | yes  | `0`      | tax amount                                         |
| `total_amount`   | `NUMERIC(12,2)` | yes  | `0`      | final invoice total                                |
| `payment_mode`   | `VARCHAR(20)`   | no   | `'cash'` | current payment mode                               |
| `payment_status` | `VARCHAR(20)`   | no   | `'paid'` | current payment state                              |
| `amount_paid`    | `NUMERIC(12,2)` | no   | `0`      | cumulative received amount                         |
| `amount_due`     | `NUMERIC(12,2)` | no   | `0`      | outstanding amount                                 |
| `created_at`     | `TIMESTAMPTZ`   | yes  | `NOW()`  | creation timestamp                                 |
| `updated_at`     | `TIMESTAMPTZ`   | yes  | `NOW()`  | updated by trigger                                 |

Constraints, indexes, and triggers:

- primary key on `id`
- unique key on `invoice_no`
- foreign key `user_id -> users.id`
- indexes: `idx_invoices_user_date`, `idx_invoices_user_id`
- runtime compatibility also ensures `idx_invoices_user_date_id_desc`, `idx_invoices_user_invoice_lookup`, `idx_invoices_user_customer_lookup`, `idx_invoices_user_contact_lookup`, and partial due-collection index `idx_invoices_user_contact_due_date`
- trigger `update_invoices_timestamp` calls shared `update_timestamp()`
- `GET /api/invoices/customers` reads saved customer fields here to autofill Billing details

#### `invoice_items`

| Column        | Type            | Null | Default  | Details                                               |
| ------------- | --------------- | ---- | -------- | ----------------------------------------------------- |
| `id`          | `SERIAL`        | no   | sequence | primary key                                           |
| `invoice_id`  | `INT`           | no   | none     | foreign key to `invoices.id` with `ON DELETE CASCADE` |
| `description` | `VARCHAR(200)`  | yes  | none     | line description/item name snapshot                   |
| `quantity`    | `NUMERIC(12,2)` | yes  | `0`      | line quantity                                         |
| `rate`        | `NUMERIC(12,2)` | yes  | `0`      | line rate                                             |
| `amount`      | `NUMERIC(12,2)` | yes  | `0`      | line total                                            |

Constraints, indexes, and triggers:

- primary key on `id`
- foreign key `invoice_id -> invoices.id`
- index `idx_invoice_items_invoice`
- no update trigger exists because rows are line snapshots tied to an invoice header

#### `item_serials`

| Column             | Type            | Null | Default      | Details                                                      |
| ------------------ | --------------- | ---- | ------------ | ------------------------------------------------------------ |
| `id`               | `SERIAL`        | no   | sequence     | primary key                                                  |
| `user_id`          | `INT`           | no   | none         | foreign key to `users.id` with `ON DELETE CASCADE`           |
| `item_id`          | `INT`           | no   | none         | foreign key to `items.id` with `ON DELETE CASCADE`           |
| `purchase_id`      | `INT`           | yes  | none         | source purchase; `ON DELETE CASCADE`                         |
| `purchase_item_id` | `INT`           | yes  | none         | source purchase line; `ON DELETE CASCADE`                    |
| `invoice_id`       | `INT`           | yes  | none         | selling invoice; `ON DELETE SET NULL`                        |
| `invoice_item_id`  | `INT`           | yes  | none         | selling invoice line; `ON DELETE SET NULL`                   |
| `sale_id`          | `INT`           | yes  | none         | generated sales movement; `ON DELETE SET NULL`               |
| `serial_no`        | `VARCHAR(160)`  | no   | none         | preserved display serial/SN                                  |
| `serial_no_norm`   | `VARCHAR(160)`  | no   | none         | normalized owner-level lookup and uniqueness key             |
| `sale_rate`        | `NUMERIC(12,2)` | no   | `0`          | per-unit selling-rate snapshot used by invoice serial lookup |
| `status`           | `VARCHAR(20)`   | no   | `'in_stock'` | constrained to `in_stock` or `sold`                          |
| `created_at`       | `TIMESTAMPTZ`   | yes  | `NOW()`      | purchase-unit creation timestamp                             |
| `sold_at`          | `TIMESTAMPTZ`   | yes  | none         | timestamp set when the serial is sold                        |

Constraints, indexes, and triggers:

- primary key on `id`
- foreign keys to `users`, `items`, `purchases`, `purchase_items`, `invoices`, `invoice_items`, and `sales`
- check `item_serials_status_check` allows only `in_stock` and `sold`
- unique index `idx_item_serials_user_serial_unique` on `(user_id, serial_no_norm)`
- indexes `idx_item_serials_user_item_status`, `idx_item_serials_purchase_item`, and `idx_item_serials_invoice_item`
- no update trigger; status/link/timestamp transitions are explicit in invoice transactions

#### `user_invoice_counter`

| Column       | Type          | Null | Default | Details                                            |
| ------------ | ------------- | ---- | ------- | -------------------------------------------------- |
| `user_id`    | `INT`         | no   | none    | foreign key to `users.id` with `ON DELETE CASCADE` |
| `date_key`   | `DATE`        | no   | none    | per-day invoice bucket                             |
| `next_no`    | `INTEGER`     | no   | `1`     | next serial to allocate                            |
| `created_at` | `TIMESTAMPTZ` | yes  | `NOW()` | first creation timestamp                           |

Constraints, indexes, and triggers:

- composite primary key on `(user_id, date_key)`
- foreign key `user_id -> users.id`
- index `idx_user_invoice_counter_user_id`
- no update trigger exists

### 12.7 Relationship notes and data flow

#### Direct foreign keys

- `staff_accounts.owner_user_id -> users.id`
- `support_conversations.owner_user_id -> users.id`
- `support_messages.conversation_id -> support_conversations.id`
- `items.user_id -> users.id`
- `sales.user_id -> users.id`
- `sales.item_id -> items.id`
- `debts.user_id -> users.id`
- `debts.invoice_id -> invoices.id`
- `suppliers.user_id -> users.id`
- `purchases.user_id -> users.id`
- `purchases.supplier_id -> suppliers.id`
- `purchase_items.purchase_id -> purchases.id`
- `expenses.user_id -> users.id`
- `settings.user_id -> users.id`
- `invoices.user_id -> users.id`
- `invoice_items.invoice_id -> invoices.id`
- `item_serials.user_id -> users.id`
- `item_serials.item_id -> items.id`
- `item_serials.purchase_id -> purchases.id`
- `item_serials.purchase_item_id -> purchase_items.id`
- `item_serials.invoice_id -> invoices.id`
- `item_serials.invoice_item_id -> invoice_items.id`
- `item_serials.sale_id -> sales.id`
- `user_invoice_counter.user_id -> users.id`

#### Important indirect relationships

- `sales` rows are created during invoice save, but the schema does not store `invoice_id` inside `sales`
- `purchase_items` affect `items`, but the schema does not store `item_id` inside `purchase_items`
- `item_serials` is the durable bridge from a purchased unit to its item, source purchase line, selling invoice line, and generated sale row
- invoice collections are recorded through `debts` rows with `invoice_id`
- `support_conversations.requester_actor_id` is polymorphic by `requester_role`; it is not a direct foreign key to either `users` or `staff_accounts`
- `support_messages.sender_actor_id` is polymorphic by `sender_type` and `sender_role`; it records the sender but is not a direct foreign key

#### Main business data flows

Invoice save:

1. next invoice number is generated through `user_invoice_counter`
2. submitted serials are normalized, de-duplicated, locked, and checked for owner, item, and `in_stock` status
3. `invoices` header row is inserted
4. `invoice_items` rows are inserted
5. `items.quantity` is adjusted and `sales` rows are inserted
6. selected `item_serials` rows are marked `sold` and linked to the invoice, invoice line, sale, and `sold_at`
7. if the invoice is partial or due, due-related tracking continues through invoice payment fields and settlement rows

Purchase save:

1. supplier is found or created in `suppliers`
2. submitted serials are normalized and rejected when duplicated in the request or already present for that owner
3. `purchases` header is inserted
4. `purchase_items` rows are inserted
5. `items` stock and rate snapshot are updated
6. one `item_serials` row is inserted per serialized unit with its source purchase links and `sale_rate`

Purchase or supplier ledger delete:

1. owner-only route locks the purchase/supplier scope
2. linked `purchase_items` rows are loaded and grouped by normalized item name
3. delete is rejected when any linked serial has already been sold
4. `items.quantity` is reduced by the purchased quantity being removed
5. delete is rejected if stock would go below zero, which also protects already-sold non-serialized stock
6. the purchase bill is deleted, or the bill item is deleted and the purchase totals are recalculated; unsold linked serial rows cascade with their source line
7. supplier ledger delete applies the same bill-delete flow to all purchases for that supplier and keeps the supplier row

Invoice collection:

1. invoice row is locked and updated
2. payment totals are recalculated
3. a `debts` row is inserted as a collection ledger line
4. when invoice due rows are created, the invoice billing address is copied into `debts.customer_address` when available

Customer ledger delete:

1. owner-only route locks the selected customer ledger
2. the full customer ledger or one selected `debts` row is deleted
3. invoice IDs from deleted rows are collected
4. linked invoices are locked and their paid/due totals are recalculated from remaining debt rows
5. owner-scoped response cache is invalidated

### 12.8 Indexes, triggers, and compatibility behavior

Important index coverage includes:

- owner email lookup, including normalized `LOWER(email)` lookup
- item lookup by normalized name
- supplier lookup by normalized name and mobile
- purchase report by `user_id, purchase_date`
- purchase ledger/report ordering by `user_id, purchase_date, id`
- purchase product history by normalized `purchase_items.item_name`
- expense report by `user_id, expense_date`
- expense suggestions by normalized title/category
- invoice history by `user_id, date`
- invoice number, customer name, and contact lookup
- invoice items by `invoice_id`
- serialized stock by `(user_id, item_id, status)`, with owner-wide normalized serial uniqueness and source/sale-line lookup indexes
- debt settlement lookup by `invoice_id`
- staff lookup by normalized username
- Google owner lookup by non-empty `google_sub`
- developer support lookup by normalized email
- support inbox queue ordering and unread counts
- support message lookup by conversation and creation order
- due-collection lookup by `(user_id, contact, date)` for invoices with outstanding dues

Timestamp trigger coverage from [`../migrations/full_updated_schema.sql`](../migrations/full_updated_schema.sql):

- shared trigger function: `update_timestamp()` sets `NEW.updated_at = NOW()`
- `users`
- `staff_accounts`
- `developer_admins`
- `support_conversations`
- `items`
- `debts`
- `suppliers`
- `purchases`
- `expenses`
- `invoices`

Runtime compatibility patching in [`../db.js`](../db.js) exists so older databases can be brought closer to current expectations even before a full migration pass is run.

Compatibility limits:

- startup statements run individually rather than as one migration transaction, so a failure can leave a partially patched database
- `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` do not validate every type, constraint, or default when an object already exists
- the compatibility layer assumes the core tables already exist and cannot bootstrap an empty database by itself
- there is no migration ledger or automatic migration command in `package.json`; schema rollout order and verification are operator-managed

Data-integrity boundaries to keep in mind:

- owner `email` uniqueness is case-sensitive in PostgreSQL; the `LOWER(email)` lookup index is not unique, while normalized staff usernames are globally unique rather than owner-scoped
- many payment/status combinations, nonnegative monetary rules, and cross-table owner matches are enforced by application transactions instead of database constraints or row-level security
- `reset_token_expires` is a timezone-less `TIMESTAMP`; most operational timestamps use `TIMESTAMPTZ`
- application SQL does not set an explicit schema/search path

## 13. Environment Variables

| Variable                                    | Required                                        | Purpose                                                                                       |
| ------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                              | yes                                             | PostgreSQL connection string                                                                  |
| `DB_SSL`                                    | optional                                        | force SSL on or off; otherwise auto-detected from `DATABASE_URL`                              |
| `PG_POOL_MAX`                               | optional                                        | maximum PostgreSQL pool size                                                                  |
| `PG_CONNECTION_TIMEOUT_MS`                  | optional                                        | DB connect timeout in milliseconds                                                            |
| `PG_IDLE_TIMEOUT_MS`                        | optional                                        | DB idle timeout in milliseconds                                                               |
| `PG_KEEP_ALIVE_DELAY_MS`                    | optional                                        | initial keep-alive delay for DB connections                                                   |
| `PG_MAX_USES`                               | optional                                        | recycle DB connections after this many uses                                                   |
| `PG_STATEMENT_TIMEOUT_MS`                   | optional                                        | PostgreSQL statement timeout in milliseconds; `0` disables it                                 |
| `PG_QUERY_TIMEOUT_MS`                       | optional                                        | client query timeout in milliseconds; `0` disables it                                         |
| `PG_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS` | optional                                        | idle-in-transaction timeout in milliseconds; defaults to `30000`                              |
| `PG_APPLICATION_NAME`                       | optional                                        | PostgreSQL application name; defaults to `shop-inventory-api`                                 |
| `JWT_SECRET`                                | yes                                             | signing key for session JWTs                                                                  |
| `STAFF_SESSION_CACHE_TTL_MS`                | optional                                        | staff auth cache TTL in milliseconds; default `0` disables it; cache is capped at 200 entries |
| `PORT`                                      | optional                                        | HTTP port; defaults to `8080`                                                                 |
| `NODE_ENV`                                  | optional                                        | production/development behavior                                                               |
| `MAINTENANCE_MODE`                          | optional                                        | enable maintenance responses with `1`, `true`, `yes`, or `on`; health paths remain exempt     |
| `MAINTENANCE_MESSAGE`                       | optional                                        | user-facing maintenance text; defaults to `Sorry for the inconvenience.`                      |
| `MAINTENANCE_RETRY_AFTER_SECONDS`           | optional                                        | positive `Retry-After` value for maintenance responses; defaults to `3600`                    |
| `CORS_ALLOWED_ORIGINS`                      | recommended                                     | comma-separated allowlist for cross-origin requests                                           |
| `BASE_URL`                                  | recommended, effectively required in production | public app base URL, also used in reset links                                                 |
| `MAIL_RELAY_URL`                            | optional                                        | outbound mail relay endpoint                                                                  |
| `MAIL_RELAY_KEY`                            | optional                                        | credential for mail relay                                                                     |
| `GOOGLE_CLIENT_ID`                          | optional                                        | enables Google OAuth owner login when paired with client secret                               |
| `GOOGLE_CLIENT_SECRET`                      | optional                                        | Google OAuth client secret                                                                    |
| `GOOGLE_REDIRECT_URI`                       | optional                                        | explicit OAuth callback URL; otherwise derived from `BASE_URL`                                |
| `DEVELOPER_REGISTRATION_KEY`                | required for safe production setup              | private setup key used by `/api/developer-auth/register`; do not rely on the code fallback    |
| `SUPPORT_ADMIN_BOOTSTRAP`                   | optional                                        | when truthy, enables startup bootstrap/update of a developer admin                            |
| `SUPPORT_ADMIN_EMAIL`                       | optional                                        | email address for the bootstrap developer admin                                               |
| `SUPPORT_ADMIN_PASSWORD_HASH`               | optional                                        | pre-hashed bcrypt password for the bootstrap developer admin                                  |
| `SUPPORT_ADMIN_PASSWORD`                    | optional                                        | plain-text bootstrap password, hashed at startup if no hash is supplied                       |
| `SUPPORT_ADMIN_NAME`                        | optional                                        | display name for the bootstrap developer admin                                                |
| `JSON_BODY_LIMIT`                           | optional                                        | JSON request body size limit for Express; defaults to `1mb`                                   |
| `URLENCODED_BODY_LIMIT`                     | optional                                        | URL-encoded request body size limit for Express; defaults to `200kb`                          |
| `ENABLE_DEBUG_ROUTES`                       | optional                                        | enable `/debug-env` and `/debug-db` in non-production                                         |
| `ENABLE_REQUEST_LOGS`                       | optional                                        | log every request instead of only slow/error requests                                         |
| `REQUEST_LOG_SLOW_MS`                       | optional                                        | mark requests slower than this threshold for logging; defaults to `1500` ms                   |
| `DB_POOL_WAITING_REJECT_THRESHOLD`          | optional                                        | reject non-health API requests when DB pool waiting count reaches this; defaults to `20`      |
| `API_RATE_LIMIT_MAX`                        | optional                                        | `/api` request limit per 15-minute window; defaults to `500`                                  |
| `RESPONSE_CACHE_MAX_ENTRIES`                | optional                                        | max in-memory JSON response cache entries; defaults to `600`                                  |
| `EXPORT_QUEUE_TIMEOUT_MS`                   | optional                                        | internal export fetch timeout; defaults to `110000` ms                                        |
| `EXPORT_QUEUE_MAX_JOBS`                     | optional                                        | max in-memory queued export jobs; defaults to `80`                                            |
| `EXPORT_QUEUE_CONCURRENCY`                  | optional                                        | export worker concurrency; defaults to `1`                                                    |
| `EXPORT_QUEUE_TTL_MS`                       | optional                                        | completed/failed export retention; defaults to `600000` ms                                    |
| `BACKGROUND_CLEANUP_INTERVAL_MS`            | optional                                        | cache/export cleanup interval; defaults to `60000` ms                                         |
| `MONITOR_HEARTBEAT_INTERVAL_MS`             | optional                                        | monitor heartbeat log interval; defaults to `300000` ms                                       |

## 14. Maintenance Guide

### If you want to change login, reset password, or session behavior

Edit:

- [`../routes/auth.js`](../routes/auth.js)
- [`../middleware/auth.js`](../middleware/auth.js)
- [`../public/login.html`](../public/login.html)
- [`../public/reset.html`](../public/reset.html)

For Google sign-in specifically, update [`../routes/auth.js`](../routes/auth.js), [`../public/login.html`](../public/login.html), and the `GOOGLE_*` environment variables together. Keep the state/onboarding cookies short-lived and cookie-only.

### If you want to change login banners

- Add or replace `public/images/login_page_banner_1` through `login_page_banner_10` using `.png`, `.jpg`, `.jpeg`, or `.webp`.
- [`../server.js`](../server.js) discovers matching files, sorts them numerically, HTML-escapes the generated markup, and replaces the `<!-- LOGIN_BANNER_SLIDES -->` placeholder when serving [`../public/login.html`](../public/login.html).
- The current repository contains nine banner images; the carousel supports at most ten and includes autoplay, keyboard, touch-swipe, and reduced-motion behavior.
- Restart the Node process after changing banners because rendered HTML templates are cached in process memory.

### If you want to change shared navigation or permission names

Edit:

- [`../public/js/permission-contract.js`](../public/js/permission-contract.js)
- [`../public/js/app-core.js`](../public/js/app-core.js)
- [`../public/js/app-shell.js`](../public/js/app-shell.js)
- backend guards in [`../middleware/auth.js`](../middleware/auth.js)

Keep frontend labels, staff permission options, sidebar items, and backend `requirePermission(...)` guards aligned. `purchase_entry` currently owns the old stock-add capability, so do not reintroduce `add_stock` without updating the schema default, staff UI, backend guards, and migration notes together.

### If you want to change dashboard stock, purchase, report, due, or expense features

Edit:

- [`../public/index.html`](../public/index.html)
- [`../public/js/dashboard.js`](../public/js/dashboard.js)
- [`../routes/inventory.js`](../routes/inventory.js)
- [`../routes/business.js`](../routes/business.js)

For purchase-specific search/autofill behavior:

- supplier autocomplete lives in [`../public/js/dashboard.js`](../public/js/dashboard.js) and calls `GET /api/suppliers`
- bill-wise supplier search uses the same supplier dropdown selection path as Supplier Ledger
- Supplier Ledger View All should continue to clear the current search input and call `GET /api/suppliers/summary` without a search query
- product purchase history lives in [`../public/index.html`](../public/index.html), [`../public/js/dashboard.js`](../public/js/dashboard.js), and `GET /api/purchases/product-history`
- standalone Add New Stock UI is retired; stock changes should continue to go through `POST /api/purchases`
- serialized purchase rows allow one serial per whole-number unit; manual entry always works, while camera scanning depends on `BarcodeDetector`, `getUserMedia`, browser support, and a secure context or localhost
- serial changes must keep [`../public/js/dashboard.js`](../public/js/dashboard.js), `POST /api/purchases`, `GET /api/item-serials`, and the `item_serials` schema/compatibility code aligned
- mobile autocomplete/dropdown handlers deliberately distinguish scrolling/swiping from tapping and delay blur-based hiding; regression-test touch scrolling before simplifying those guards
- owner-only 3-dot delete actions are rendered from [`../public/js/dashboard.js`](../public/js/dashboard.js) and protected again in [`../routes/inventory.js`](../routes/inventory.js) / [`../routes/business.js`](../routes/business.js) with `requireOwner`
- purchase/supplier delete behavior must preserve stock rollback checks; customer debt delete behavior must preserve linked invoice balance resync

### If you want to change Play Store, Android install, or browser install behavior

Edit:

- [`../public/login.html`](../public/login.html) for the visible Android install CTA; it currently links to `https://play.google.com/store/apps/details?id=india.inventory.management`
- [`../public/site.webmanifest`](../public/site.webmanifest) for browser/PWA install metadata
- [`../public/js/service-worker-register.js`](../public/js/service-worker-register.js) and [`../public/service-worker.js`](../public/service-worker.js) for browser/PWA/WebView service-worker rollback behavior
- Android wrapper project at `C:\Users\Dipayan\AndroidStudioProjects\IndiaInventoryManagement` for native WebView behavior, cache settings, upload-key signing, target SDK, Play Store screenshots, version metadata, and AAB releases

The web app can be updated through normal Railway deployment when only web code changes. A Play Store AAB update is only needed when native Android wrapper behavior, signing/version metadata, permissions, target SDK, or native app assets change. The current rollback worker uses `ROLLBACK_VERSION` and deletes old runtime caches on install/activation.

The rollback worker intentionally provides no offline app shell or fetch interception. Also keep manifest metadata honest: `site.webmanifest` currently labels the 1254x1254 `app_logo.png` as `512x512`, which should be corrected or replaced with a true 512px asset.

### If you want to change invoice flow or PDF output

Edit:

- [`../public/invoice.html`](../public/invoice.html)
- [`../routes/invoices.js`](../routes/invoices.js)
- [`../middleware/auth.js`](../middleware/auth.js) if auth behavior also changes

For Billing details customer autocomplete, update [`../public/invoice.html`](../public/invoice.html) and `GET /api/invoices/customers` in [`../routes/invoices.js`](../routes/invoices.js). For invoice bank/UPI profile and PDF payment details, update [`../public/invoice.html`](../public/invoice.html), `POST/GET /api/shop-info`, the `settings` table columns, and the invoice PDF helpers in [`../routes/invoices.js`](../routes/invoices.js) together.

Serialized invoice lines query `GET /api/item-serials`, enforce one in-stock serial per positive whole-number unit, and submit `serial_numbers`. The UI's per-line Sale % helper derives rate from buying rate, but `sale_profit_percent` and `buying_rate` are draft-only fields: the persisted request contains the calculated `rate` and serial list, not those helper values. Preserve that boundary when changing invoice payloads.

### If you want to change support chat or developer portal behavior

Edit:

- [`../routes/support.js`](../routes/support.js)
- [`../middleware/auth.js`](../middleware/auth.js)
- [`../public/index.html`](../public/index.html) for the owner/staff support chat card
- [`../public/developer-login.html`](../public/developer-login.html)
- [`../public/developer-support.html`](../public/developer-support.html)
- [`../public/js/developer-login.js`](../public/js/developer-login.js)
- [`../public/js/developer-support.js`](../public/js/developer-support.js)

Known maintenance item: `logoutDeveloper()` currently invokes an undefined `clearStoredDeveloperToken()` after the server logout request. Fix or remove that call so the redirect is reliable.

### If you want to change database schema

Edit:

- [`../migrations/full_updated_schema.sql`](../migrations/full_updated_schema.sql) for the latest full snapshot
- create a reviewed incremental SQL change when upgrading an existing database, then apply and record it through the deployment/provider workflow
- update compatibility logic in [`../db.js`](../db.js) if old databases also need startup patching
- update this document after the schema change

There is currently only one transactional full-schema snapshot, no migration history/ledger, and no migration runner in `package.json`. `db.js` compatibility statements are startup patches, not a substitute for controlled migrations, and they cannot initialize an empty database. Validate the resulting schema after every rollout, especially `item_serials`, constraints, and indexes.

### If you want to change database backup or restore behavior

The repository contains no backup scheduler, restore command, retention policy, or point-in-time-recovery configuration. PDF/Excel exports are business reports, not database backups.

- Configure automated backups and retention in the PostgreSQL hosting platform.
- Before a risky migration, take a provider snapshot or `pg_dump` using an approved secret-handling workflow.
- Test restores into an isolated database and verify all 17 tables, foreign keys, indexes, triggers, owner counts, serial statuses, and invoice totals before promoting it.
- Never restore directly over production as a first test, and never commit connection strings or dump files containing customer data.

### If you want to change deployment healthchecks or runtime logging

Edit:

- [`../server.js`](../server.js)
- [`../db.js`](../db.js)
- [`../utils/runtime-log.js`](../utils/runtime-log.js)
- [`../utils/monitoring.js`](../utils/monitoring.js)
- [`../utils/background-jobs.js`](../utils/background-jobs.js)
- [`../railway.json`](../railway.json)

For carrier, DNS, SSL, or weak-network debugging, start with `/network-check` and the liveness route `/live`. If those routes fail on one network but not another, investigate the deployed domain/DNS/SSL path before changing business API code.

Railway is configured to probe `/health`. Keep deployment probes on the non-API `/health`, `/ready`, or `/live` paths: because broad `/api` router middleware is mounted first, the `/api/*` aliases currently cross DB/auth gates and can return `401` to an unauthenticated probe. Maintenance mode exempts health path names and returns no-store `503` plus `Retry-After` elsewhere.

### If you want to change caching, pagination, or queued exports

Edit:

- [`../middleware/cache.js`](../middleware/cache.js)
- [`../middleware/export-queue.js`](../middleware/export-queue.js)
- [`../utils/cache.js`](../utils/cache.js)
- [`../utils/export-queue.js`](../utils/export-queue.js)
- [`../utils/pagination.js`](../utils/pagination.js)
- route files that opt into cache/pagination/export behavior
- [`../public/service-worker.js`](../public/service-worker.js) for browser/WebView service-worker rollback and old cache cleanup
- [`../server.js`](../server.js) for static asset headers, service-worker headers, and HTML bootstrap injection

Do not re-enable service-worker fetch handling unless the endpoint has an explicit stale-data policy and mobile-carrier behavior has been tested. Current business data freshness and Jio troubleshooting depend on requests going directly to the network.

### If you want to change owner ops metrics

Edit:

- [`../routes/ops.js`](../routes/ops.js)
- [`../repositories/ops-repository.js`](../repositories/ops-repository.js)
- [`../utils/monitoring.js`](../utils/monitoring.js)
- [`../utils/background-jobs.js`](../utils/background-jobs.js)

## 15. Detailed Architecture Diagram

```mermaid
flowchart TB
  subgraph Frontend["Frontend pages and shared modules"]
    Login["public/login.html<br/>server-injected banner carousel | register | owner/staff login | forgot password | Play Store install"]
    DevLogin["public/developer-login.html<br/>developer login | developer register"]
    DevSupport["public/developer-support.html<br/>developer inbox | replies | status updates"]
    Dashboard["public/index.html<br/>Purchase Entry/Add Stock | serial entry/scan | supplier ledger | product history | reports | dues | expenses | staff"]
    Invoice["public/invoice.html<br/>invoice builder | Sale % helper | serial lookup/scan | customer autofill | payment profile | history | collection | PDF"]
    Reset["public/reset.html<br/>password reset"]
    Privacy["public/privacy-policy.html<br/>privacy policy"]
    AccountDeletion["public/account-deletion.html<br/>account deletion instructions"]
    NetworkCheck["server-generated /network-check<br/>first-party reachability diagnostics"]
    AppCore["public/js/app-core.js<br/>apiBase | page metadata | shared helpers"]
    AppShell["public/js/app-shell.js<br/>sidebar shell | refresh button | page navigation"]
    Permissions["public/js/permission-contract.js<br/>permission keys shared by frontend and backend"]
    SWRegister["public/js/service-worker-register.js<br/>service-worker cleanup helper"]
    ServiceWorker["public/service-worker.js<br/>rollback worker | cache cleanup | unregister"]
    DashJS["public/js/dashboard.js<br/>dashboard UI orchestration"]
    DevLoginJS["public/js/developer-login.js<br/>developer auth UI controller"]
    DevSupportJS["public/js/developer-support.js<br/>developer inbox controller"]
  end

  subgraph Server["Express backend"]
    Entry["server.js<br/>login-banner injection | maintenance mode | health routes | network-check | request IDs | CORS/CSP/helmet | compression | cleanup bootstrap | background jobs"]
    AuthMW["middleware/auth.js<br/>cookie-first JWT auth | staff permission reload | developer support auth"]
    CacheMW["middleware/cache.js<br/>owner-scoped short TTL JSON cache"]
    ExportMW["middleware/export-queue.js<br/>async PDF/Excel queue trigger"]
    AuthAPI["routes/auth.js<br/>register | login | Google OAuth | reset | staff CRUD | me"]
    SupportAPI["routes/support.js<br/>developer auth | support thread | developer inbox"]
    ExportAPI["routes/exports.js<br/>export job status | download"]
    OpsAPI["routes/ops.js<br/>owner metrics | background cleanup"]
    InventoryAPI["routes/inventory.js<br/>stock | in-stock serial lookup | reports | GST compare/export | debts | due deletes | overview"]
    BusinessAPI["routes/business.js<br/>suppliers | purchases + serial intake | product history | repayments | guarded purchase deletes | expenses"]
    InvoiceAPI["routes/invoices.js<br/>invoice save + serial sale transition | customer lookup | history | settlement | PDF payment details | shop info"]
    Concurrency["utils/concurrency.js<br/>normalizers | advisory locks"]
    RuntimeHelpers["utils/cache.js | export-queue.js | monitoring.js | background-jobs.js | pagination.js"]
    OpsRepo["repositories/ops-repository.js<br/>database overview"]
    DBFile["db.js<br/>pool | timeout tuning | readiness state | SSL selection | non-transactional compatibility patches"]
    RuntimeLog["utils/runtime-log.js<br/>structured lifecycle and request logging"]
    DeployCfg["railway.json<br/>start command | healthcheck | restart policy"]
  end

  subgraph Database["PostgreSQL tables"]
    Users["users"]
    Staff["staff_accounts"]
    Developers["developer_admins"]
    SupportThreads["support_conversations"]
    SupportMessages["support_messages"]
    Settings["settings"]
    Items["items"]
    Sales["sales"]
    Debts["debts"]
    Suppliers["suppliers"]
    Purchases["purchases"]
    PurchaseItems["purchase_items"]
    Expenses["expenses"]
    Invoices["invoices"]
    InvoiceItems["invoice_items"]
    ItemSerials["item_serials<br/>purchased-unit to sold-unit bridge"]
    Counter["user_invoice_counter"]
  end

  Login --> AppCore
  Login --> SWRegister
  DevLogin --> DevLoginJS
  DevSupport --> DevSupportJS
  Dashboard --> AppCore
  Dashboard --> AppShell
  Dashboard --> SWRegister
  Dashboard --> DashJS
  Invoice --> AppCore
  Invoice --> AppShell
  Invoice --> SWRegister
  Reset --> AppCore
  Reset --> SWRegister
  Login --> Privacy
  Login --> AccountDeletion
  SWRegister --> ServiceWorker

  AppCore --> Entry
  AppShell --> Entry
  ServiceWorker -->|"cleanup only; no fetch interception"| Entry
  DashJS --> Entry
  DevLoginJS --> Entry
  DevSupportJS --> Entry
  Login -->|"POST /api/auth/* and GET /api/auth/google/*"| Entry
  DevLogin -->|"POST /api/developer-auth/*"| Entry
  DevSupport -->|"GET/POST/PATCH /api/developer-support/*"| Entry
  Dashboard -->|"GET/POST/DELETE /api/* plus queued export polling"| Entry
  Invoice -->|"GET/POST /api/invoices* including /api/invoices/customers, /api/shop-info, and queued PDF polling"| Entry
  Reset -->|"POST /api/auth/reset-password"| Entry
  NetworkCheck -->|"GET /live, /health, /api/live"| Entry

  Entry --> AuthMW
  Entry --> CacheMW
  Entry --> ExportMW
  Entry --> AuthAPI
  Entry --> SupportAPI
  Entry --> ExportAPI
  Entry --> OpsAPI
  Entry --> InventoryAPI
  Entry --> BusinessAPI
  Entry --> InvoiceAPI
  Entry --> RuntimeHelpers
  Entry --> RuntimeLog
  AuthAPI --> DBFile
  SupportAPI --> DBFile
  OpsAPI --> OpsRepo
  OpsAPI --> RuntimeHelpers
  ExportAPI --> RuntimeHelpers
  InventoryAPI --> DBFile
  BusinessAPI --> DBFile
  InvoiceAPI --> DBFile
  DBFile --> RuntimeLog
  InventoryAPI --> Concurrency
  BusinessAPI --> Concurrency
  InvoiceAPI --> Concurrency
  CacheMW --> RuntimeHelpers
  ExportMW --> RuntimeHelpers
  OpsRepo --> DBFile
  DeployCfg -. deploy/runtime defaults .-> Entry

  DBFile --> Users
  DBFile --> Staff
  DBFile --> Developers
  DBFile --> SupportThreads
  DBFile --> SupportMessages
  DBFile --> Settings
  DBFile --> Items
  DBFile --> Sales
  DBFile --> Debts
  DBFile --> Suppliers
  DBFile --> Purchases
  DBFile --> PurchaseItems
  DBFile --> Expenses
  DBFile --> Invoices
  DBFile --> InvoiceItems
  DBFile --> ItemSerials
  DBFile --> Counter

  Users --> Staff
  Users --> SupportThreads
  Users --> Settings
  Users --> Items
  Users --> Sales
  Users --> Debts
  Users --> Suppliers
  Users --> Purchases
  Users --> Expenses
  Users --> Invoices
  Users --> ItemSerials
  Users --> Counter
  Suppliers --> Purchases
  Purchases --> PurchaseItems
  Purchases --> ItemSerials
  PurchaseItems --> ItemSerials
  Items --> Sales
  Items --> ItemSerials
  Invoices --> InvoiceItems
  Invoices --> ItemSerials
  InvoiceItems --> ItemSerials
  Sales --> ItemSerials
  Invoices -. optional settlement link .-> Debts
  Developers -. sender reference only .-> SupportMessages
  SupportThreads --> SupportMessages
```

### Android App Architecture

The Play Store Android app is a native Kotlin WebView wrapper for the same Railway-hosted web application.

Android project location:

```text
C:\Users\Dipayan\AndroidStudioProjects\IndiaInventoryManagement
```

Current Android build snapshot from `app/build.gradle.kts`, verified 2026-07-23:

| Setting                   | Current value                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| Android namespace         | `com.india.inventory`                                                                                  |
| Play Store application ID | `india.inventory.management`                                                                           |
| Version                   | `1.2.40` / `versionCode 43`                                                                            |
| Minimum SDK               | `24`                                                                                                   |
| Target SDK                | `36`                                                                                                   |
| Compile SDK               | `36`                                                                                                   |
| Main web URL              | `https://india-inventory-management-production.up.railway.app` by default                              |
| Debug URL override        | `inventoryWebAppUrlMainDebug` or legacy `inventoryWebAppUrlDebug` Gradle property                      |
| Release URL override      | `inventoryWebAppUrlMainRelease` or legacy `inventoryWebAppUrlRelease` Gradle property                  |
| Debug WebView policy      | mixed content compatibility mode and third-party cookies enabled                                       |
| Release WebView policy    | mixed content blocked and third-party cookies disabled                                                 |
| Release build behavior    | minify + shrink resources + non-debuggable                                                             |
| Release signing           | reads `keystore.properties` when present                                                               |
| App update strategy       | Play Core optional/flexible update flow active; legacy custom manifest/APK updater disabled at startup |

Important Android files:

| Android file                                                   | Role                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `app/build.gradle.kts`                                         | SDK levels, app ID, version metadata, web URL `BuildConfig` fields, release signing, dependencies                        |
| `app/src/main/AndroidManifest.xml`                             | permissions, FileProvider, reminder receivers, launcher activity, Google auth deep link                                  |
| `app/src/main/java/com/india/inventory/MainActivity.kt`        | main native shell: WebView, offline UI, connectivity retry, downloads, permissions, Google transfer, app update handling |
| `app/src/main/java/com/india/inventory/AppReminderManager.kt`  | scheduled business reminders, reminder notifications, boot/package-replace rescheduling                                  |
| `app/src/main/java/com/india/inventory/AppReminderReceiver.kt` | reminder trigger receiver and boot/package-replace receiver                                                              |
| `app/src/main/res/layout/activity_main.xml`                    | native shell layout: WebView, swipe refresh, top progress, loading card, offline screen                                  |
| `app/src/main/res/xml/shortcuts.xml`                           | launcher shortcuts for invoice, sales report, low stock, and customer due                                                |
| `app/src/main/res/xml/file_paths.xml`                          | FileProvider paths for camera/file/share/install flows                                                                   |
| `app/src/main/res/values/strings.xml`                          | Android shell strings, offline messages, reminders, shortcuts, download/update text                                      |

Native dependency map:

| Dependency                                       | Used for                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `androidx.appcompat:appcompat`                   | `AppCompatActivity` and compatible app shell behavior                     |
| `androidx.swiperefreshlayout:swiperefreshlayout` | pull-to-refresh around the WebView                                        |
| `androidx.core:core-ktx`                         | notification, permission, and compatibility helpers                       |
| `androidx.activity:activity-ktx`                 | activity result launchers for permissions, file chooser, and update flows |
| `androidx.lifecycle:lifecycle-runtime-ktx`       | lifecycle integration                                                     |
| `com.google.android.play:app-update-ktx`         | optional Play Store in-app update checks                                  |

Android manifest architecture:

| Area                   | Details                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Network                | `INTERNET` and `ACCESS_NETWORK_STATE` support WebView loading and connectivity checks                |
| Device features        | camera is optional via `android.hardware.camera.any`                                                 |
| Runtime permissions    | camera, coarse/fine location, notifications, and legacy external storage for Android 9 and lower     |
| Storage/share          | `FileProvider` exposes app-owned files safely to external apps                                       |
| Background reminders   | `AppReminderReceiver` handles scheduled reminder alarms                                              |
| Boot recovery          | `ReminderBootReceiver` reschedules reminders on `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED`           |
| Activity               | `MainActivity` is `singleTop`, exported launcher, and handles deep links                             |
| Google OAuth deep link | `indiainventory://google-auth` returns Android Google-transfer tokens from the web auth flow         |
| Dynamic shortcuts      | `indiainventory://shortcut/...` opens invoice, sales report, low stock, or customer due destinations |

Native runtime diagram:

```mermaid
flowchart TB
  subgraph Android["Android wrapper project"]
    Gradle["app/build.gradle.kts<br/>app ID | SDK | version | BuildConfig URL | signing"]
    Manifest["AndroidManifest.xml<br/>permissions | FileProvider | receivers | deep links | shortcuts"]
    MainActivity["MainActivity.kt<br/>WebView shell | offline state | downloads | permissions | app updates"]
    Layout["activity_main.xml<br/>SwipeRefreshLayout | WebView | progress | offline card"]
    ReminderManager["AppReminderManager.kt<br/>business reminders | notification channel | alarm scheduling"]
    ReminderReceivers["AppReminderReceiver.kt<br/>alarm trigger | boot/package replace"]
    AndroidBridges["JS bridges<br/>AndroidDownloader | AndroidAppShell"]
    DownloadManagerNode["Android DownloadManager<br/>file downloads | APK downloads"]
    PlayCore["Play Core AppUpdateManager<br/>optional store update prompt"]
  end

  subgraph WebApp["Hosted web app"]
    Railway["Railway Express server<br/>server.js"]
    ServiceWorker["public/service-worker.js<br/>rollback cleanup worker"]
    Pages["login.html | index.html | invoice.html"]
    APIs["/api/* live business APIs"]
  end

  Gradle --> MainActivity
  Manifest --> MainActivity
  MainActivity --> Layout
  MainActivity --> AndroidBridges
  MainActivity --> DownloadManagerNode
  MainActivity --> PlayCore
  MainActivity -->|"loadUrl(BuildConfig.MAIN_WEB_APP_URL)"| Railway
  Railway --> Pages
  Pages --> ServiceWorker
  Pages --> APIs
  ServiceWorker -->|"cleanup only; no fetch interception"| Railway
  AndroidBridges --> Pages
  ReminderReceivers --> ReminderManager
  ReminderManager --> MainActivity
```

MainActivity responsibility map:

| Area                    | Native behavior                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WebView setup           | enables JavaScript, DOM storage, database storage, geolocation, multiple windows, safe browsing, hardware rendering, and normal WebView loading                                                                          |
| URL trust               | only trusted web hosts from enabled `AppSite` values stay inside the WebView; external or special schemes open through Android intents                                                                                   |
| Low-network behavior    | relies on direct network loads plus native retry/reachability probing; the web service-worker app-shell cache is currently rolled back                                                                                   |
| Offline UI              | shows native offline screen with retry, saved page action, downloads action, last sync text, and last captured preview                                                                                                   |
| Pull refresh            | reloads the current page or home page only when network is available                                                                                                                                                     |
| Connectivity            | registers `ConnectivityManager.NetworkCallback`, retries pending loads when connectivity returns, and shows offline state when all active networks are lost                                                              |
| Loading state           | uses top progress, centered loading card, splash timing, and WebChrome progress callbacks                                                                                                                                |
| Session support         | injects runtime JavaScript that watches `fetch`/`XMLHttpRequest` for `401` and asks Android to show a session-expired dialog                                                                                             |
| Sidebar gesture support | web sidebar calls `AndroidAppShell.setSidebarGesturesLocked(...)` so native pull refresh does not fight mobile sidebar gestures                                                                                          |
| Google transfer         | handles `indiainventory://google-auth?transfer=...`, loads `/api/auth/google/android-transfer`, and completes cookie-based web login inside the WebView                                                                  |
| App shortcuts           | handles `indiainventory://shortcut/invoice` and dashboard section shortcuts, then opens the matching web destination                                                                                                     |
| Downloads               | supports regular URLs through `DownloadManager`, `blob:` downloads through injected JavaScript, `data:` downloads, authenticated cookies, bearer token fallback, notifications, share actions, and downloads app opening |
| File chooser            | supports web file inputs with Android document picker and optional camera capture                                                                                                                                        |
| Permissions             | requests camera, location, and notification permissions through activity result launchers                                                                                                                                |
| App updates             | actively checks Play Core for an optional flexible update on start/resume; legacy custom manifest/APK download helpers remain in the file but `disableAppUpdateFeatures()` disables that path at startup                 |

WebView and web-app cache boundary:

- Native WebView cache may still exist, but the web service-worker app-shell cache is disabled through the rollback worker.
- `loadUrlKeepingWarmCache(...)` restores default WebView cache mode before navigation instead of forcing `LOAD_NO_CACHE`.
- The web rollback worker does not intercept `/api/*`, HTML navigation, JS/CSS/images, or diagnostics; Android does not change API freshness rules.
- Offline "Saved page" uses `LOAD_CACHE_ELSE_NETWORK` only when the user explicitly chooses the cached page action.

Android-to-web bridges:

| Bridge           | Web-visible object         | Purpose                                                                              |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `DownloadBridge` | `window.AndroidDownloader` | saves base64/blob downloads and reports download errors from injected web code       |
| `AppShellBridge` | `window.AndroidAppShell`   | receives sidebar gesture-lock events and session-expired events from the web runtime |

Android navigation and auth flow:

1. `MainActivity.onCreate(...)` binds views, configures the WebView, registers receivers/listeners, restores offline state, and handles the launch intent.
2. If online, it loads `BuildConfig.MAIN_WEB_APP_URL`; if offline, it shows the native offline screen and schedules retry-on-reconnect.
3. The web app serves HTML with the service-worker cleanup bootstrap, then older same-origin service-worker registrations and runtime caches are removed.
4. Login/session remains cookie-based inside the WebView; the web app still calls `/api/auth/me` and other `/api/*` endpoints normally.
5. Google sign-in can return through `indiainventory://google-auth`; Android loads the transfer endpoint so the web app can set the correct session cookie.
6. If the web runtime sees a `401`, injected JS calls `AndroidAppShell.onSessionExpired(...)`; Android clears old web storage keys and opens `login.html` when the user confirms.

Android offline and retry flow:

1. `ConnectivityManager` determines whether the current network has internet or a usable transport.
2. Main-frame WebView errors such as DNS lookup, timeout, connect, or I/O errors are treated as transient.
3. Android schedules limited retries and can probe the base server URL before showing the offline page.
4. When connectivity returns, pending reloads resume automatically.
5. The last successful trusted URL and last sync timestamp are stored in Android `SharedPreferences`.
6. A bitmap preview of the last successful WebView screen is saved in app cache for the native offline card.

Android reminders:

`AppReminderManager` owns a fixed business reminder schedule:

| Reminder type  | Destination           |
| -------------- | --------------------- |
| Morning start  | app home              |
| Stock checks   | `itemReportSection`   |
| Due follow-ups | `customerDebtSection` |
| Sales close    | `salesReportSection`  |
| GST prep       | `gstReportSection`    |

Reminder behavior:

- creates the `business_reminders` notification channel on Android 8+
- schedules alarms through `AlarmManager`
- prevents duplicate reminder notifications inside a short duplicate-trigger window
- reschedules reminders after app launch, boot completed, and package replacement
- opens the correct dashboard section through `ACTION_OPEN_APP_NOTIFICATION`
- respects notification runtime permission on Android 13+

Android release and deployment boundary:

| Change type                                                                                                                                    | Required deployment                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| HTML, JS, API, service worker, CSS, image, manifest changes in this web repo                                                                   | normal Railway/web deployment                                                    |
| Service-worker cache version or cache strategy changes                                                                                         | normal Railway/web deployment; clients update after worker activation            |
| WebView settings, Android permissions, shortcuts, reminders, native downloads, app update logic, icons, version code/name, signing, target SDK | Android build and Play Store/AAB release                                         |
| Backend URL change for the Android app                                                                                                         | Gradle property override or Android release if the baked release URL must change |

Android verification commands used for native changes:

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
$env:Path="$env:JAVA_HOME\bin;$env:Path"
.\gradlew.bat :app:assembleDebug
.\gradlew.bat :app:lintDebug
```

## 16. Final Summary

This codebase is organized around a single owner-scoped business workspace:

- frontend pages are static HTML with shared vanilla JS modules
- Express route files expose 84 live router declarations grouped by business domain
- PostgreSQL uses 17 application tables for inventory, purchase-backed stock intake, serialized units, invoices, dues, expenses, support, and staff control
- authentication is cookie-based for owner, staff, Google owner login, and developer support flows, with staff permissions enforced on both frontend and backend
- serialized purchase units are stored in `item_serials`; invoice creation locks in-stock serials, marks them sold, and links their purchase, invoice, and sale records
- invoice rows provide a Sale % rate helper in the UI, but only the calculated rate and `serial_numbers` cross the API boundary
- destructive ledger cleanup is owner-only: customer ledger deletes sync invoice balances, while purchase/supplier deletes reject sold serials and reverse stock before removing purchase data
- the support system adds owner/staff requester threads plus a dedicated developer inbox backed by `developer_admins`, `support_conversations`, and `support_messages`
- runtime behavior includes structured lifecycle/request logging, request metrics, DB-pool backpressure protection, maintenance mode, background cleanup, queued export jobs, and health endpoints
- non-API `/health`, `/ready`, and `/live` are the reliable public probes; current router order causes their `/api/*` aliases to cross DB/auth middleware
- `/network-check` provides a first-party diagnostic page for mobile/carrier reachability checks, while `/api/live` may currently report `401` without a session
- login HTML receives up to ten numerically named banner slides from `public/images`; nine are present at this baseline
- deployment defaults for Railway are codified in [`../railway.json`](../railway.json)
- Android users can install through the Play Store link on `login.html`, while `site.webmanifest` keeps browser/PWA install metadata available
- browser/PWA/WebView clients now use direct network loading again; the service-worker rollback path clears old app-shell caches and unregisters older workers
- the Android wrapper at `C:\Users\Dipayan\AndroidStudioProjects\IndiaInventoryManagement` is currently `1.2.40` (`versionCode 43`) and needs a Play Store release only when native WebView, signing, SDK, version, permission, or asset behavior changes
- the repository has no automated test/lint/build pipeline beyond `npm start`, no migration runner/history, and no database backup implementation; those operational gaps and current security caveats are explicitly recorded above
- this document contains local setup, route/access maps, workflow/function maps, environment and maintenance guidance, architecture diagrams, and a schema-level table dictionary
