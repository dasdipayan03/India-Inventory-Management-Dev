/**
 * =========================================================
 * FILE: routes/inventory.js
 * PURPOSE: STOCK, REPORT EXPORT, GST, CUSTOMER DUE ও DASHBOARD ROUTES
 * =========================================================
 * এই Express router inventory lookup/reports, stock intelligence, PDF/Excel export, sales/GST reports,
 * customer debt ledger এবং dashboard analytics পরিচালনা করে। সব data authenticated account scope-এ query হয়;
 * feature permissions routes সীমিত করে। Debt mutations transaction-এর মধ্যে linked invoice balance sync করে,
 * আর cached read endpoints mutation-এর পরে user cache invalidation দিয়ে fresh রাখা হয়।
 */

// routes/inventory.js

// ==================== BLOCK 01: DEPENDENCIES ও SHARED INFRASTRUCTURE ====================
// Database pool queries/transactions চালায়; PDFKit ও ExcelJS downloadable reports বানায়। Auth/permission helpers account scope দেয়,
// concurrency helpers lock/normalize করে, cache utilities read-heavy endpoints দ্রুত রাখে এবং pagination helpers large lists সীমিত করে।
const express = require("express");
const pool = require("../db");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const {
  authMiddleware,
  getUserId,
  requireOwner,
  requirePermission,
} = require("../middleware/auth");
const {
  lockScopedResource,
  normalizeDisplayText,
  normalizeLookupText,
} = require("../utils/concurrency");
const { cacheJsonResponse } = require("../middleware/cache");
const { invalidateUserCache } = require("../utils/cache");
const {
  parsePagination,
  setPaginationHeaders,
} = require("../utils/pagination");

const router = express.Router();
// ==================== BLOCK 02: STOCK THRESHOLDS, EXPORT THEME ও FORMATTERS ====================
// Central thresholds low-stock/reorder/slow-moving classification consistent রাখে। PDF theme visual palette দেয়;
// currency/date formatters Indian numeric style ও Asia/Kolkata date presentation সব exports-এ reuse করে।
// ===== STOCK ALERT CONFIG =====
const STOCK_CONFIG = {
  CRITICAL_DAYS: 4,
  WARNING_DAYS: 15,
  REORDER_TARGET_DAYS: 21,
  REORDER_LIMIT: 8,
  SLOW_MOVING_DAYS: 45,
  STAGNANT_DAYS: 75,
  SLOW_MOVING_LIMIT: 8,
  SLOW_MOVING_MIN_QTY: 5,
  SLOW_MOVING_LOW_SALES: 3,
};

const PDF_THEME = {
  navy: "#17315d",
  cyan: "#0ea5e9",
  cyanSoft: "#eef6ff",
  line: "#d7e3f4",
  ink: "#0f172a",
  muted: "#64748b",
  success: "#15803d",
  danger: "#b91c1c",
  rowAlt: "#f8fbff",
};

const currencyFormatter = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

// ==================== BLOCK 03: SAFE DISPLAY ও EXPORT VALUE HELPERS ====================
// Currency/date output format করে, current IST year নেয় এবং filename unsafe characters normalized underscore-এ বদলায়।
// sanitizeExcelCell `=`, `+`, `-`, `@` দিয়ে শুরু হওয়া user text-এর আগে apostrophe দিয়ে spreadsheet formula injection আটকায়।
function formatCurrency(value) {
  return currencyFormatter.format(Number(value) || 0);
}

function formatIstDate(value) {
  return dateFormatter.format(new Date(value));
}

function getCurrentIstYear() {
  return Number.parseInt(
    new Intl.DateTimeFormat("en-IN", {
      year: "numeric",
      timeZone: "Asia/Kolkata",
    }).format(new Date()),
    10,
  );
}

function safeFilePart(value) {
  return String(value || "report")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function sanitizeExcelCell(value) {
  if (value == null) {
    return "";
  }

  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.replace(/^\uFEFF/, "");
  return /^[\t\r ]*[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
}

function parseNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// ==================== BLOCK 04: INVOICE PAYMENT STATUS ও DEBT-LEDGER RECONCILIATION ====================
// Paid/due numbers থেকে paid/partial/due status ঠিক করে। Debt entry delete/change-এর পরে linked invoices FOR UPDATE lock করে,
// ledger credits পুনরায় sum, total-এর মধ্যে clamp এবং amount_paid/amount_due/payment_status atomically sync করে।
function getInvoicePaymentStatus(amountPaid, amountDue) {
  if (amountDue > 0.009 && amountPaid > 0.009) {
    return "partial";
  }

  if (amountDue > 0.009) {
    return "due";
  }

  return "paid";
}

async function syncInvoiceBalancesFromDebtLedger(client, userId, invoiceIds) {
  const uniqueInvoiceIds = Array.from(
    new Set(
      invoiceIds
        .map((invoiceId) => Number.parseInt(invoiceId, 10))
        .filter((invoiceId) => Number.isInteger(invoiceId) && invoiceId > 0),
    ),
  );

  for (const invoiceId of uniqueInvoiceIds) {
    const invoiceResult = await client.query(
      `SELECT id, total_amount
       FROM invoices
       WHERE user_id = $1 AND id = $2
       FOR UPDATE`,
      [userId, invoiceId],
    );

    const invoice = invoiceResult.rows[0];
    if (!invoice) {
      continue;
    }

    const ledgerResult = await client.query(
      `SELECT COALESCE(SUM(credit), 0) AS amount_paid
       FROM debts
       WHERE user_id = $1 AND invoice_id = $2`,
      [userId, invoiceId],
    );

    const totalAmount = Number(invoice.total_amount || 0);
    const ledgerPaid = Number(ledgerResult.rows[0]?.amount_paid || 0);
    const amountPaid = Number(
      Math.min(Math.max(ledgerPaid, 0), totalAmount).toFixed(2),
    );
    const amountDue = Number((totalAmount - amountPaid).toFixed(2));

    await client.query(
      `UPDATE invoices
       SET amount_paid = $1,
           amount_due = $2,
           payment_status = $3,
           updated_at = NOW()
       WHERE user_id = $4 AND id = $5`,
      [
        amountPaid,
        amountDue,
        getInvoicePaymentStatus(amountPaid, amountDue),
        userId,
        invoiceId,
      ],
    );
  }
}

// ==================== BLOCK 05: SHOP IDENTITY ও REUSABLE PDF LAYOUT ====================
// Settings থেকে shop name fallbackসহ নেয়। Banner/table-header helpers report branding ও columns আঁকে; ensurePdfSpace row/summary
// বর্তমান page-এ না ধরলে নতুন page যোগ করে caller-এর header-redraw callback চালায়।
async function getShopName(userId) {
  const result = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(shop_name), ''), 'Shop Inventory Management') AS shop_name
     FROM settings
     WHERE user_id = $1
     LIMIT 1`,
    [userId],
  );

  return result.rows[0]?.shop_name || "Shop Inventory Management";
}

function drawPdfBanner(doc, title, shopName, subtitle, rightText) {
  const x = 40;
  const y = 34;
  const width = 515;
  const height = 78;

  doc.save();
  doc.roundedRect(x, y, width, height, 14).fill(PDF_THEME.navy);
  doc.fillColor("white").font("Helvetica-Bold").fontSize(18);
  doc.text(title, x + 18, y + 14, { width: 260 });
  doc.fillColor("#eff6ff").font("Helvetica-Bold").fontSize(11);
  doc.text(shopName, x + 18, y + 36, { width: 300 });
  doc.fillColor("#dbeafe").font("Helvetica").fontSize(10);
  doc.text(subtitle, x + 18, y + 52, { width: 300 });
  doc.fillColor("#eff6ff").font("Helvetica").fontSize(10);
  doc.text(rightText, x + 330, y + 22, { width: 165, align: "right" });
  doc.restore();

  doc.fillColor(PDF_THEME.ink).font("Helvetica").fontSize(10);
  doc.y = y + height + 16;
}

function drawPdfTableHeader(doc, columns) {
  const x = 40;
  const y = doc.y;
  const width = 515;
  const rowHeight = 22;

  doc.save();
  doc.roundedRect(x, y, width, rowHeight, 8).fill(PDF_THEME.cyanSoft);
  doc.restore();

  doc.font("Helvetica-Bold").fontSize(9).fillColor(PDF_THEME.navy);
  columns.forEach((column) => {
    doc.text(column.label, column.x, y + 6, {
      width: column.width,
      align: column.align || "left",
    });
  });

  doc.fillColor(PDF_THEME.ink).font("Helvetica").fontSize(10);
  doc.y = y + rowHeight + 6;
}

function ensurePdfSpace(doc, heightNeeded, onNewPage) {
  if (doc.y + heightNeeded <= doc.page.height - doc.page.margins.bottom) {
    return;
  }

  doc.addPage();
  onNewPage();
}

// ==================== BLOCK 06: STOCK INTELLIGENCE CLASSIFICATION ====================
// Estimated days-left থেকে low-stock status ও reorder priority দেয়। Recent sales এবং days-cover থেকে slow/no-sale/overstock label
// ও human-readable focus note বানায়; thresholds STOCK_CONFIG-এ থাকায় dashboard cards ও reports একই business meaning ব্যবহার করে।
function getLowStockStatus(daysLeft) {
  if (!Number.isFinite(daysLeft)) {
    return "";
  }

  if (daysLeft <= STOCK_CONFIG.CRITICAL_DAYS) {
    return "LOW";
  }

  if (daysLeft <= STOCK_CONFIG.WARNING_DAYS) {
    return "MEDIUM";
  }

  return "OK";
}

function getReorderPriority(daysLeft) {
  if (!Number.isFinite(daysLeft)) {
    return "WATCH";
  }

  if (daysLeft <= STOCK_CONFIG.CRITICAL_DAYS) {
    return "URGENT";
  }

  if (daysLeft <= STOCK_CONFIG.WARNING_DAYS) {
    return "SOON";
  }

  return "BUFFER";
}

function getSlowMovingPriority(sold30Days, daysCover) {
  if (sold30Days <= 0) {
    return "NO SALE";
  }

  if (Number.isFinite(daysCover) && daysCover >= STOCK_CONFIG.STAGNANT_DAYS) {
    return "OVERSTOCK";
  }

  return "SLOW";
}

function getSlowMovingFocusNote(sold30Days, daysCover) {
  if (sold30Days <= 0) {
    return "No sale in the last 30 days.";
  }

  if (Number.isFinite(daysCover) && daysCover >= STOCK_CONFIG.STAGNANT_DAYS) {
    return "Very high stock cover against recent movement.";
  }

  if (
    Number.isFinite(daysCover) &&
    daysCover >= STOCK_CONFIG.SLOW_MOVING_DAYS
  ) {
    return "Recent sales are soft for the stock on hand.";
  }

  return "Push visibility before buying more.";
}

// ==================== BLOCK 07: ROUTER AUTH BOUNDARY ও STOCK DEFAULT SETTINGS ====================
// পরের সব endpoints valid session require করে। stock-defaults GET purchase workflow-এর saved profit percentage cacheসহ দেয়;
// PUT non-negative bounded value upsert করে এবং cache invalidate করে, যাতে নতুন purchase line rate calculation updated default পায়।
// ✅ Protect all routes
router.use(authMiddleware);

// ----------------- STOCK DEFAULT SETTINGS -----------------
router.get(
  "/stock-defaults",
  requirePermission("purchase_entry"),
  cacheJsonResponse({
    namespace: "inventory:stock-defaults",
    ttlMs: 15 * 1000,
  }),
  async (req, res) => {
    try {
      const user_id = getUserId(req);
      const { rows } = await pool.query(
        `
        SELECT default_profit_percent
        FROM settings
        WHERE user_id = $1
        LIMIT 1
      `,
        [user_id],
      );

      const savedValue = Number(rows[0]?.default_profit_percent);

      res.json({
        success: true,
        settings: Number.isFinite(savedValue)
          ? { default_profit_percent: savedValue }
          : {},
      });
    } catch (err) {
      console.error("Stock defaults load error:", err);
      res.status(500).json({ error: "Failed to load stock defaults" });
    }
  },
);

router.put(
  "/stock-defaults",
  requirePermission("purchase_entry"),
  async (req, res) => {
    try {
      const user_id = getUserId(req);
      const normalizedProfitPercent = parseNonNegativeNumber(
        req.body?.default_profit_percent,
      );

      if (normalizedProfitPercent === null || normalizedProfitPercent > 10000) {
        return res.status(400).json({
          error:
            "Default profit percent must be a valid number between 0 and 10000.",
        });
      }

      const roundedProfitPercent = Number(normalizedProfitPercent.toFixed(2));
      const { rows } = await pool.query(
        `
        INSERT INTO settings (user_id, default_profit_percent)
        VALUES ($1, $2)
        ON CONFLICT (user_id)
        DO UPDATE SET
          default_profit_percent = EXCLUDED.default_profit_percent
        RETURNING default_profit_percent
      `,
        [user_id, roundedProfitPercent],
      );

      invalidateUserCache(user_id);
      res.json({
        success: true,
        settings: {
          default_profit_percent:
            Number(rows[0]?.default_profit_percent) || roundedProfitPercent,
        },
      });
    } catch (err) {
      console.error("Stock defaults save error:", err);
      res.status(500).json({ error: "Failed to save stock defaults" });
    }
  },
);

// Auto-suggest item names
// ==================== BLOCK 08: ITEM NAME, DETAIL ও SERIAL LOOKUPS ====================
// Item names permission-sharing autocomplete list দেয়; item info selected product-এর stock/rates/serial behavior দেয়। Serial endpoint
// item/query/exact filters দিয়ে available serials account scope-এ আনে, যাতে invoice/purchase UI duplicate বা sold serial ব্যবহার না করে।
router.get(
  "/items/names",
  requirePermission(
    // "add_stock", // Add New Stock page retired; shared lookup remains active.
    "purchase_entry",
    "sale_invoice",
    "stock_report",
  ),
  cacheJsonResponse({ namespace: "inventory:item-names", ttlMs: 15 * 1000 }),
  async (req, res) => {
    try {
      const user_id = getUserId(req);
      const result = await pool.query(
        "SELECT name FROM items WHERE user_id=$1 ORDER BY LOWER(TRIM(name)) ASC",
        [user_id],
      );
      res.json(result.rows.map((r) => r.name));
    } catch (err) {
      if (process.env.NODE_ENV !== "production")
        console.error("Error fetching item names:", err);
      res.status(500).json({ error: "Server error" });
    }
  },
);

router.get(
  "/items/info",
  requirePermission("sale_invoice", "purchase_entry"),
  cacheJsonResponse({ namespace: "inventory:item-info", ttlMs: 10 * 1000 }),
  async (req, res) => {
    try {
      const user_id = getUserId(req);
      const name = req.query.name;
      if (!name) return res.status(400).json({ error: "Missing item name" });

      const result = await pool.query(
        `SELECT id, name, quantity, buying_rate, selling_rate
       FROM items
       WHERE user_id=$1 AND LOWER(TRIM(name))=LOWER($2)`,
        [user_id, name.trim()],
      );

      if (!result.rows.length)
        return res.status(404).json({ error: "Item not found" });

      res.json(result.rows[0]);
    } catch (err) {
      console.error("Item info error:", err);
      res.status(500).json({ error: "Server error" });
    }
  },
);

router.get(
  "/item-serials",
  requirePermission("sale_invoice", "purchase_entry", "stock_report"),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const itemName = normalizeDisplayText(req.query.item_name);
      const query = normalizeDisplayText(req.query.q);
      const exactLookup = ["1", "true", "yes"].includes(
        String(req.query.exact || "").toLowerCase(),
      );

      if (!itemName && (!exactLookup || !query)) {
        return res.status(400).json({ error: "Item name is required." });
      }

      const params = [userId];
      const filters = [
        "s.user_id = $1",
        "i.user_id = $1",
        "s.status = 'in_stock'",
      ];

      if (itemName) {
        params.push(itemName);
        filters.push(`LOWER(TRIM(i.name)) = LOWER(TRIM($${params.length}))`);
      }

      if (query) {
        params.push(exactLookup ? normalizeLookupText(query) : `%${query}%`);
        filters.push(
          exactLookup
            ? `s.serial_no_norm = $${params.length}`
            : `s.serial_no ILIKE $${params.length}`,
        );
      }

      const result = await pool.query(
        `
        SELECT
          s.id,
          s.serial_no,
          s.sale_rate,
          s.status,
          i.id AS item_id,
          i.name AS item_name
        FROM item_serials s
        JOIN items i
          ON i.id = s.item_id
        WHERE ${filters.join("\n          AND ")}
        ORDER BY s.created_at ASC, s.id ASC
        LIMIT 25
      `,
        params,
      );

      res.json({
        success: true,
        serials: result.rows,
      });
    } catch (err) {
      console.error("Item serial lookup error:", err);
      res.status(500).json({ error: "Failed to load serial numbers" });
    }
  },
);

// ----------------- ITEM WISE STOCK & SALES REPORT (JSON) -----------------
// ==================== BLOCK 09: FILTERED ITEM/STOCK REPORT ====================
// stock_report permission-এর user optional name query ও pagination দিয়ে inventory rows আনে। Selling/buying/quantity/value fields
// dashboard table-এর dataset দেয়; cache identical filters দ্রুত serve করে এবং pagination headers/client metadata large catalog handle করে।
router.get(
  "/items/report",
  requirePermission("stock_report"),
  cacheJsonResponse({ namespace: "inventory:item-report", ttlMs: 10 * 1000 }),
  async (req, res) => {
    try {
      const user_id = getUserId(req);
      const { name } = req.query;
      const pagination = parsePagination(req.query, 100, 500, {
        optional: true,
      });

      let params = [user_id];
      let nameFilter = "";

      if (name && name.trim()) {
        params.push(name.trim());
        nameFilter = "AND LOWER(TRIM(i.name)) = LOWER($2)";
      }

      const paginationClause = pagination.enabled
        ? `LIMIT ${pagination.limit} OFFSET ${pagination.offset}`
        : "";
      const countResult = pagination.enabled
        ? await pool.query(
            `
      SELECT COUNT(*)::int AS total
      FROM items i
      WHERE i.user_id = $1
      ${nameFilter}
      `,
            params,
          )
        : null;

      const result = await pool.query(
        `
      SELECT
      i.name AS item_name,
      i.quantity AS available_qty,
      i.buying_rate,
      i.selling_rate,
      COALESCE(SUM(s.quantity), 0) AS sold_qty
      FROM items i
      LEFT JOIN sales s
        ON s.item_id = i.id
        AND s.user_id = $1
      WHERE i.user_id = $1
      ${nameFilter}
      GROUP BY i.id, i.name, i.quantity, i.buying_rate, i.selling_rate
      ORDER BY i.name ASC
      ${paginationClause}
      `,
        params,
      );

      setPaginationHeaders(
        res,
        pagination,
        countResult?.rows[0]?.total,
        result.rows.length,
      );
      res.json(result.rows);
    } catch (err) {
      console.error("Item report error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ----------------- STOCK ALERTS (Days of Stock Model) -----------------
// ==================== BLOCK 10: LOW-STOCK ALERT LIST ====================
// Current quantity ও recent sales velocity থেকে estimated days-left হিসাব করে configurable thresholds অনুযায়ী LOW/MEDIUM/OK status দেয়।
// Cached result attention table ও alert count পূরণ করে; শুধু current authenticated account-এর items/sales aggregate হয়।
router.get(
  "/items/low-stock",
  requirePermission("stock_report"),
  cacheJsonResponse({ namespace: "inventory:low-stock", ttlMs: 10 * 1000 }),
  async (req, res) => {
    try {
      const user_id = getUserId(req);

      const result = await pool.query(
        `
      WITH sales_30 AS (
        SELECT 
          item_id,
          SUM(quantity) AS sold_30_days
        FROM sales
        WHERE user_id = $1
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY item_id
      )
      SELECT 
        i.name AS item_name,
        i.quantity AS available_qty,
        COALESCE(s.sold_30_days, 0) AS sold_30_days,
        ROUND(
          CASE 
            WHEN COALESCE(s.sold_30_days, 0) = 0 THEN NULL
            ELSE (i.quantity / NULLIF((s.sold_30_days / 30.0),0))
          END
        , 2) AS days_left
      FROM items i
      LEFT JOIN sales_30 s 
        ON s.item_id = i.id
      WHERE i.user_id = $1
        AND COALESCE(s.sold_30_days, 0) > 0
        AND (
          (i.quantity / NULLIF((s.sold_30_days / 30.0),0)) <= $2
        )
      ORDER BY days_left ASC
      `,
        [user_id, STOCK_CONFIG.WARNING_DAYS],
      );

      const rowsWithStatus = result.rows.map((r) => ({
        ...r,
        status: getLowStockStatus(Number(r.days_left)),
      }));

      res.json(rowsWithStatus);
    } catch (err) {
      console.error("Stock alert error FULL:", err);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ----------------- REORDER SUGGESTIONS (Replenishment Planner) -----------------
// ==================== BLOCK 11: REORDER SUGGESTIONS ====================
// Sales velocity, stock cover ও target days ব্যবহার করে suggested replenishment quantity, priority এবং estimated buying investment বানায়।
// Limit/threshold config operational shortlist ছোট রাখে; frontend KPI এবং reorder table একই computed rows থেকে তৈরি হয়।
router.get(
  "/items/reorder-suggestions",
  requirePermission("stock_report"),
  cacheJsonResponse({ namespace: "inventory:reorder", ttlMs: 10 * 1000 }),
  async (req, res) => {
    try {
      const user_id = getUserId(req);

      const result = await pool.query(
        `
      WITH sales_30 AS (
        SELECT
          item_id,
          SUM(quantity) AS sold_30_days
        FROM sales
        WHERE user_id = $1
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY item_id
      ),
      movement AS (
        SELECT
          i.name AS item_name,
          i.quantity AS available_qty,
          COALESCE(i.buying_rate, 0) AS buying_rate,
          COALESCE(s.sold_30_days, 0) AS sold_30_days,
          ROUND(COALESCE(s.sold_30_days, 0) / 30.0, 2) AS daily_run_rate,
          ROUND(
            CASE
              WHEN COALESCE(s.sold_30_days, 0) = 0 THEN NULL
              ELSE (i.quantity / NULLIF((s.sold_30_days / 30.0), 0))
            END
          , 2) AS days_left,
          CEIL((COALESCE(s.sold_30_days, 0) / 30.0) * $2) AS target_stock_qty,
          CEIL(
            GREATEST(
              ((COALESCE(s.sold_30_days, 0) / 30.0) * $2) - i.quantity,
              0
            )
          ) AS recommended_reorder_qty
        FROM items i
        LEFT JOIN sales_30 s
          ON s.item_id = i.id
        WHERE i.user_id = $1
          AND COALESCE(s.sold_30_days, 0) > 0
      )
      SELECT
        item_name,
        available_qty,
        buying_rate,
        sold_30_days,
        daily_run_rate,
        days_left,
        target_stock_qty,
        recommended_reorder_qty,
        ROUND((recommended_reorder_qty * buying_rate)::numeric, 2) AS reorder_cost
      FROM movement
      WHERE recommended_reorder_qty > 0
        AND (
          days_left IS NULL
          OR days_left < $2
        )
      ORDER BY
        CASE
          WHEN days_left IS NULL THEN 3
          WHEN days_left <= $3 THEN 0
          WHEN days_left <= $4 THEN 1
          ELSE 2
        END,
        sold_30_days DESC,
        days_left ASC NULLS LAST,
        item_name ASC
      LIMIT $5
      `,
        [
          user_id,
          STOCK_CONFIG.REORDER_TARGET_DAYS,
          STOCK_CONFIG.CRITICAL_DAYS,
          STOCK_CONFIG.WARNING_DAYS,
          STOCK_CONFIG.REORDER_LIMIT,
        ],
      );

      const rowsWithPriority = result.rows.map((row) => {
        const daysLeft = Number(row.days_left);
        const recommendedReorderQty = Number(row.recommended_reorder_qty) || 0;
        const buyingRate = Number(row.buying_rate) || 0;

        return {
          ...row,
          target_days: STOCK_CONFIG.REORDER_TARGET_DAYS,
          priority: getReorderPriority(daysLeft),
          recommended_reorder_qty: recommendedReorderQty,
          reorder_cost:
            Number(row.reorder_cost) || recommendedReorderQty * buyingRate,
        };
      });

      res.json(rowsWithPriority);
    } catch (err) {
      console.error("Reorder suggestions error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ----------------- SLOW MOVING STOCK (Sell-First Focus) -----------------
// ==================== BLOCK 12: SLOW-MOVING / OVERSTOCK SUGGESTIONS ====================
// Last 30-day sales, on-hand quantity ও days-cover দিয়ে no-sale, slow এবং overstock candidates চিহ্নিত করে। Focus note sales push বনাম
// further buying pause-এর context দেয়; minimum quantity/limit config low-impact rows বাদ দেয়।
router.get(
  "/items/slow-moving",
  requirePermission("stock_report"),
  cacheJsonResponse({ namespace: "inventory:slow-moving", ttlMs: 10 * 1000 }),
  async (req, res) => {
    try {
      const user_id = getUserId(req);

      const result = await pool.query(
        `
      WITH sales_30 AS (
        SELECT
          item_id,
          SUM(quantity) AS sold_30_days
        FROM sales
        WHERE user_id = $1
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY item_id
      ),
      movement AS (
        SELECT
          i.name AS item_name,
          i.quantity AS available_qty,
          COALESCE(i.buying_rate, 0) AS buying_rate,
          COALESCE(s.sold_30_days, 0) AS sold_30_days,
          ROUND(COALESCE(s.sold_30_days, 0) / 30.0, 2) AS daily_run_rate,
          ROUND(
            CASE
              WHEN COALESCE(s.sold_30_days, 0) = 0 THEN NULL
              ELSE (i.quantity / NULLIF((s.sold_30_days / 30.0), 0))
            END
          , 2) AS days_cover,
          ROUND((i.quantity * COALESCE(i.buying_rate, 0))::numeric, 2) AS stock_value
        FROM items i
        LEFT JOIN sales_30 s
          ON s.item_id = i.id
        WHERE i.user_id = $1
          AND i.quantity >= $4
      )
      SELECT
        item_name,
        available_qty,
        buying_rate,
        sold_30_days,
        daily_run_rate,
        days_cover,
        stock_value
      FROM movement
      WHERE
        sold_30_days = 0
        OR days_cover >= $2
        OR (
          sold_30_days <= $3
          AND available_qty >= ($4 * 2)
        )
      ORDER BY
        CASE
          WHEN sold_30_days = 0 THEN 0
          WHEN days_cover >= $5 THEN 1
          ELSE 2
        END,
        stock_value DESC,
        available_qty DESC,
        sold_30_days ASC,
        item_name ASC
      LIMIT $6
      `,
        [
          user_id,
          STOCK_CONFIG.SLOW_MOVING_DAYS,
          STOCK_CONFIG.SLOW_MOVING_LOW_SALES,
          STOCK_CONFIG.SLOW_MOVING_MIN_QTY,
          STOCK_CONFIG.STAGNANT_DAYS,
          STOCK_CONFIG.SLOW_MOVING_LIMIT,
        ],
      );

      const rowsWithPriority = result.rows.map((row) => {
        const availableQty = Number(row.available_qty) || 0;
        const buyingRate = Number(row.buying_rate) || 0;
        const sold30Days = Number(row.sold_30_days) || 0;
        const daysCover =
          row.days_cover == null ? null : Number(row.days_cover);

        return {
          ...row,
          available_qty: availableQty,
          sold_30_days: sold30Days,
          stock_value: Number(row.stock_value) || availableQty * buyingRate,
          priority: getSlowMovingPriority(sold30Days, daysCover),
          focus_note: getSlowMovingFocusNote(sold30Days, daysCover),
        };
      });

      res.json(rowsWithPriority);
    } catch (err) {
      console.error("Slow moving stock error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ----------------- ITEM WISE STOCK & SALES REPORT (PDF) -----------------
// ==================== BLOCK 13: STOCK REPORT PDF EXPORT ====================
// Item filter ও show-selling/show-buying flags দিয়ে report columns নির্বাচন করে। PDFKit branded header, alternating rows, page-break header
// redraw এবং stock-value summary আঁকে; Content-Disposition safe filename দিয়ে browser download response পাঠায়।
router.get(
  "/items/report/pdf",
  requirePermission("stock_report"),
  async (req, res) => {
    try {
      const user_id = getUserId(req);
      const { name } = req.query;
      const showSelling = req.query.show_selling !== "false";
      const showBuying = req.query.show_buying !== "false";
      const shopName = await getShopName(user_id);

      let params = [user_id];
      let nameFilter = "";

      if (name && name.trim()) {
        params.push(name.trim());
        nameFilter = "AND LOWER(TRIM(i.name)) = LOWER($2)";
      }

      const result = await pool.query(
        `
      SELECT
      i.name AS item_name,
      i.quantity AS available_qty,
      i.buying_rate,
      i.selling_rate,
      COALESCE(SUM(s.quantity), 0) AS sold_qty
      FROM items i
      LEFT JOIN sales s
        ON s.item_id = i.id
        AND s.user_id = $1
      WHERE i.user_id = $1
      ${nameFilter}
      GROUP BY i.id, i.name, i.quantity, i.buying_rate, i.selling_rate
      ORDER BY i.name ASC
      `,
        params,
      );

      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const filename =
        name && name.trim()
          ? `stock_report_${safeFilePart(name)}.pdf`
          : "stock_report.pdf";
      const reportScope =
        name && name.trim()
          ? `Filtered for: ${name.trim()}`
          : "Full stock catalog";
      const hiddenRateColumnCount = Number(!showBuying) + Number(!showSelling);
      const visibleRateColumnCount = Number(showBuying) + Number(showSelling);
      const stockColumns = [
        { label: "Sl", x: 46, width: 28 },
        { label: "Item Name", x: 78, width: 180 + hiddenRateColumnCount * 76 },
        {
          label: "Available",
          x: 262 + hiddenRateColumnCount * 76,
          width: 72,
          align: "right",
        },
      ];
      let rateColumnX = 490 - visibleRateColumnCount * 76;
      if (showBuying) {
        stockColumns.push({
          label: "Buying",
          x: rateColumnX,
          width: 72,
          align: "right",
        });
        rateColumnX += 76;
      }
      if (showSelling) {
        stockColumns.push({
          label: "Selling",
          x: rateColumnX,
          width: 72,
          align: "right",
        });
      }
      stockColumns.push({ label: "Sold", x: 490, width: 54, align: "right" });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

      doc.pipe(res);

      drawPdfBanner(
        doc,
        "Stock Report",
        shopName,
        reportScope,
        `Generated: ${formatIstDate(new Date())}`,
      );

      // ✅ draw table header for first page
      drawPdfTableHeader(doc, stockColumns);

      // ---- Rows ----
      let totalCostValue = 0;
      let totalSellingValue = 0;

      result.rows.forEach((r, i) => {
        // 🔒 Page overflow handling (same as Sales PDF)
        if (doc.y > 720) {
          doc.addPage();
          drawPdfTableHeader(doc, stockColumns);
        }
        const qty = Number(r.available_qty);
        const buy = Number(r.buying_rate);
        const sell = Number(r.selling_rate);

        totalCostValue += qty * buy;
        totalSellingValue += qty * sell;

        const y = doc.y;

        // 👉 Dynamic height based on item name
        const itemHeight = doc.heightOfString(r.item_name || "", {
          width: stockColumns[1].width,
          align: "left",
        });

        if (i % 2 === 0) {
          doc.save();
          doc
            .rect(40, y - 2, 515, Math.max(itemHeight, 18) + 6)
            .fill(PDF_THEME.rowAlt);
          doc.restore();
        }

        doc.fillColor(PDF_THEME.ink).font("Helvetica").fontSize(10);
        const values = [String(i + 1), r.item_name || "", qty.toFixed(2)];
        if (showBuying) values.push(formatCurrency(buy));
        if (showSelling) values.push(formatCurrency(sell));
        values.push(Number(r.sold_qty).toFixed(2));
        stockColumns.forEach((column, index) => {
          doc.text(values[index], column.x, y, {
            width: column.width,
            align: column.align || "left",
          });
        });
        doc
          .moveTo(40, y + Math.max(itemHeight, 18) + 2)
          .lineTo(555, y + Math.max(itemHeight, 18) + 2)
          .strokeColor(PDF_THEME.line)
          .stroke();
        // 👉 Move Y exactly like Sales PDF
        doc.y = y + Math.max(itemHeight, 18) + 6;
      });

      const profit = totalSellingValue - totalCostValue;
      const summaryHeight = showSelling ? 88 : 58;

      ensurePdfSpace(doc, summaryHeight + 16, () => {
        drawPdfBanner(
          doc,
          "Stock Summary",
          shopName,
          reportScope,
          `Generated: ${formatIstDate(new Date())}`,
        );
      });

      const summaryY = doc.y + 8;

      doc.save();
      doc
        .roundedRect(310, summaryY, 245, summaryHeight, 12)
        .fillAndStroke("#f8fbff", PDF_THEME.line);
      doc.restore();

      doc.font("Helvetica-Bold").fontSize(11).fillColor(PDF_THEME.navy);
      doc.text("Report Summary", 326, summaryY + 12, { width: 190 });
      doc.font("Helvetica").fontSize(10).fillColor(PDF_THEME.ink);
      doc.text(
        `Total Cost Value: Rs. ${formatCurrency(totalCostValue)}`,
        326,
        summaryY + 34,
      );
      if (showSelling) {
        doc.text(
          `Total Selling Value: Rs. ${formatCurrency(totalSellingValue)}`,
          326,
          summaryY + 50,
        );
        doc
          .font("Helvetica-Bold")
          .fillColor(profit >= 0 ? PDF_THEME.success : PDF_THEME.danger)
          .text(
            `Estimated Profit: Rs. ${formatCurrency(profit)}`,
            326,
            summaryY + 66,
          );
      }

      doc.fillColor(PDF_THEME.ink);
      doc.end();
    } catch (err) {
      console.error("Item report PDF error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ----------------- SALES REPORT table (JSON PREVIEW) -----------------
// ==================== BLOCK 14: SALES REPORT JSON ====================
// sales_report permission ও required date range দিয়ে invoice-level sales rows আনে; optional pagination large history সীমিত করে।
// Totals/payment fields report table ও analytics-এর input দেয়; short cache repeated filters-এর query cost কমায়।
router.get(
  "/sales/report",
  requirePermission("sales_report"),
  cacheJsonResponse({ namespace: "inventory:sales-report", ttlMs: 10 * 1000 }),
  async (req, res) => {
    try {
      const user_id = getUserId(req);
      const { from, to } = req.query;
      const pagination = parsePagination(req.query, 100, 500, {
        optional: true,
      });

      if (!from || !to) {
        return res.status(400).json({ error: "Missing date range" });
      }

      const paginationClause = pagination.enabled
        ? `LIMIT ${pagination.limit} OFFSET ${pagination.offset}`
        : "";
      const countResult = pagination.enabled
        ? await pool.query(
            `SELECT COUNT(*)::int AS total
       FROM sales s
        WHERE s.user_id = $1
          AND s.created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
          AND s.created_at < (($3::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`,
            [user_id, from, to],
          )
        : null;

      const result = await pool.query(
        `SELECT
        s.created_at,
        i.name AS item_name,
        s.quantity,
        s.selling_price,
        COALESCE(s.gst_amount, 0) AS gst_amount,
        s.total_price
       FROM sales s
       JOIN items i ON i.id = s.item_id
        WHERE s.user_id = $1
          AND s.created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
          AND s.created_at < (($3::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
      ORDER BY s.created_at ASC
      ${paginationClause}`,
        [user_id, from, to],
      );

      setPaginationHeaders(
        res,
        pagination,
        countResult?.rows[0]?.total,
        result.rows.length,
      );
      res.json(result.rows);
    } catch (err) {
      console.error("Sales report JSON error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ----------------- SALES REPORT (PDF DOWNLOAD) -----------------
// ==================== BLOCK 15: SALES PDF EXPORT ====================
// Same date-filtered sales dataset PDF table-এ invoice/customer/amount/payment statusসহ render করে। Page space helper repeated header দেয়,
// summary box aggregate totals দেখায় এবং filename/shop branding current owner settings থেকে আসে।
router.get(
  "/sales/report/pdf",
  requirePermission("sales_report"),
  async (req, res) => {
    try {
      const user_id = getUserId(req);
      const { from, to } = req.query;
      const shopName = await getShopName(user_id);

      if (!from || !to) {
        return res.status(400).json({ error: "Missing date range" });
      }

      const result = await pool.query(
        `SELECT
        s.created_at,
        i.name AS item_name,
        s.quantity,
        s.selling_price,
        COALESCE(s.gst_amount, 0) AS gst_amount,
        s.total_price
       FROM sales s
       JOIN items i ON i.id = s.item_id
        WHERE s.user_id = $1
          AND s.created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
          AND s.created_at < (($3::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
      ORDER BY s.created_at ASC`,
        [user_id, from, to],
      );

      const doc = new PDFDocument({ margin: 40, size: "A4" });
      const salesColumns = [
        { label: "Sl", x: 46, width: 24 },
        { label: "Date", x: 74, width: 62 },
        { label: "Item", x: 140, width: 160 },
        { label: "Qty", x: 304, width: 36, align: "right" },
        { label: "Rate", x: 344, width: 60, align: "right" },
        { label: "GST", x: 408, width: 60, align: "right" },
        { label: "Total", x: 472, width: 72, align: "right" },
      ];

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=sales_report_${from}_to_${to}.pdf`,
      );

      doc.pipe(res);

      drawPdfBanner(
        doc,
        "Sales Report",
        shopName,
        `Date range: ${from} to ${to}`,
        `Generated: ${formatIstDate(new Date())}`,
      );

      const startX = 40;
      drawPdfTableHeader(doc, salesColumns);

      // ---- Rows ----
      let subtotal = 0;
      let gstTotal = 0;
      let grandTotal = 0;

      result.rows.forEach((r, i) => {
        const totalPrice = Number(r.total_price) || 0;
        const gstAmount = Number(r.gst_amount) || 0;
        const finalTotal = totalPrice + gstAmount;
        // 🔒 Page overflow protection
        if (doc.y > 720) {
          doc.addPage();
          drawPdfTableHeader(doc, salesColumns);
        }

        const y = doc.y;

        // 👉 calculate dynamic height for item name
        const itemHeight = doc.heightOfString(r.item_name || "", {
          width: 160,
          align: "left",
        });

        if (i % 2 === 0) {
          doc.save();
          doc
            .rect(40, y - 2, 515, Math.max(itemHeight, 18) + 6)
            .fill(PDF_THEME.rowAlt);
          doc.restore();
        }

        const saleDate = formatIstDate(r.created_at);
        doc.fillColor(PDF_THEME.ink).font("Helvetica").fontSize(10);
        doc.text(i + 1, startX, y, { width: 24 });
        doc.text(saleDate, startX + 26, y, { width: 62 });
        doc.text(r.item_name || "", startX + 92, y, { width: 160 });
        doc.text(r.quantity, startX + 256, y, { width: 36, align: "right" });
        doc.text(formatCurrency(r.selling_price), startX + 296, y, {
          width: 60,
          align: "right",
        });
        doc.text(formatCurrency(r.gst_amount), startX + 360, y, {
          width: 60,
          align: "right",
        });
        doc.text(formatCurrency(finalTotal), startX + 424, y, {
          width: 72,
          align: "right",
        });
        doc
          .moveTo(40, y + Math.max(itemHeight, 18) + 2)
          .lineTo(555, y + Math.max(itemHeight, 18) + 2)
          .strokeColor(PDF_THEME.line)
          .stroke();

        // 👉 move y based on tallest content
        doc.y = y + Math.max(itemHeight, 18) + 6;

        subtotal += totalPrice;
        gstTotal += gstAmount;
        grandTotal += finalTotal;
      });

      const summaryHeight = 88;
      ensurePdfSpace(doc, summaryHeight + 12, () =>
        drawPdfTableHeader(doc, salesColumns),
      );

      const summaryY = doc.y + 6;
      doc.save();
      doc
        .roundedRect(320, summaryY, 235, summaryHeight, 12)
        .fillAndStroke("#f8fbff", PDF_THEME.line);
      doc.restore();

      doc.font("Helvetica-Bold").fontSize(11).fillColor(PDF_THEME.navy);
      doc.text("Sales Summary", 336, summaryY + 12, { width: 180 });
      [
        ["Total Sale", grandTotal, true],
        ["Total GST", gstTotal, false],
        ["Subtotal", subtotal, false],
      ].forEach(([label, value, highlight], index) => {
        const rowY = summaryY + 32 + index * 16;
        doc
          .font(highlight ? "Helvetica-Bold" : "Helvetica")
          .fontSize(10)
          .fillColor(highlight ? PDF_THEME.navy : PDF_THEME.ink);
        doc.text(label, 336, rowY, { width: 96 });
        doc.text(`Rs. ${formatCurrency(value)}`, 430, rowY, {
          width: 110,
          align: "right",
        });
      });

      doc.fillColor(PDF_THEME.ink);

      doc.end();
    } catch (err) {
      console.error("Sales PDF error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ----------------- SALES REPORT (EXCEL DOWNLOAD) -----------------
// ==================== BLOCK 16: SALES EXCEL EXPORT ====================
// ExcelJS workbook-এ styled title/header, sanitized cell values, invoice rows ও summary totals লিখে। Column widths/number formats spreadsheet
// review সহজ করে; formula-like user text neutralize হয় এবং XLSX buffer attachment response হিসেবে পাঠানো হয়।
router.get(
  "/sales/report/excel",
  requirePermission("sales_report"),
  async (req, res) => {
    try {
      const user_id = getUserId(req);
      const { from, to } = req.query;
      const shopName = await getShopName(user_id);

      if (!from || !to) {
        return res.status(400).json({ error: "Missing date range" });
      }

      const result = await pool.query(
        `SELECT
        s.created_at,
        i.name AS item_name,
        s.quantity,
        s.selling_price,
        COALESCE(s.gst_amount, 0) AS gst_amount,
        s.total_price
       FROM sales s
       JOIN items i ON i.id = s.item_id
        WHERE s.user_id = $1
          AND s.created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
          AND s.created_at < (($3::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
      ORDER BY s.created_at ASC`,
        [user_id, from, to],
      );

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Sales Report");
      workbook.creator = "Shop Inventory Management";
      workbook.created = new Date();
      sheet.views = [{ state: "frozen", ySplit: 4 }];
      sheet.pageSetup = {
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        margins: {
          left: 0.3,
          right: 0.3,
          top: 0.5,
          bottom: 0.5,
          header: 0.2,
          footer: 0.2,
        },
      };

      sheet.columns = [
        { header: "Sl No", key: "sl", width: 8 },
        { header: "Date", key: "date", width: 15 },
        { header: "Item Name", key: "item", width: 30 },
        { header: "Quantity", key: "qty", width: 12 },
        { header: "Rate", key: "rate", width: 12 },
        { header: "GST", key: "gst", width: 12 },
        { header: "Amount", key: "total", width: 14 },
      ];

      sheet.insertRow(1, [`Sales Report`]);
      sheet.mergeCells("A1:G1");
      sheet.getCell("A1").font = { size: 16, bold: true };
      sheet.getCell("A1").alignment = { horizontal: "center" };
      sheet.getCell("A1").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF17315D" },
      };
      sheet.getCell("A1").font = {
        size: 16,
        bold: true,
        color: { argb: "FFFFFFFF" },
      };

      sheet.insertRow(2, [sanitizeExcelCell(shopName)]);
      sheet.mergeCells("A2:G2");
      sheet.getCell("A2").alignment = { horizontal: "center" };
      sheet.getCell("A2").font = {
        size: 12,
        bold: true,
        color: { argb: "FF17315D" },
      };
      sheet.getCell("A2").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF8FBFF" },
      };

      sheet.insertRow(3, [
        `From: ${from}   To: ${to}   |   Generated: ${formatIstDate(new Date())}`,
      ]);
      sheet.mergeCells("A3:G3");
      sheet.getCell("A3").alignment = { horizontal: "center" };
      sheet.getCell("A3").font = { italic: true, color: { argb: "FF475569" } };
      sheet.autoFilter = "A4:G4";

      const headerRow = sheet.getRow(4);
      headerRow.font = { bold: true };
      headerRow.alignment = { horizontal: "center" };
      headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFEFF6FF" },
      };
      headerRow.eachCell((cell) => {
        cell.border = {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" },
        };
      });

      let subtotal = 0;
      let gstTotal = 0;
      let grandTotal = 0;

      result.rows.forEach((r, i) => {
        const totalPrice = Number(r.total_price) || 0;
        const gstAmount = Number(r.gst_amount) || 0;
        const finalTotal = totalPrice + gstAmount;
        const saleDate = formatIstDate(r.created_at);
        const row = sheet.addRow({
          sl: i + 1,
          date: saleDate,
          item: sanitizeExcelCell(r.item_name),
          qty: r.quantity,
          rate: Number(r.selling_price),
          gst: gstAmount,
          total: finalTotal,
        });

        row.eachCell((cell) => {
          cell.border = {
            top: { style: "thin" },
            bottom: { style: "thin" },
            left: { style: "thin" },
            right: { style: "thin" },
          };
        });
        row.alignment = { vertical: "middle" };
        row.getCell("A").alignment = { horizontal: "center" };
        row.getCell("B").alignment = { horizontal: "center" };
        row.getCell("C").alignment = { wrapText: true };
        row.getCell("D").alignment = { horizontal: "right" };
        row.getCell("E").alignment = { horizontal: "right" };
        row.getCell("F").alignment = { horizontal: "right" };
        row.getCell("G").alignment = { horizontal: "right" };

        if (i % 2 === 1) {
          row.eachCell((cell) => {
            cell.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FFF8FBFF" },
            };
          });
        }

        row.getCell(4).numFmt = "#,##0.00";
        row.getCell(5).numFmt = "#,##0.00";
        row.getCell(6).numFmt = "#,##0.00";
        row.getCell(7).numFmt = "#,##0.00";

        subtotal += totalPrice;
        gstTotal += gstAmount;
        grandTotal += finalTotal;
      });

      // ----------------- Summary -----------------
      sheet.addRow([]);

      [
        { label: "Total Sale (Rs.)", value: grandTotal, fill: "FFE0F2FE" },
        { label: "Total GST (Rs.)", value: gstTotal, fill: "FFF0F9FF" },
        { label: "Subtotal (Rs.)", value: subtotal, fill: "FFF8FBFF" },
      ].forEach(({ label, value, fill }) => {
        const summaryRow = sheet.addRow({
          item: label,
          total: value,
        });

        summaryRow.font = { bold: true };
        summaryRow.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: fill },
        };
        summaryRow.eachCell((cell) => {
          cell.border = {
            top: { style: "thin" },
            bottom: { style: "thin" },
          };
        });
        summaryRow.getCell("G").numFmt = "#,##0.00";
        summaryRow.getCell("C").alignment = { horizontal: "right" };
        summaryRow.getCell("G").alignment = { horizontal: "right" };
      });

      // ----------------- Response -----------------
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=sales_report_${from}_to_${to}.xlsx`,
      );

      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error("Sales Excel error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ==================== BLOCK 17: REUSABLE GST DATASET ও SUMMARY ====================
// Account/date range অনুযায়ী invoices ও line-tax values থেকে GST report rows আনে; options report/compare/export-এর প্রয়োজনমতো query shape দেয়।
// summarizeGstRows taxable/subtotal/GST/grand total এবং payment amounts reduce করে, যাতে JSON/PDF/Excel একই aggregate rules ব্যবহার করে।
async function fetchGstReportRows(userId, from, to, options = {}) {
  const limit = Number.parseInt(options.limit, 10);
  const offset = Number.parseInt(options.offset, 10);
  const paginationClause =
    Number.isInteger(limit) && limit > 0
      ? `LIMIT ${limit} OFFSET ${Number.isInteger(offset) && offset > 0 ? offset : 0}`
      : "";
  const result = await pool.query(
    `SELECT
      i.date AS created_at,
      i.invoice_no,
      COALESCE(NULLIF(TRIM(i.customer_name), ''), 'Walk-in Customer') AS customer_name,
      COALESCE(i.subtotal, 0) AS taxable_amount,
      CASE
        WHEN COALESCE(i.subtotal, 0) = 0 THEN 0
        ELSE ROUND(ABS((i.gst_amount / NULLIF(i.subtotal, 0)) * 100)::numeric, 2)
      END AS gst_rate,
      COALESCE(i.gst_amount, 0) AS gst_amount,
      COALESCE(i.total_amount, 0) AS invoice_total
     FROM invoices i
     WHERE i.user_id = $1
       AND i.date >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
       AND i.date < (($3::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')
     ORDER BY i.date ASC, i.id ASC
     ${paginationClause}`,
    [userId, from, to],
  );

  return result.rows;
}

function summarizeGstRows(rows) {
  return rows.reduce(
    (summary, row) => {
      summary.invoiceCount += 1;
      summary.taxableTotal += Number(row.taxable_amount) || 0;
      summary.gstTotal += Number(row.gst_amount) || 0;
      summary.grandTotal += Number(row.invoice_total) || 0;
      return summary;
    },
    {
      invoiceCount: 0,
      taxableTotal: 0,
      gstTotal: 0,
      grandTotal: 0,
    },
  );
}

// ----------------- GST REPORT table (JSON PREVIEW) -----------------
// ==================== BLOCK 18: GST REPORT JSON ====================
// gst_report permission এবং required from/to range validate করে shared fetch/summarize helpers চালায়। Rows ও totals cached JSON response-এ
// ফেরে, যা compliance table ও KPI cards পূরণ করে; account scope অন্য shop-এর invoices বাদ দেয়।
router.get(
  "/gst/report",
  requirePermission("gst_report"),
  cacheJsonResponse({ namespace: "inventory:gst-report", ttlMs: 10 * 1000 }),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const { from, to } = req.query;

      if (!from || !to) {
        return res.status(400).json({ error: "Missing date range" });
      }

      const rows = await fetchGstReportRows(userId, from, to);
      res.json(rows);
    } catch (err) {
      console.error("GST report JSON error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ==================== BLOCK 19: GST PERIOD / RATE COMPARISON ====================
// Selected period-এর monthly/rate-group aggregates ও overall totals হিসাব করে trend এবং tax mix comparison দেয়। Frontend monthly GST,
// slab/rate tables ও comparison KPI একই normalized numeric response থেকে render করে।
router.get(
  "/gst/compare",
  requirePermission("gst_report"),
  cacheJsonResponse({ namespace: "inventory:gst-compare", ttlMs: 10 * 1000 }),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const { from, to } = req.query;

      if (!from || !to) {
        return res.status(400).json({ error: "Missing date range" });
      }

      const result = await pool.query(
        `
      WITH params AS (
        SELECT
          $2::date AS from_date,
          $3::date AS to_date,
          ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') AS from_ts,
          (($3::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata') AS to_ts_exclusive
      ),
      months AS (
        SELECT
          generate_series(
            DATE_TRUNC('month', params.from_date::timestamp),
            DATE_TRUNC('month', params.to_date::timestamp),
            INTERVAL '1 month'
          )::date AS month_start
        FROM params
      ),
      sales_rollup AS (
        SELECT
          DATE_TRUNC('month', s.created_at AT TIME ZONE 'Asia/Kolkata')::date AS month_start,
          COALESCE(SUM(s.cost_price * s.quantity), 0)::numeric(12,2) AS purchase_taxable_total,
          ROUND(
            COALESCE(
              SUM(
                (s.cost_price * s.quantity) *
                CASE
                  WHEN COALESCE(s.total_price, 0) = 0 THEN 0
                  ELSE ABS(s.gst_amount / NULLIF(s.total_price, 0))
                END
              ),
              0
            )::numeric,
            2
          ) AS purchase_gst_total,
          COALESCE(SUM(s.total_price), 0)::numeric(12,2) AS sales_taxable_total,
          COALESCE(SUM(s.gst_amount), 0)::numeric(12,2) AS sales_gst_total
        FROM sales s
        CROSS JOIN params p
        WHERE s.user_id = $1
          AND s.created_at >= p.from_ts
          AND s.created_at < p.to_ts_exclusive
        GROUP BY 1
      )
      SELECT
        TO_CHAR(m.month_start, 'YYYY-MM') AS month_key,
        TO_CHAR(m.month_start, 'Mon YYYY') AS month_label,
        COALESCE(sr.purchase_taxable_total, 0)::numeric(12,2) AS purchase_taxable_total,
        COALESCE(sr.purchase_gst_total, 0)::numeric(12,2) AS purchase_gst_total,
        COALESCE(sr.sales_taxable_total, 0)::numeric(12,2) AS sales_taxable_total,
        COALESCE(sr.sales_gst_total, 0)::numeric(12,2) AS sales_gst_total,
        ROUND(
          (
            COALESCE(sr.sales_gst_total, 0)
            - COALESCE(sr.purchase_gst_total, 0)
          )::numeric,
          2
        ) AS profit_gst_total,
        ROUND(
          CASE
            WHEN COALESCE(sr.purchase_taxable_total, 0) = 0 THEN 0
            ELSE (
              COALESCE(sr.purchase_gst_total, 0)
              / NULLIF(sr.purchase_taxable_total, 0)
            ) * 100
          END::numeric,
          2
        ) AS applied_rate
      FROM months m
      LEFT JOIN sales_rollup sr
        ON sr.month_start = m.month_start
      ORDER BY m.month_start ASC
      `,
        [userId, from, to],
      );

      const monthly = result.rows.map((row) => ({
        month_key: row.month_key,
        month_label: row.month_label,
        purchase_taxable_total: Number(row.purchase_taxable_total) || 0,
        purchase_gst_total: Number(row.purchase_gst_total) || 0,
        sales_taxable_total: Number(row.sales_taxable_total) || 0,
        sales_gst_total: Number(row.sales_gst_total) || 0,
        profit_gst_total: Number(row.profit_gst_total) || 0,
        applied_rate: Number(row.applied_rate) || 0,
      }));

      const summary = monthly.reduce(
        (totals, row) => {
          totals.purchase_taxable_total += row.purchase_taxable_total;
          totals.purchase_gst_total += row.purchase_gst_total;
          totals.sales_taxable_total += row.sales_taxable_total;
          totals.sales_gst_total += row.sales_gst_total;
          totals.profit_gst_total += row.profit_gst_total;
          return totals;
        },
        {
          purchase_taxable_total: 0,
          purchase_gst_total: 0,
          sales_taxable_total: 0,
          sales_gst_total: 0,
          profit_gst_total: 0,
        },
      );

      const appliedRate =
        summary.purchase_taxable_total > 0
          ? (summary.purchase_gst_total / summary.purchase_taxable_total) * 100
          : 0;

      res.json({
        success: true,
        range: { from, to },
        compare: {
          applied_rate: Number(appliedRate.toFixed(2)),
          summary: {
            purchase_taxable_total: Number(
              summary.purchase_taxable_total.toFixed(2),
            ),
            purchase_gst_total: Number(summary.purchase_gst_total.toFixed(2)),
            sales_taxable_total: Number(summary.sales_taxable_total.toFixed(2)),
            sales_gst_total: Number(summary.sales_gst_total.toFixed(2)),
            profit_gst_total: Number(summary.profit_gst_total.toFixed(2)),
          },
          monthly,
        },
      });
    } catch (err) {
      console.error("GST compare JSON error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ----------------- GST REPORT (PDF DOWNLOAD) -----------------
// ==================== BLOCK 20: GST PDF EXPORT ====================
// Shared GST rows branded PDF-এ invoice/date/customer/taxable/GST/total columnsসহ আঁকে। Page overflow হলে headers পুনরায় আঁকে এবং শেষে
// period summary box দেয়; safe filename ও application/pdf headers download response নিয়ন্ত্রণ করে।
router.get(
  "/gst/report/pdf",
  requirePermission("gst_report"),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const { from, to } = req.query;
      const shopName = await getShopName(userId);

      if (!from || !to) {
        return res.status(400).json({ error: "Missing date range" });
      }

      const rows = await fetchGstReportRows(userId, from, to);
      const summary = summarizeGstRows(rows);
      const doc = new PDFDocument({ margin: 40, size: "A4" });
      const gstColumns = [
        { label: "Date", x: 46, width: 64 },
        { label: "Invoice No", x: 114, width: 112 },
        { label: "Customer", x: 230, width: 120 },
        { label: "Taxable", x: 354, width: 64, align: "right" },
        { label: "GST", x: 422, width: 58, align: "right" },
        { label: "Total", x: 484, width: 58, align: "right" },
      ];

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=gst_report_${from}_to_${to}.pdf`,
      );

      doc.pipe(res);

      drawPdfBanner(
        doc,
        "GST Report",
        shopName,
        `Invoice-wise GST from ${from} to ${to}`,
        `Generated: ${formatIstDate(new Date())}`,
      );

      drawPdfTableHeader(doc, gstColumns);

      rows.forEach((row, index) => {
        if (doc.y > 720) {
          doc.addPage();
          drawPdfTableHeader(doc, gstColumns);
        }

        const y = doc.y;
        const invoiceHeight = doc.heightOfString(row.invoice_no || "", {
          width: 112,
        });
        const customerHeight = doc.heightOfString(row.customer_name || "", {
          width: 120,
        });
        const rowHeight = Math.max(invoiceHeight, customerHeight, 18);

        if (index % 2 === 0) {
          doc.save();
          doc.rect(40, y - 2, 515, rowHeight + 6).fill(PDF_THEME.rowAlt);
          doc.restore();
        }

        doc.fillColor(PDF_THEME.ink).font("Helvetica").fontSize(10);
        doc.text(formatIstDate(row.created_at), 46, y, { width: 64 });
        doc.text(row.invoice_no || "-", 114, y, { width: 112 });
        doc.text(row.customer_name || "-", 230, y, { width: 120 });
        doc.text(formatCurrency(row.taxable_amount), 354, y, {
          width: 64,
          align: "right",
        });
        doc.text(formatCurrency(row.gst_amount), 422, y, {
          width: 58,
          align: "right",
        });
        doc.text(formatCurrency(row.invoice_total), 484, y, {
          width: 58,
          align: "right",
        });

        doc
          .moveTo(40, y + rowHeight + 2)
          .lineTo(555, y + rowHeight + 2)
          .strokeColor(PDF_THEME.line)
          .stroke();

        doc.y = y + rowHeight + 6;
      });

      const summaryHeight = 64;
      ensurePdfSpace(doc, summaryHeight + 12, () =>
        drawPdfTableHeader(doc, gstColumns),
      );

      const summaryY = doc.y + 6;
      doc.save();
      doc
        .roundedRect(304, summaryY, 251, summaryHeight, 14)
        .fillAndStroke("#f8fbff", PDF_THEME.line);
      doc.restore();

      doc.font("Helvetica-Bold").fontSize(11).fillColor(PDF_THEME.navy);
      doc.text(`Invoices: ${summary.invoiceCount}`, 320, summaryY + 12, {
        width: 100,
      });
      doc.text(
        `GST: Rs. ${formatCurrency(summary.gstTotal)}`,
        430,
        summaryY + 12,
        {
          width: 108,
          align: "right",
        },
      );
      doc.text(
        `Taxable: Rs. ${formatCurrency(summary.taxableTotal)}`,
        320,
        summaryY + 34,
        {
          width: 120,
        },
      );
      doc.text(
        `Total: Rs. ${formatCurrency(summary.grandTotal)}`,
        430,
        summaryY + 34,
        {
          width: 108,
          align: "right",
        },
      );

      doc.fillColor(PDF_THEME.ink);
      doc.end();
    } catch (err) {
      console.error("GST PDF error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ----------------- GST REPORT (EXCEL DOWNLOAD) -----------------
// ==================== BLOCK 21: GST EXCEL EXPORT ====================
// Shared GST dataset XLSX workbook-এ styled heading, sanitized text, currency formats ও total rowসহ লেখে। Formula injection guard user data
// neutralize করে; generated workbook buffer correct spreadsheet content type/attachment filenameসহ পাঠানো হয়।
router.get(
  "/gst/report/excel",
  requirePermission("gst_report"),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const { from, to } = req.query;
      const shopName = await getShopName(userId);

      if (!from || !to) {
        return res.status(400).json({ error: "Missing date range" });
      }

      const rows = await fetchGstReportRows(userId, from, to);
      const summary = summarizeGstRows(rows);
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("GST Report");
      workbook.creator = "Shop Inventory Management";
      workbook.created = new Date();
      sheet.views = [{ state: "frozen", ySplit: 4 }];
      sheet.pageSetup = {
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        margins: {
          left: 0.3,
          right: 0.3,
          top: 0.5,
          bottom: 0.5,
          header: 0.2,
          footer: 0.2,
        },
      };

      sheet.columns = [
        { header: "Date", key: "date", width: 15 },
        { header: "Invoice No", key: "invoice", width: 24 },
        { header: "Customer", key: "customer", width: 24 },
        { header: "Taxable Amount", key: "taxable", width: 16 },
        { header: "GST Amount", key: "gst", width: 14 },
        { header: "Invoice Total", key: "total", width: 16 },
      ];

      sheet.insertRow(1, ["GST Report"]);
      sheet.mergeCells("A1:F1");
      sheet.getCell("A1").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF17315D" },
      };
      sheet.getCell("A1").font = {
        size: 16,
        bold: true,
        color: { argb: "FFFFFFFF" },
      };
      sheet.getCell("A1").alignment = { horizontal: "center" };

      sheet.insertRow(2, [sanitizeExcelCell(shopName)]);
      sheet.mergeCells("A2:F2");
      sheet.getCell("A2").alignment = { horizontal: "center" };
      sheet.getCell("A2").font = {
        size: 12,
        bold: true,
        color: { argb: "FF17315D" },
      };
      sheet.getCell("A2").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF8FBFF" },
      };

      sheet.insertRow(3, [
        `Invoice-wise GST from ${from} to ${to}   |   Generated: ${formatIstDate(new Date())}`,
      ]);
      sheet.mergeCells("A3:F3");
      sheet.getCell("A3").alignment = { horizontal: "center" };
      sheet.getCell("A3").font = { italic: true, color: { argb: "FF475569" } };
      sheet.autoFilter = "A4:F4";

      const headerRow = sheet.getRow(4);
      headerRow.font = { bold: true };
      headerRow.alignment = { horizontal: "center" };
      headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFEFF6FF" },
      };
      headerRow.eachCell((cell) => {
        cell.border = {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" },
        };
      });

      rows.forEach((row, index) => {
        const excelRow = sheet.addRow({
          date: formatIstDate(row.created_at),
          invoice: sanitizeExcelCell(row.invoice_no),
          customer: sanitizeExcelCell(row.customer_name),
          taxable: Number(row.taxable_amount) || 0,
          gst: Number(row.gst_amount) || 0,
          total: Number(row.invoice_total) || 0,
        });

        excelRow.eachCell((cell) => {
          cell.border = {
            top: { style: "thin" },
            bottom: { style: "thin" },
            left: { style: "thin" },
            right: { style: "thin" },
          };
        });

        excelRow.alignment = { vertical: "middle" };
        excelRow.getCell("A").alignment = { horizontal: "center" };
        excelRow.getCell("B").alignment = { wrapText: true };
        excelRow.getCell("C").alignment = { wrapText: true };
        excelRow.getCell("D").alignment = { horizontal: "right" };
        excelRow.getCell("E").alignment = { horizontal: "right" };
        excelRow.getCell("F").alignment = { horizontal: "right" };

        if (index % 2 === 1) {
          excelRow.eachCell((cell) => {
            cell.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FFF8FBFF" },
            };
          });
        }

        excelRow.getCell(4).numFmt = "#,##0.00";
        excelRow.getCell(5).numFmt = "#,##0.00";
        excelRow.getCell(6).numFmt = "#,##0.00";
      });

      sheet.addRow([]);

      const totalRow = sheet.addRow({
        customer: `Invoices: ${summary.invoiceCount}`,
        taxable: summary.taxableTotal,
        gst: summary.gstTotal,
        total: summary.grandTotal,
      });
      totalRow.font = { bold: true };
      totalRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFE0F2FE" },
      };
      totalRow.eachCell((cell) => {
        cell.border = {
          top: { style: "thin" },
          bottom: { style: "thin" },
        };
      });
      totalRow.getCell("D").numFmt = "#,##0.00";
      totalRow.getCell("E").numFmt = "#,##0.00";
      totalRow.getCell("F").numFmt = "#,##0.00";
      totalRow.getCell("D").alignment = { horizontal: "right" };
      totalRow.getCell("E").alignment = { horizontal: "right" };
      totalRow.getCell("F").alignment = { horizontal: "right" };

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=gst_report_${from}_to_${to}.xlsx`,
      );

      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error("GST Excel error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ------------------- CUSTOMER DEBTS -------------------

// ==================== BLOCK 22: CREATE CUSTOMER DUE / COLLECTION TRANSACTION ====================
// customer_due permission-এর payload name, 10-digit number, address, debit(total), credit, date, mode ও remark validate/normalize করে।
// Customer identity account-scoped lock নেয়। invoice_id থাকলে target invoice FOR UPDATE করে credit outstanding-এর মধ্যে সীমিত রাখে এবং
// linked debt entry insert/update path চালায়; generic entry হলে ledger row যোগ হয়। Commit-এর আগে affected invoice balances ledger থেকে sync হয়,
// তারপর cache invalidation; error হলে rollback ও client release নিশ্চিত হয়।
router.post("/debts", requirePermission("customer_due"), async (req, res) => {
  const client = await pool.connect();
  try {
    const user_id = getUserId(req);
    const {
      customer_name,
      customer_number,
      customer_address,
      total = 0,
      credit = 0,
      remark,
    } = req.body;
    const normalizedCustomerName = normalizeDisplayText(customer_name);
    const customerNumber = String(customer_number || "").trim();
    const normalizedCustomerAddress =
      String(customer_address || "").trim() || null;
    const totalAmount = parseNonNegativeNumber(total);
    const creditAmount = parseNonNegativeNumber(credit);
    const normalizedRemark = String(remark || "").trim();

    if (!normalizedCustomerName || !/^\d{10}$/.test(customerNumber))
      return res
        .status(400)
        .json({ error: "Valid name and 10-digit number required" });

    if (totalAmount === null || creditAmount === null) {
      return res
        .status(400)
        .json({ error: "Total and credit must be valid non-negative numbers" });
    }

    if (totalAmount === 0 && creditAmount === 0) {
      return res
        .status(400)
        .json({ error: "Enter an amount or a credit value before saving" });
    }

    if (totalAmount > 0 && creditAmount > totalAmount) {
      return res
        .status(400)
        .json({ error: "Credit cannot be greater than total amount" });
    }

    // DEBT TRANSACTION PHASE A — customer ledger ও linked invoice changes একটি atomic transaction-এ শুরু হয়।
    // Customer number-scoped lock একই customer-এর concurrent due/collection writes serialize করে।
    await client.query("BEGIN");
    await lockScopedResource(client, user_id, "customer-debt", customerNumber);

    // DEBT TRANSACTION PHASE B — একই mobile-এর latest saved name/address নিয়ে canonical customer identity স্থির করা হয়।
    const existingNameResult = await client.query(
      `SELECT customer_name, customer_address
       FROM debts
       WHERE user_id = $1 AND customer_number = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [user_id, customerNumber],
    );

    const canonicalCustomerName =
      normalizeDisplayText(existingNameResult.rows[0]?.customer_name) ||
      normalizedCustomerName;
    const canonicalCustomerAddress =
      normalizedCustomerAddress ||
      String(existingNameResult.rows[0]?.customer_address || "").trim() ||
      null;

    let createdRows = [];
    let settledInvoiceCount = 0;
    let remainingCredit = Number((creditAmount || 0).toFixed(2));

    if (totalAmount === 0 && remainingCredit > 0) {
      // DEBT TRANSACTION PHASE C — collection credit থাকলে customer-এর oldest outstanding invoices lock করে ক্রমানুসারে settle করা হয়।
      const invoiceResult = await client.query(
        `SELECT id, invoice_no, customer_name, address, amount_paid, amount_due
         FROM invoices
         WHERE user_id = $1
           AND contact = $2
           AND amount_due > 0
         ORDER BY date ASC, id ASC
         FOR UPDATE`,
        [user_id, customerNumber],
      );

      for (const invoice of invoiceResult.rows) {
        if (remainingCredit <= 0.009) {
          break;
        }

        const invoiceDue = Number(invoice.amount_due || 0);
        if (invoiceDue <= 0) {
          continue;
        }

        const appliedCredit = Number(
          Math.min(remainingCredit, invoiceDue).toFixed(2),
        );
        const nextAmountPaid = Number(
          (Number(invoice.amount_paid || 0) + appliedCredit).toFixed(2),
        );
        const nextAmountDue = Number((invoiceDue - appliedCredit).toFixed(2));
        const nextPaymentStatus = nextAmountDue > 0 ? "partial" : "paid";

        await client.query(
          `UPDATE invoices
           SET amount_paid = $1,
               amount_due = $2,
               payment_status = $3,
               updated_at = NOW()
           WHERE id = $4`,
          [nextAmountPaid, nextAmountDue, nextPaymentStatus, invoice.id],
        );

        // Applied credit invoice_id-সহ ledger row-এ লেখা হয়, যাতে invoice balance পরে ledger থেকে পুনর্গঠন করা যায়।
        const linkedDebtResult = await client.query(
          `INSERT INTO debts (
             user_id,
             invoice_id,
             customer_name,
             customer_number,
             customer_address,
             total,
             credit,
             remark
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            RETURNING *`,
          [
            user_id,
            invoice.id,
            canonicalCustomerName,
            customerNumber,
            canonicalCustomerAddress ||
              String(invoice.address || "").trim() ||
              null,
            0,
            appliedCredit,
            normalizedRemark
              ? `Customer due credit applied to ${invoice.invoice_no} | ${normalizedRemark}`
              : `Customer due credit applied to ${invoice.invoice_no}`,
          ],
        );

        createdRows.push(linkedDebtResult.rows[0]);
        settledInvoiceCount += 1;
        remainingCredit = Number((remainingCredit - appliedCredit).toFixed(2));
      }
    }

    if (totalAmount > 0 || remainingCredit > 0) {
      // DEBT TRANSACTION PHASE D — নতুন due অথবা invoice settlement-এর পর অবশিষ্ট credit generic ledger entry হিসেবে রাখা হয়।
      const genericResult = await client.query(
        `INSERT INTO debts (
           user_id,
           customer_name,
           customer_number,
           customer_address,
           total,
           credit,
           remark
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          RETURNING *`,
        [
          user_id,
          canonicalCustomerName,
          customerNumber,
          canonicalCustomerAddress,
          totalAmount,
          remainingCredit,
          normalizedRemark || null,
        ],
      );

      createdRows.push(genericResult.rows[0]);
    }

    // DEBT TRANSACTION PHASE E — সব ledger/invoice writes সফল হলে commit এবং related cached summaries invalidate করা হয়।
    await client.query("COMMIT");
    invalidateUserCache(user_id);

    res.json({
      message:
        creditAmount > 0 && totalAmount === 0 && settledInvoiceCount > 0
          ? `Credit saved and applied to ${settledInvoiceCount} invoice${settledInvoiceCount === 1 ? "" : "s"}.`
          : "Debt entry added successfully",
      debt: createdRows[createdRows.length - 1] || null,
      settled_invoice_count: settledInvoiceCount,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      if (process.env.NODE_ENV !== "production") {
        console.error("Error rolling back POST /debts:", rollbackError);
      }
    }
    if (process.env.NODE_ENV !== "production")
      console.error("Error in POST /debts:", err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ==================== BLOCK 23: DELETE COMPLETE CUSTOMER LEDGER ====================
// Owner-only transaction 10-digit customer number-এর সব debt rows delete করে এবং RETURNING invoice ids সংগ্রহ করে। Linked invoices ledger
// credits থেকে পুনরায় balance/status sync হয়; no rows হলে 404 rollback, success হলে commit/cache invalidation ledger ও invoices atomic রাখে।
router.delete("/debts/customers/:number", requireOwner, async (req, res) => {
  const client = await pool.connect();
  try {
    const user_id = getUserId(req);
    const customerNumber = String(req.params.number || "").trim();

    if (!/^\d{10}$/.test(customerNumber)) {
      return res
        .status(400)
        .json({ error: "Customer number must be 10 digits" });
    }

    await client.query("BEGIN");
    await lockScopedResource(client, user_id, "customer-debt", customerNumber);

    const deleteResult = await client.query(
      `DELETE FROM debts
         WHERE user_id = $1 AND customer_number = $2
         RETURNING id, invoice_id`,
      [user_id, customerNumber],
    );

    if (!deleteResult.rowCount) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ error: "No ledger rows found for this customer" });
    }

    await syncInvoiceBalancesFromDebtLedger(
      client,
      user_id,
      deleteResult.rows.map((row) => row.invoice_id),
    );

    await client.query("COMMIT");
    invalidateUserCache(user_id);

    res.json({
      message: "Customer ledger deleted successfully",
      deleted_count: deleteResult.rowCount,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      if (process.env.NODE_ENV !== "production") {
        console.error(
          "Error rolling back DELETE /debts/customers:",
          rollbackError,
        );
      }
    }

    if (process.env.NODE_ENV !== "production") {
      console.error("Error in DELETE /debts/customers/:number:", err);
    }
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ==================== BLOCK 24: DELETE SINGLE DEBT ENTRY ====================
// Owner-only transaction positive debt id account scope-এ delete করে এবং linked invoice id সংগ্রহ করে। Affected invoice balance পুনরায় sync হয়;
// missing entry 404 rollback দেয়, success commit/cache refresh করে এবং transaction client finally release হয়।
router.delete("/debts/entries/:id", requireOwner, async (req, res) => {
  const client = await pool.connect();
  try {
    const user_id = getUserId(req);
    const debtId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(debtId) || debtId <= 0) {
      return res.status(400).json({ error: "Valid ledger entry id required" });
    }

    await client.query("BEGIN");

    const debtResult = await client.query(
      `SELECT customer_number
         FROM debts
         WHERE user_id = $1 AND id = $2`,
      [user_id, debtId],
    );

    const customerNumber = debtResult.rows[0]?.customer_number;
    if (!customerNumber) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Ledger entry not found" });
    }

    await lockScopedResource(client, user_id, "customer-debt", customerNumber);

    const deleteResult = await client.query(
      `DELETE FROM debts
         WHERE user_id = $1 AND id = $2
         RETURNING id, customer_number, invoice_id`,
      [user_id, debtId],
    );

    if (!deleteResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Ledger entry not found" });
    }

    await syncInvoiceBalancesFromDebtLedger(
      client,
      user_id,
      deleteResult.rows.map((row) => row.invoice_id),
    );

    await client.query("COMMIT");
    invalidateUserCache(user_id);

    res.json({
      message: "Ledger transaction deleted successfully",
      deleted_count: deleteResult.rowCount,
      customer_number: deleteResult.rows[0].customer_number,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      if (process.env.NODE_ENV !== "production") {
        console.error(
          "Error rolling back DELETE /debts/entries:",
          rollbackError,
        );
      }
    }

    if (process.env.NODE_ENV !== "production") {
      console.error("Error in DELETE /debts/entries/:id:", err);
    }
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ----------------- CUSTOMER AUTOSUGGEST -----------------
// ==================== BLOCK 25: CUSTOMER AUTOCOMPLETE DIRECTORY ====================
// customer_due permission-এর user name/number/address query দিয়ে distinct latest customer identities খোঁজে। 15-second cached compact result
// due-entry form autocomplete চালায়; user_id filter অন্য shop-এর customer data বাদ দেয়।
router.get(
  "/debts/customers",
  requirePermission("customer_due"),
  cacheJsonResponse({
    namespace: "inventory:debt-customers",
    ttlMs: 15 * 1000,
  }),
  async (req, res) => {
    try {
      const user_id = getUserId(req);
      const { q } = req.query;

      let query = `
        SELECT customer_name, customer_number, customer_address
        FROM (
          SELECT DISTINCT ON (customer_number)
            customer_name,
            customer_number,
            COALESCE(customer_address, '') AS customer_address,
            created_at,
            id
          FROM debts
          WHERE user_id = $1
      `;
      let params = [user_id];

      if (q && q.trim()) {
        query += `
            AND (
              customer_name ILIKE $2
              OR customer_number ILIKE $2
              OR COALESCE(customer_address, '') ILIKE $2
            )
        `;
        params.push(`%${q.trim()}%`);
      }

      query += `
          ORDER BY customer_number, created_at DESC, id DESC
        ) latest_customers
        ORDER BY LOWER(TRIM(customer_name)) ASC, customer_number ASC
        LIMIT 20
      `;

      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      console.error("Customer dropdown error:", err);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// Full ledger
// ==================== BLOCK 26: CUSTOMER LEDGER PDF EXPORT ====================
// Customer number validate করে profile/address ও ordered ledger entries আনে। Debit-credit effect, running balance এবং totals PDFKit দিয়ে
// multi-page statement-এ render হয়; shop/customer context ও safe filenameসহ downloadable PDF পাঠানো হয়।
router.get(
  "/debts/:number/pdf",
  requirePermission("customer_due"),
  async (req, res) => {
    try {
      const user_id = getUserId(req);
      const number = String(req.params.number || "").trim();

      if (!/^\d{10}$/.test(number)) {
        return res
          .status(400)
          .json({ error: "Customer number must be 10 digits" });
      }

      const [shopName, result] = await Promise.all([
        getShopName(user_id),
        pool.query(
          `SELECT id, customer_name, customer_number, customer_address, total, credit, remark, created_at
           FROM debts
           WHERE user_id = $1 AND customer_number = $2
           ORDER BY created_at ASC, id ASC`,
          [user_id, number],
        ),
      ]);

      if (!result.rows.length) {
        return res
          .status(404)
          .json({ error: "No ledger rows found for this customer" });
      }

      const customerName =
        normalizeDisplayText(result.rows[0]?.customer_name) || "Customer";
      const customerAddress =
        result.rows
          .slice()
          .reverse()
          .map((row) => normalizeDisplayText(row.customer_address))
          .find(Boolean) || "-";
      const filename = `customer_ledger_${safeFilePart(customerName)}_${number}.pdf`;
      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const ledgerNarrative =
        "Invoice-linked collections and manual due entries are shown in one running timeline.";
      const ledgerColumns = [
        { label: "Date", x: 46, width: 88 },
        { label: "Debit/purchase Amnt", x: 138, width: 70, align: "right" },
        { label: "Credit", x: 212, width: 70, align: "right" },
        { label: "Balance", x: 286, width: 78, align: "right" },
        { label: "Remarks", x: 378, width: 168 },
      ];

      let runningBalance = 0;
      let totalRaised = 0;
      let totalCollected = 0;
      const ledgerRows = result.rows.map((row) => {
        const totalValue = Number(row.total) || 0;
        const creditValue = Number(row.credit) || 0;

        totalRaised += totalValue;
        totalCollected += creditValue;
        runningBalance = Number(
          (runningBalance + totalValue - creditValue).toFixed(2),
        );

        return {
          ...row,
          totalValue,
          creditValue,
          runningBalance,
        };
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

      doc.pipe(res);

      drawPdfBanner(
        doc,
        "Customer Ledger",
        shopName,
        `${customerName} | ${number}`,
        `Generated: ${formatIstDate(new Date())}`,
      );

      const summaryTop = doc.y + 2;
      const detailValueX = 142;
      const detailValueWidth = 168;
      const addressTop = summaryTop + 74;
      const addressHeight = doc.heightOfString(customerAddress, {
        width: detailValueWidth,
        lineGap: 0.7,
      });
      const narrativeTop = addressTop + Math.max(addressHeight, 12) + 10;
      const narrativeHeight = doc.heightOfString(ledgerNarrative, {
        width: 248,
        lineGap: 0.8,
      });
      const infoHeight = Math.max(
        124,
        Math.ceil(narrativeTop - summaryTop + narrativeHeight + 14),
      );

      doc.save();
      doc
        .roundedRect(40, summaryTop, 288, infoHeight, 12)
        .fillAndStroke("#f8fbff", PDF_THEME.line);
      doc
        .roundedRect(340, summaryTop, 215, infoHeight, 12)
        .fillAndStroke("#f8fbff", PDF_THEME.line);
      doc.restore();

      doc.font("Helvetica-Bold").fontSize(11).fillColor(PDF_THEME.navy);
      doc.text("Customer Details", 56, summaryTop + 12, { width: 180 });
      doc.text("Ledger Summary", 356, summaryTop + 12, { width: 140 });

      doc.font("Helvetica").fontSize(10).fillColor(PDF_THEME.muted);
      doc.text("Customer", 56, summaryTop + 34, { width: 70 });
      doc.text("Mobile Number", 56, summaryTop + 54, { width: 82 });
      doc.text("Address", 56, addressTop, { width: 70 });
      doc.text("Entries", 356, summaryTop + 34, { width: 70 });
      doc.text("Outstanding", 356, summaryTop + 54, { width: 80 });
      doc.text("Collected", 356, summaryTop + 74, { width: 70 });

      doc.font("Helvetica-Bold").fontSize(10).fillColor(PDF_THEME.ink);
      doc.text(customerName, detailValueX, summaryTop + 34, {
        width: detailValueWidth,
      });
      doc.text(number, detailValueX, summaryTop + 54, {
        width: detailValueWidth,
      });
      doc.text(customerAddress, detailValueX, addressTop, {
        width: detailValueWidth,
        lineGap: 0.7,
      });
      doc.text(String(ledgerRows.length), 436, summaryTop + 34, {
        width: 100,
        align: "right",
      });
      doc
        .fillColor(
          runningBalance > 0.009 ? PDF_THEME.danger : PDF_THEME.success,
        )
        .text(
          `Rs. ${formatCurrency(Math.abs(runningBalance))}`,
          436,
          summaryTop + 54,
          {
            width: 100,
            align: "right",
          },
        );
      doc
        .fillColor(PDF_THEME.ink)
        .text(`Rs. ${formatCurrency(totalCollected)}`, 436, summaryTop + 74, {
          width: 100,
          align: "right",
        });

      doc.font("Helvetica").fontSize(9).fillColor(PDF_THEME.muted);
      doc.text(ledgerNarrative, 56, narrativeTop, {
        width: 248,
        lineGap: 0.8,
      });

      doc.y = summaryTop + infoHeight + 18;
      drawPdfTableHeader(doc, ledgerColumns);

      ledgerRows
        .slice()
        .reverse()
        .forEach((row, index) => {
          const dateText = formatIstDate(row.created_at);
          const totalText = formatCurrency(row.totalValue);
          const creditText = formatCurrency(row.creditValue);
          const balanceText = formatCurrency(Math.abs(row.runningBalance));
          const remarkText = String(row.remark || "-").trim() || "-";
          const rowHeight = Math.max(
            doc.heightOfString(dateText, { width: 88 }),
            doc.heightOfString(totalText, { width: 70, align: "right" }),
            doc.heightOfString(creditText, { width: 70, align: "right" }),
            doc.heightOfString(balanceText, { width: 78, align: "right" }),
            doc.heightOfString(remarkText, { width: 168 }),
            18,
          );

          ensurePdfSpace(doc, rowHeight + 12, () => {
            drawPdfTableHeader(doc, ledgerColumns);
          });

          const rowY = doc.y;

          if (index % 2 === 0) {
            doc.save();
            doc.rect(40, rowY - 2, 515, rowHeight + 6).fill(PDF_THEME.rowAlt);
            doc.restore();
          }

          doc.fillColor(PDF_THEME.ink).font("Helvetica").fontSize(10);
          doc.text(dateText, 46, rowY, { width: 88 });
          doc.text(totalText, 138, rowY, { width: 70, align: "right" });
          doc.text(creditText, 212, rowY, { width: 70, align: "right" });
          doc
            .fillColor(
              row.runningBalance > 0.009 ? PDF_THEME.danger : PDF_THEME.success,
            )
            .text(balanceText, 286, rowY, { width: 78, align: "right" });
          doc.fillColor(PDF_THEME.ink).text(remarkText, 378, rowY, {
            width: 168,
          });
          doc
            .moveTo(40, rowY + rowHeight + 2)
            .lineTo(555, rowY + rowHeight + 2)
            .strokeColor(PDF_THEME.line)
            .stroke();
          doc.y = rowY + rowHeight + 6;
        });

      const totalsBoxHeight = 86;
      ensurePdfSpace(doc, totalsBoxHeight + 16, () => {
        drawPdfBanner(
          doc,
          "Customer Ledger",
          shopName,
          `${customerName} | ${number}`,
          `Generated: ${formatIstDate(new Date())}`,
        );
      });

      const totalsY = doc.y + 8;
      doc.save();
      doc
        .roundedRect(310, totalsY, 245, totalsBoxHeight, 12)
        .fillAndStroke("#f8fbff", PDF_THEME.line);
      doc.restore();

      doc.font("Helvetica-Bold").fontSize(11).fillColor(PDF_THEME.navy);
      doc.text("Ledger Totals", 326, totalsY + 12, { width: 190 });
      doc.font("Helvetica").fontSize(10).fillColor(PDF_THEME.ink);
      doc.text(
        `Raised Due: Rs. ${formatCurrency(totalRaised)}`,
        326,
        totalsY + 34,
      );
      doc.text(
        `Collected Credit: Rs. ${formatCurrency(totalCollected)}`,
        326,
        totalsY + 50,
      );
      doc
        .font("Helvetica-Bold")
        .fillColor(
          runningBalance > 0.009 ? PDF_THEME.danger : PDF_THEME.success,
        )
        .text(
          `Current Outstanding: Rs. ${formatCurrency(Math.abs(runningBalance))}`,
          326,
          totalsY + 66,
        );

      doc.end();
    } catch (err) {
      console.error("Customer ledger PDF error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ==================== BLOCK 27: SINGLE CUSTOMER LEDGER JSON ====================
// Number ও optional pagination দিয়ে customer-specific debt/collection history আনে। Cached ordered rows detail workspace চালায় এবং pagination
// headers long histories handle করে; সব query authenticated account scope-এ থাকে।
router.get(
  "/debts/:number",
  requirePermission("customer_due"),
  cacheJsonResponse({ namespace: "inventory:debt-ledger", ttlMs: 10 * 1000 }),
  async (req, res) => {
    try {
      const user_id = getUserId(req);
      const number = req.params.number;
      const pagination = parsePagination(req.query, 100, 500, {
        optional: true,
      });

      if (!/^\d{10}$/.test(number))
        return res
          .status(400)
          .json({ error: "Customer number must be 10 digits" });

      const paginationClause = pagination.enabled
        ? `LIMIT ${pagination.limit} OFFSET ${pagination.offset}`
        : "";
      const countResult = pagination.enabled
        ? await pool.query(
            `SELECT COUNT(*)::int AS total
       FROM debts
       WHERE user_id=$1 AND customer_number=$2`,
            [user_id, number],
          )
        : null;

      const result = await pool.query(
        `SELECT id, customer_name, customer_number, customer_address, total, credit, remark, created_at
       FROM debts
       WHERE user_id=$1 AND customer_number=$2
       ORDER BY created_at ASC, id ASC
       ${paginationClause}`,
        [user_id, number],
      );

      setPaginationHeaders(
        res,
        pagination,
        countResult?.rows[0]?.total,
        result.rows.length,
      );
      res.json(result.rows);
    } catch (err) {
      if (process.env.NODE_ENV !== "production")
        console.error("Error in GET /debts/:number:", err);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ==================== BLOCK 28: ALL CUSTOMER DEBT SUMMARY ====================
// Customer name/number group করে latest non-empty address, total debit, total credit ও outstanding balance বানায়। Optional pagination ও cache
// due-ledger summary table এবং follow-up list দ্রুত render করতে সাহায্য করে।
router.get(
  "/debts",
  requirePermission("customer_due"),
  cacheJsonResponse({ namespace: "inventory:debt-summary", ttlMs: 10 * 1000 }),
  async (req, res) => {
    try {
      const user_id = getUserId(req);
      const pagination = parsePagination(req.query, 100, 500, {
        optional: true,
      });
      const paginationClause = pagination.enabled
        ? `LIMIT ${pagination.limit} OFFSET ${pagination.offset}`
        : "";
      const countResult = pagination.enabled
        ? await pool.query(
            `SELECT COUNT(*)::int AS total
       FROM (
         SELECT 1
         FROM debts
         WHERE user_id=$1
         GROUP BY customer_name, customer_number
       ) grouped_debts`,
            [user_id],
          )
        : null;
      const result = await pool.query(
        `SELECT customer_name, customer_number,
              COALESCE(
                (ARRAY_REMOVE(ARRAY_AGG(NULLIF(BTRIM(customer_address), '') ORDER BY created_at DESC, id DESC), NULL))[1],
                ''
              ) AS customer_address,
              SUM(total) AS total,
              SUM(credit) AS credit,
              SUM(total - credit) AS balance
       FROM debts
       WHERE user_id=$1
       GROUP BY customer_name, customer_number
       ORDER BY customer_name ASC
       ${paginationClause}`,
        [user_id],
      );

      setPaginationHeaders(
        res,
        pagination,
        countResult?.rows[0]?.total,
        result.rows.length,
      );
      res.json(result.rows);
    } catch (err) {
      if (process.env.NODE_ENV !== "production")
        console.error("Error in GET /debts:", err);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// ==================== BLOCK 29: OWNER DASHBOARD OVERVIEW ====================
// Owner-only cached endpoint catalog, stock alerts, sales, purchases, customer/supplier dues, GST, profit ও expenses-এর headline aggregates
// একটি SQL snapshot-এ দেয়। Dashboard KPI cards একই response ব্যবহার করায় আলাদা request timing-এর inconsistent totals কমে।
router.get(
  "/dashboard/overview",
  requireOwner,
  cacheJsonResponse({ namespace: "inventory:dashboard", ttlMs: 10 * 1000 }),
  async (req, res) => {
    try {
      const user_id = getUserId(req);

      const overviewResult = await pool.query(
        `
        WITH sales_30 AS (
          SELECT
            item_id,
            SUM(quantity) AS sold_30_days
          FROM sales
          WHERE user_id = $1
            AND created_at >= NOW() - INTERVAL '30 days'
          GROUP BY item_id
        ),
        catalog AS (
          SELECT
            COUNT(*) AS item_count,
            COALESCE(SUM(quantity), 0) AS total_units,
            COALESCE(SUM(quantity * buying_rate), 0) AS total_cost_value,
            COALESCE(SUM(quantity * selling_rate), 0) AS total_selling_value
          FROM items
          WHERE user_id = $1
        ),
        low_stock AS (
          SELECT
            i.name AS item_name,
            ROUND(
              CASE
                WHEN COALESCE(s.sold_30_days, 0) = 0 THEN NULL
                ELSE (i.quantity / NULLIF((s.sold_30_days / 30.0), 0))
              END,
              2
            ) AS days_left
          FROM items i
          LEFT JOIN sales_30 s
            ON s.item_id = i.id
          WHERE i.user_id = $1
            AND COALESCE(s.sold_30_days, 0) > 0
            AND (
              i.quantity / NULLIF((s.sold_30_days / 30.0), 0)
            ) <= $2
        ),
        low_stock_summary AS (
          SELECT
            COUNT(*) AS low_stock_count,
            MIN(days_left) AS shortest_days_left,
            (ARRAY_AGG(item_name ORDER BY days_left ASC NULLS LAST))[1] AS most_urgent_item
          FROM low_stock
        ),
        customer_due_summary AS (
          SELECT
            COUNT(*) AS due_customer_count,
            COALESCE(SUM(balance), 0) AS due_balance
          FROM (
            SELECT
              SUM(total - credit) AS balance
            FROM debts
            WHERE user_id = $1
            GROUP BY customer_number
            HAVING SUM(total - credit) > 0
          ) AS due_summary
        ),
        supplier_due_summary AS (
          SELECT
            COUNT(*) AS due_supplier_count,
            COALESCE(SUM(amount_due), 0) AS supplier_due
          FROM (
            SELECT
              supplier_id,
              SUM(amount_due) AS amount_due
            FROM purchases
            WHERE user_id = $1
            GROUP BY supplier_id
            HAVING SUM(amount_due) > 0
          ) AS supplier_summary
        ),
        month_window AS (
          SELECT
            DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Kolkata')::date AS month_start,
            (
              DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Kolkata')
              + INTERVAL '1 month'
            )::date AS next_month_start,
            TO_CHAR(
              DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Kolkata'),
              'Mon YYYY'
            ) AS month_label
        ),
        gst_month AS (
          SELECT
            COALESCE(SUM(i.gst_amount), 0) AS current_month_gst_total,
            COUNT(i.id) AS current_month_invoice_count,
            MAX(month_window.month_label) AS current_month_label
          FROM month_window
          LEFT JOIN invoices i
            ON i.user_id = $1
           AND i.date >= (month_window.month_start::timestamp AT TIME ZONE 'Asia/Kolkata')
           AND i.date < (month_window.next_month_start::timestamp AT TIME ZONE 'Asia/Kolkata')
        ),
        gross_profit AS (
          SELECT
            COALESCE(SUM((selling_price - cost_price) * quantity), 0) AS gross_profit
          FROM sales
          WHERE user_id = $1
        ),
        total_expense AS (
          SELECT
            COALESCE(SUM(amount), 0) AS total_expense
          FROM expenses
          WHERE user_id = $1
        )
        SELECT
          catalog.item_count,
          catalog.total_units,
          catalog.total_cost_value,
          catalog.total_selling_value,
          low_stock_summary.low_stock_count,
          low_stock_summary.shortest_days_left,
          low_stock_summary.most_urgent_item,
          customer_due_summary.due_customer_count,
          customer_due_summary.due_balance,
          supplier_due_summary.due_supplier_count,
          supplier_due_summary.supplier_due,
          gst_month.current_month_gst_total,
          gst_month.current_month_invoice_count,
          gst_month.current_month_label,
          gross_profit.gross_profit,
          total_expense.total_expense,
          (gross_profit.gross_profit - total_expense.total_expense) AS net_profit
        FROM catalog
        CROSS JOIN low_stock_summary
        CROSS JOIN customer_due_summary
        CROSS JOIN supplier_due_summary
        CROSS JOIN gst_month
        CROSS JOIN gross_profit
        CROSS JOIN total_expense
        `,
        [user_id, STOCK_CONFIG.WARNING_DAYS],
      );

      const overview = overviewResult.rows[0] || {};

      res.json({
        catalog: {
          item_count: overview.item_count,
          total_units: overview.total_units,
          total_cost_value: overview.total_cost_value,
          total_selling_value: overview.total_selling_value,
        },
        alerts: {
          low_stock_count: overview.low_stock_count,
          shortest_days_left: overview.shortest_days_left,
          most_urgent_item: overview.most_urgent_item,
        },
        dues: {
          due_customer_count: overview.due_customer_count,
          due_balance: overview.due_balance,
        },
        purchases: {
          due_supplier_count: overview.due_supplier_count,
          supplier_due: overview.supplier_due,
        },
        gst: {
          current_month_gst_total: overview.current_month_gst_total,
          current_month_invoice_count: overview.current_month_invoice_count,
          current_month_label: overview.current_month_label,
        },
        finance: {
          gross_profit: overview.gross_profit,
          total_expense: overview.total_expense,
          net_profit: overview.net_profit,
        },
      });
    } catch (err) {
      console.error("Dashboard overview error:", err);
      res.status(500).json({ error: "Server error" });
    }
  },
);

// Global error handler
// ==================== BLOCK 30: ROUTER ERROR NORMALIZATION ====================
// Route chain থেকে unhandled error এলে server log করে এবং consistent generic 500 JSON পাঠায়, যাতে internal error detail client-এ expose না হয়।
router.use((err, req, res, next) => {
  console.error("Unhandled route error:", err.message);
  res.status(500).json({ error: "Unexpected server error" });
});

// ----------------- MONTHLY SALES + PROFIT TREND -----------------
// ==================== BLOCK 31: SALES MONTHLY TREND ====================
// sales_report permission-এর optional year/all filter দিয়ে zero-filled month series, sales ও profit totals আনে। Response available years এবং
// timeline দেয়, যা year selector, trend chart ও growth summary cards চালায়।
router.get(
  "/sales/monthly-trend",
  requirePermission("sales_report"),
  async (req, res) => {
    try {
      const user_id = getUserId(req);
      const rawYear = String(req.query.year || "all")
        .trim()
        .toLowerCase();
      let selectedYear = null;

      if (rawYear && rawYear !== "all") {
        const parsedYear = Number.parseInt(rawYear, 10);
        const currentYear = getCurrentIstYear();

        if (
          !Number.isInteger(parsedYear) ||
          parsedYear < 2000 ||
          parsedYear > currentYear
        ) {
          return res.status(400).json({ error: "Invalid year filter" });
        }

        selectedYear = parsedYear;
      }

      const result = await pool.query(
        `
      WITH catalog_bounds AS (
        SELECT
          COALESCE(
            MIN(DATE_TRUNC('month', s.created_at AT TIME ZONE 'Asia/Kolkata')),
            DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
          ) AS first_month,
          DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') AS current_month
        FROM sales s
        WHERE s.user_id = $1
      ),
      display_bounds AS (
        SELECT
          CASE
            WHEN $2::int IS NULL THEN cb.first_month
            ELSE make_date($2::int, 1, 1)::timestamp
          END AS start_month,
          CASE
            WHEN $2::int IS NULL THEN cb.current_month
            ELSE make_date($2::int, 12, 1)::timestamp
          END AS end_month,
          cb.first_month,
          cb.current_month
        FROM catalog_bounds cb
      ),
      months AS (
        SELECT
          db.first_month,
          db.current_month,
          generate_series(db.start_month, db.end_month, INTERVAL '1 month') AS month_start
        FROM display_bounds db
      ),
      sales_rollup AS (
        SELECT
          DATE_TRUNC('month', s.created_at AT TIME ZONE 'Asia/Kolkata') AS month_start,
          SUM(s.total_price) AS total_sales,
          SUM((s.selling_price - s.cost_price) * s.quantity) AS total_profit
        FROM sales s
        WHERE s.user_id = $1
          AND (
            $2::int IS NULL
            OR EXTRACT(YEAR FROM s.created_at AT TIME ZONE 'Asia/Kolkata') = $2::int
          )
        GROUP BY 1
      )
      SELECT
        TO_CHAR(
          m.month_start,
          CASE
            WHEN $2::int IS NULL THEN 'Mon YYYY'
            ELSE 'Mon'
          END
        ) AS month_label,
        TO_CHAR(m.month_start, 'YYYY-MM') AS month_key,
        m.month_start::date AS month_start_date,
        COALESCE(sr.total_sales, 0)::numeric(12,2) AS total_sales,
        COALESCE(sr.total_profit, 0)::numeric(12,2) AS total_profit,
        EXTRACT(YEAR FROM m.first_month)::int AS first_available_year,
        EXTRACT(YEAR FROM m.current_month)::int AS current_year
      FROM months m
      LEFT JOIN sales_rollup sr
        ON sr.month_start = m.month_start
      ORDER BY m.month_start ASC
      `,
        [user_id, selectedYear],
      );

      const currentYear =
        Number(result.rows[0]?.current_year) || getCurrentIstYear();
      const firstAvailableYear =
        Number(result.rows[0]?.first_available_year) || currentYear;
      const availableYears = [];

      for (let year = currentYear; year >= firstAvailableYear; year -= 1) {
        availableYears.push(year);
      }

      res.json({
        success: true,
        mode: selectedYear ? "year" : "all",
        year: selectedYear,
        available_years: availableYears,
        timeline: result.rows.map((row) => ({
          month_label: row.month_label,
          month_key: row.month_key,
          month_start_date: row.month_start_date,
          total_sales: row.total_sales,
          total_profit: row.total_profit,
        })),
      });
    } catch (err) {
      console.error("Monthly trend error:", err);
      res.status(500).json({ error: "Server error" });
    }
  },
);
// ----------------- MONTHLY SALES + PROFIT TREND end -----------------

// ----------------- LAST 13 MONTH SALES CHART -----------------
// ==================== BLOCK 32: ROLLING LAST 13 MONTHS SALES ====================
// Current monthসহ continuous 13-month window generate করে এবং sales না থাকা মাসও zero-filled result-এ রাখে। Calendar-year boundary ছাড়াই
// recent sales chart-এর stable labels ও comparable sequence পাওয়া যায়।
router.get(
  "/sales/last-13-months",
  requirePermission("sales_report"),
  async (req, res) => {
    try {
      const user_id = getUserId(req);

      const result = await pool.query(
        `
      WITH months AS (
        SELECT DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '12 months' 
               + (INTERVAL '1 month' * generate_series(0,12)) AS month_start
      )
      SELECT 
        TO_CHAR(m.month_start, 'Mon YYYY') AS month,
        COALESCE(SUM(s.total_price), 0) AS total_sales
      FROM months m
      LEFT JOIN sales s
        ON DATE_TRUNC('month', s.created_at AT TIME ZONE 'Asia/Kolkata') = m.month_start
        AND s.user_id = $1
      GROUP BY m.month_start
      ORDER BY m.month_start ASC
      `,
        [user_id],
      );

      res.json(result.rows);
    } catch (err) {
      console.error("Last 13 months chart error:", err.message);
      res.status(500).json({ error: "Server error" });
    }
  },
);
// ----------------- LAST 13 MONTH SALES CHART end -----------------

// ==================== BLOCK 33: PUBLIC ROUTER EXPORT ====================
// CommonJS export configured authenticated inventory router-কে server application-এর inventory API base path-এ mount করার সুযোগ দেয়।
module.exports = router;
