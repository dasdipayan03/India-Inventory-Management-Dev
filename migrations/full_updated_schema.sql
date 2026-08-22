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
  password_set BOOLEAN NOT NULL DEFAULT TRUE,
  password_set_at TIMESTAMPTZ,
  is_verified BOOLEAN DEFAULT FALSE,
  google_sub VARCHAR(255),
  google_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  google_picture_url TEXT,
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
  page_permissions TEXT[] NOT NULL DEFAULT ARRAY['purchase_entry', 'sale_invoice']::TEXT[],
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT staff_accounts_name_length CHECK (char_length(TRIM(name)) >= 2),
  CONSTRAINT staff_accounts_username_length CHECK (
    char_length(TRIM(username)) >= 3
  )
);

-- =====================================================
-- DEVELOPER SUPPORT ADMINS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS developer_admins (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(120) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- SUPPORT CONVERSATIONS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS support_conversations (
  id SERIAL PRIMARY KEY,
  owner_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_actor_id INT NOT NULL,
  requester_role VARCHAR(20) NOT NULL,
  requester_name VARCHAR(120) NOT NULL,
  requester_identifier VARCHAR(120),
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  unread_for_user INT NOT NULL DEFAULT 0,
  unread_for_developer INT NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT support_conversations_requester_role_check CHECK (
    requester_role IN ('owner', 'staff')
  ),
  CONSTRAINT support_conversations_status_check CHECK (
    status IN ('open', 'closed')
  ),
  CONSTRAINT support_conversations_unique_requester UNIQUE (
    owner_user_id,
    requester_actor_id,
    requester_role
  )
);

-- =====================================================
-- SUPPORT MESSAGES TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS support_messages (
  id SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  sender_type VARCHAR(20) NOT NULL,
  sender_actor_id INT NOT NULL,
  sender_role VARCHAR(30) NOT NULL,
  sender_name VARCHAR(120) NOT NULL,
  message_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT support_messages_sender_type_check CHECK (
    sender_type IN ('user', 'developer')
  ),
  CONSTRAINT support_messages_message_not_blank CHECK (
    char_length(TRIM(message_text)) > 0
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
  cost_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  selling_price NUMERIC(10,2) NOT NULL,
  total_price NUMERIC(12,2) NOT NULL,
  gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
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
  customer_address TEXT,
  total NUMERIC(12,2) DEFAULT 0,
  credit NUMERIC(12,2) DEFAULT 0,
  balance NUMERIC(12,2) GENERATED ALWAYS AS (total - credit) STORED,
  remark TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- SUPPLIERS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  mobile_number VARCHAR(10),
  address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT suppliers_mobile_number_format CHECK (
    mobile_number IS NULL OR mobile_number ~ '^[0-9]{10}$'
  )
);

CREATE INDEX IF NOT EXISTS idx_suppliers_user_name
  ON suppliers (user_id, LOWER(TRIM(name)));

CREATE INDEX IF NOT EXISTS idx_suppliers_user_mobile
  ON suppliers (user_id, mobile_number);

-- =====================================================
-- PURCHASES TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supplier_id INT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  bill_no VARCHAR(80),
  purchase_date TIMESTAMPTZ DEFAULT NOW(),
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_due NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_mode VARCHAR(20) NOT NULL DEFAULT 'cash',
  payment_status VARCHAR(20) NOT NULL DEFAULT 'paid',
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchases_user_date
  ON purchases (user_id, purchase_date DESC);

CREATE INDEX IF NOT EXISTS idx_purchases_supplier_id
  ON purchases (supplier_id);

-- =====================================================
-- PURCHASE ITEMS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS purchase_items (
  id SERIAL PRIMARY KEY,
  purchase_id INT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_name VARCHAR(200) NOT NULL,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
  buying_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
  selling_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase
  ON purchase_items (purchase_id);

-- =====================================================
-- EXPENSES TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  category VARCHAR(80) NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_mode VARCHAR(20) NOT NULL DEFAULT 'cash',
  expense_date TIMESTAMPTZ DEFAULT NOW(),
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_user_date
  ON expenses (user_id, expense_date DESC);

-- =====================================================
-- SETTINGS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  shop_name VARCHAR(150),
  shop_address TEXT,
  gst_no VARCHAR(20),
  gst_rate NUMERIC(5,2) NOT NULL DEFAULT 18.00,
  default_profit_percent NUMERIC(8,2) NOT NULL DEFAULT 30.00,
  bank_name VARCHAR(150),
  account_holder_name VARCHAR(150),
  account_number VARCHAR(64),
  ifsc_code VARCHAR(20),
  upi_id VARCHAR(120)
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
  payment_mode VARCHAR(20) NOT NULL DEFAULT 'cash',
  payment_status VARCHAR(20) NOT NULL DEFAULT 'paid',
  amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_due NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_user_date
  ON invoices (user_id, date DESC);

ALTER TABLE debts
  ADD COLUMN IF NOT EXISTS customer_address TEXT;

ALTER TABLE debts
  ADD COLUMN IF NOT EXISTS invoice_id INT REFERENCES invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_debts_invoice_id
  ON debts (invoice_id);

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
-- ITEM SERIALS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS item_serials (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  purchase_id INT REFERENCES purchases(id) ON DELETE CASCADE,
  purchase_item_id INT REFERENCES purchase_items(id) ON DELETE CASCADE,
  invoice_id INT REFERENCES invoices(id) ON DELETE SET NULL,
  invoice_item_id INT REFERENCES invoice_items(id) ON DELETE SET NULL,
  sale_id INT REFERENCES sales(id) ON DELETE SET NULL,
  serial_no VARCHAR(160) NOT NULL,
  serial_no_norm VARCHAR(160) NOT NULL,
  sale_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'in_stock',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sold_at TIMESTAMPTZ,
  CONSTRAINT item_serials_status_check CHECK (
    status IN ('in_stock', 'sold')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_item_serials_user_serial_unique
  ON item_serials (user_id, serial_no_norm);

CREATE INDEX IF NOT EXISTS idx_item_serials_user_item_status
  ON item_serials (user_id, item_id, status);

CREATE INDEX IF NOT EXISTS idx_item_serials_purchase_item
  ON item_serials (purchase_item_id);

CREATE INDEX IF NOT EXISTS idx_item_serials_invoice_item
  ON item_serials (invoice_item_id);

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

DROP TRIGGER IF EXISTS update_suppliers_timestamp ON suppliers;
CREATE TRIGGER update_suppliers_timestamp
BEFORE UPDATE ON suppliers
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS update_purchases_timestamp ON purchases;
CREATE TRIGGER update_purchases_timestamp
BEFORE UPDATE ON purchases
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS update_expenses_timestamp ON expenses;
CREATE TRIGGER update_expenses_timestamp
BEFORE UPDATE ON expenses
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS update_invoices_timestamp ON invoices;
CREATE TRIGGER update_invoices_timestamp
BEFORE UPDATE ON invoices
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS update_developer_admins_timestamp ON developer_admins;
CREATE TRIGGER update_developer_admins_timestamp
BEFORE UPDATE ON developer_admins
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS update_support_conversations_timestamp ON support_conversations;
CREATE TRIGGER update_support_conversations_timestamp
BEFORE UPDATE ON support_conversations
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

-- =====================================================
-- PERFORMANCE INDEXES
-- =====================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
  ON users(email);

CREATE INDEX IF NOT EXISTS idx_users_email_lookup
  ON users (LOWER(email));

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub_unique
  ON users (google_sub)
  WHERE google_sub IS NOT NULL AND google_sub <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_accounts_username_unique
  ON staff_accounts (LOWER(TRIM(username)));

CREATE INDEX IF NOT EXISTS idx_staff_accounts_owner_user_id
  ON staff_accounts(owner_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_admins_email_normalized_unique
  ON developer_admins (LOWER(BTRIM(email)));

CREATE INDEX IF NOT EXISTS idx_developer_admins_email_lookup
  ON developer_admins (LOWER(BTRIM(email)));

CREATE INDEX IF NOT EXISTS idx_items_user_id
  ON items(user_id);

CREATE INDEX IF NOT EXISTS idx_sales_user_id
  ON sales(user_id);

CREATE INDEX IF NOT EXISTS idx_debts_user_id
  ON debts(user_id);

CREATE INDEX IF NOT EXISTS idx_debts_user_number_created
  ON debts (user_id, customer_number, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_suppliers_user_id
  ON suppliers(user_id);

CREATE INDEX IF NOT EXISTS idx_purchases_user_id
  ON purchases(user_id);

CREATE INDEX IF NOT EXISTS idx_expenses_user_id
  ON expenses(user_id);

CREATE INDEX IF NOT EXISTS idx_invoices_user_id
  ON invoices(user_id);

CREATE INDEX IF NOT EXISTS idx_invoices_user_contact_due_date
  ON invoices (user_id, contact, date ASC)
  WHERE amount_due > 0;

CREATE INDEX IF NOT EXISTS idx_support_conversations_owner_lookup
  ON support_conversations (owner_user_id, requester_actor_id, requester_role);

CREATE INDEX IF NOT EXISTS idx_support_conversations_queue
  ON support_conversations (status, last_message_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_support_conversations_unread_queue
  ON support_conversations (unread_for_developer, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_messages_conversation_created
  ON support_messages (conversation_id, created_at ASC, id ASC);

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
