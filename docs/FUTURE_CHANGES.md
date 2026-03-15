# Future Changes Guide

## Why This Guide Exists

This file is the practical checklist for making changes safely.

Use it when you want to:

- add a new page
- add a new report
- add a new staff permission
- move UI parts around
- change database structure

## Golden Rules

- keep backend authorization stricter than frontend visibility
- avoid copying the same config into many files
- prefer shared config over repeated hardcoded values
- add migrations for DB changes
- test both `admin` and `staff`

## Change Checklist By Area

## 1. Frontend Visual Change Only

If the change is only visual:

- update HTML/CSS
- keep existing element IDs and JS hooks stable
- check laptop layout
- check mobile layout
- check sidebar open/close behavior
- check popup and form behavior

## 2. New Dashboard Section

If the new feature belongs inside `index.html`:

1. add the section markup
2. add or reuse the related sidebar item in `public/js/app-core.js`
3. connect it in `public/js/dashboard.js`
4. decide whether it needs permission protection
5. test admin and staff visibility

## 3. New Separate Page

If the new feature should be its own page:

1. create the new HTML page
2. include shared shell files:
   - `public/js/app-core.js`
   - `public/js/app-shell.js`
3. render the sidebar from the shared shell
4. add page-specific JS
5. add permission-aware navigation logic
6. add backend route protection

## 4. New Staff Permission

Use this order:

1. update `public/js/permission-contract.js`
2. add matching frontend UI config in `public/js/app-core.js`
3. update sidebar mapping if needed
4. protect backend route with `requirePermission(...)`
5. update staff access UI if the permission should be selectable
6. test login and page visibility again

## 5. Database Change

Use this order:

1. create a new SQL file in `migrations/`
2. make the migration idempotent when possible
3. update `migrations/full_updated_schema.sql`
4. apply the migration in pgAdmin for existing DBs
5. verify route queries still match the schema

## Safe Testing Checklist

Before deploy, test these flows:

- admin login
- staff login
- admin sidebar visibility
- staff sidebar visibility
- add stock
- invoice save
- invoice history search
- stock report
- sales report
- GST report
- customer due
- staff create/edit/delete
- mobile sidebar behavior

## Files To Check First Before Any Major Change

- `server.js`
- `middleware/auth.js`
- `public/js/permission-contract.js`
- `public/js/app-core.js`
- `public/js/app-shell.js`
- `public/js/dashboard.js`
- `public/index.html`
- `public/invoice.html`
- `routes/auth.js`
- `routes/inventory.js`
- `routes/invoices.js`

## When To Create A New Shared Module

Create a shared module when:

- the same logic is duplicated in 2 or more files
- the same permission labels are repeated
- the same API setup is repeated
- the same sidebar/menu data is repeated

Do not create a shared module when:

- the logic is truly page-specific
- the abstraction would make reading harder than the duplication

## Recommended Direction

If the project keeps growing, the next good splits are:

- `public/js/invoice.js`
- `public/js/api-client.js`
- `public/js/session.js`
- `public/js/staff-access.js`
- `public/js/reports.js`

## Final Principle

The safest future changes follow this pattern:

```text
shared config
  -> shared shell
  -> page behavior
  -> backend permission
  -> database migration if needed
```

If you follow that order, the project will stay understandable and easier to scale.
