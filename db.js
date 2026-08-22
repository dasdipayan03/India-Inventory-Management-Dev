/**
 * =========================================================
 * FILE: db.js
 * MODULE: PostgreSQL Database Connection
 *
 * PURPOSE:
 *  - Create and manage a global PostgreSQL connection pool
 *  - Ensure environment variables are configured properly
 *  - Maintain stable database connectivity
 *  - Export pool for use across the application
 *
 * NOTE:
 *  This file runs once when the server starts.
 * =========================================================
 */
const bcrypt = require("bcrypt");
const { Pool } = require("pg");
const { logEvent } = require("./utils/runtime-log");

function shouldUseSsl(databaseUrl) {
  if (process.env.DB_SSL === "true") {
    return true;
  }

  if (process.env.DB_SSL === "false") {
    return false;
  }

  return !/localhost|127\.0\.0\.1/i.test(databaseUrl);
}

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isTruthyEnvFlag(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function buildArchivedDeveloperEmail(normalizedEmail, id) {
  const safeEmail = String(normalizedEmail || "developer@example.com")
    .replace(/[^a-z0-9@._+-]/gi, "")
    .trim();
  return `archived+${id}.${safeEmail}`;
}

// =========================================================
// ENVIRONMENT VARIABLE CHECK
// Ensures DATABASE_URL exists before server starts.
// Without this, database connection is impossible.
// =========================================================
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not defined");
  process.exit(1);
}

// =========================================================
// CREATE POSTGRESQL CONNECTION POOL
//
// Instead of creating a new DB connection for every request,
// we create a pool (connection manager).
//
// Why Pool?
//  - Reuses connections
//  - Improves performance
//  - Prevents DB overload
// =========================================================
const SSL_ENABLED = shouldUseSsl(process.env.DATABASE_URL);
const PG_POOL_MAX = readPositiveInt(process.env.PG_POOL_MAX, 10);
const PG_CONNECTION_TIMEOUT_MS = readPositiveInt(
  process.env.PG_CONNECTION_TIMEOUT_MS,
  10000,
);
const PG_IDLE_TIMEOUT_MS = readPositiveInt(
  process.env.PG_IDLE_TIMEOUT_MS,
  30000,
);
const PG_KEEP_ALIVE_DELAY_MS = readPositiveInt(
  process.env.PG_KEEP_ALIVE_DELAY_MS,
  10000,
);
const PG_MAX_USES = readPositiveInt(process.env.PG_MAX_USES, 7500);
const PG_STATEMENT_TIMEOUT_MS = readNonNegativeInt(
  process.env.PG_STATEMENT_TIMEOUT_MS,
  0,
);
const PG_QUERY_TIMEOUT_MS = readNonNegativeInt(
  process.env.PG_QUERY_TIMEOUT_MS,
  0,
);
const PG_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = readNonNegativeInt(
  process.env.PG_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
  30000,
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: SSL_ENABLED
    ? {
        require: true,
        rejectUnauthorized: false,
      }
    : false,
  max: PG_POOL_MAX,
  connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: PG_IDLE_TIMEOUT_MS,
  keepAlive: true,
  keepAliveInitialDelayMillis: PG_KEEP_ALIVE_DELAY_MS,
  maxUses: PG_MAX_USES,
  statement_timeout: PG_STATEMENT_TIMEOUT_MS,
  query_timeout: PG_QUERY_TIMEOUT_MS,
  idle_in_transaction_session_timeout:
    PG_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
  application_name: process.env.PG_APPLICATION_NAME || "shop-inventory-api",
});

const dbState = {
  startedAt: new Date().toISOString(),
  status: "starting",
  readyAt: null,
  lastError: null,
  lastErrorAt: null,
};

// =========================================================
// GLOBAL ERROR LISTENER
// =========================================================
pool.on("error", (err) => {
  dbState.lastError = err.message;
  dbState.lastErrorAt = new Date().toISOString();
  logEvent("error", "db_pool_error", { error: err });
});

async function ensureSchemaCompatibility() {
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255)
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS google_email_verified BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS google_picture_url TEXT
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_set BOOLEAN NOT NULL DEFAULT TRUE
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_set_at TIMESTAMPTZ
  `);

  await pool.query(`
    UPDATE users
    SET password_set = FALSE
    WHERE google_sub IS NOT NULL
      AND password_set_at IS NULL
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub_unique
      ON users (google_sub)
      WHERE google_sub IS NOT NULL AND google_sub <> ''
  `);

  await pool.query(`
    ALTER TABLE settings
    ADD COLUMN IF NOT EXISTS default_profit_percent NUMERIC(8,2) NOT NULL DEFAULT 30.00
  `);

  await pool.query(`
    ALTER TABLE settings
    ADD COLUMN IF NOT EXISTS bank_name VARCHAR(150)
  `);

  await pool.query(`
    ALTER TABLE settings
    ADD COLUMN IF NOT EXISTS account_holder_name VARCHAR(150)
  `);

  await pool.query(`
    ALTER TABLE settings
    ADD COLUMN IF NOT EXISTS account_number VARCHAR(64)
  `);

  await pool.query(`
    ALTER TABLE settings
    ADD COLUMN IF NOT EXISTS ifsc_code VARCHAR(20)
  `);

  await pool.query(`
    ALTER TABLE settings
    ADD COLUMN IF NOT EXISTS upi_id VARCHAR(120)
  `);

  await pool.query(`
    ALTER TABLE sales
    ADD COLUMN IF NOT EXISTS cost_price NUMERIC(10,2) NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE sales
    ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0
  `);

  await pool.query(`
    UPDATE sales AS s
    SET cost_price = COALESCE(i.buying_rate, 0)
    FROM items AS i
    WHERE i.id = s.item_id
      AND (s.cost_price IS NULL OR s.cost_price = 0)
  `);

  await pool.query(`
    ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(20) NOT NULL DEFAULT 'cash'
  `);

  await pool.query(`
    ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'paid'
  `);

  await pool.query(`
    ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS amount_due NUMERIC(12,2) NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE debts
    ADD COLUMN IF NOT EXISTS customer_address TEXT
  `);

  await pool.query(`
    ALTER TABLE debts
    ADD COLUMN IF NOT EXISTS invoice_id INT REFERENCES invoices(id) ON DELETE SET NULL
  `);

  await pool.query(`
    UPDATE invoices
    SET amount_paid = total_amount,
        amount_due = 0
    WHERE payment_status = 'paid'
      AND amount_due = 0
      AND amount_paid = 0
      AND COALESCE(total_amount, 0) > 0
  `);

  await pool.query(`
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
    )
  `);

  await pool.query(`
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
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchase_items (
      id SERIAL PRIMARY KEY,
      purchase_id INT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      item_name VARCHAR(200) NOT NULL,
      quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
      buying_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
      selling_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
      line_total NUMERIC(12,2) NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
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
    )
  `);

  await pool.query(`
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
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS developer_admins (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(120) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
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
    )
  `);

  await pool.query(`
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
        char_length(trim(message_text)) > 0
      )
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_items_user_name
      ON items (user_id, LOWER(TRIM(name)))
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_items_user_id
      ON items (user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_items_user_name_lookup
      ON items (user_id, LOWER(TRIM(name)))
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sales_user_date
      ON sales (user_id, created_at)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sales_user_date_desc
      ON sales (user_id, created_at DESC, id DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sales_user_item_date
      ON sales (user_id, item_id, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sales_user_id
      ON sales (user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_staff_accounts_owner_user_id
      ON staff_accounts (owner_user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_staff_accounts_username_lookup
      ON staff_accounts (LOWER(TRIM(username)))
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_email_lookup
      ON users (LOWER(email))
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_invoices_user_date
      ON invoices (user_id, date DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_invoices_user_date_id_desc
      ON invoices (user_id, date DESC, id DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_invoices_user_invoice_lookup
      ON invoices (user_id, LOWER(invoice_no))
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_invoices_user_customer_lookup
      ON invoices (user_id, LOWER(TRIM(customer_name)))
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_invoices_user_contact_lookup
      ON invoices (user_id, contact)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_invoices_user_id
      ON invoices (user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice
      ON invoice_items (invoice_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_invoice_counter_user_id
      ON user_invoice_counter (user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_debts_user_id
      ON debts (user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_debts_user_number_created
      ON debts (user_id, customer_number, created_at ASC, id ASC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_debts_user_customer_summary
      ON debts (user_id, customer_name, customer_number)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_invoices_user_contact_due_date
      ON invoices (user_id, contact, date ASC)
      WHERE amount_due > 0
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_suppliers_user_name
      ON suppliers (user_id, LOWER(TRIM(name)))
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_suppliers_user_mobile
      ON suppliers (user_id, mobile_number)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_purchases_user_date
      ON purchases (user_id, purchase_date DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_purchases_user_date_id_desc
      ON purchases (user_id, purchase_date DESC, id DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_purchases_user_supplier_date
      ON purchases (user_id, supplier_id, purchase_date ASC, id ASC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_purchases_supplier_id
      ON purchases (supplier_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase
      ON purchase_items (purchase_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_purchase_items_item_lookup
      ON purchase_items (LOWER(TRIM(item_name)))
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_item_serials_user_serial_unique
      ON item_serials (user_id, serial_no_norm)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_item_serials_user_item_status
      ON item_serials (user_id, item_id, status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_item_serials_purchase_item
      ON item_serials (purchase_item_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_item_serials_invoice_item
      ON item_serials (invoice_item_id)
  `);

  await pool.query(`
    ALTER TABLE item_serials
    ADD COLUMN IF NOT EXISTS sale_rate NUMERIC(12,2) NOT NULL DEFAULT 0
  `);

  await pool.query(`
    UPDATE item_serials s
    SET sale_rate = COALESCE(
      NULLIF(
        (
          SELECT pi.selling_rate
          FROM purchase_items pi
          WHERE pi.id = s.purchase_item_id
          LIMIT 1
        ),
        0
      ),
      NULLIF(i.selling_rate, 0),
      s.sale_rate,
      0
    )
    FROM items i
    WHERE i.id = s.item_id
      AND COALESCE(s.sale_rate, 0) = 0
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_expenses_user_date
      ON expenses (user_id, expense_date DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_expenses_user_date_id_desc
      ON expenses (user_id, expense_date DESC, id DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_expenses_user_title_lookup
      ON expenses (user_id, LOWER(TRIM(title)))
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_expenses_user_category_lookup
      ON expenses (user_id, LOWER(TRIM(category)))
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_debts_invoice_id
      ON debts (invoice_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_developer_admins_email_lookup
      ON developer_admins (LOWER(email))
  `);

  async function reconcileDeveloperAdmins() {
    const developers = await pool.query(`
      SELECT
        id,
        email,
        is_active,
        last_login_at,
        updated_at,
        LOWER(BTRIM(email)) AS normalized_email
      FROM developer_admins
      ORDER BY
        LOWER(BTRIM(email)) ASC,
        is_active DESC,
        updated_at DESC NULLS LAST,
        last_login_at DESC NULLS LAST,
        id DESC
    `);

    const groupedDevelopers = new Map();

    for (const row of developers.rows) {
      const normalizedEmail = String(row.normalized_email || "").trim();
      if (!normalizedEmail) {
        await pool.query(
          `
            UPDATE developer_admins
            SET email = $2,
                is_active = FALSE,
                updated_at = NOW()
            WHERE id = $1
          `,
          [
            row.id,
            buildArchivedDeveloperEmail("developer@example.com", row.id),
          ],
        );

        logEvent("warn", "developer_admin_invalid_email_archived", {
          developerId: row.id,
          previousEmail: row.email,
        });
        continue;
      }

      if (!groupedDevelopers.has(normalizedEmail)) {
        groupedDevelopers.set(normalizedEmail, []);
      }

      groupedDevelopers.get(normalizedEmail).push(row);
    }

    for (const [normalizedEmail, rows] of groupedDevelopers.entries()) {
      const primary = rows[0];
      if (!primary) {
        continue;
      }

      if (primary.email !== normalizedEmail) {
        await pool.query(
          `
            UPDATE developer_admins
            SET email = $2,
                updated_at = NOW()
            WHERE id = $1
          `,
          [primary.id, normalizedEmail],
        );
      }

      if (rows.length <= 1) {
        continue;
      }

      const archivedIds = [];
      for (const duplicate of rows.slice(1)) {
        const archivedEmail = buildArchivedDeveloperEmail(
          normalizedEmail,
          duplicate.id,
        );

        await pool.query(
          `
            UPDATE developer_admins
            SET email = $2,
                is_active = FALSE,
                updated_at = NOW()
            WHERE id = $1
          `,
          [duplicate.id, archivedEmail],
        );

        archivedIds.push(duplicate.id);
      }

      logEvent("warn", "developer_admin_duplicates_archived", {
        normalizedEmail,
        keptId: primary.id,
        archivedIds,
      });
    }

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_admins_email_normalized_unique
        ON developer_admins (LOWER(BTRIM(email)))
    `);
  }

  await reconcileDeveloperAdmins();

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_support_conversations_owner_lookup
      ON support_conversations (owner_user_id, requester_actor_id, requester_role)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_support_conversations_queue
      ON support_conversations (status, last_message_at DESC, id DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_support_conversations_unread_queue
      ON support_conversations (unread_for_developer, last_message_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_support_messages_conversation_created
      ON support_messages (conversation_id, created_at ASC, id ASC)
  `);

  const supportAdminEmail = normalizeEmail(process.env.SUPPORT_ADMIN_EMAIL);
  const supportAdminPasswordHash = String(
    process.env.SUPPORT_ADMIN_PASSWORD_HASH || "",
  ).trim();
  const supportAdminPassword = String(process.env.SUPPORT_ADMIN_PASSWORD || "");
  const supportAdminBootstrapEnabled = isTruthyEnvFlag(
    process.env.SUPPORT_ADMIN_BOOTSTRAP,
  );
  const supportAdminName =
    String(process.env.SUPPORT_ADMIN_NAME || "Developer Support")
      .replace(/\s+/g, " ")
      .trim() || "Developer Support";

  if (
    supportAdminBootstrapEnabled &&
    supportAdminEmail &&
    (supportAdminPasswordHash || supportAdminPassword)
  ) {
    const passwordHash =
      supportAdminPasswordHash || (await bcrypt.hash(supportAdminPassword, 12));
    const existingSupportAdmin = await pool.query(
      `
        SELECT id
        FROM developer_admins
        WHERE LOWER(BTRIM(email)) = $1
        ORDER BY
          is_active DESC,
          updated_at DESC NULLS LAST,
          last_login_at DESC NULLS LAST,
          id DESC
        LIMIT 1
      `,
      [supportAdminEmail],
    );

    if (existingSupportAdmin.rowCount) {
      await pool.query(
        `
          UPDATE developer_admins
          SET name = $2,
              email = $3,
              password_hash = $4,
              is_active = TRUE,
              updated_at = NOW()
          WHERE id = $1
        `,
        [
          existingSupportAdmin.rows[0].id,
          supportAdminName,
          supportAdminEmail,
          passwordHash,
        ],
      );
    } else {
      await pool.query(
        `
          INSERT INTO developer_admins (
            name,
            email,
            password_hash,
            is_active,
            last_login_at,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, TRUE, NULL, NOW(), NOW())
        `,
        [supportAdminName, supportAdminEmail, passwordHash],
      );
    }

    await reconcileDeveloperAdmins();
  } else if (
    !supportAdminBootstrapEnabled &&
    (supportAdminEmail || supportAdminPasswordHash || supportAdminPassword)
  ) {
    logEvent("info", "developer_admin_bootstrap_skipped", {
      reason: "SUPPORT_ADMIN_BOOTSTRAP is not enabled",
    });
  }
}

// =========================================================
// INITIAL CONNECTION TEST
// Ensures the latest schema additions are available.
// =========================================================
async function initializeDatabase() {
  const startedAt = Date.now();
  dbState.status = "connecting";

  logEvent("info", "db_init_started", {
    sslEnabled: SSL_ENABLED,
    poolMax: PG_POOL_MAX,
    connectionTimeoutMs: PG_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: PG_IDLE_TIMEOUT_MS,
    keepAliveDelayMs: PG_KEEP_ALIVE_DELAY_MS,
    maxUses: PG_MAX_USES,
    statementTimeoutMs: PG_STATEMENT_TIMEOUT_MS,
    queryTimeoutMs: PG_QUERY_TIMEOUT_MS,
    idleInTransactionSessionTimeoutMs:
      PG_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
  });

  try {
    await pool.query("SELECT 1");
    logEvent("info", "db_connection_ready", {
      durationMs: Date.now() - startedAt,
    });

    dbState.status = "migrating";
    const schemaStartedAt = Date.now();
    await ensureSchemaCompatibility();

    dbState.status = "ready";
    dbState.readyAt = new Date().toISOString();
    dbState.lastError = null;
    dbState.lastErrorAt = null;

    logEvent("info", "db_schema_ready", {
      schemaDurationMs: Date.now() - schemaStartedAt,
      totalStartupMs: Date.now() - startedAt,
    });

    return dbState;
  } catch (err) {
    dbState.status = "error";
    dbState.lastError = err.message;
    dbState.lastErrorAt = new Date().toISOString();

    logEvent("error", "db_init_failed", {
      durationMs: Date.now() - startedAt,
      error: err,
    });

    throw err;
  }
}

pool.dbState = dbState;
pool.isReady = () => dbState.status === "ready";
pool.readyPromise = initializeDatabase();

module.exports = pool;
