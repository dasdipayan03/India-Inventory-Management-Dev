BEGIN;

-- =====================================================
-- USERS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  mobile_number VARCHAR(10) CHECK (mobile_number ~ '^[0-9]{10}$'),
  password_hash VARCHAR(255) NOT NULL,
  is_verified BOOLEAN DEFAULT FALSE,
  verify_token VARCHAR(255),
  reset_token VARCHAR(255),
  reset_token_expires TIMESTAMP,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- STAFF ACCOUNTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS staff_accounts (
  id SERIAL PRIMARY KEY,
  owner_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  username VARCHAR(50) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT staff_accounts_name_length CHECK (char_length(TRIM(name)) >= 2),
  CONSTRAINT staff_accounts_username_length CHECK (
    char_length(TRIM(username)) >= 3
  )
);

-- =====================================================
-- ITEMS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  quantity NUMERIC(12,2) DEFAULT 0,
  buying_rate NUMERIC(10,2) DEFAULT 0,
  selling_rate NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_items_user_name
  ON items (user_id, LOWER(TRIM(name)));

-- =====================================================
-- SALES TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity NUMERIC(12,2) NOT NULL,
  selling_price NUMERIC(10,2) NOT NULL,
  total_price NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_user_date
  ON sales (user_id, created_at);

-- =====================================================
-- DEBTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS debts (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_name VARCHAR(100) NOT NULL,
  customer_number VARCHAR(10) NOT NULL CHECK (customer_number ~ '^[0-9]{10}$'),
  total NUMERIC(12,2) DEFAULT 0,
  credit NUMERIC(12,2) DEFAULT 0,
  balance NUMERIC(12,2) GENERATED ALWAYS AS (total - credit) STORED,
  remark TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- SETTINGS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  shop_name VARCHAR(150),
  shop_address TEXT,
  gst_no VARCHAR(20),
  gst_rate NUMERIC(5,2) NOT NULL DEFAULT 18.00
);

-- =====================================================
-- INVOICES TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_no VARCHAR(40) NOT NULL UNIQUE,
  gst_no VARCHAR(20),
  customer_name VARCHAR(150),
  contact VARCHAR(20),
  address TEXT,
  date TIMESTAMPTZ DEFAULT NOW(),
  subtotal NUMERIC(12,2) DEFAULT 0,
  gst_amount NUMERIC(12,2) DEFAULT 0,
  total_amount NUMERIC(12,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_user_date
  ON invoices (user_id, date DESC);

-- =====================================================
-- INVOICE ITEMS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS invoice_items (
  id SERIAL PRIMARY KEY,
  invoice_id INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description VARCHAR(200),
  quantity NUMERIC(12,2) DEFAULT 0,
  rate NUMERIC(12,2) DEFAULT 0,
  amount NUMERIC(12,2) DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice
  ON invoice_items (invoice_id);

-- =====================================================
-- USER INVOICE COUNTER TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS user_invoice_counter (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date_key DATE NOT NULL,
  next_no INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, date_key)
);

CREATE INDEX IF NOT EXISTS idx_user_invoice_counter_user_id
  ON user_invoice_counter(user_id);

-- =====================================================
-- TIMESTAMP FUNCTION & TRIGGERS
-- =====================================================
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_users_timestamp ON users;
CREATE TRIGGER update_users_timestamp
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS update_staff_accounts_timestamp ON staff_accounts;
CREATE TRIGGER update_staff_accounts_timestamp
BEFORE UPDATE ON staff_accounts
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS update_items_timestamp ON items;
CREATE TRIGGER update_items_timestamp
BEFORE UPDATE ON items
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS update_debts_timestamp ON debts;
CREATE TRIGGER update_debts_timestamp
BEFORE UPDATE ON debts
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS update_invoices_timestamp ON invoices;
CREATE TRIGGER update_invoices_timestamp
BEFORE UPDATE ON invoices
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

-- =====================================================
-- PERFORMANCE INDEXES
-- =====================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
  ON users(email);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_accounts_username_unique
  ON staff_accounts (LOWER(TRIM(username)));

CREATE INDEX IF NOT EXISTS idx_staff_accounts_owner_user_id
  ON staff_accounts(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_items_user_id
  ON items(user_id);

CREATE INDEX IF NOT EXISTS idx_sales_user_id
  ON sales(user_id);

CREATE INDEX IF NOT EXISTS idx_debts_user_id
  ON debts(user_id);

CREATE INDEX IF NOT EXISTS idx_invoices_user_id
  ON invoices(user_id);

-- =====================================================
-- OPTIONAL TIMEZONE FIX NOTES
-- =====================================================
-- SHOW timezone;
--
-- BEGIN;
-- ALTER TABLE sales
--   ALTER COLUMN created_at
--   TYPE TIMESTAMPTZ
--   USING created_at AT TIME ZONE 'UTC';
-- COMMIT;
--
-- BEGIN;
-- ALTER TABLE invoices
--   ALTER COLUMN date
--   TYPE TIMESTAMPTZ
--   USING date AT TIME ZONE 'UTC';
-- COMMIT;

COMMIT;
