BEGIN;

ALTER TABLE staff_accounts
  ADD COLUMN IF NOT EXISTS page_permissions TEXT[] NOT NULL
  DEFAULT ARRAY['add_stock', 'sale_invoice']::TEXT[];

UPDATE staff_accounts
SET page_permissions = ARRAY['add_stock', 'sale_invoice']::TEXT[]
WHERE page_permissions IS NULL
   OR array_length(page_permissions, 1) IS NULL;

COMMIT;
