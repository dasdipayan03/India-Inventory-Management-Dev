BEGIN;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS staff_accounts (
  id SERIAL PRIMARY KEY,
  owner_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  username VARCHAR(50) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT staff_accounts_name_length CHECK (char_length(trim(name)) >= 2),
  CONSTRAINT staff_accounts_username_length CHECK (
    char_length(trim(username)) >= 3
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_accounts_username_unique
  ON staff_accounts (LOWER(TRIM(username)));

CREATE INDEX IF NOT EXISTS idx_staff_accounts_owner_user_id
  ON staff_accounts (owner_user_id);

CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_invoices_timestamp ON invoices;
CREATE TRIGGER update_invoices_timestamp
BEFORE UPDATE ON invoices
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS update_staff_accounts_timestamp ON staff_accounts;
CREATE TRIGGER update_staff_accounts_timestamp
BEFORE UPDATE ON staff_accounts
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

COMMIT;
