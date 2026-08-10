# Shop Inventory Management - Project Guide

**Audience:** a new developer who needs to understand, maintain, or rebuild this project.

**Last checked:** 2026-08-10 against web repository commit `27bc003`.

This is an easy-English guide. It explains what the app does, why each technology exists, how data moves, where it is stored, and how to rebuild the same kind of project from scratch.

## 1. Start Here

Shop Inventory Management is a multi-shop business web application. One owner gets one private workspace. The owner can create staff accounts and decide which pages each staff member may use.

The application is not a separate React frontend and API backend. It is one Node.js application:

1. Express serves HTML, JavaScript, CSS, images, and API endpoints.
2. Browser JavaScript calls `/api/...` on the same domain.
3. Express validates the request and talks to PostgreSQL.
4. PostgreSQL stores the permanent business data.

The live application is deployed on Railway. `railway.json` tells Railway to run `server.js` and check `/health`.

## 2. What Users Can Do

| Area             | Main use                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------- |
| Owner account    | Register, log in with password or Google, reset password, manage shop profile               |
| Staff account    | Owner creates staff and grants page permissions                                             |
| Purchase entry   | Save supplier bills, add stock, update rates, record supplier dues                          |
| Item serials     | Save one serial/SN per purchased unit and scan serials using the optional camera flow       |
| Invoice and sale | Create invoices, reduce stock, save sale history, create PDF                                |
| Customer due     | Track pending amount, collections, customer address, and ledger history                     |
| Supplier ledger  | Review bills, supplier balance, repayments, and owner-only cleanup actions                  |
| Reports          | View stock, sales, GST, purchase, expense, and profit-related information; export Excel/PDF |
| Support          | Owner/staff can chat with developer support; developer has a separate inbox                 |
| Operations       | Owner-only runtime metrics, cache state, export queue state, and cleanup controls           |

## 3. Technology and Why It Is Used

| Technology                  | Where it is used                       | Why it is used                                                     |
| --------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| Node.js                     | Runtime                                | Runs JavaScript on the server                                      |
| Express                     | `server.js`, `routes/`                 | Serves pages and creates HTTP API routes                           |
| Vanilla HTML/CSS/JavaScript | `public/`                              | Simple frontend with no build step or framework bundle             |
| PostgreSQL                  | `db.js`, `migrations/`                 | Reliable relational storage for business, invoice, and ledger data |
| `pg`                        | `db.js`                                | PostgreSQL connection pool for Node.js                             |
| JWT + cookies               | `routes/auth.js`, `middleware/auth.js` | Keeps owner/staff sessions private in HTTP-only cookies            |
| bcrypt                      | Auth routes                            | Hashes passwords before they are stored                            |
| Helmet                      | `server.js`                            | Sets safer HTTP security headers and CSP                           |
| express-rate-limit          | `server.js`, auth routes               | Slows repeated API/login/reset attempts                            |
| compression                 | `server.js`                            | Compresses responses to reduce network size                        |
| ExcelJS                     | route files                            | Creates Excel exports                                              |
| PDFKit                      | route files                            | Creates invoice and report PDFs                                    |
| Nodemailer                  | auth route                             | Sends password-reset email through the configured mail relay       |
| Railway                     | deployment                             | Hosts the Node.js service and can host/connect PostgreSQL          |

## 4. Folder Map

| Path                                 | What is inside                                                                    | When to edit it                                        |
| ------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `server.js`                          | Express bootstrap, security middleware, HTML serving, health routes, cache repair | New global middleware, pages, headers, health behavior |
| `db.js`                              | PostgreSQL pool and safe runtime schema compatibility updates                     | DB connection or startup schema/index fixes            |
| `routes/auth.js`                     | Registration, login, Google login, staff accounts, password reset                 | Account and session changes                            |
| `routes/inventory.js`                | Stock, reports, customer due, item serial lookup                                  | Inventory, due, and report changes                     |
| `routes/business.js`                 | Purchase entry, suppliers, expenses                                               | Purchase/supplier/expense changes                      |
| `routes/invoices.js`                 | Invoice, sale, payment, shop settings                                             | Billing/PDF/payment changes                            |
| `routes/support.js`                  | User support chat and developer support login/inbox                               | Support feature changes                                |
| `routes/exports.js`                  | Queued export status and download                                                 | Long-running PDF/Excel export behavior                 |
| `routes/ops.js`                      | Owner-only runtime/queue metrics                                                  | Operational tools                                      |
| `middleware/auth.js`                 | Cookie/JWT checks, owner and permission guards                                    | Access-control rules                                   |
| `middleware/cache.js`                | Optional short API response cache                                                 | Read-cache behavior                                    |
| `middleware/export-queue.js`         | Detects async export requests                                                     | Export queue behavior                                  |
| `repositories/ops-repository.js`     | Database queries for ops page                                                     | Operational DB summaries                               |
| `utils/`                             | Cache, queue, logs, metrics, background jobs, pagination                          | Shared backend helper behavior                         |
| `public/`                            | Browser pages, frontend JS, images, web manifest                                  | UI, browser behavior, app assets                       |
| `migrations/full_updated_schema.sql` | Full base database schema                                                         | Fresh database setup and schema reference              |
| `railway.json`                       | Railway start command and health check                                            | Railway deployment settings                            |

## 5. System Architecture

```text
Browser / Android WebView
        |
        | HTML, JavaScript, cookie-based API calls
        v
Railway public URL
        |
        v
Node.js + Express (`server.js`)
        |
        +--> static pages from `public/`
        +--> `/api/auth`       -> account and staff routes
        +--> `/api`            -> inventory, business, invoices, support, exports, ops
        |
        v
PostgreSQL (`db.js` pool)
        |
        +--> users, items, purchases, invoices, debts, support, and related tables
```

### Important rule: owner data is separated

Most business tables have a `user_id`. This is the owner ID. Every query must use the logged-in owner ID, either directly or through the staff member's `owner_user_id`.

Example: a staff member may log in, but their purchase data belongs to the owner. The API finds the owner ID from the staff session and uses that ID in database queries. This prevents one shop from seeing another shop's records.

## 6. How a Browser Request Works

Example: owner saves a purchase bill.

```text
1. User fills Purchase Entry in `public/index.html`.
2. `public/js/dashboard.js` validates simple UI rules.
3. Browser sends JSON to an `/api/...` purchase endpoint with cookies.
4. `middleware/auth.js` reads the signed session cookie.
5. Permission middleware confirms owner/staff access.
6. `routes/business.js` validates values again on the server.
7. The route starts a PostgreSQL transaction.
8. It inserts/updates supplier, purchase, purchase_items, items, and optional item_serials.
9. PostgreSQL commits all changes together, or rolls all of them back on error.
10. Express returns JSON. Dashboard JavaScript refreshes the visible data.
```

Never trust only frontend validation. The frontend improves user experience; the route must still validate owner, permission, input, and stock rules before changing the database.

## 7. Main Data Flows

### 7.1 Registration and login

```text
Register form
  -> `/api/auth/register`
  -> bcrypt hashes password
  -> `users` row is created
  -> `settings` row is prepared for shop information

Login form
  -> `/api/auth/login` or `/api/auth/staff/login`
  -> bcrypt compares password hash
  -> server signs JWT
  -> JWT is placed in an HTTP-only cookie
  -> browser calls `/api/auth/me` to load current user
```

Google login uses Google OAuth routes in `routes/auth.js`. Google account data is verified, then the app either signs in the existing owner or asks for first-time shop name and mobile number.

### 7.2 Purchase entry: supplier bill becomes stock

```text
Purchase form
  -> supplier lookup/create in `suppliers`
  -> one bill header in `purchases`
  -> one row per product in `purchase_items`
  -> item quantity/rates update in `items`
  -> optional one row per serial/SN in `item_serials`
```

Why there are two purchase tables:

- `purchases` stores shared bill information: supplier, bill number, date, total, paid, due.
- `purchase_items` stores each line inside that bill: item name, quantity, buying rate, selling rate.

When a purchase is deleted, the backend checks whether any related serial has already been sold. It also makes sure stock will not become negative before reversing quantity. Only the owner can use the destructive purchase/supplier delete actions.

### 7.3 Serial number scan and storage

```text
Camera scanner (optional)
  -> reads barcode/QR serial text in the browser
  -> puts serial text in Purchase Entry or Invoice form
  -> normal API validation still runs
  -> `item_serials` stores serial, item, source purchase, and status
```

Camera permission is optional. It is requested only after the user starts the serial/SN scan action. Manual serial entry is always available.

Each serial is unique per owner through `(user_id, serial_no_norm)`. A serial begins with status `in_stock`. When sold, it becomes `sold` and is linked to its invoice, invoice line, and sale movement.

### 7.4 Invoice: sale reduces stock

```text
Invoice form
  -> create header in `invoices`
  -> create lines in `invoice_items`
  -> reduce `items.quantity`
  -> create movement rows in `sales`
  -> mark selected `item_serials` as `sold`
  -> if payment is pending, invoice due amount remains available for collection
```

This happens inside a transaction. The backend locks and checks selected serials so the same in-stock serial cannot be sold twice at the same time.

### 7.5 Customer due and payment collection

```text
Due invoice / manual due entry
  -> `debts` ledger row

Collection against invoice
  -> invoice totals are updated
  -> a `debts` row records the collection ledger movement
```

`debts` is a customer ledger, not only a simple “amount due” value. It keeps customer name, number, address, total, credit, calculated balance, remarks, dates, and optional linked `invoice_id`.

### 7.6 Supplier dues

Supplier due is held on `purchases.amount_due`. Supplier history is built by joining `suppliers`, `purchases`, and `purchase_items`. Supplier repayment actions update the related purchase payment values.

### 7.7 Support chat

```text
Owner or staff message
  -> `support_conversations` finds/creates one conversation
  -> `support_messages` stores each message
  -> unread counters update

Developer inbox
  -> developer session cookie
  -> reads conversation queue and messages
  -> replies or closes conversation
```

Developer support accounts are stored separately in `developer_admins`; they are not normal shop owners.

## 8. Frontend Pages and JavaScript

| Page/file                              | Purpose                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `public/login.html`                    | Owner/staff login, registration, password reset, Google login entry, app install link |
| `public/index.html`                    | Main dashboard: purchase, reports, dues, expenses, staff, support                     |
| `public/invoice.html`                  | Sale entry, invoice history, customer suggestions, PDF actions                        |
| `public/developer-login.html`          | Developer support login                                                               |
| `public/developer-support.html`        | Developer support inbox                                                               |
| `public/privacy-policy.html`           | Privacy information, including optional serial scan camera use                        |
| `public/account-deletion.html`         | Account deletion request information                                                  |
| `public/js/dashboard.js`               | Main dashboard controller and API calls                                               |
| `public/js/app-core.js`                | Shared session, permissions, helper functions                                         |
| `public/js/app-shell.js`               | Shared sidebar/navigation shell                                                       |
| `public/js/permission-contract.js`     | Canonical staff permission keys                                                       |
| `public/js/service-worker-register.js` | Removes old service workers/runtime caches and performs safe cache repair             |

## 9. Authentication and Permissions

### Session model

- Passwords are stored as bcrypt hashes, never plain text.
- After login, the server writes a signed JWT to an HTTP-only cookie.
- Browser JavaScript uses `credentials: "include"` on API calls.
- The browser does not need to store a readable auth token in local storage.
- `/api/auth/me` gives the frontend the current owner/staff identity and permissions.

### Roles

| Role                    | Meaning                                            |
| ----------------------- | -------------------------------------------------- |
| Owner                   | Full control of one shop workspace                 |
| Staff                   | Works under one owner and only sees assigned pages |
| Developer support admin | Separate support-inbox account, not a shop account |

Current staff permission keys are:

- `purchase_entry`
- `sale_invoice`
- `stock_report`
- `sales_report`
- `gst_report`
- `customer_due`
- `expense_tracking`

The frontend hides unavailable pages, but the backend also checks permissions. Both checks are required.

## 10. Database Design

### 10.1 Table relationship map

```text
users (owner)
  |-- settings                    one shop profile per owner
  |-- staff_accounts              owner creates many staff accounts
  |-- items                       owner inventory
  |-- sales                       owner sale movements
  |-- debts                       owner customer ledger rows
  |-- suppliers                   owner suppliers
  |     |-- purchases             supplier bills
  |           |-- purchase_items  bill lines
  |-- invoices                    sale bill headers
  |     |-- invoice_items          sale bill lines
  |-- item_serials                purchased/sold unit tracking
  |-- expenses                    owner expenses
  |-- support_conversations       support threads

support_conversations
  |-- support_messages

developer_admins
  |-- uses support conversations/messages through application logic
```

### 10.2 Every table in plain English

| Table                   | Stores                                                              | Important relationships                                                    |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `users`                 | Owner account, login identity, Google identity, password/reset data | Parent of most business tables                                             |
| `settings`              | Shop name, address, GST, default margin, bank/UPI details           | One row per `users.id`                                                     |
| `staff_accounts`        | Staff name, username, hash, permissions, active flag                | `owner_user_id -> users.id`                                                |
| `items`                 | Current item quantity and buying/selling rate                       | `user_id -> users.id`                                                      |
| `sales`                 | Individual sold stock movements                                     | `user_id -> users.id`, `item_id -> items.id`                               |
| `debts`                 | Customer due/collection ledger rows                                 | `user_id -> users.id`; optionally `invoice_id -> invoices.id`              |
| `suppliers`             | Supplier contact data                                               | `user_id -> users.id`                                                      |
| `purchases`             | Purchase bill header and payment state                              | `user_id -> users.id`, `supplier_id -> suppliers.id`                       |
| `purchase_items`        | Product lines inside a purchase bill                                | `purchase_id -> purchases.id`                                              |
| `item_serials`          | One serial/SN unit and its stock/sale status                        | Links user, item, purchase, purchase line, invoice, invoice line, and sale |
| `invoices`              | Invoice header, customer, GST, totals, payment status               | `user_id -> users.id`                                                      |
| `invoice_items`         | Product lines inside an invoice                                     | `invoice_id -> invoices.id`                                                |
| `user_invoice_counter`  | Per-owner, per-day next invoice number                              | `user_id -> users.id`                                                      |
| `expenses`              | Expense title, category, amount, date, note                         | `user_id -> users.id`                                                      |
| `developer_admins`      | Developer support login accounts                                    | Standalone support-admin identity                                          |
| `support_conversations` | One support thread for an owner/requester pair                      | `owner_user_id -> users.id`                                                |
| `support_messages`      | Every message in a support thread                                   | `conversation_id -> support_conversations.id`                              |

### 10.3 Foreign keys and delete behavior

Most owner-owned records use `ON DELETE CASCADE`: deleting an owner removes their business data. Most child line tables also cascade when their parent invoice/purchase is removed.

Some serial links use `ON DELETE SET NULL` for `invoice_id`, `invoice_item_id`, and `sale_id`. This preserves the serial record even when a linked sale-side row is removed.

## 11. Database Indexes: What They Do

An index is like the index at the end of a book. It makes common lookups fast, but it adds a small write cost. The project indexes fields used for login, owner isolation, search, report sorting, and table joins.

### 11.1 Login and identity indexes

| Index                                                                                  | Table              | Helps with                                    |
| -------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------- |
| `idx_users_email` and `idx_users_email_lookup`                                         | `users`            | Exact and case-insensitive email login/search |
| `idx_users_google_sub_unique`                                                          | `users`            | Finds one Google account identity safely      |
| `idx_staff_accounts_username_unique`                                                   | `staff_accounts`   | Case-insensitive unique staff username/login  |
| `idx_staff_accounts_owner_user_id`                                                     | `staff_accounts`   | Lists staff for one owner                     |
| `idx_developer_admins_email_normalized_unique` and `idx_developer_admins_email_lookup` | `developer_admins` | Developer login lookup                        |

### 11.2 Owner-scoped inventory and report indexes

| Index                                                       | Table      | Columns                     | Helps with                             |
| ----------------------------------------------------------- | ---------- | --------------------------- | -------------------------------------- |
| `idx_items_user_name` / `idx_items_user_name_lookup`        | `items`    | owner + normalized name     | Item autocomplete without mixing shops |
| `idx_items_user_id`                                         | `items`    | owner                       | Owner item lists                       |
| `idx_sales_user_date` / `idx_sales_user_date_desc`          | `sales`    | owner + sale date           | Date-wise sales reports                |
| `idx_sales_user_item_date`                                  | `sales`    | owner + item + date         | Product-specific sales history         |
| `idx_expenses_user_date` / `idx_expenses_user_date_id_desc` | `expenses` | owner + expense date        | Expense reports, newest-first lists    |
| `idx_expenses_user_title_lookup`                            | `expenses` | owner + normalized title    | Expense title suggestions              |
| `idx_expenses_user_category_lookup`                         | `expenses` | owner + normalized category | Category suggestions                   |

### 11.3 Supplier and purchase indexes

| Index                                                         | Table            | Columns                 | Helps with                              |
| ------------------------------------------------------------- | ---------------- | ----------------------- | --------------------------------------- |
| `idx_suppliers_user_name`                                     | `suppliers`      | owner + normalized name | Supplier autocomplete                   |
| `idx_suppliers_user_mobile`                                   | `suppliers`      | owner + mobile          | Supplier phone lookup                   |
| `idx_purchases_user_date` / `idx_purchases_user_date_id_desc` | `purchases`      | owner + date (+ id)     | Purchase reports and newest-first bills |
| `idx_purchases_user_supplier_date`                            | `purchases`      | owner + supplier + date | One supplier's bill history             |
| `idx_purchases_supplier_id`                                   | `purchases`      | supplier                | Join supplier to purchases              |
| `idx_purchase_items_purchase`                                 | `purchase_items` | purchase                | Load bill lines                         |
| `idx_purchase_items_item_lookup`                              | `purchase_items` | normalized item name    | Product purchase history                |

### 11.4 Invoice, due, and serial indexes

| Index                                                       | Table           | Columns                                   | Helps with                                     |
| ----------------------------------------------------------- | --------------- | ----------------------------------------- | ---------------------------------------------- |
| `idx_invoices_user_date` / `idx_invoices_user_date_id_desc` | `invoices`      | owner + date (+ id)                       | Invoice history/order                          |
| `idx_invoices_user_invoice_lookup`                          | `invoices`      | owner + normalized invoice number         | Invoice search                                 |
| `idx_invoices_user_customer_lookup`                         | `invoices`      | owner + normalized customer name          | Customer autocomplete                          |
| `idx_invoices_user_contact_lookup`                          | `invoices`      | owner + contact                           | Customer lookup by phone                       |
| `idx_invoices_user_contact_due_date`                        | `invoices`      | owner + contact + date, only due invoices | Customer due collection search                 |
| `idx_invoice_items_invoice`                                 | `invoice_items` | invoice                                   | Load invoice lines                             |
| `idx_debts_user_number_created`                             | `debts`         | owner + customer number + created/id      | Customer ledger order and balance calculation  |
| `idx_debts_user_customer_summary`                           | `debts`         | owner + normalized customer/contact       | Customer due summary lookup                    |
| `idx_debts_invoice_id`                                      | `debts`         | invoice                                   | Resync due ledger after invoice payment/delete |
| `idx_item_serials_user_serial_unique`                       | `item_serials`  | owner + normalized serial                 | Blocks duplicate serials for one owner         |
| `idx_item_serials_user_item_status`                         | `item_serials`  | owner + item + status                     | Finds only in-stock serials for billing        |
| `idx_item_serials_purchase_item`                            | `item_serials`  | purchase item                             | Checks serials belonging to a purchase line    |
| `idx_item_serials_invoice_item`                             | `item_serials`  | invoice item                              | Shows serials sold on an invoice line          |

### 11.5 Support and counters

| Index                                       | Table                   | Helps with                                    |
| ------------------------------------------- | ----------------------- | --------------------------------------------- |
| `idx_user_invoice_counter_user_id`          | `user_invoice_counter`  | Finds daily invoice counter for owner         |
| `idx_support_conversations_owner_lookup`    | `support_conversations` | Finds one owner/requester conversation        |
| `idx_support_conversations_queue`           | `support_conversations` | Developer queue by status and latest activity |
| `idx_support_conversations_unread_queue`    | `support_conversations` | Prioritizes unread developer messages         |
| `idx_support_messages_conversation_created` | `support_messages`      | Loads chat messages in time order             |

## 12. API Map

There are 84 route declarations. Do not begin with all 84 when learning the app. Start with route files by business area.

| Base path   | File                  | Examples                                                                                         |
| ----------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| `/api/auth` | `routes/auth.js`      | register, login, staff login, logout, current user, staff CRUD, reset password, Google OAuth     |
| `/api`      | `routes/inventory.js` | items, item serials, sales/stock/GST reports, customer dues and ledger actions                   |
| `/api`      | `routes/business.js`  | suppliers, purchase bills, purchase items, stock defaults, expenses                              |
| `/api`      | `routes/invoices.js`  | create/read invoices, invoice PDF/export, payment collection, customer suggestions, shop profile |
| `/api`      | `routes/support.js`   | support thread/messages and developer support authentication/inbox                               |
| `/api`      | `routes/exports.js`   | queued export status and download                                                                |
| `/api`      | `routes/ops.js`       | owner-only metrics and background job cleanup                                                    |

Useful non-API routes:

| Path                  | Purpose                                                         |
| --------------------- | --------------------------------------------------------------- |
| `/` and `/login.html` | Login page                                                      |
| `/index.html`         | Main dashboard                                                  |
| `/invoice.html`       | Invoice page                                                    |
| `/health`, `/ready`   | Public readiness probes; database must be ready                 |
| `/live`               | Public process liveness probe; does not require DB-ready state  |
| `/network-check`      | Simple first-party mobile/carrier connectivity diagnostic       |
| `/cache-repair`       | Browser-cache repair response; sends `Clear-Site-Data: "cache"` |

Use non-API health paths for Railway. The `/api/*` health aliases are registered after broad API middleware and may return `401` for an anonymous probe.

## 13. Security and Reliability

| Protection         | How it works                                                                         |
| ------------------ | ------------------------------------------------------------------------------------ |
| Password safety    | bcrypt password hashes                                                               |
| Session safety     | Signed JWT inside HTTP-only cookie                                                   |
| Role safety        | Owner and staff permission middleware on backend routes                              |
| Browser safety     | Helmet security headers, CSP nonce for inline page code, CORS allowlist              |
| Abuse safety       | API rate limits, separate login/reset rate limits                                    |
| Data safety        | SQL parameterized queries and database transactions for complex changes              |
| Export safety      | Excel formula-like values are sanitized before export                                |
| Logging safety     | Runtime logger redacts password, token, authorization, cookie, and access-key fields |
| DB pressure safety | API can return `503` before the pool becomes overloaded                              |
| Cache safety       | Auth-sensitive responses use no-store; old service worker caches are removed         |

## 14. Caching, Service Workers, and Mobile Networks

The app intentionally does **not** use an offline app-shell cache now. Old service workers caused carrier-specific loading trouble.

Current behavior:

1. HTML is sent with no-store cache headers.
2. `server.js` injects `public/js/service-worker-register.js` into served HTML.
3. The helper removes old same-origin service workers and old runtime caches.
4. When the cache-repair version changes, the helper calls `/cache-repair` and reloads once.
5. The reload guard prevents an infinite reload loop.

For Jio/mobile DNS problems, first use `/network-check` and `/live`. If a hostname returns `DNS_PROBE_FINISHED_NXDOMAIN` only on one carrier, it is a carrier DNS/domain-resolution issue, not an inventory database or login bug.

## 15. Environment Variables

Put secrets in Railway environment variables or a local `.env` file. Never commit `.env`.

| Variable                                   | Required            | Meaning                                                         |
| ------------------------------------------ | ------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`                             | Yes                 | PostgreSQL connection string                                    |
| `JWT_SECRET`                               | Yes                 | Secret used to sign sessions                                    |
| `BASE_URL`                                 | Production          | Public app URL; used by CORS and reset/OAuth links              |
| `CORS_ALLOWED_ORIGINS`                     | Recommended         | Comma-separated allowed browser origins                         |
| `NODE_ENV`                                 | Recommended         | Use `production` on Railway                                     |
| `PORT`                                     | Railway provides it | HTTP port; local default is `8080`                              |
| `DB_SSL`                                   | Optional            | Force PostgreSQL SSL behavior                                   |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional            | Enable Google owner login                                       |
| `GOOGLE_REDIRECT_URI`                      | Optional            | Explicit Google callback URL; otherwise based on `BASE_URL`     |
| `MAIL_RELAY_URL`, `MAIL_RELAY_KEY`         | Optional            | Password-reset email relay                                      |
| `DEVELOPER_REGISTRATION_KEY`               | Production setup    | Private key for creating developer-support account              |
| `APP_CACHE_VERSION`                        | Optional            | Force a browser cache-repair version                            |
| `MAINTENANCE_MODE`                         | Optional            | Show maintenance response except health paths                   |
| `API_RATE_LIMIT_MAX`                       | Optional            | API request limit per 15 minutes; default `500`                 |
| `PG_POOL_MAX`                              | Optional            | Maximum PostgreSQL connections in pool                          |
| `DB_POOL_WAITING_REJECT_THRESHOLD`         | Optional            | Reject busy requests before DB pool overload; default `20`      |
| `ENABLE_REQUEST_LOGS`                      | Optional            | Log every request; normally only slow/error requests are logged |

For the complete optional tuning list, search `process.env` in `server.js` and `db.js`.

## 16. Local Setup

### Prerequisites

- Node.js 18 or newer
- PostgreSQL database
- A `.env` file with at least `DATABASE_URL`, `JWT_SECRET`, and local `BASE_URL`

### Run locally

```powershell
npm install
$env:NODE_ENV='development'
$env:DATABASE_URL='your-postgres-connection-string'
$env:JWT_SECRET='use-a-long-random-secret'
$env:BASE_URL='http://localhost:8080'
npm start
```

Open `http://localhost:8080`.

### Database setup

For an empty database:

1. Run `migrations/full_updated_schema.sql` in PostgreSQL.
2. Start the app once. `db.js` applies idempotent compatibility additions for newer columns/indexes.
3. Create a test owner account from the UI.
4. Add a supplier, a purchase, an item serial, and an invoice to test the main flow.

## 17. Railway Deployment

1. Push the project to GitHub.
2. Create/import a Railway service from the repository.
3. Attach PostgreSQL or set a reachable PostgreSQL `DATABASE_URL`.
4. Add all required environment variables in Railway.
5. Railway runs `node --max-old-space-size=256 server.js` from `railway.json`.
6. Railway checks `/health` for readiness.
7. After deploy, open `/health`, `/live`, login page, and a protected owner flow.

Do not place database password, JWT secret, mail key, Google client secret, or developer registration key in source code.

## 18. How to Rebuild This Project From Scratch

Build in this order. It avoids mixing complex invoice logic with unfinished security/data foundations.

### Phase 1: foundation

1. Create Node.js + Express project.
2. Add `helmet`, `cors`, `compression`, JSON parsing, cookie parser, request logging, and rate limiting.
3. Create PostgreSQL pool in `db.js`.
4. Add `/health` and `/live` before business routes.
5. Serve a simple `public/login.html`.

### Phase 2: account and tenancy

1. Create `users`, `settings`, and `staff_accounts` tables.
2. Add owner registration/login with bcrypt + HTTP-only JWT cookie.
3. Add `authMiddleware`, `requireOwner`, and `requirePermission`.
4. Make every business query filter by owner ID.
5. Add `/api/auth/me` so frontend can learn role and permissions.

### Phase 3: stock and purchases

1. Create `items`, `suppliers`, `purchases`, and `purchase_items`.
2. Create Purchase Entry UI.
3. Save bill header and lines inside one transaction.
4. Update item quantity/rates in the same transaction.
5. Add the supplier/item/date indexes before large data arrives.

### Phase 4: invoices and due ledger

1. Create `invoices`, `invoice_items`, `sales`, `debts`, and `user_invoice_counter`.
2. Implement invoice transaction: header, lines, stock reduction, sales movement.
3. Reject invoice when stock is not available.
4. Add payment/due collection and resync rules.
5. Build invoice PDF only after invoice data is correct.

### Phase 5: serials, reports, and operations

1. Add `item_serials` with owner-unique normalized serial.
2. Add optional browser camera scan with manual fallback.
3. Add report endpoints with pagination and owner-scoped indexes.
4. Add Excel/PDF export queue for longer exports.
5. Add structured logs, metrics, background cleanup, and maintenance mode.

### Phase 6: support and deployment

1. Add `developer_admins`, `support_conversations`, and `support_messages`.
2. Add privacy policy and account deletion pages.
3. Configure Railway health check and environment variables.
4. Test on desktop Chrome, Android Chrome, and the Android WebView wrapper.

## 19. Safe Change Checklist

Before changing a feature, ask these questions:

1. Which page sends the request?
2. Which route validates it?
3. Which table(s) change?
4. Is the operation owner-scoped?
5. Does staff need a permission check?
6. Does the operation need one database transaction?
7. Which report/cache/export must be refreshed after the change?
8. Does it need a new index because it adds a common lookup or sort?
9. Does the privacy policy need an update for a new permission or data type?
10. Can the change be tested with one owner and one staff account?

## 20. Useful First Tests

Run these manual tests after a meaningful backend change:

1. Register/login/logout as owner.
2. Create staff with limited permissions; confirm blocked pages/API actions are denied.
3. Save purchase bill; confirm item stock increases.
4. Add a serial, then sell it once; confirm it cannot be sold again.
5. Create paid and due invoices; collect a due payment; inspect customer ledger.
6. Create and delete an allowed purchase/ledger record; confirm stock totals stay valid.
7. Download an invoice/export.
8. Open `/health`, `/live`, and `/network-check`.
9. Test login and serial scan on Android with camera permission allowed and denied.

## 21. Current Project Limits to Remember

- There is no automated unit-test, lint, or CI pipeline in this repository.
- There is no built-in scheduled database backup implementation.
- The application has runtime compatibility SQL in `db.js`; long term, numbered migration files plus a migration runner would be easier to audit.
- The generated Railway domain can be affected by mobile-carrier DNS problems. A custom domain gives stronger DNS control, but is not required for normal application function.

## 22. One-Screen Summary

This project is a Node.js + Express + PostgreSQL shop-management system. The browser UI in `public/` calls same-origin API routes. Express checks cookie sessions and permissions, then stores owner-scoped data in PostgreSQL. Purchases increase item stock; invoices decrease it; serials connect a purchased unit to its later sale; debts track customer collection; indexes keep repeated owner/search/report queries fast. Railway runs the server and checks `/health`.

When in doubt, follow this path:

```text
Page -> frontend JavaScript -> API route -> middleware -> PostgreSQL tables -> response -> refreshed UI
```
