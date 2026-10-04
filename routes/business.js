/**
 * =========================================================
 * FILE: routes/business.js
 * PURPOSE: PURCHASE, SUPPLIER LEDGER ও EXPENSE ROUTES
 * =========================================================
 * এই Express router supplier lookup, purchase entry/report/detail, stock-safe purchase deletion,
 * supplier repayment/ledger এবং expense entry/report পরিচালনা করে। সব routes authenticated user-এর
 * account scope ব্যবহার করে; permission middleware feature access সীমিত করে। Purchase mutations transaction,
 * row/advisory locking ও cache invalidation ব্যবহার করে যাতে stock, serial এবং due totals consistent থাকে।
 */

// ==================== BLOCK 01: DEPENDENCIES ও SHARED BUSINESS INFRASTRUCTURE ====================
// Database pool SQL/transaction চালায়। Auth helpers user scope ও permissions দেয়; concurrency helpers normalized lookup key
// এবং scoped lock দেয়; response cache read-heavy reports দ্রুত করে; mutation শেষে user cache invalidation stale data সরায়।
const express = require("express");
const pool = require("../db");
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
const { buildPaginationMeta, parsePagination } = require("../utils/pagination");

const router = express.Router();

const PAYMENT_MODES = new Set(["cash", "upi", "bank", "mixed", "credit"]);

// ==================== BLOCK 02: NUMBER, MOBILE, PAYMENT ও IST DATE NORMALIZATION ====================
// Amount/quantity parser invalid value-এ null দেয়, mobile Indian prefix/leading zero পরিষ্কার করে এবং payment mode allow-list enforce করে।
// Date helpers YYYY-MM-DD fallback হিসেবে current Asia/Kolkata date নেয় এবং report filters-এর inclusive IST range তৈরি করে।
function parseNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parsePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeMobileNumber(value) {
  const digits = String(value || "").replace(/\D+/g, "");

  if (digits.length === 12 && digits.startsWith("91")) {
    return digits.slice(2);
  }

  if (digits.length === 11 && digits.startsWith("0")) {
    return digits.slice(1);
  }

  return digits;
}

function normalizePaymentMode(value, fallback = "cash") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return PAYMENT_MODES.has(normalized) ? normalized : fallback;
}

function parseDateInput(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  return new Date()
    .toLocaleString("en-CA", { timeZone: "Asia/Kolkata" })
    .slice(0, 10);
}

function toIstStartTimestamp(value) {
  return `${parseDateInput(value)}T00:00:00+05:30`;
}

function toIstDateRange(from, to) {
  const fromDate = parseDateInput(from);
  const toDate = parseDateInput(to);
  return {
    fromDate,
    toDate,
    fromTimestamp: `${fromDate}T00:00:00+05:30`,
    toTimestampExclusive: `${toDate}T23:59:59.999+05:30`,
  };
}

// ==================== BLOCK 03: PURCHASE PAYMENT SNAPSHOT ====================
// Subtotal, optional paid amount ও mode থেকে bounded amountPaid/amountDue এবং paid/partial/due state বানায়। Blank paid value
// non-credit purchase-এ full payment, credit mode-এ zero payment ধরে; paid amount কখনও subtotal-এর নিচে/উপরে যেতে পারে না।
function buildPaymentSnapshot(subtotal, paidInput, fallbackMode = "cash") {
  const total = Number(subtotal) || 0;
  const paymentMode = normalizePaymentMode(fallbackMode, "cash");
  const rawPaidInput = String(paidInput ?? "").trim();
  const normalizedPaid =
    rawPaidInput === "" ? null : parseNonNegativeNumber(paidInput);

  if (total <= 0) {
    return {
      amountPaid: 0,
      amountDue: 0,
      paymentMode,
      paymentStatus: "paid",
    };
  }

  const desiredPaid =
    normalizedPaid === null
      ? paymentMode === "credit"
        ? 0
        : total
      : normalizedPaid;
  const amountPaid = Number(
    Math.min(Math.max(desiredPaid, 0), total).toFixed(2),
  );
  const amountDue = Number((total - amountPaid).toFixed(2));

  let paymentStatus = "paid";
  if (amountDue > 0 && amountPaid > 0) {
    paymentStatus = "partial";
  } else if (amountDue > 0) {
    paymentStatus = "due";
  }

  return {
    amountPaid,
    amountDue,
    paymentMode,
    paymentStatus,
  };
}

function buildPurchasePaymentStatus(amountPaid, amountDue) {
  if (amountDue > 0.001 && amountPaid > 0.001) {
    return "partial";
  }

  if (amountDue > 0.001) {
    return "due";
  }

  return "paid";
}

// ==================== BLOCK 04: SERIAL NUMBER NORMALIZATION ও DUPLICATE CHECK ====================
// Display value length সীমিত করে এবং case/whitespace-insensitive lookup key বানায়। Array অথবা comma/newline text parse করে;
// blank values বাদ দেয় এবং একই purchase payload-এর duplicate serial দেখলে transaction শুরু হওয়ার আগেই error দেয়।
function normalizeSerialNumber(value) {
  return normalizeDisplayText(value).slice(0, 160);
}

function normalizeSerialNumberKey(value) {
  return normalizeLookupText(normalizeSerialNumber(value));
}

function parseSerialNumbers(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[\n\r,]+/)
        .map((entry) => entry.trim());
  const serials = [];
  const seen = new Set();

  rawValues.forEach((rawValue) => {
    const serialNo = normalizeSerialNumber(rawValue);
    const serialKey = normalizeSerialNumberKey(serialNo);
    if (!serialNo || !serialKey) {
      return;
    }

    if (seen.has(serialKey)) {
      throw new Error(`Duplicate serial number in this purchase: ${serialNo}`);
    }

    seen.add(serialKey);
    serials.push({ serialNo, serialKey });
  });

  return serials;
}

// ==================== BLOCK 05: PURCHASE DELETE-এ STOCK REVERSAL ====================
// Purchase items-এর serial আগে sold হয়েছে কি না যাচাই করে; sold serial থাকলে deletion আটকায়। Items normalized name দিয়ে group করে,
// account-scoped stock lock ও FOR UPDATE নেয়, purchased quantity current stock থেকে বাদ দেয় এবং negative stock হলে rollback-triggering error দেয়।
async function applyPurchaseStockReversal(client, userId, purchaseItems) {
  const groupedItems = new Map();
  const purchaseItemIds = purchaseItems
    .map((item) => Number.parseInt(item.id, 10))
    .filter((itemId) => Number.isInteger(itemId) && itemId > 0);

  if (purchaseItemIds.length) {
    const soldSerial = await client.query(
      `
        SELECT serial_no
        FROM item_serials
        WHERE user_id = $1
          AND purchase_item_id = ANY($2::int[])
          AND status = 'sold'
        ORDER BY sold_at DESC NULLS LAST, id DESC
        LIMIT 1
      `,
      [userId, purchaseItemIds],
    );

    if (soldSerial.rowCount) {
      throw new Error(
        `Cannot delete purchase; serial number ${soldSerial.rows[0].serial_no} is already sold.`,
      );
    }
  }

  for (const item of purchaseItems) {
    const itemName = normalizeDisplayText(item.item_name);
    const lookupKey = normalizeLookupText(itemName);
    const quantity = Number(item.quantity) || 0;

    if (!itemName || !lookupKey || quantity <= 0) {
      continue;
    }

    const current = groupedItems.get(lookupKey) || {
      itemName,
      lookupKey,
      quantity: 0,
    };
    current.quantity = Number((current.quantity + quantity).toFixed(2));
    groupedItems.set(lookupKey, current);
  }

  const entries = Array.from(groupedItems.values()).sort((left, right) =>
    left.lookupKey.localeCompare(right.lookupKey),
  );

  for (const item of entries) {
    await lockScopedResource(client, userId, "item-stock", item.lookupKey);

    const stockResult = await client.query(
      `
        SELECT id, quantity
        FROM items
        WHERE user_id = $1 AND LOWER(TRIM(name)) = $2
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
      `,
      [userId, item.lookupKey],
    );

    const stockRow = stockResult.rows[0];
    if (!stockRow) {
      throw new Error(`Stock item not found for ${item.itemName}.`);
    }

    const nextQuantity = Number(
      ((Number(stockRow.quantity) || 0) - item.quantity).toFixed(2),
    );

    if (nextQuantity < -0.001) {
      throw new Error(
        `Cannot delete ${item.itemName}; stock from this purchase appears to be already used.`,
      );
    }

    await client.query(
      `
        UPDATE items
        SET quantity = $1,
            updated_at = NOW()
        WHERE id = $2 AND user_id = $3
      `,
      [Math.max(0, nextQuantity), stockRow.id, userId],
    );
  }
}

// ==================== BLOCK 06: MULTIPLE PURCHASE DELETE HELPER ====================
// Positive unique purchase ids normalize করে, owner-scoped purchase items lock করে, stock reversal চালায় এবং parent purchases delete করে।
// Foreign-key cascade related purchase items/serial rows সরাতে পারে; caller একই transaction-এ commit/rollback ও cache invalidation করে।
async function deletePurchaseBillsWithStockRollback(client, userId, purchaseIds) {
  const normalizedIds = Array.from(
    new Set(
      purchaseIds
        .map((purchaseId) => Number.parseInt(purchaseId, 10))
        .filter((purchaseId) => Number.isInteger(purchaseId) && purchaseId > 0),
    ),
  );

  if (!normalizedIds.length) {
    return { deletedCount: 0, deletedRows: [] };
  }

  const itemsResult = await client.query(
    `
      SELECT pi.id, pi.purchase_id, pi.item_name, pi.quantity
      FROM purchase_items pi
      JOIN purchases p ON p.id = pi.purchase_id
      WHERE p.user_id = $1
        AND p.id = ANY($2::int[])
      ORDER BY LOWER(TRIM(pi.item_name)), pi.id
      FOR UPDATE OF pi
    `,
    [userId, normalizedIds],
  );

  await applyPurchaseStockReversal(client, userId, itemsResult.rows);

  const deleteResult = await client.query(
    `
      DELETE FROM purchases
      WHERE user_id = $1
        AND id = ANY($2::int[])
      RETURNING id, supplier_id
    `,
    [userId, normalizedIds],
  );

  return {
    deletedCount: deleteResult.rowCount,
    deletedRows: deleteResult.rows,
  };
}

// ==================== BLOCK 07: SUPPLIER LOOKUP / UPDATE / CREATE ====================
// Supplier name/mobile/address normalize ও validate করে, mobile থাকলে সেটি না হলে normalized name দিয়ে account-scoped lock নেয়।
// Existing supplier mobile/name match হলে missing/current details update করে; match না হলে নতুন supplier insert করে এবং row return করে।
async function findOrCreateSupplier(client, userId, payload) {
  const supplierName = normalizeDisplayText(payload.name);
  const supplierMobile = normalizeMobileNumber(payload.mobile_number);
  const supplierAddress = String(payload.address || "").trim();

  if (!supplierName) {
    throw new Error("Supplier name is required");
  }

  if (supplierMobile && !/^\d{10}$/.test(supplierMobile)) {
    throw new Error("Supplier mobile number must be 10 digits");
  }

  await lockScopedResource(
    client,
    userId,
    "supplier",
    supplierMobile || normalizeLookupText(supplierName),
  );

  let existing = null;

  if (supplierMobile) {
    const result = await client.query(
      `
        SELECT id, name, mobile_number, address
        FROM suppliers
        WHERE user_id = $1 AND mobile_number = $2
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
      `,
      [userId, supplierMobile],
    );
    existing = result.rows[0] || null;
  }

  if (!existing) {
    const result = await client.query(
      `
        SELECT id, name, mobile_number, address
        FROM suppliers
        WHERE user_id = $1 AND LOWER(TRIM(name)) = $2
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
      `,
      [userId, normalizeLookupText(supplierName)],
    );
    existing = result.rows[0] || null;
  }

  if (existing) {
    const updated = await client.query(
      `
        UPDATE suppliers
        SET
          name = $1,
          mobile_number = $2,
          address = $3,
          updated_at = NOW()
        WHERE id = $4 AND user_id = $5
        RETURNING id, name, mobile_number, address
      `,
      [
        supplierName,
        supplierMobile || null,
        supplierAddress || null,
        existing.id,
        userId,
      ],
    );

    return updated.rows[0];
  }

  const inserted = await client.query(
    `
      INSERT INTO suppliers (user_id, name, mobile_number, address)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, mobile_number, address
    `,
    [userId, supplierName, supplierMobile || null, supplierAddress || null],
  );

  return inserted.rows[0];
}

// ==================== BLOCK 08: ROUTER-WIDE AUTHENTICATION BOUNDARY ====================
// এই line-এর পরের প্রতিটি business endpoint valid session ছাড়া চলবে না। getUserId(req) middleware-verified owner scope দেয়;
// individual routes requirePermission অথবা requireOwner দিয়ে আরও কঠোর feature/action authorization যোগ করে।
router.use(authMiddleware);

// ==================== BLOCK 09: SUPPLIER AUTOCOMPLETE SEARCH ====================
// purchase_entry permission এবং current user scope-এর মধ্যে supplier name/mobile query করে। Optional q normalized pattern-এ filter হয়;
// result compact suggestion fields দেয় এবং 15-second cache typing-এর সময় repeated identical lookup query কমায়।
router.get(
  "/suppliers",
  requirePermission("purchase_entry"),
  cacheJsonResponse({ namespace: "business:suppliers", ttlMs: 15 * 1000 }),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const query = String(req.query.q || "").trim();
      const params = [userId];
      let whereClause = "";

      if (query) {
        params.push(`%${query}%`);
        whereClause = `
        AND (
          s.name ILIKE $2
          OR COALESCE(s.mobile_number, '') ILIKE $2
        )
      `;
      }

      const result = await pool.query(
        `
        SELECT
          s.id,
          s.name,
          s.mobile_number,
          s.address
        FROM suppliers s
        WHERE s.user_id = $1
        ${whereClause}
        ORDER BY s.updated_at DESC, s.name ASC
        LIMIT 20
      `,
        params,
      );

      res.json(result.rows);
    } catch (error) {
      console.error("Supplier lookup error:", error);
      res.status(500).json({ error: "Failed to load suppliers" });
    }
  },
);

// ==================== BLOCK 10: CREATE PURCHASE TRANSACTION ====================
// purchase_entry permission-এর user supplier/bill/payment/items payload পাঠায়। Handler supplier resolve/create করে, settings থেকে GST নেয়,
// প্রতিটি item/quantity/rate/serial normalize করে, duplicate/existing available serial আটকায় এবং subtotal/payment snapshot হিসাব করে।
// Transaction-এর মধ্যে purchase ও purchase_items insert, inventory row lock/update-or-create এবং item_serials insert হয়। সব সফল হলে COMMIT,
// user cache invalidate ও saved purchase response; validation/constraint/stock failure হলে ROLLBACK এবং client release নিশ্চিত হয়।
router.post(
  "/purchases",
  requirePermission("purchase_entry"),
  async (req, res) => {
    const client = await pool.connect();

    try {
      const userId = getUserId(req);
      const supplierName = normalizeDisplayText(req.body.supplier_name);
      const supplierNumber = normalizeMobileNumber(req.body.supplier_number);
      const supplierAddress = String(req.body.supplier_address || "").trim();
      const billNo = String(req.body.bill_no || "").trim();
      const purchaseDate = parseDateInput(req.body.purchase_date);
      const note = String(req.body.note || "").trim();
      const paymentMode = normalizePaymentMode(req.body.payment_mode, "cash");
      const items = Array.isArray(req.body.items) ? req.body.items : [];

      if (!supplierName) {
        return res.status(400).json({ error: "Supplier name is required." });
      }

      if (supplierNumber && !/^\d{10}$/.test(supplierNumber)) {
        return res
          .status(400)
          .json({ error: "Supplier mobile number must be 10 digits." });
      }

      if (!items.length) {
        return res
          .status(400)
          .json({ error: "Add at least one purchase item." });
      }

      // TRANSACTION PHASE A — সব supplier, purchase, stock ও serial mutation একই atomic unit-এ শুরু হয়।
      await client.query("BEGIN");

      // TRANSACTION PHASE B — user settings থেকে fallback profit percentage নিয়ে missing buying/selling rate derive করা হয়।
      const settingsResult = await client.query(
        `
        SELECT default_profit_percent
        FROM settings
        WHERE user_id = $1
        LIMIT 1
      `,
        [userId],
      );

      const defaultProfitPercent =
        Number(settingsResult.rows[0]?.default_profit_percent) || 30;

      // TRANSACTION PHASE C — প্রতিটি payload row validate/normalize করে stable item name, quantity, rates, total ও serial list বানায়।
      const normalizedItems = items.map((item, index) => {
        const itemName = normalizeDisplayText(item.item_name || item.name);
        const lookupKey = normalizeLookupText(itemName);
        const quantity = parsePositiveNumber(item.quantity);
        const buyingRate = parsePositiveNumber(item.buying_rate);
        const sellingRateInput = parseNonNegativeNumber(item.selling_rate);
        const serialNumbers = parseSerialNumbers(
          item.serial_numbers ?? item.serials ?? item.serial_no_text,
        );

        if (
          !itemName ||
          !lookupKey ||
          quantity === null ||
          buyingRate === null
        ) {
          throw new Error(`Invalid purchase item at line ${index + 1}`);
        }

        if (serialNumbers.length) {
          if (!Number.isInteger(quantity)) {
            throw new Error(
              `Serial-tracked quantity must be a whole number at line ${index + 1}`,
            );
          }

          if (serialNumbers.length !== quantity) {
            throw new Error(
              `Serial number count must match quantity at line ${index + 1}`,
            );
          }
        }

        const sellingRate =
          sellingRateInput === null
            ? Number((buyingRate * (1 + defaultProfitPercent / 100)).toFixed(2))
            : Number(sellingRateInput.toFixed(2));
        const lineTotal = Number((quantity * buyingRate).toFixed(2));

        return {
          itemName,
          lookupKey,
          quantity: Number(quantity.toFixed(2)),
          buyingRate: Number(buyingRate.toFixed(2)),
          sellingRate,
          lineTotal,
          serialNumbers,
        };
      });

      // TRANSACTION PHASE D — পুরো purchase-এর serial keys একত্র করে payload duplicate এবং database-এ existing available serial আটকায়।
      const allSerials = [];
      const seenSerialKeys = new Set();
      normalizedItems.forEach((item) => {
        item.serialNumbers.forEach((serial) => {
          if (seenSerialKeys.has(serial.serialKey)) {
            throw new Error(
              `Duplicate serial number in this purchase: ${serial.serialNo}`,
            );
          }
          seenSerialKeys.add(serial.serialKey);
          allSerials.push(serial);
        });
      });

      for (const serial of [...allSerials].sort((left, right) =>
        left.serialKey.localeCompare(right.serialKey),
      )) {
        await lockScopedResource(
          client,
          userId,
          "item-serial",
          serial.serialKey,
        );
      }

      if (allSerials.length) {
        const existingSerials = await client.query(
          `
            SELECT serial_no
            FROM item_serials
            WHERE user_id = $1
              AND serial_no_norm = ANY($2::text[])
            LIMIT 5
          `,
          [userId, allSerials.map((serial) => serial.serialKey)],
        );

        if (existingSerials.rowCount) {
          throw new Error(
            `Serial number already exists: ${existingSerials.rows[0].serial_no}`,
          );
        }
      }

      // TRANSACTION PHASE E — normalized line totals থেকে subtotal এবং bounded paid/due/status snapshot হিসাব করা হয়।
      const subtotal = Number(
        normalizedItems
          .reduce((sum, item) => sum + item.lineTotal, 0)
          .toFixed(2),
      );

      const payment = buildPaymentSnapshot(
        subtotal,
        req.body.amount_paid,
        paymentMode,
      );

      const supplier = await findOrCreateSupplier(client, userId, {
        name: supplierName,
        mobile_number: supplierNumber,
        address: supplierAddress,
      });

      // TRANSACTION PHASE F — supplier-linked purchase header প্রথমে insert হয়, যাতে পরের item/serial rows parent id পায়।
      const purchaseResult = await client.query(
        `
        INSERT INTO purchases (
          user_id,
          supplier_id,
          bill_no,
          purchase_date,
          subtotal,
          amount_paid,
          amount_due,
          payment_mode,
          payment_status,
          note
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, subtotal, amount_paid, amount_due, payment_status
      `,
        [
          userId,
          supplier.id,
          billNo || null,
          toIstStartTimestamp(purchaseDate),
          subtotal,
          payment.amountPaid,
          payment.amountDue,
          payment.paymentMode,
          payment.paymentStatus,
          note || null,
        ],
      );

      const purchase = purchaseResult.rows[0];

      // TRANSACTION PHASE G — প্রতিটি line insert করে matching inventory row lock/update-or-create এবং serial records attach করা হয়।
      for (const item of normalizedItems) {
        const purchaseItemResult = await client.query(
          `
          INSERT INTO purchase_items (
            purchase_id,
            item_name,
            quantity,
            buying_rate,
            selling_rate,
            line_total
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `,
          [
            purchase.id,
            item.itemName,
            item.quantity,
            item.buyingRate,
            item.sellingRate,
            item.lineTotal,
          ],
        );
        const purchaseItemId = purchaseItemResult.rows[0].id;

        await lockScopedResource(client, userId, "item-stock", item.lookupKey);

        const existingItem = await client.query(
          `
          SELECT id
          FROM items
          WHERE user_id = $1 AND LOWER(TRIM(name)) = $2
          ORDER BY id ASC
          LIMIT 1
          FOR UPDATE
        `,
          [userId, item.lookupKey],
        );

        let itemId = null;
        if (existingItem.rowCount) {
          await client.query(
            `
            UPDATE items
            SET
              quantity = quantity + $1,
              buying_rate = $2,
              selling_rate = $3,
              updated_at = NOW()
            WHERE id = $4 AND user_id = $5
          `,
            [
              item.quantity,
              item.buyingRate,
              item.sellingRate,
              existingItem.rows[0].id,
              userId,
            ],
          );
          itemId = existingItem.rows[0].id;
        } else {
          const insertedItem = await client.query(
            `
            INSERT INTO items (user_id, name, quantity, buying_rate, selling_rate)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
          `,
            [
              userId,
              item.itemName,
              item.quantity,
              item.buyingRate,
              item.sellingRate,
            ],
          );
          itemId = insertedItem.rows[0].id;
        }

        for (const serial of item.serialNumbers) {
          await client.query(
            `
            INSERT INTO item_serials (
              user_id,
              item_id,
              purchase_id,
              purchase_item_id,
              serial_no,
              serial_no_norm,
              sale_rate
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
            [
              userId,
              itemId,
              purchase.id,
              purchaseItemId,
              serial.serialNo,
              serial.serialKey,
              item.sellingRate,
            ],
          );
        }
      }

      // TRANSACTION PHASE H — সব writes সফল হলেই commit; এরপর cached reports/suggestions invalid করে fresh data নিশ্চিত করা হয়।
      await client.query("COMMIT");
      invalidateUserCache(userId);

      res.json({
        success: true,
        message: "Purchase saved and stock updated successfully.",
        purchase: {
          id: purchase.id,
          subtotal: purchase.subtotal,
          amount_paid: purchase.amount_paid,
          amount_due: purchase.amount_due,
          payment_status: purchase.payment_status,
        },
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Purchase rollback error:", rollbackError);
      }

      if (
        error.code === "23505" &&
        String(error.constraint || "").includes("item_serials")
      ) {
        return res
          .status(400)
          .json({ error: "One or more serial numbers already exist." });
      }

      if (
        error.message.startsWith("Invalid purchase item") ||
        error.message.includes("Supplier") ||
        error.message.includes("Serial") ||
        error.message.includes("serial") ||
        error.message.includes("Duplicate")
      ) {
        return res.status(400).json({ error: error.message });
      }

      console.error("Purchase save error:", error);
      res.status(500).json({ error: "Failed to save purchase entry" });
    } finally {
      client.release();
    }
  },
);

// ==================== BLOCK 11: PURCHASE REPORT LIST ====================
// Date range, free-text query ও pagination parse করে owner-scoped purchase rows supplier/payment totalsসহ আনে। Optional count query
// pagination metadata বানায়; short-lived JSON cache একই filter query বারবার চললে database load কমায়।
router.get(
  "/purchases/report",
  requirePermission("purchase_entry"),
  cacheJsonResponse({ namespace: "business:purchases", ttlMs: 10 * 1000 }),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const rawQuery = String(req.query.q || "").trim();
      const pagination = parsePagination(req.query, 100, 500, {
        optional: true,
      });
      const { fromDate, toDate, fromTimestamp, toTimestampExclusive } =
        toIstDateRange(req.query.from, req.query.to);

      const params = [userId, fromTimestamp, toTimestampExclusive];
      let searchClause = "";

      if (rawQuery) {
        params.push(`%${rawQuery}%`);
        searchClause = `
        AND (
          COALESCE(s.name, '') ILIKE $4
          OR COALESCE(s.mobile_number, '') ILIKE $4
          OR COALESCE(p.bill_no, '') ILIKE $4
        )
      `;
      }

      const paginationClause = pagination.enabled
        ? `LIMIT ${pagination.limit} OFFSET ${pagination.offset}`
        : "";

      const countResult = pagination.enabled
        ? await pool.query(
            `
        SELECT COUNT(DISTINCT p.id)::int AS total
        FROM purchases p
        JOIN suppliers s
          ON s.id = p.supplier_id
        WHERE p.user_id = $1
          AND p.purchase_date >= $2::timestamptz
          AND p.purchase_date <= $3::timestamptz
          ${searchClause}
      `,
            params,
          )
        : null;

      const result = await pool.query(
        `
        SELECT
          p.id,
          p.bill_no,
          p.purchase_date,
          p.subtotal,
          p.amount_paid,
          p.amount_due,
          p.payment_mode,
          p.payment_status,
          p.note,
          s.id AS supplier_id,
          s.name AS supplier_name,
          s.mobile_number AS supplier_number,
          COUNT(pi.id)::int AS item_count
        FROM purchases p
        JOIN suppliers s
          ON s.id = p.supplier_id
        LEFT JOIN purchase_items pi
          ON pi.purchase_id = p.id
        WHERE p.user_id = $1
          AND p.purchase_date >= $2::timestamptz
          AND p.purchase_date <= $3::timestamptz
          ${searchClause}
        GROUP BY p.id, s.id
        ORDER BY p.purchase_date DESC, p.id DESC
        ${paginationClause}
      `,
        params,
      );

      const payload = {
        success: true,
        range: { from: fromDate, to: toDate },
        purchases: result.rows,
      };
      const paginationMeta = buildPaginationMeta(
        pagination,
        countResult?.rows[0]?.total,
        result.rows.length,
      );
      if (paginationMeta) {
        payload.pagination = paginationMeta;
      }

      res.json(payload);
    } catch (error) {
      console.error("Purchase report error:", error);
      res.status(500).json({ error: "Failed to load purchase report" });
    }
  },
);

// ==================== BLOCK 12: PRODUCT PURCHASE HISTORY ====================
// Selected product name/search key অনুযায়ী previous purchase lines supplier, bill date, quantity ও buying rateসহ return করে।
// purchase_entry permission, account scope ও cached response product autocomplete/history view-কে নিরাপদ ও দ্রুত রাখে।
router.get(
  "/purchases/product-history",
  requirePermission("purchase_entry"),
  cacheJsonResponse({
    namespace: "business:purchase-product-history",
    ttlMs: 15 * 1000,
  }),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const itemName = normalizeDisplayText(req.query.item_name);

      if (!itemName) {
        return res.status(400).json({ error: "Product name is required." });
      }

      const result = await pool.query(
        `
        SELECT
          pi.id,
          pi.purchase_id,
          pi.item_name,
          pi.quantity,
          pi.buying_rate,
          pi.selling_rate,
          pi.line_total,
          p.bill_no,
          p.purchase_date,
          p.payment_status,
          s.id AS supplier_id,
          s.name AS supplier_name,
          s.mobile_number AS supplier_number
        FROM purchase_items pi
        JOIN purchases p
          ON p.id = pi.purchase_id
        JOIN suppliers s
          ON s.id = p.supplier_id
        WHERE p.user_id = $1
          AND (
            LOWER(TRIM(pi.item_name)) = LOWER(TRIM($2))
            OR pi.item_name ILIKE $3
          )
        ORDER BY
          CASE
            WHEN LOWER(TRIM(pi.item_name)) = LOWER(TRIM($2)) THEN 0
            ELSE 1
          END,
          p.purchase_date DESC,
          pi.id DESC
        LIMIT 100
      `,
        [userId, itemName, `%${itemName}%`],
      );

      res.json({
        success: true,
        item_name: itemName,
        rows: result.rows,
      });
    } catch (error) {
      console.error("Product purchase history error:", error);
      res
        .status(500)
        .json({ error: "Failed to load product purchase history" });
    }
  },
);

// ==================== BLOCK 13: SINGLE PURCHASE DETAIL ====================
// Positive purchaseId validate করে owner-scoped purchase header, supplier/payment information ও ordered item/serial details load করে।
// Record না থাকলে 404 দেয়; result purchase detail panel ও repayment availability render করতে ব্যবহৃত হয়।
router.get(
  "/purchases/:purchaseId",
  requirePermission("purchase_entry"),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const purchaseId = Number.parseInt(req.params.purchaseId, 10);

      if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase selection." });
      }

      const result = await pool.query(
        `
        SELECT
          p.id,
          p.bill_no,
          p.purchase_date,
          p.subtotal,
          p.amount_paid,
          p.amount_due,
          p.payment_mode,
          p.payment_status,
          p.note,
          s.id AS supplier_id,
          s.name AS supplier_name,
          s.mobile_number AS supplier_number,
          s.address AS supplier_address,
          COALESCE(
            json_agg(
              json_build_object(
                'id', pi.id,
                'item_name', pi.item_name,
                'quantity', pi.quantity,
                'buying_rate', pi.buying_rate,
                'selling_rate', pi.selling_rate,
                'line_total', pi.line_total,
                'serial_numbers', COALESCE(
                  (
                    SELECT json_agg(
                      json_build_object(
                        'id', isn.id,
                        'serial_no', isn.serial_no,
                        'sale_rate', isn.sale_rate,
                        'status', isn.status,
                        'sold_at', isn.sold_at
                      )
                      ORDER BY isn.id
                    )
                    FROM item_serials isn
                    WHERE isn.user_id = p.user_id
                      AND isn.purchase_item_id = pi.id
                  ),
                  '[]'::json
                )
              )
              ORDER BY pi.id
            ) FILTER (WHERE pi.id IS NOT NULL),
            '[]'
          ) AS items
        FROM purchases p
        JOIN suppliers s
          ON s.id = p.supplier_id
        LEFT JOIN purchase_items pi
          ON pi.purchase_id = p.id
        WHERE p.user_id = $1
          AND p.id = $2
        GROUP BY p.id, s.id
        LIMIT 1
      `,
        [userId, purchaseId],
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: "Purchase not found." });
      }

      res.json({
        success: true,
        purchase: result.rows[0],
      });
    } catch (error) {
      console.error("Purchase detail error:", error);
      res.status(500).json({ error: "Failed to load purchase detail" });
    }
  },
);

// ==================== BLOCK 14: DELETE COMPLETE PURCHASE WITH STOCK ROLLBACK ====================
// Owner-only transaction target purchase lock করে এবং helper দিয়ে sold-serial/available-stock safety যাচাই করে purchased quantity reverse করে।
// Purchase delete সফল হলে COMMIT ও cache invalidation; invalid id/not found/conflict/error হলে ROLLBACK করে stock ও bill atomic রাখে।
router.delete(
  "/purchases/:purchaseId",
  requireOwner,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const userId = getUserId(req);
      const purchaseId = Number.parseInt(req.params.purchaseId, 10);

      if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase selection." });
      }

      await client.query("BEGIN");

      const purchaseResult = await client.query(
        `
          SELECT id, supplier_id
          FROM purchases
          WHERE user_id = $1 AND id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [userId, purchaseId],
      );

      if (!purchaseResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Purchase not found." });
      }

      const deletion = await deletePurchaseBillsWithStockRollback(
        client,
        userId,
        [purchaseId],
      );

      await client.query("COMMIT");
      invalidateUserCache(userId);

      res.json({
        success: true,
        message: "Purchase bill deleted successfully.",
        deleted_count: deletion.deletedCount,
        supplier_id:
          deletion.deletedRows[0]?.supplier_id ||
          purchaseResult.rows[0].supplier_id,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Purchase delete rollback error:", rollbackError);
      }

      const message = String(error.message || "");
      if (
        message.startsWith("Cannot delete") ||
        message.startsWith("Stock item not found")
      ) {
        return res.status(400).json({ error: message });
      }

      console.error("Purchase delete error:", error);
      res.status(500).json({ error: "Failed to delete purchase bill" });
    } finally {
      client.release();
    }
  },
);

// ==================== BLOCK 15: DELETE ONE PURCHASE ITEM ও RECOMPUTE BILL ====================
// Owner-only transaction item ও parent purchase lock করে। একমাত্র item delete করা আটকায়; selected item stock reversal করে row delete করে,
// remaining lines থেকে subtotal/GST/total পুনরায় হিসাব এবং paid amount clamp করে due/status update করে। Commit-এর পরে cache invalid হয়।
router.delete(
  "/purchase-items/:itemId",
  requireOwner,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const userId = getUserId(req);
      const itemId = Number.parseInt(req.params.itemId, 10);

      if (!Number.isInteger(itemId) || itemId <= 0) {
        return res
          .status(400)
          .json({ error: "Invalid purchase item selection." });
      }

      await client.query("BEGIN");

      const itemResult = await client.query(
        `
          SELECT
            pi.id,
            pi.purchase_id,
            pi.item_name,
            pi.quantity,
            pi.line_total,
            p.supplier_id,
            p.amount_paid,
            p.payment_mode
          FROM purchase_items pi
          JOIN purchases p ON p.id = pi.purchase_id
          WHERE p.user_id = $1
            AND pi.id = $2
          LIMIT 1
          FOR UPDATE OF pi, p
        `,
        [userId, itemId],
      );

      const item = itemResult.rows[0];
      if (!item) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Purchase item not found." });
      }

      const countResult = await client.query(
        `
          SELECT COUNT(*)::int AS item_count
          FROM purchase_items
          WHERE purchase_id = $1
        `,
        [item.purchase_id],
      );

      if ((Number(countResult.rows[0]?.item_count) || 0) <= 1) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error:
            "This is the last item in the bill. Delete the full bill instead.",
        });
      }

      await applyPurchaseStockReversal(client, userId, [item]);

      await client.query(
        `
          DELETE FROM purchase_items
          WHERE id = $1
        `,
        [itemId],
      );

      const subtotalResult = await client.query(
        `
          SELECT COALESCE(SUM(line_total), 0) AS subtotal
          FROM purchase_items
          WHERE purchase_id = $1
        `,
        [item.purchase_id],
      );

      const nextSubtotal = Number(
        Number(subtotalResult.rows[0]?.subtotal || 0).toFixed(2),
      );
      const nextPaid = Number(
        Math.min(Number(item.amount_paid) || 0, nextSubtotal).toFixed(2),
      );
      const nextDue = Number((nextSubtotal - nextPaid).toFixed(2));

      await client.query(
        `
          UPDATE purchases
          SET subtotal = $1,
              amount_paid = $2,
              amount_due = $3,
              payment_status = $4,
              updated_at = NOW()
          WHERE user_id = $5 AND id = $6
        `,
        [
          nextSubtotal,
          nextPaid,
          nextDue,
          buildPurchasePaymentStatus(nextPaid, nextDue),
          userId,
          item.purchase_id,
        ],
      );

      await client.query("COMMIT");
      invalidateUserCache(userId);

      res.json({
        success: true,
        message: "Purchase item deleted successfully.",
        purchase_id: item.purchase_id,
        supplier_id: item.supplier_id,
        deleted_item_id: itemId,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Purchase item delete rollback error:", rollbackError);
      }

      const message = String(error.message || "");
      if (
        message.startsWith("Cannot delete") ||
        message.startsWith("Stock item not found")
      ) {
        return res.status(400).json({ error: message });
      }

      console.error("Purchase item delete error:", error);
      res.status(500).json({ error: "Failed to delete purchase item" });
    } finally {
      client.release();
    }
  },
);

// ==================== BLOCK 16: SUPPLIER PURCHASE REPAYMENT ====================
// purchase_entry permission-এর user outstanding bill-এ positive repayment, mode ও optional remark পাঠায়। Transaction purchase lock করে,
// amount current due-এর বেশি হতে দেয় না, payment ledger entry insert করে এবং purchase paid/due/status update করে। Commit/cache refresh শেষে
// নতুন payment snapshot return হয়; fully-paid/invalid/not-found/overpayment branch rollback করে।
router.post(
  "/purchases/:purchaseId/repayment",
  requirePermission("purchase_entry"),
  async (req, res) => {
    const client = await pool.connect();

    try {
      const userId = getUserId(req);
      const purchaseId = Number.parseInt(req.params.purchaseId, 10);
      const amount = parsePositiveNumber(req.body.amount);
      const paymentMode = normalizePaymentMode(req.body.payment_mode, "cash");
      const note = String(req.body.note || "").trim();

      if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
        return res.status(400).json({ error: "Invalid purchase selection." });
      }

      if (amount === null) {
        return res
          .status(400)
          .json({ error: "Repayment amount must be greater than zero." });
      }

      await client.query("BEGIN");

      const purchaseResult = await client.query(
        `
          SELECT
            p.id,
            p.bill_no,
            p.amount_paid,
            p.amount_due,
            p.payment_mode,
            p.payment_status,
            p.note,
            s.id AS supplier_id,
            s.name AS supplier_name
          FROM purchases p
          JOIN suppliers s
            ON s.id = p.supplier_id
          WHERE p.user_id = $1
            AND p.id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [userId, purchaseId],
      );

      if (!purchaseResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Purchase not found." });
      }

      const purchase = purchaseResult.rows[0];
      const currentDue = Number(purchase.amount_due) || 0;

      if (currentDue <= 0) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "This purchase already has no due amount." });
      }

      if (amount - currentDue > 0.001) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Repayment amount cannot be greater than the current due of Rs. ${currentDue.toFixed(2)}.`,
        });
      }

      const nextAmountPaid = Number(
        ((Number(purchase.amount_paid) || 0) + amount).toFixed(2),
      );
      const nextAmountDue = Number((currentDue - amount).toFixed(2));
      const nextPaymentStatus = nextAmountDue > 0 ? "partial" : "paid";
      const previousMode = normalizePaymentMode(purchase.payment_mode, "cash");
      const nextPaymentMode =
        previousMode === "credit"
          ? nextAmountDue > 0
            ? "mixed"
            : paymentMode
          : previousMode === paymentMode
            ? previousMode
            : Number(purchase.amount_paid) > 0
              ? "mixed"
              : paymentMode;

      const repaymentStamp = new Date().toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const repaymentNote = [
        `Repayment ${amount.toFixed(2)} via ${paymentMode.toUpperCase()} on ${repaymentStamp}`,
        note || "",
      ]
        .filter(Boolean)
        .join(" | ");
      const mergedNote = [String(purchase.note || "").trim(), repaymentNote]
        .filter(Boolean)
        .join("\n");

      await client.query(
        `
          UPDATE purchases
          SET
            amount_paid = $1,
            amount_due = $2,
            payment_mode = $3,
            payment_status = $4,
            note = $5,
            updated_at = NOW()
          WHERE id = $6
            AND user_id = $7
        `,
        [
          nextAmountPaid,
          nextAmountDue,
          nextPaymentMode,
          nextPaymentStatus,
          mergedNote || null,
          purchaseId,
          userId,
        ],
      );

      await client.query("COMMIT");
      invalidateUserCache(userId);

      res.json({
        success: true,
        message:
          nextAmountDue > 0
            ? "Supplier repayment saved. The remaining due is still pending."
            : "Supplier repayment saved and the bill is now fully cleared.",
        purchase: {
          id: purchaseId,
          supplier_id: purchase.supplier_id,
          supplier_name: purchase.supplier_name,
          amount_paid: nextAmountPaid,
          amount_due: nextAmountDue,
          payment_mode: nextPaymentMode,
          payment_status: nextPaymentStatus,
          note: mergedNote,
        },
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Purchase repayment rollback error:", rollbackError);
      }

      console.error("Purchase repayment error:", error);
      res.status(500).json({ error: "Failed to save supplier repayment" });
    } finally {
      client.release();
    }
  },
);

// ==================== BLOCK 17: SUPPLIER SUMMARY LIST ====================
// Supplier identity-এর সঙ্গে purchase count, total purchase value, amount paid ও outstanding due aggregate করে। Search/pagination support
// ledger workspace-এর supplier list চালায়; cached account-scoped result current filter-এর summary ও pagination metadata return করে।
router.get(
  "/suppliers/summary",
  requirePermission("purchase_entry"),
  cacheJsonResponse({
    namespace: "business:supplier-summary",
    ttlMs: 10 * 1000,
  }),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const rawQuery = String(req.query.q || "").trim();
      const pagination = parsePagination(req.query, 100, 500, {
        optional: true,
      });
      const params = [userId];
      let searchClause = "";

      if (rawQuery) {
        params.push(`%${rawQuery}%`);
        searchClause = `
        AND (
          s.name ILIKE $2
          OR COALESCE(s.mobile_number, '') ILIKE $2
        )
      `;
      }

      const paginationClause = pagination.enabled
        ? `LIMIT ${pagination.limit} OFFSET ${pagination.offset}`
        : "";
      const countResult = pagination.enabled
        ? await pool.query(
            `
        SELECT COUNT(*)::int AS total
        FROM (
          SELECT s.id
          FROM suppliers s
          LEFT JOIN purchases p
            ON p.supplier_id = s.id AND p.user_id = s.user_id
          WHERE s.user_id = $1
            ${searchClause}
          GROUP BY s.id
          HAVING COUNT(p.id) > 0
        ) supplier_summary
      `,
            params,
          )
        : null;

      const result = await pool.query(
        `
        SELECT
          s.id,
          s.name,
          s.mobile_number,
          COUNT(p.id)::int AS purchase_count,
          COALESCE(SUM(p.subtotal), 0) AS total_amount,
          COALESCE(SUM(p.amount_paid), 0) AS total_paid,
          COALESCE(SUM(p.amount_due), 0) AS total_due,
          MAX(p.purchase_date) AS last_purchase_date
        FROM suppliers s
        LEFT JOIN purchases p
          ON p.supplier_id = s.id AND p.user_id = s.user_id
        WHERE s.user_id = $1
          ${searchClause}
        GROUP BY s.id
        HAVING COUNT(p.id) > 0
        ORDER BY COALESCE(SUM(p.amount_due), 0) DESC, MAX(p.purchase_date) DESC NULLS LAST
        ${paginationClause}
      `,
        params,
      );

      const payload = {
        success: true,
        suppliers: result.rows,
      };
      const paginationMeta = buildPaginationMeta(
        pagination,
        countResult?.rows[0]?.total,
        result.rows.length,
      );
      if (paginationMeta) {
        payload.pagination = paginationMeta;
      }

      res.json(payload);
    } catch (error) {
      console.error("Supplier ledger summary error:", error);
      res.status(500).json({ error: "Failed to load supplier summary" });
    }
  },
);

// ==================== BLOCK 18: DELETE SUPPLIER LEDGER WITH PURCHASE ROLLBACK ====================
// Owner-only transaction supplier row ও related purchases lock করে। Purchase না থাকলে destructive action reject করে; থাকলে সব bill ids
// bulk helper-এ পাঠিয়ে sold serial/stock safetyসহ reverse/delete করে। Commit-এর পরে cache invalidate হয়; কোনো conflict হলে সব rollback হয়।
router.delete(
  "/suppliers/:supplierId/ledger",
  requireOwner,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const userId = getUserId(req);
      const supplierId = Number.parseInt(req.params.supplierId, 10);

      if (!Number.isInteger(supplierId) || supplierId <= 0) {
        return res.status(400).json({ error: "Invalid supplier selection." });
      }

      await client.query("BEGIN");

      const supplierResult = await client.query(
        `
          SELECT id, name
          FROM suppliers
          WHERE id = $1 AND user_id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [supplierId, userId],
      );

      if (!supplierResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Supplier not found." });
      }

      const purchasesResult = await client.query(
        `
          SELECT id
          FROM purchases
          WHERE user_id = $1
            AND supplier_id = $2
          ORDER BY id ASC
          FOR UPDATE
        `,
        [userId, supplierId],
      );

      if (!purchasesResult.rowCount) {
        await client.query("ROLLBACK");
        return res
          .status(404)
          .json({ error: "No purchases found for this supplier." });
      }

      const deletion = await deletePurchaseBillsWithStockRollback(
        client,
        userId,
        purchasesResult.rows.map((row) => row.id),
      );

      await client.query("COMMIT");
      invalidateUserCache(userId);

      res.json({
        success: true,
        message: "Supplier ledger deleted successfully.",
        supplier_id: supplierId,
        supplier_name: supplierResult.rows[0].name,
        deleted_count: deletion.deletedCount,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Supplier ledger delete rollback error:", rollbackError);
      }

      const message = String(error.message || "");
      if (
        message.startsWith("Cannot delete") ||
        message.startsWith("Stock item not found")
      ) {
        return res.status(400).json({ error: message });
      }

      console.error("Supplier ledger delete error:", error);
      res.status(500).json({ error: "Failed to delete supplier ledger" });
    } finally {
      client.release();
    }
  },
);

// ==================== BLOCK 19: SUPPLIER-SPECIFIC LEDGER DETAIL ====================
// Supplier ownership verify করে, date/pagination filters অনুযায়ী bills ও repayment history load করে এবং ledger totals/rows return করে।
// purchase_entry permission ও short cache supplier detail view-কে account-isolated রাখে এবং repeated browsing query কমায়।
router.get(
  "/suppliers/:supplierId/ledger",
  requirePermission("purchase_entry"),
  cacheJsonResponse({
    namespace: "business:supplier-ledger",
    ttlMs: 10 * 1000,
  }),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const supplierId = Number.parseInt(req.params.supplierId, 10);
      const pagination = parsePagination(req.query, 100, 500, {
        optional: true,
      });

      if (!Number.isInteger(supplierId) || supplierId <= 0) {
        return res.status(400).json({ error: "Invalid supplier selection." });
      }

      const supplierResult = await pool.query(
        `
        SELECT id, name, mobile_number, address
        FROM suppliers
        WHERE id = $1 AND user_id = $2
        LIMIT 1
      `,
        [supplierId, userId],
      );

      if (!supplierResult.rowCount) {
        return res.status(404).json({ error: "Supplier not found." });
      }

      const paginationClause = pagination.enabled
        ? `LIMIT ${pagination.limit} OFFSET ${pagination.offset}`
        : "";
      const countResult = pagination.enabled
        ? await pool.query(
            `
        SELECT COUNT(*)::int AS total
        FROM purchases p
        WHERE p.user_id = $1
          AND p.supplier_id = $2
      `,
            [userId, supplierId],
          )
        : null;

      const rows = await pool.query(
        `
        SELECT
          p.id,
          p.bill_no,
          p.purchase_date,
          p.subtotal,
          p.amount_paid,
          p.amount_due,
          p.payment_mode,
          p.payment_status,
          p.note,
          COUNT(pi.id)::int AS item_count
        FROM purchases p
        LEFT JOIN purchase_items pi
          ON pi.purchase_id = p.id
        WHERE p.user_id = $1
          AND p.supplier_id = $2
        GROUP BY p.id
        ORDER BY p.purchase_date DESC, p.id DESC
        ${paginationClause}
      `,
        [userId, supplierId],
      );

      const payload = {
        success: true,
        supplier: supplierResult.rows[0],
        ledger: rows.rows,
      };
      const paginationMeta = buildPaginationMeta(
        pagination,
        countResult?.rows[0]?.total,
        rows.rows.length,
      );
      if (paginationMeta) {
        payload.pagination = paginationMeta;
      }

      res.json(payload);
    } catch (error) {
      console.error("Supplier ledger detail error:", error);
      res.status(500).json({ error: "Failed to load supplier ledger" });
    }
  },
);

// ==================== BLOCK 20: CREATE EXPENSE ENTRY ====================
// expense_tracking permission-এর user title/category/positive amount/date/mode/note পাঠায়। Normalized validated values owner scope-এ insert হয়;
// mutation শেষে user cache invalidate করে saved row return করা হয়, যাতে expense report ও dashboard totals stale না থাকে।
router.post(
  "/expenses",
  requirePermission("expense_tracking"),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const title = normalizeDisplayText(req.body.title);
      const category = normalizeDisplayText(req.body.category);
      const amount = parsePositiveNumber(req.body.amount);
      const paymentMode = normalizePaymentMode(req.body.payment_mode, "cash");
      const expenseDate = parseDateInput(req.body.expense_date);
      const note = String(req.body.note || "").trim();

      if (!title) {
        return res.status(400).json({ error: "Expense title is required." });
      }

      if (!category) {
        return res.status(400).json({ error: "Expense category is required." });
      }

      if (amount === null) {
        return res
          .status(400)
          .json({ error: "Expense amount must be greater than zero." });
      }

      const result = await pool.query(
        `
        INSERT INTO expenses (
          user_id,
          title,
          category,
          amount,
          payment_mode,
          expense_date,
          note
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, title, category, amount, payment_mode, expense_date
      `,
        [
          userId,
          title,
          category,
          Number(amount.toFixed(2)),
          paymentMode,
          toIstStartTimestamp(expenseDate),
          note || null,
        ],
      );

      invalidateUserCache(userId);
      res.json({
        success: true,
        message: "Expense saved successfully.",
        expense: result.rows[0],
      });
    } catch (error) {
      console.error("Expense save error:", error);
      res.status(500).json({ error: "Failed to save expense" });
    }
  },
);

// ==================== BLOCK 21: EXPENSE AUTOCOMPLETE SUGGESTIONS ====================
// Owner-এর previous expense titles/categories থেকে normalized query matching suggestions আনে। Compact distinct values ও 15-second cache
// expense form typing দ্রুত রাখে; অন্য account-এর values userId filter-এর কারণে result-এ আসে না।
router.get(
  "/expenses/suggestions",
  requirePermission("expense_tracking"),
  cacheJsonResponse({
    namespace: "business:expense-suggestions",
    ttlMs: 15 * 1000,
  }),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const rawQuery = String(req.query.q || "").trim();

      if (!rawQuery) {
        return res.json([]);
      }

      const result = await pool.query(
        `
        SELECT value, type
        FROM (
          SELECT DISTINCT TRIM(e.title) AS value, 'Title' AS type, 1 AS sort_order
          FROM expenses e
          WHERE e.user_id = $1
            AND TRIM(COALESCE(e.title, '')) <> ''
            AND e.title ILIKE $2

          UNION

          SELECT DISTINCT TRIM(e.category) AS value, 'Category' AS type, 2 AS sort_order
          FROM expenses e
          WHERE e.user_id = $1
            AND TRIM(COALESCE(e.category, '')) <> ''
            AND e.category ILIKE $2
        ) suggestions
        ORDER BY sort_order ASC, value ASC
        LIMIT 12
      `,
        [userId, `%${rawQuery}%`],
      );

      res.json(result.rows);
    } catch (error) {
      console.error("Expense suggestions error:", error);
      res.status(500).json({ error: "Failed to load expense suggestions" });
    }
  },
);

// ==================== BLOCK 22: EXPENSE REPORT, SUMMARY ও PAGINATION ====================
// IST date range, text/category filters ও pagination দিয়ে expense rows আনে এবং matching records-এর aggregate summary হিসাব করে।
// buildPaginationMeta total/page/limit navigation দেয়; cached JSON report expense table ও KPI cards একই filtered dataset থেকে পূরণ করে।
router.get(
  "/expenses/report",
  requirePermission("expense_tracking"),
  cacheJsonResponse({ namespace: "business:expense-report", ttlMs: 10 * 1000 }),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const rawQuery = String(req.query.q || "").trim();
      const pagination = parsePagination(req.query, 100, 500, {
        optional: true,
      });
      const { fromDate, toDate, fromTimestamp, toTimestampExclusive } =
        toIstDateRange(req.query.from, req.query.to);

      const baseParams = [userId, fromTimestamp, toTimestampExclusive];
      let searchClause = "";

      if (rawQuery) {
        baseParams.push(`%${rawQuery}%`);
        searchClause = `
        AND (
          e.title ILIKE $4
          OR e.category ILIKE $4
          OR COALESCE(e.note, '') ILIKE $4
        )
      `;
      }

      const paginationClause = pagination.enabled
        ? `LIMIT ${pagination.limit} OFFSET ${pagination.offset}`
        : "";
      const countResult = pagination.enabled
        ? await pool.query(
            `
        SELECT COUNT(*)::int AS total
        FROM expenses e
        WHERE e.user_id = $1
          AND e.expense_date >= $2::timestamptz
          AND e.expense_date <= $3::timestamptz
          ${searchClause}
      `,
            baseParams,
          )
        : null;

      const rowsResult = await pool.query(
        `
        SELECT
          e.id,
          e.title,
          e.category,
          e.amount,
          e.payment_mode,
          e.expense_date,
          e.note
        FROM expenses e
        WHERE e.user_id = $1
          AND e.expense_date >= $2::timestamptz
          AND e.expense_date <= $3::timestamptz
          ${searchClause}
        ORDER BY e.expense_date DESC, e.id DESC
        ${paginationClause}
      `,
        baseParams,
      );

      const summaryParams = [userId, fromTimestamp, toTimestampExclusive];
      let summarySearchClause = "";

      if (rawQuery) {
        summaryParams.push(`%${rawQuery}%`);
        summarySearchClause = `
        AND (
          e.title ILIKE $4
          OR e.category ILIKE $4
          OR COALESCE(e.note, '') ILIKE $4
        )
      `;
      }

      const summaryResult = await pool.query(
        `
        WITH filtered_expenses AS (
          SELECT e.*
          FROM expenses e
          WHERE e.user_id = $1
            AND e.expense_date >= $2::timestamptz
            AND e.expense_date <= $3::timestamptz
            ${summarySearchClause}
        ),
        expense_totals AS (
          SELECT
            COALESCE(SUM(amount), 0) AS total_expense,
            COUNT(*)::int AS entry_count
          FROM filtered_expenses
        ),
        top_category AS (
          SELECT
            category,
            SUM(amount) AS total
          FROM filtered_expenses
          GROUP BY category
          ORDER BY SUM(amount) DESC, category ASC
          LIMIT 1
        ),
        gross_profit AS (
          SELECT
            COALESCE(SUM((selling_price - cost_price) * quantity), 0) AS gross_profit
          FROM sales
          WHERE user_id = $1
            AND created_at >= $2::timestamptz
            AND created_at <= $3::timestamptz
        )
        SELECT
          expense_totals.total_expense,
          expense_totals.entry_count,
          COALESCE(top_category.category, 'No expenses') AS top_category,
          COALESCE(top_category.total, 0) AS top_category_total,
          gross_profit.gross_profit
        FROM expense_totals
        CROSS JOIN gross_profit
        LEFT JOIN top_category ON TRUE
      `,
        summaryParams,
      );

      const summary = summaryResult.rows[0] || {};
      const totalExpense = Number(summary.total_expense) || 0;
      const grossProfit = Number(summary.gross_profit) || 0;

      const payload = {
        success: true,
        range: { from: fromDate, to: toDate },
        expenses: rowsResult.rows,
        summary: {
          entry_count: Number(summary.entry_count) || 0,
          total_expense: totalExpense,
          top_category: summary.top_category || "No expenses",
          top_category_total: Number(summary.top_category_total) || 0,
          gross_profit: grossProfit,
          net_profit: Number((grossProfit - totalExpense).toFixed(2)),
        },
      };
      const paginationMeta = buildPaginationMeta(
        pagination,
        countResult?.rows[0]?.total,
        rowsResult.rows.length,
      );
      if (paginationMeta) {
        payload.pagination = paginationMeta;
      }

      res.json(payload);
    } catch (error) {
      console.error("Expense report error:", error);
      res.status(500).json({ error: "Failed to load expense report" });
    }
  },
);

// ==================== BLOCK 23: PUBLIC ROUTER EXPORT ====================
// CommonJS export configured authenticated business router-কে server application-এর business API base path-এ mount করার সুযোগ দেয়।
module.exports = router;
