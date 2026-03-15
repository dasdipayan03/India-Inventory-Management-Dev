# India Inventory Management Architecture

## Purpose

This document explains how the project is structured today, how data and requests move through the system, and where future changes should be made.

The goal is simple:

- keep the current UI and feature behavior stable
- make future changes easy to understand
- make new pages, permissions, and modules safer to add

## System Overview

This project is a server-rendered web app with a lightweight frontend layer.

- Backend: Node.js + Express + PostgreSQL
- Frontend: static HTML + CSS + vanilla JavaScript
- Authentication: JWT-based session
- Roles:
  - `admin`
  - `staff`
- Authorization:
  - backend route-level permission checks
  - frontend navigation visibility checks

## High-Level Structure

```text
Browser
  -> public/login.html
  -> public/index.html
  -> public/invoice.html
  -> public/reset.html

Frontend JS
  -> public/js/permission-contract.js
  -> public/js/app-core.js
  -> public/js/app-shell.js
  -> public/js/dashboard.js

Express Server
  -> server.js
  -> routes/auth.js
  -> routes/inventory.js
  -> routes/invoices.js
  -> middleware/auth.js
  -> db.js

Database
  -> users
  -> staff_accounts
  -> items
  -> invoices
  -> invoice_items
  -> sales
  -> settings
  -> debts
  -> user_invoice_counter
  -> existing reporting/helper tables/views from schema
```

## Request Flow

```text
User Action
  -> Frontend page JS sends request to /api/...
  -> Express route receives request
  -> authMiddleware validates token
  -> role/permission middleware checks access
  -> route reads/writes PostgreSQL
  -> JSON or file response returns to frontend
  -> frontend updates UI
```

## Main User Flows

### 1. Admin Login Flow

```text
login.html
  -> POST /api/auth/login
  -> routes/auth.js verifies email + password
  -> JWT issued
  -> token stored in browser
  -> redirect to index.html
```

### 2. Staff Login Flow

```text
login.html
  -> POST /api/auth/staff/login
  -> routes/auth.js verifies username + password
  -> staff session is linked to owner admin account
  -> JWT issued
  -> token stored in browser
  -> redirect to allowed workspace
```

### 3. Authenticated Page Load Flow

```text
index.html or invoice.html
  -> /api/auth/me
  -> middleware/auth.js refreshes staff permissions from DB
  -> frontend receives current user + permissions
  -> sidebar/menu visibility is updated
  -> page loads only the allowed features
```

### 4. Staff Permission Flow

```text
Admin opens Staff Access
  -> GET /api/auth/staff
  -> current staff list + permissions returned

Admin creates or edits staff access
  -> POST /api/auth/staff
  -> PATCH /api/auth/staff/:staffId/permissions

Staff logs in later
  -> permissions are not trusted from old token only
  -> middleware re-reads page_permissions from DB
  -> latest access is applied immediately
```

## Frontend Architecture

## Pages

- `public/login.html`
  - admin login
  - staff login
  - register flow
  - forgot password flow entry

- `public/reset.html`
  - reset password flow

- `public/index.html`
  - main dashboard workspace
  - add stock
  - stock report
  - sales report
  - GST report
  - customer due
  - staff access

- `public/invoice.html`
  - sale entry
  - invoice generation
  - invoice history
  - shop profile view/edit rules

## Shared Frontend Modules

### `public/js/app-core.js`

This is the shared frontend configuration layer.

Responsibilities:

- API base URL resolution
- shared sidebar item definitions
- shared permission option definitions
- permission normalization helpers
- permission label helpers
- central page-to-permission mapping

Why it exists:

- sidebar definitions should live in one place
- permission names should not be duplicated in multiple files
- future pages should be added once, not in many places

### `public/js/permission-contract.js`

This is the shared permission contract used by both frontend and backend.

Responsibilities:

- define valid staff permission keys
- define labels and section mapping
- define default staff permissions
- normalize permission arrays

Why it exists:

- permission vocabulary should come from one source
- backend and frontend should not drift apart

### `public/js/app-shell.js`

This is the shared frontend shell renderer.

Responsibilities:

- render sidebar for dashboard page
- render sidebar for invoice page
- keep sidebar order, text, and metadata consistent
- keep footer text consistent

Why it exists:

- admin and staff should see the same menu structure logic everywhere
- future sidebar changes should happen in one place

### `public/js/dashboard.js`

This is the main dashboard behavior controller.

Responsibilities:

- load session
- apply permissions to dashboard sections
- call inventory/report/debt/staff APIs
- update dashboard cards and tables
- manage popup feedback
- manage staff create/edit/remove workflow

Important note:

- this file is still large because it owns many existing features
- it is now safer than before because sidebar/permission definitions were extracted

## Backend Architecture

### `server.js`

This is the application entry point.

Responsibilities:

- start Express
- configure middleware
- register routes
- serve static files
- expose health route
- provide fallback routing

### `middleware/auth.js`

This is the authentication and authorization guard layer.

Responsibilities:

- verify JWT
- load latest staff permissions from DB
- attach normalized session context to `req.user`
- expose `requireAdmin`
- expose `requirePermission(...)`

Important design rule:

- frontend access checks are for UX
- backend access checks are the real security boundary

### `routes/auth.js`

Authentication and staff account management.

Responsibilities:

- register admin
- admin login
- staff login
- forgot/reset password
- current session lookup
- staff CRUD
- staff permission update

### `routes/inventory.js`

Inventory and reporting domain.

Responsibilities:

- add/update stock
- item lookup
- stock report
- low stock
- reorder suggestions
- sales report
- GST report
- customer due
- dashboard overview
- sales trend charts

### `routes/invoices.js`

Billing and invoice domain.

Responsibilities:

- generate invoice number
- save invoice
- invoice history
- invoice detail
- invoice PDF
- shop profile read/write

## Current Permission Model

The project uses page-based permissions for staff.

Valid staff permissions:

- `add_stock`
- `sale_invoice`
- `stock_report`
- `sales_report`
- `gst_report`
- `customer_due`

Admin behavior:

- always has full access

Staff behavior:

- only sees the pages assigned by admin
- cannot access admin-only management routes
- always operates under the owner admin account's business data

Admin-only area:

- `Staff Access`

## Data Ownership Model

This is one of the most important concepts in the project.

- Admin is the business owner
- Staff is not a separate business
- Staff works under the admin's business account
- Business records are still tied to the owner admin's `user_id`

That means:

- stock added by staff belongs to the owner business
- invoices made by staff belong to the owner business
- reports are filtered by owner business

This keeps business data centralized.

## Database Notes

Important auth/permission tables:

- `users`
  - admin account records

- `staff_accounts`
  - linked to `users.id` through `owner_user_id`
  - stores `username`
  - stores `password_hash`
  - stores `page_permissions`
  - stores `is_active`

- `settings`
  - business settings such as shop profile and GST rate

Important business tables used by routes:

- `items`
- `sales`
- `invoices`
- `invoice_items`
- `debts`
- `user_invoice_counter`

Migration files:

- `migrations/20260315_role_access.sql`
  - adds `staff_accounts`
  - fixes invoice timestamp support

- `migrations/20260316_staff_page_permissions.sql`
  - adds `page_permissions` to `staff_accounts`

- `migrations/full_updated_schema.sql`
  - fresh database snapshot

## Safe Change Rules

If you change this project in the future, follow these rules.

### UI Changes

- preserve current element IDs unless the JS is updated too
- keep mobile and desktop layouts tested together
- do not duplicate sidebar definitions in multiple pages
- keep permission-aware visibility in sync with backend rules

### Backend Changes

- never rely only on hidden frontend buttons for access control
- always add backend permission checks for new protected routes
- if a new feature is staff-assignable, define a permission key first

### Database Changes

- put all schema changes in `migrations/`
- update `full_updated_schema.sql` after important schema changes
- never silently change table structure without a migration file

## How To Add A New Feature

Use this order:

1. Decide if the feature is:
   - admin-only
   - staff-assignable
   - available to everyone
2. Add backend route(s)
3. Protect route(s) with `requireAdmin` or `requirePermission(...)`
4. If staff-assignable:
   - add permission key in `public/js/permission-contract.js`
   - add matching frontend permission config in `app-core.js`
5. Add UI entry point
6. Add page or section behavior
7. Test both admin and staff access

## How To Add A New Staff-Assignable Page

Use this order:

1. Add new permission key to `public/js/permission-contract.js`
2. Add migration if the DB shape changes
3. Add new sidebar item in `public/js/app-core.js`
4. Map the new page/section to the permission
5. Add backend routes with `requirePermission(...)`
6. Add frontend page or section
7. Update staff access UI if needed
8. Test:
   - admin can access
   - allowed staff can access
   - unassigned staff cannot access

Note:

- this document intentionally keeps examples conceptual
- use real file references from the repo when implementing

## Recommended Next Refactor Steps

The project is safer now, but these would improve it further:

- split `dashboard.js` into smaller feature modules
- move large inline `invoice.html` script into `public/js/invoice.js`
- add a small shared API client module
- add lightweight smoke tests for login, permission, invoice, and stock flows
- add a top-level `README.md` for deploy and environment setup

## Summary

Today the project follows this pattern:

- shared backend permission contract
- shared frontend app config
- shared sidebar shell
- feature-specific route files
- page-specific behavior files
- central owner-based business data model

This is the correct direction for future-safe growth without breaking the current UI and feature set.
