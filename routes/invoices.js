/**
 * =========================================================
 * FILE: routes/invoices.js
 * PURPOSE: SALES INVOICE, PAYMENT SETTLEMENT, PDF ও SHOP PROFILE ROUTES
 * =========================================================
 * এই router নতুন invoice number তৈরি, sale invoice save, stock/serial deduction, customer due ledger,
 * invoice search/detail, later payment collection, PDF generation এবং invoice-facing shop settings পরিচালনা করে।
 * Invoice writes transaction ও scoped locks ব্যবহার করে; retryable PostgreSQL conflicts সীমিত retry পায়।
 * PDF-এর UPI QR matrix এই file-এর internal encoder দিয়ে তৈরি হয়, কোনো remote QR service-এ payment data পাঠানো হয় না।
 */

// routes/invoices.js

// ==================== BLOCK 01: DEPENDENCIES ও SHARED INFRASTRUCTURE ====================
// Express routes, PDFKit rendering ও database pool load করে। Auth/permission helpers account access enforce করে; concurrency helpers
// normalized item/serial keys ও scoped locks দেয়; cache/pagination helpers read endpoints দ্রুত ও bounded রাখে।
const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
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
const { parsePagination } = require("../utils/pagination");

// ==================== BLOCK 02: BASIC INPUT, NUMBER, MOBILE ও SERIAL HELPERS ====================
// Invoice suffix zero-pad করে; positive/non-zero/non-negative parsers invalid numeric input reject করে; mobile Indian prefix পরিষ্কার করে।
// Serial parser display/key normalize করে, blank বাদ দেয় এবং একই invoice payload-এর case-insensitive duplicate serial আটকায়।
/* ---------------------- Helper: pad serial ---------------------- */
function padSerial(n) {
  return String(n).padStart(4, "0");
}

function parsePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNonZeroNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
}

function parseNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
      throw new Error(`Duplicate serial number in this invoice: ${serialNo}`);
    }

    seen.add(serialKey);
    serials.push({ serialNo, serialKey });
  });

  return serials;
}

// ==================== BLOCK 03: PAYMENT MODES ও QR ENCODER TABLES ====================
// Invoice payment mode allow-list invalid input-এ cash fallback দেয়। QR lookup tables version 1–10 low-error-correction capacity,
// Reed-Solomon block layout এবং alignment pattern positions নির্ধারণ করে; generated UPI payload-এর maximum size সীমিত থাকে।
const INVOICE_PAYMENT_MODES = new Set(["cash", "upi", "bank", "mixed"]);

const QR_MAX_VERSION = 10;
const QR_TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const QR_ECC_CODEWORDS_PER_BLOCK_LOW = [
  0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18,
];
const QR_BLOCK_COUNT_LOW = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
const QR_ALIGNMENT_PATTERN_POSITIONS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

function normalizeInvoicePaymentMode(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return INVOICE_PAYMENT_MODES.has(normalized) ? normalized : "cash";
}

// ==================== BLOCK 04: QR BITSTREAM ও ERROR CORRECTION ====================
// Byte-mode payload bits, version capacity ও padding codewords তৈরি করে। GF(256) multiply এবং Reed-Solomon divisor/remainder functions
// error-correction bytes বানায়; block interleaving QR decoder-কে damaged modules থেকেও payload recover করতে সাহায্য করে।
function appendQrBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) {
    bits.push(((value >>> i) & 1) !== 0);
  }
}

function getQrDataCodewordCount(version) {
  return (
    QR_TOTAL_CODEWORDS[version] -
    QR_ECC_CODEWORDS_PER_BLOCK_LOW[version] * QR_BLOCK_COUNT_LOW[version]
  );
}

function getQrByteCapacity(version) {
  const charCountBits = version < 10 ? 8 : 16;
  return Math.floor(
    (getQrDataCodewordCount(version) * 8 - 4 - charCountBits) / 8,
  );
}

function findQrVersion(byteLength) {
  for (let version = 1; version <= QR_MAX_VERSION; version++) {
    if (byteLength <= getQrByteCapacity(version)) {
      return version;
    }
  }
  throw new Error("UPI QR payload is too long");
}

function qrGfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function qrReedSolomonDivisor(degree) {
  const result = Array(degree).fill(0);
  result[degree - 1] = 1;

  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = qrGfMultiply(result[j], root);
      if (j + 1 < degree) {
        result[j] ^= result[j + 1];
      }
    }
    root = qrGfMultiply(root, 0x02);
  }

  return result;
}

function qrReedSolomonRemainder(data, divisor) {
  const result = Array(divisor.length).fill(0);

  data.forEach((byte) => {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, index) => {
      result[index] ^= qrGfMultiply(coefficient, factor);
    });
  });

  return result;
}

function addQrErrorCorrection(version, dataCodewords) {
  const blockCount = QR_BLOCK_COUNT_LOW[version];
  const eccLength = QR_ECC_CODEWORDS_PER_BLOCK_LOW[version];
  const rawCodewords = QR_TOTAL_CODEWORDS[version];
  const shortBlockCount = blockCount - (rawCodewords % blockCount);
  const shortBlockLength = Math.floor(rawCodewords / blockCount);
  const divisor = qrReedSolomonDivisor(eccLength);
  const blocks = [];
  let offset = 0;

  for (let i = 0; i < blockCount; i++) {
    const dataLength =
      shortBlockLength - eccLength + (i >= shortBlockCount ? 1 : 0);
    const data = dataCodewords.slice(offset, offset + dataLength);
    offset += dataLength;
    blocks.push({
      data,
      ecc: qrReedSolomonRemainder(data, divisor),
    });
  }

  const result = [];
  const maxDataLength = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < maxDataLength; i++) {
    blocks.forEach((block) => {
      if (i < block.data.length) {
        result.push(block.data[i]);
      }
    });
  }

  for (let i = 0; i < eccLength; i++) {
    blocks.forEach((block) => result.push(block.ecc[i]));
  }

  return result;
}

// ==================== BLOCK 05: QR MASK, FORMAT ও VERSION METADATA ====================
// Module coordinates-এর mask bit, BCH-protected format bits এবং larger-version metadata হিসাব করে। Current encoder mask 0 ব্যবহার করে;
// format/version information scanner-কে matrix layout ও error-correction interpretation জানায়।
function getQrMaskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    default:
      return false;
  }
}

function getQrFormatBits(mask) {
  const data = (1 << 3) | mask;
  let remainder = data;

  for (let i = 0; i < 10; i++) {
    remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  }

  return ((data << 10) | remainder) ^ 0x5412;
}

function getQrVersionBits(version) {
  let remainder = version;

  for (let i = 0; i < 12; i++) {
    remainder = (remainder << 1) ^ (((remainder >>> 11) & 1) * 0x1f25);
  }

  return (version << 12) | remainder;
}

// ==================== BLOCK 06: COMPLETE QR MATRIX GENERATION ====================
// UTF-8 UPI URI-এর smallest supported version বেছে data/error-correction codewords বানায়। Finder, timing, alignment, format ও version
// function modules আগে আঁকে; তারপর remaining cells-এ masked data zig-zag order-এ বসিয়ে boolean matrix return করে।
function createQrCodeMatrix(text) {
  const bytes = Array.from(Buffer.from(String(text), "utf8"));
  const version = findQrVersion(bytes.length);
  const size = version * 4 + 17;
  const dataCodewordCount = getQrDataCodewordCount(version);
  const charCountBits = version < 10 ? 8 : 16;
  const bits = [];

  appendQrBits(bits, 0x4, 4);
  appendQrBits(bits, bytes.length, charCountBits);
  bytes.forEach((byte) => appendQrBits(bits, byte, 8));

  const capacityBits = dataCodewordCount * 8;
  appendQrBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) {
    bits.push(false);
  }

  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) {
      value = (value << 1) | (bits[i + j] ? 1 : 0);
    }
    dataCodewords.push(value);
  }

  for (
    let padByte = 0xec;
    dataCodewords.length < dataCodewordCount;
    padByte ^= 0xfd
  ) {
    dataCodewords.push(padByte);
  }

  const codewords = addQrErrorCorrection(version, dataCodewords);
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () =>
    Array(size).fill(false),
  );
  const mask = 0;

  const setFunctionModule = (x, y, dark) => {
    if (x >= 0 && y >= 0 && x < size && y < size) {
      modules[y][x] = Boolean(dark);
      isFunction[y][x] = true;
    }
  };

  const drawFinderPattern = (left, top) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = left + dx;
        const y = top + dy;
        const dark =
          dx >= 0 &&
          dx <= 6 &&
          dy >= 0 &&
          dy <= 6 &&
          (dx === 0 ||
            dx === 6 ||
            dy === 0 ||
            dy === 6 ||
            (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        setFunctionModule(x, y, dark);
      }
    }
  };

  const drawAlignmentPattern = (centerX, centerY) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFunctionModule(
          centerX + dx,
          centerY + dy,
          Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
        );
      }
    }
  };

  const drawFormatBits = () => {
    const formatBits = getQrFormatBits(mask);
    const bit = (index) => ((formatBits >>> index) & 1) !== 0;

    for (let i = 0; i <= 5; i++) {
      setFunctionModule(8, i, bit(i));
    }
    setFunctionModule(8, 7, bit(6));
    setFunctionModule(8, 8, bit(7));
    setFunctionModule(7, 8, bit(8));
    for (let i = 9; i < 15; i++) {
      setFunctionModule(14 - i, 8, bit(i));
    }

    for (let i = 0; i < 8; i++) {
      setFunctionModule(size - 1 - i, 8, bit(i));
    }
    for (let i = 8; i < 15; i++) {
      setFunctionModule(8, size - 15 + i, bit(i));
    }
    setFunctionModule(8, size - 8, true);
  };

  const drawVersionBits = () => {
    if (version < 7) {
      return;
    }

    const versionBits = getQrVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((versionBits >>> i) & 1) !== 0;
      const x = size - 11 + (i % 3);
      const y = Math.floor(i / 3);
      setFunctionModule(x, y, dark);
      setFunctionModule(y, x, dark);
    }
  };

  drawFinderPattern(0, 0);
  drawFinderPattern(size - 7, 0);
  drawFinderPattern(0, size - 7);

  QR_ALIGNMENT_PATTERN_POSITIONS[version].forEach((x) => {
    QR_ALIGNMENT_PATTERN_POSITIONS[version].forEach((y) => {
      const overlapsFinder =
        (x === 6 && y === 6) ||
        (x === 6 && y === size - 7) ||
        (x === size - 7 && y === 6);
      if (!overlapsFinder) {
        drawAlignmentPattern(x, y);
      }
    });
  });

  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setFunctionModule(i, 6, dark);
    setFunctionModule(6, i, dark);
  }

  drawFormatBits();
  drawVersionBits();

  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }

    for (let vertical = 0; vertical < size; vertical++) {
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? size - 1 - vertical : vertical;

      for (let column = 0; column < 2; column++) {
        const x = right - column;
        if (isFunction[y][x]) {
          continue;
        }

        let dark = false;
        if (bitIndex < totalBits) {
          dark =
            ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex++;
        }

        modules[y][x] = dark !== getQrMaskBit(mask, x, y);
      }
    }
  }

  if (bitIndex !== totalBits) {
    throw new Error("UPI QR payload could not be encoded");
  }

  return modules;
}

// ==================== BLOCK 07: UPI URI ও GST CALCULATION ====================
// Valid UPI id থাকলে payee address/name encoded `upi://pay` URI বানায়; blank id-এ empty string দেয় যাতে PDF QR block skip করতে পারে।
// Sale GST helper base amount ও non-negative rate থেকে two-decimal tax amount তৈরি করে।
function buildUpiPaymentUri(upiId, payeeName) {
  const normalizedUpiId = normalizeDisplayText(upiId);
  if (!normalizedUpiId) {
    return "";
  }

  const normalizedPayee = normalizeDisplayText(payeeName) || "Invoice Payment";
  return [
    "upi://pay?pa=",
    encodeURIComponent(normalizedUpiId),
    "&pn=",
    encodeURIComponent(normalizedPayee),
    "&cu=INR",
  ].join("");
}

function calculateSaleGstAmount(baseAmount, gstRate) {
  const normalizedBaseAmount = Number(baseAmount) || 0;
  const normalizedGstRate = Number(gstRate) || 0;
  return Number(((normalizedBaseAmount * normalizedGstRate) / 100).toFixed(2));
}

// ==================== BLOCK 08: INITIAL INVOICE PAYMENT SNAPSHOT ====================
// Grand total, optional paid input ও mode থেকে bounded amountPaid/amountDue এবং paid/partial/due state বানায়। Blank paid value full payment,
// explicit value total-এর মধ্যে clamp হয়; due amount numeric roundingসহ consistent থাকে।
function buildInvoicePaymentSnapshot(
  totalAmount,
  amountPaidInput,
  paymentModeInput,
) {
  const normalizedTotal = Number(totalAmount) || 0;

  if (normalizedTotal <= 0) {
    return {
      amountPaid: 0,
      amountDue: 0,
      paymentMode: normalizeInvoicePaymentMode(paymentModeInput),
      paymentStatus: "return",
    };
  }

  const normalizedPaid = parseNonNegativeNumber(amountPaidInput);
  const amountPaid = Number(
    Math.min(
      Math.max(normalizedPaid === null ? normalizedTotal : normalizedPaid, 0),
      normalizedTotal,
    ).toFixed(2),
  );
  const amountDue = Number((normalizedTotal - amountPaid).toFixed(2));

  let paymentStatus = "paid";
  if (amountDue > 0 && amountPaid > 0) {
    paymentStatus = "partial";
  } else if (amountDue > 0) {
    paymentStatus = "due";
  }

  return {
    amountPaid,
    amountDue,
    paymentMode: normalizeInvoicePaymentMode(paymentModeInput),
    paymentStatus,
  };
}

// ==================== BLOCK 09: LATER PAYMENT SETTLEMENT SNAPSHOT ====================
// Existing paid/due-এর সঙ্গে positive collection যোগ করে total-এর মধ্যে cap করে এবং next paid/due/status return করে। Caller এই normalized
// snapshot invoice row ও linked debt credit entry একই transaction-এ update করতে ব্যবহার করে।
function buildInvoiceSettlementSnapshot(
  invoiceRow,
  paymentAmountInput,
  paymentModeInput,
) {
  const currentPaid = Number(invoiceRow?.amount_paid || 0);
  const currentDue = Number(invoiceRow?.amount_due || 0);
  const amountInput = parsePositiveNumber(paymentAmountInput);

  if (amountInput === null) {
    throw new Error("Payment amount must be greater than zero.");
  }

  if (currentDue <= 0) {
    throw new Error("This invoice is already fully paid.");
  }

  if (amountInput - currentDue > 0.009) {
    throw new Error(
      "Payment amount cannot be greater than the outstanding due.",
    );
  }

  const nextAmountPaid = Number((currentPaid + amountInput).toFixed(2));
  const remainingDue = Number((currentDue - amountInput).toFixed(2));
  const nextAmountDue = remainingDue <= 0.009 ? 0 : remainingDue;
  const incomingMode = normalizeInvoicePaymentMode(paymentModeInput);
  const currentMode = normalizeInvoicePaymentMode(invoiceRow?.payment_mode);

  return {
    amountReceived: Number(amountInput.toFixed(2)),
    amountPaid: nextAmountPaid,
    amountDue: nextAmountDue,
    paymentStatus: nextAmountDue > 0 ? "partial" : "paid",
    paymentMode:
      currentPaid <= 0 || currentMode === incomingMode ? incomingMode : "mixed",
  };
}

// ==================== BLOCK 10: RETRYABLE DATABASE CONFLICTS ও INVOICE NUMBER GENERATION ====================
// Unique collision, serialization failure ও deadlock codes limited invoice-write retry পায়। Invoice number generator user/date scoped lock নেয়,
// current day's highest suffix পড়ে এবং date prefixসহ next padded number বানায়, যাতে concurrent requests duplicate number না পায়।
const RETRYABLE_INVOICE_PG_CODES = new Set(["23505", "40001", "40P01"]);

function isRetryableInvoiceWriteError(error) {
  if (!error || !RETRYABLE_INVOICE_PG_CODES.has(error.code)) {
    return false;
  }

  if (error.code !== "23505") {
    return true;
  }

  const constraint = String(error.constraint || "").toLowerCase();
  const detail = String(error.detail || "").toLowerCase();
  const message = String(error.message || "").toLowerCase();

  return (
    constraint.includes("invoice_no") ||
    detail.includes("invoice_no") ||
    message.includes("invoice_no")
  );
}

/* ---------------------- Generate Invoice No ---------------------- */
async function generateInvoiceNoWithClient(client, userId) {
  const todayDate = new Date()
    .toLocaleString("en-CA", { timeZone: "Asia/Kolkata" })
    .slice(0, 10);

  const dateKey = todayDate;
  const datePart = todayDate.replace(/-/g, "");

  const q = `
      INSERT INTO user_invoice_counter (user_id, date_key, next_no)
      VALUES ($1, $2, 2)
      ON CONFLICT (user_id, date_key)
      DO UPDATE SET next_no = user_invoice_counter.next_no + 1
      RETURNING next_no;
    `;

  const r = await client.query(q, [userId, dateKey]);
  const assignedSerial = Number(r.rows[0].next_no) - 1;
  const seqStr = padSerial(assignedSerial);

  return {
    invoiceNo: `INV-${datePart}-${userId}-${seqStr}`,
    dateKey,
  };
}

/*
 * =========================================================
 * BLOCK 11: পরবর্তী invoice number-এর preview
 * =========================================================
 * Login করা এবং `sale_invoice` permission থাকা user-এর আজকের counter পড়ে সম্ভাব্য পরবর্তী invoice number দেখায়।
 * এটি counter বাড়ায় না; তাই preview দেখার পর অন্য request invoice save করলে চূড়ান্ত number আলাদা হতে পারে।
 * Asia/Kolkata date, user id এবং zero-padded daily serial মিলিয়ে `INV-YYYYMMDD-userId-serial` format তৈরি হয়।
 */
router.get(
  "/invoices/new",
  authMiddleware,
  requirePermission("sale_invoice"),
  async (req, res) => {
    const userId = getUserId(req);
    const client = await pool.connect();
    try {
      const todayDate = new Date()
        .toLocaleString("en-CA", { timeZone: "Asia/Kolkata" })
        .slice(0, 10);

      const datePart = todayDate.replace(/-/g, "");
      const q = `SELECT next_no FROM user_invoice_counter WHERE user_id=$1 AND date_key=$2`;
      const r = await client.query(q, [userId, todayDate]);
      const nextNo = r.rowCount ? r.rows[0].next_no : 1;

      res.json({
        success: true,
        invoice_no: `INV-${datePart}-${userId}-${padSerial(nextNo)}`,
        date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      });
    } catch (err) {
      res.status(500).json({ success: false });
    } finally {
      client.release();
    }
  },
);

/*
 * =========================================================
 * BLOCK 12: নতুন sale invoice save করার মূল transaction
 * =========================================================
 * Body থেকে customer, item ও payment data নিয়ে একটি atomic database transaction-এ invoice তৈরি করে।
 * প্রতিটি item validate হয়, serial ও stock row lock হয়, invoice/items/sales/debt ledger লেখা হয় এবং stock কমে।
 * কোনো ধাপ ব্যর্থ হলে পুরো transaction rollback হয়; invoice-number conflict বা deadlock-এর মতো retryable error সর্বোচ্চ তিনবার চেষ্টা করে।
 */
router.post(
  "/invoices",
  authMiddleware,
  requirePermission("sale_invoice"),
  async (req, res) => {
    const userId = getUserId(req);
    const {
      customer_name,
      contact,
      address,
      gst_no,
      items,
      payment_mode,
      amount_paid,
    } = req.body;

    // অন্তত একটি sale line ছাড়া invoice অর্থপূর্ণ নয়, তাই database connection নেওয়ার আগেই request reject করা হয়।
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: "No items" });
    }

    const client = await pool.connect();
    let lastRetryableError = null;
    try {
      // একই client ব্যবহার করে retry loop চলে; প্রতিটি attempt নিজস্ব BEGIN/COMMIT বা ROLLBACK পায়।
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await client.query("BEGIN");

          /* PHASE A: transaction-এর ভেতরে daily counter reserve করে unique invoice number এবং customer-এর normalized value তৈরি। */
          const { invoiceNo } = await generateInvoiceNoWithClient(
            client,
            userId,
          );
          const customerName = normalizeDisplayText(customer_name) || null;
          const customerContact = normalizeMobileNumber(contact);
          const customerAddress = String(address || "").trim() || null;
          const trimmedGstNo = String(gst_no || "").trim() || null;

          /* PHASE B: প্রতিটি invoice line-এর description, quantity, rate ও optional serial list validate করে internal working object বানানো। */
          const computed = items.map((item, index) => {
            const description = normalizeDisplayText(item.description);
            const q = parseNonZeroNumber(item.quantity);
            const serialNumbers = parseSerialNumbers(
              item.serial_numbers ?? item.serials ?? item.serial_no_text,
            );
            const r = serialNumbers.length
              ? (parseNonNegativeNumber(item.rate) ?? 0)
              : parsePositiveNumber(item.rate);

            if (
              !description ||
              q === null ||
              (!serialNumbers.length && r === null)
            ) {
              throw new Error(`Invalid invoice item at line ${index + 1}`);
            }

            if (serialNumbers.length) {
              if (q <= 0 || !Number.isInteger(q)) {
                throw new Error(
                  `Serial-tracked sale quantity must be a whole positive number at line ${index + 1}`,
                );
              }

              if (serialNumbers.length !== q) {
                throw new Error(
                  `Serial number count must match quantity at line ${index + 1}`,
                );
              }
            }

            return {
              description,
              lookupKey: normalizeLookupText(description),
              quantity: q,
              rate: r,
              amount: 0,
              serialNumbers,
              serialRows: [],
            };
          });

          /* PHASE C: পুরো invoice জুড়ে duplicate serial আটকানো এবং stable order-এ advisory lock নিয়ে concurrent sale প্রতিরোধ। */
          const allSerials = [];
          const seenSerialKeys = new Set();
          computed.forEach((line) => {
            line.serialNumbers.forEach((serial) => {
              if (seenSerialKeys.has(serial.serialKey)) {
                throw new Error(
                  `Duplicate serial number in this invoice: ${serial.serialNo}`,
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

          /* PHASE D: serial-tracked item হলে serial row lock করে ownership, stock status এবং item-name matching যাচাই। */
          if (allSerials.length) {
            const serialResult = await client.query(
              `
              SELECT
                s.id,
                s.item_id,
                s.serial_no,
                s.serial_no_norm,
                s.sale_rate,
                s.status,
                i.name AS item_name,
                LOWER(TRIM(i.name)) AS item_lookup_key
              FROM item_serials s
              JOIN items i
                ON i.id = s.item_id
              WHERE s.user_id = $1
                AND i.user_id = $1
                AND s.serial_no_norm = ANY($2::text[])
              FOR UPDATE OF s
            `,
              [userId, allSerials.map((serial) => serial.serialKey)],
            );
            const serialRowsByKey = new Map(
              serialResult.rows.map((row) => [row.serial_no_norm, row]),
            );

            computed.forEach((line, index) => {
              line.serialRows = line.serialNumbers.map((serial) => {
                const row = serialRowsByKey.get(serial.serialKey);
                if (!row) {
                  throw new Error(
                    `Serial number not found: ${serial.serialNo}`,
                  );
                }

                if (row.status !== "in_stock") {
                  throw new Error(
                    `Serial number already sold: ${row.serial_no}`,
                  );
                }

                if (row.item_lookup_key !== line.lookupKey) {
                  throw new Error(
                    `Serial number ${row.serial_no} does not belong to ${line.description} at line ${index + 1}`,
                  );
                }

                return row;
              });
            });
          }

          /* PHASE E: line amount/subtotal হিসাব এবং একই product-এর মোট প্রয়োজনীয় quantity group করা। */
          let subtotal = 0;
          computed.forEach((line) => {
            line.amount = +(line.quantity * line.rate).toFixed(2);
            subtotal += line.amount;
          });
          subtotal = +subtotal.toFixed(2);

          const groupedStockNeed = new Map();
          computed.forEach((line) => {
            const existing = groupedStockNeed.get(line.lookupKey) || {
              description: line.description,
              quantity: 0,
            };
            existing.quantity += line.quantity;
            groupedStockNeed.set(line.lookupKey, existing);
          });

          /* PHASE F: সংশ্লিষ্ট inventory rows deterministic order-এ lock করে মোট available stock যথেষ্ট কি না যাচাই। */
          const lockedStockByKey = new Map();
          for (const lookupKey of Array.from(groupedStockNeed.keys()).sort()) {
            const requirement = groupedStockNeed.get(lookupKey);
            const itemRows = await client.query(
              `
              SELECT id, name, quantity, buying_rate
              FROM items
              WHERE user_id = $1 AND LOWER(TRIM(name)) = $2
              ORDER BY id ASC
              FOR UPDATE
            `,
              [userId, lookupKey],
            );

            if (!itemRows.rowCount) {
              throw new Error(`Item not found: ${requirement.description}`);
            }

            const stockRows = itemRows.rows.map((row) => ({
              id: row.id,
              name: row.name,
              available: Number(row.quantity || 0),
              costPrice: Number(row.buying_rate || 0),
            }));
            const totalAvailable = stockRows.reduce(
              (sum, row) => sum + row.available,
              0,
            );

            if (
              requirement.quantity > 0 &&
              totalAvailable < requirement.quantity
            ) {
              throw new Error(
                `Stock not sufficient for ${requirement.description}. Available: ${totalAvailable}`,
              );
            }

            lockedStockByKey.set(lookupKey, stockRows);
          }

          /* PHASE G: shop GST rate দিয়ে tax/total এবং initial paid/due/payment-status snapshot তৈরি। */
          const gstR = await client.query(
            `SELECT gst_rate FROM settings WHERE user_id=$1`,
            [userId],
          );
          const gstRate = Number(gstR.rows[0]?.gst_rate || 18);
          const gst_amount = +((subtotal * gstRate) / 100).toFixed(2);
          const total_amount = +(subtotal + gst_amount).toFixed(2);
          computed.forEach((item) => {
            item.gstAmount = calculateSaleGstAmount(item.amount, gstRate);
          });
          const payment = buildInvoicePaymentSnapshot(
            total_amount,
            amount_paid,
            payment_mode,
          );

          if (payment.amountDue > 0 && !/^\d{10}$/.test(customerContact)) {
            throw new Error(
              "A valid 10-digit contact number is required for partial or due invoices.",
            );
          }

          /* PHASE H: validated header ও payment summary `invoices` table-এ লিখে নতুন invoice id নেওয়া। */
          const inv = await client.query(
            `
              INSERT INTO invoices
              (
                invoice_no,
                user_id,
                gst_no,
                customer_name,
                contact,
                address,
                subtotal,
                gst_amount,
                total_amount,
                payment_mode,
                payment_status,
                amount_paid,
                amount_due,
                date
              )
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
              RETURNING id
            `,
            [
              invoiceNo,
              userId,
              trimmedGstNo,
              customerName,
              customerContact || null,
              customerAddress,
              subtotal,
              gst_amount,
              total_amount,
              payment.paymentMode,
              payment.paymentStatus,
              payment.amountPaid,
              payment.amountDue,
              new Date(),
            ],
          );

          const invoiceId = inv.rows[0].id;

          /*
           * PHASE I: প্রতিটি line `invoice_items`-এ লেখা এবং FIFO-style locked stock rows থেকে sale allocate করা।
           * Serial item-এর serial status sold হয়; negative quantity return হিসেবে stock বাড়ায়; প্রতিটি allocation `sales` audit row তৈরি করে।
           */
          const stockAdjustments = new Map();
          for (const it of computed) {
            const invoiceItemResult = await client.query(
              `
                  INSERT INTO invoice_items
                  (invoice_id,description,quantity,rate,amount)
                  VALUES ($1,$2,$3,$4,$5)
                  RETURNING id
            `,
              [invoiceId, it.description, it.quantity, it.rate, it.amount],
            );
            const invoiceItemId = invoiceItemResult.rows[0].id;

            const stockRows = lockedStockByKey.get(it.lookupKey) || [];

            if (it.serialRows.length) {
              let allocatedGstAmount = 0;
              const serialGroups = new Map();

              it.serialRows.forEach((serialRow) => {
                const current = serialGroups.get(serialRow.item_id) || [];
                current.push(serialRow);
                serialGroups.set(serialRow.item_id, current);
              });

              const sortedSerialGroups = Array.from(
                serialGroups.entries(),
              ).sort(([leftItemId], [rightItemId]) => leftItemId - rightItemId);

              for (
                let groupIndex = 0;
                groupIndex < sortedSerialGroups.length;
                groupIndex += 1
              ) {
                const [itemId, serialRows] = sortedSerialGroups[groupIndex];
                const stockRow = stockRows.find((row) => row.id === itemId);
                const consumedQty = serialRows.length;

                if (!stockRow || stockRow.available < consumedQty) {
                  throw new Error(
                    `Stock allocation failed for ${it.description}`,
                  );
                }

                stockRow.available -= consumedQty;
                const saleBaseAmount = +(consumedQty * it.rate).toFixed(2);
                const isLastSplit =
                  groupIndex === sortedSerialGroups.length - 1;
                const saleGstAmount = isLastSplit
                  ? Number((it.gstAmount - allocatedGstAmount).toFixed(2))
                  : calculateSaleGstAmount(saleBaseAmount, gstRate);
                allocatedGstAmount = Number(
                  (allocatedGstAmount + saleGstAmount).toFixed(2),
                );

                stockAdjustments.set(
                  stockRow.id,
                  (stockAdjustments.get(stockRow.id) || 0) + consumedQty,
                );

                const saleResult = await client.query(
                  `
                    INSERT INTO sales
                    (user_id, item_id, quantity, cost_price, selling_price, total_price, gst_amount)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    RETURNING id
                    `,
                  [
                    userId,
                    stockRow.id,
                    consumedQty,
                    stockRow.costPrice,
                    it.rate,
                    saleBaseAmount,
                    saleGstAmount,
                  ],
                );

                const serialUpdate = await client.query(
                  `
                  UPDATE item_serials
                  SET
                    status = 'sold',
                    invoice_id = $1,
                    invoice_item_id = $2,
                    sale_id = $3,
                    sold_at = NOW()
                  WHERE user_id = $4
                    AND id = ANY($5::int[])
                    AND status = 'in_stock'
                `,
                  [
                    invoiceId,
                    invoiceItemId,
                    saleResult.rows[0].id,
                    userId,
                    serialRows.map((row) => row.id),
                  ],
                );

                if (serialUpdate.rowCount !== serialRows.length) {
                  throw new Error(
                    `Serial stock allocation failed for ${it.description}`,
                  );
                }
              }

              continue;
            }

            if (it.quantity < 0) {
              const targetStockRow = stockRows[0];
              const returnedQty = Math.abs(it.quantity);

              if (!targetStockRow) {
                throw new Error(
                  `Stock allocation failed for ${it.description}`,
                );
              }

              targetStockRow.available += returnedQty;
              stockAdjustments.set(
                targetStockRow.id,
                (stockAdjustments.get(targetStockRow.id) || 0) - returnedQty,
              );

              const saleBaseAmount = +(-returnedQty * it.rate).toFixed(2);

              await client.query(
                `
                    INSERT INTO sales
                    (user_id, item_id, quantity, cost_price, selling_price, total_price, gst_amount)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    `,
                [
                  userId,
                  targetStockRow.id,
                  -returnedQty,
                  targetStockRow.costPrice,
                  it.rate,
                  saleBaseAmount,
                  it.gstAmount,
                ],
              );

              continue;
            }

            let remainingQty = it.quantity;
            let allocatedGstAmount = 0;

            for (const stockRow of stockRows) {
              if (remainingQty <= 0) {
                break;
              }

              if (stockRow.available <= 0) {
                continue;
              }

              const consumedQty = Math.min(remainingQty, stockRow.available);
              stockRow.available -= consumedQty;
              remainingQty -= consumedQty;
              const saleBaseAmount = +(consumedQty * it.rate).toFixed(2);
              const isLastSplit = remainingQty <= 0;
              const saleGstAmount = isLastSplit
                ? Number((it.gstAmount - allocatedGstAmount).toFixed(2))
                : calculateSaleGstAmount(saleBaseAmount, gstRate);
              allocatedGstAmount = Number(
                (allocatedGstAmount + saleGstAmount).toFixed(2),
              );

              stockAdjustments.set(
                stockRow.id,
                (stockAdjustments.get(stockRow.id) || 0) + consumedQty,
              );

              await client.query(
                `
                    INSERT INTO sales
                    (user_id, item_id, quantity, cost_price, selling_price, total_price, gst_amount)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    `,
                [
                  userId,
                  stockRow.id,
                  consumedQty,
                  stockRow.costPrice,
                  it.rate,
                  saleBaseAmount,
                  saleGstAmount,
                ],
              );
            }

            if (remainingQty > 0) {
              throw new Error(`Stock allocation failed for ${it.description}`);
            }
          }

          /* PHASE J: জমা করা per-item adjustment একবারে মূল `items.quantity`-তে প্রয়োগ করে stock final করা। */
          for (const [itemId, deductedQty] of stockAdjustments.entries()) {
            await client.query(
              `
              UPDATE items
              SET quantity = quantity - $1, updated_at = NOW()
              WHERE id = $2 AND user_id = $3
            `,
              [deductedQty, itemId, userId],
            );
          }

          /* PHASE K: টাকা বাকি থাকলে customer debt ledger-এ invoice opening entry লেখা হয়। */
          if (payment.amountDue > 0) {
            await client.query(
              `
              INSERT INTO debts (
                user_id,
                invoice_id,
                customer_name,
                customer_number,
                customer_address,
                total,
                credit,
                remark
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `,
              [
                userId,
                invoiceId,
                customerName || `Customer ${customerContact}`,
                customerContact,
                customerAddress,
                total_amount,
                payment.amountPaid,
                `Invoice ${invoiceNo} | ${payment.paymentStatus} via ${payment.paymentMode}`,
              ],
            );
          }

          /* PHASE L: সব write সফল হলে commit, user cache invalidate এবং frontend-কে final invoice/payment summary পাঠানো। */
          await client.query("COMMIT");
          invalidateUserCache(userId);
          return res.json({
            success: true,
            invoice_no: invoiceNo,
            date: new Date().toISOString(),
            payment_status: payment.paymentStatus,
            amount_due: payment.amountDue,
          });
        } catch (err) {
          // Current attempt-এর আংশিক পরিবর্তন বাতিল করে retryable conflict retry করা হয়; validation error 400 এবং exhausted conflict 409 দেয়।
          await client.query("ROLLBACK");

          if (isRetryableInvoiceWriteError(err) && attempt < 3) {
            lastRetryableError = err;
            continue;
          }

          if (
            err.message.includes("Stock not sufficient") ||
            err.message.includes("Item not found") ||
            err.message.includes("Invalid invoice item") ||
            err.message.includes("Stock allocation failed") ||
            err.message.includes("Serial") ||
            err.message.includes("serial") ||
            err.message.includes("Duplicate") ||
            err.message.includes("contact number is required")
          ) {
            return res
              .status(400)
              .json({ success: false, message: err.message });
          }

          if (isRetryableInvoiceWriteError(err)) {
            return res.status(409).json({
              success: false,
              message:
                "Could not reserve a unique invoice number. Please try again.",
            });
          }

          return res
            .status(500)
            .json({ success: false, message: "Server error" });
        }
      }

      if (lastRetryableError) {
        return res.status(409).json({
          success: false,
          message:
            "Could not reserve a unique invoice number. Please try again.",
        });
      }
    } finally {
      client.release();
    }
  },
);

/*
 * =========================================================
 * BLOCK 13: invoice search suggestion
 * =========================================================
 * Search box-এর text দিয়ে invoice number, customer name ও contact-এ case-insensitive match খোঁজে।
 * Query-তে digit থাকলে Kolkata date-এর `YYYYMMDD` text-ও match করে; limit 1–20-এর মধ্যে রাখা হয়।
 * সাম্প্রতিক invoice আগে ফেরে এবং অল্প সময় cache হওয়ায় dropdown-এর repeated typing query কমায়।
 */
router.get(
  "/invoices/suggestions",
  authMiddleware,
  requirePermission("sale_invoice"),
  cacheJsonResponse({ namespace: "invoices:suggestions", ttlMs: 15 * 1000 }),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const rawQuery = String(req.query.q || "")
        .trim()
        .toLowerCase();
      const limit = Math.min(
        Math.max(Number.parseInt(req.query.limit, 10) || 10, 1),
        20,
      );
      const params = [userId];
      const filters = [];

      if (rawQuery) {
        params.push(`%${rawQuery}%`);
        const textFilterIndex = params.length;

        filters.push(`LOWER(i.invoice_no) LIKE $${textFilterIndex}`);
        filters.push(
          `LOWER(COALESCE(i.customer_name, '')) LIKE $${textFilterIndex}`,
        );
        filters.push(`LOWER(COALESCE(i.contact, '')) LIKE $${textFilterIndex}`);

        const numericQuery = rawQuery.replace(/\D/g, "");
        if (numericQuery) {
          params.push(`%${numericQuery}%`);
          const numericFilterIndex = params.length;
          filters.push(
            `TO_CHAR(i.date AT TIME ZONE 'Asia/Kolkata', 'YYYYMMDD') LIKE $${numericFilterIndex}`,
          );
        }
      }

      const whereClause = filters.length ? `AND (${filters.join(" OR ")})` : "";
      const { rows } = await pool.query(
        `
          SELECT
            i.invoice_no,
            COALESCE(i.customer_name, '') AS customer_name,
            COALESCE(i.contact, '') AS contact,
            i.date
          FROM invoices i
          WHERE i.user_id = $1
          ${whereClause}
          ORDER BY i.date DESC, i.id DESC
          LIMIT ${limit}
        `,
        params,
      );

      res.json({
        success: true,
        suggestions: rows,
      });
    } catch (error) {
      console.error("Invoice suggestions fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Could not load invoice suggestions.",
      });
    }
  },
);

/*
 * =========================================================
 * BLOCK 14: সাম্প্রতিক invoice number list
 * =========================================================
 * বর্তমান user-এর সর্বশেষ ৫০টি invoice number date অনুযায়ী নামিয়ে শুধু string array হিসেবে পাঠায়।
 * Invoice picker-এর lightweight data source হিসেবে response ১৫ সেকেন্ড cache হয়।
 */
router.get(
  "/invoices/numbers",
  authMiddleware,
  requirePermission("sale_invoice"),
  cacheJsonResponse({ namespace: "invoices:numbers", ttlMs: 15 * 1000 }),
  async (req, res) => {
    const userId = getUserId(req);
    const { rows } = await pool.query(
      `SELECT invoice_no
         FROM invoices
         WHERE user_id = $1
         ORDER BY date DESC
         LIMIT 50`,
      [userId],
    );

    res.json(rows.map((r) => r.invoice_no));
  },
);

/*
 * =========================================================
 * BLOCK 15: আগের invoice থেকে customer autocomplete
 * =========================================================
 * Typed name বা mobile fragment দিয়ে invoice history খুঁজে unique name/contact pair ফেরায়।
 * একই customer বহু invoice-এ থাকলে `DISTINCT ON` ও descending date-এর কারণে সর্বশেষ address/date রাখা হয়।
 * Empty query-তে সঙ্গে সঙ্গে empty list দেয় এবং সর্বোচ্চ ২০টি suggestion পাঠায়।
 */
router.get(
  "/invoices/customers",
  authMiddleware,
  requirePermission("sale_invoice"),
  cacheJsonResponse({ namespace: "invoices:customers", ttlMs: 15 * 1000 }),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const rawQuery = String(req.query.q || "").trim();
      const normalizedQuery = normalizeLookupText(rawQuery);
      const numericQuery = normalizeMobileNumber(rawQuery);
      const limit = Math.min(
        Math.max(Number.parseInt(req.query.limit, 10) || 12, 1),
        20,
      );

      if (!rawQuery) {
        return res.json({ success: true, customers: [] });
      }

      const params = [userId, `%${normalizedQuery}%`];
      const filters = ["LOWER(TRIM(COALESCE(i.customer_name, ''))) LIKE $2"];

      if (numericQuery) {
        params.push(`%${numericQuery}%`);
        filters.push(`COALESCE(i.contact, '') LIKE $3`);
      }

      const { rows } = await pool.query(
        `
          SELECT DISTINCT ON (
            LOWER(TRIM(COALESCE(i.customer_name, ''))),
            COALESCE(i.contact, '')
          )
            COALESCE(i.customer_name, '') AS customer_name,
            COALESCE(i.contact, '') AS contact,
            COALESCE(i.address, '') AS address,
            i.date AS last_invoice_date
          FROM invoices i
          WHERE i.user_id = $1
            AND COALESCE(i.customer_name, '') <> ''
            AND (${filters.join(" OR ")})
          ORDER BY
            LOWER(TRIM(COALESCE(i.customer_name, ''))),
            COALESCE(i.contact, ''),
            i.date DESC,
            i.id DESC
          LIMIT ${limit}
        `,
        params,
      );

      res.json({
        success: true,
        customers: rows,
      });
    } catch (error) {
      console.error("Invoice customer suggestions fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Could not load customer suggestions.",
      });
    }
  },
);

/*
 * =========================================================
 * BLOCK 16: paginated invoice list ও search
 * =========================================================
 * Invoice number, customer name, contact অথবা numeric date fragment দিয়ে current user-এর invoice filter করে।
 * প্রথম query মোট matching row গোনে; দ্বিতীয় query item count ও payment summary-সহ requested page আনে।
 * Response-এ total/limit/offset/page/has_more থাকে এবং short cache dashboard-এর repeated load কমায়।
 */
router.get(
  "/invoices",
  authMiddleware,
  requirePermission("sale_invoice"),
  cacheJsonResponse({ namespace: "invoices:list", ttlMs: 10 * 1000 }),
  async (req, res) => {
    try {
      const rawQuery = String(req.query.q || "")
        .trim()
        .toLowerCase();
      const pagination = parsePagination(req.query, 100, 200);
      const params = [getUserId(req)];
      const filters = [];

      if (rawQuery) {
        params.push(`%${rawQuery}%`);
        const textFilterIndex = params.length;

        filters.push(`LOWER(i.invoice_no) LIKE $${textFilterIndex}`);
        filters.push(
          `LOWER(COALESCE(i.customer_name, '')) LIKE $${textFilterIndex}`,
        );
        filters.push(`LOWER(COALESCE(i.contact, '')) LIKE $${textFilterIndex}`);

        const numericQuery = rawQuery.replace(/\D/g, "");
        if (numericQuery) {
          params.push(`%${numericQuery}%`);
          const dateFilterIndex = params.length;
          filters.push(
            `TO_CHAR(i.date AT TIME ZONE 'Asia/Kolkata', 'YYYYMMDD') LIKE $${dateFilterIndex}`,
          );
        }
      }

      const whereClause = filters.length ? `AND (${filters.join(" OR ")})` : "";
      const countResult = await pool.query(
        `
          SELECT COUNT(DISTINCT i.id)::int AS total
          FROM invoices i
          WHERE i.user_id = $1
          ${whereClause}
        `,
        params,
      );

      const { rows } = await pool.query(
        `
            SELECT
                i.date,
                i.invoice_no,
                i.customer_name,
                i.contact,
                i.payment_mode,
                i.payment_status,
                i.amount_paid,
                i.amount_due,
                i.total_amount,
                COUNT(ii.id)::int AS item_count
            FROM invoices i
            LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
            WHERE i.user_id = $1
            ${whereClause}
            GROUP BY i.id
            ORDER BY i.date DESC, i.id DESC
            LIMIT ${pagination.limit}
            OFFSET ${pagination.offset}
            `,
        params,
      );

      res.json({
        success: true,
        invoices: rows,
        pagination: {
          total: Number(countResult.rows[0]?.total) || 0,
          limit: pagination.limit,
          offset: pagination.offset,
          page: pagination.page,
          has_more:
            pagination.offset + rows.length <
            (Number(countResult.rows[0]?.total) || 0),
        },
      });
    } catch (err) {
      console.error("All invoices fetch error:", err);
      res.status(500).json({ success: false });
    }
  },
);

/*
 * =========================================================
 * BLOCK 17: একটি invoice-এর পূর্ণ detail
 * =========================================================
 * User ownership ও invoice number মিলিয়ে header-এর সঙ্গে সব invoice item JSON array হিসেবে aggregate করে।
 * প্রতিটি item-এর সঙ্গে linked serial number, sale rate, status ও sold time nested array-এ যুক্ত হয়।
 * Invoice না থাকলে 404; থাকলে debt ledger-এর collection history সময় অনুযায়ী `collections`-এ যোগ হয়।
 */
router.get(
  "/invoices/:invoiceNo",
  authMiddleware,
  requirePermission("sale_invoice"),
  cacheJsonResponse({ namespace: "invoices:detail", ttlMs: 10 * 1000 }),
  async (req, res) => {
    const userId = getUserId(req);
    const { rows } = await pool.query(
      `
      SELECT i.*, COALESCE(
        json_agg(
          json_build_object(
            'id', ii.id,
            'description', ii.description,
            'quantity', ii.quantity,
            'rate', ii.rate,
            'amount', ii.amount,
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
                WHERE isn.user_id = i.user_id
                  AND isn.invoice_item_id = ii.id
              ),
              '[]'::json
            )
          )
          ORDER BY ii.id
        ) FILTER (WHERE ii.id IS NOT NULL),
        '[]'
      ) AS items
      FROM invoices i
      LEFT JOIN invoice_items ii ON ii.invoice_id=i.id
      WHERE i.user_id=$2 AND i.invoice_no=$1
      GROUP BY i.id
    `,
      [req.params.invoiceNo, userId],
    );

    if (!rows[0]) return res.status(404).json({ success: false });

    const invoice = rows[0];
    const settlements = await pool.query(
      `
      SELECT id, total, credit, remark, created_at
      FROM debts
      WHERE user_id = $1 AND invoice_id = $2
      ORDER BY created_at ASC, id ASC
    `,
      [userId, invoice.id],
    );

    invoice.collections = settlements.rows;
    res.json({ success: true, invoice });
  },
);

/*
 * =========================================================
 * BLOCK 18: বকেয়া invoice-এ পরবর্তী payment গ্রহণ
 * =========================================================
 * Invoice row lock করে current paid/due amount থেকে নতুন settlement snapshot হিসাব করে।
 * Valid customer mobile-এর scoped lock একই customer-এর concurrent debt update serial রাখে।
 * Invoice payment fields update ও positive collection ledger entry একই transaction-এ commit হয়; failure-এ rollback হয়।
 */
router.post(
  "/invoices/:invoiceNo/payment",
  authMiddleware,
  requirePermission("sale_invoice"),
  async (req, res) => {
    const userId = getUserId(req);
    const invoiceNo = String(req.params.invoiceNo || "").trim();
    const paymentMode = normalizeInvoicePaymentMode(req.body?.payment_mode);
    const paymentRemark = normalizeDisplayText(req.body?.remark);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Invoice lock নেওয়ায় একই invoice-এ একসঙ্গে আসা payment পুরোনো due balance পড়ে overwrite করতে পারে না।
      const invoiceResult = await client.query(
        `
          SELECT
            id,
            invoice_no,
            customer_name,
            contact,
            address,
            payment_mode,
            payment_status,
            amount_paid,
            amount_due,
            total_amount
          FROM invoices
          WHERE user_id = $1 AND invoice_no = $2
          FOR UPDATE
        `,
        [userId, invoiceNo],
      );

      if (!invoiceResult.rowCount) {
        await client.query("ROLLBACK");
        return res
          .status(404)
          .json({ success: false, message: "Invoice not found." });
      }

      const invoice = invoiceResult.rows[0];
      const customerContact = normalizeMobileNumber(invoice.contact);

      if (!/^\d{10}$/.test(customerContact)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message:
            "This invoice does not have a valid 10-digit customer number for due settlement.",
        });
      }

      // Customer debt ledger-এর অন্যান্য write-এর সঙ্গে একই normalized mobile key ব্যবহার করে serialization নিশ্চিত করা হয়।
      await lockScopedResource(
        client,
        userId,
        "customer-debt",
        customerContact,
      );

      let paymentSnapshot;
      try {
        paymentSnapshot = buildInvoiceSettlementSnapshot(
          invoice,
          req.body?.amount,
          paymentMode,
        );
      } catch (error) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: error.message || "Invalid payment request.",
        });
      }

      // Validated snapshot অনুযায়ী invoice-এর cumulative paid, remaining due, mode ও status একসঙ্গে বদলায়।
      await client.query(
        `
          UPDATE invoices
          SET payment_mode = $1,
              payment_status = $2,
              amount_paid = $3,
              amount_due = $4,
              updated_at = NOW()
          WHERE id = $5
        `,
        [
          paymentSnapshot.paymentMode,
          paymentSnapshot.paymentStatus,
          paymentSnapshot.amountPaid,
          paymentSnapshot.amountDue,
          invoice.id,
        ],
      );

      // `total = 0` এবং positive `credit` row payment receipt হিসেবে customer debt history-তে যোগ হয়।
      await client.query(
        `
          INSERT INTO debts (
            user_id,
            invoice_id,
            customer_name,
            customer_number,
            customer_address,
            total,
            credit,
            remark
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          userId,
          invoice.id,
          normalizeDisplayText(invoice.customer_name) ||
            `Customer ${customerContact}`,
          customerContact,
          String(invoice.address || "").trim() || null,
          0,
          paymentSnapshot.amountReceived,
          paymentRemark
            ? `Invoice ${invoice.invoice_no} payment received via ${paymentMode} | ${paymentRemark}`
            : `Invoice ${invoice.invoice_no} payment received via ${paymentMode}`,
        ],
      );

      await client.query("COMMIT");
      invalidateUserCache(userId);

      return res.json({
        success: true,
        message:
          paymentSnapshot.paymentStatus === "paid"
            ? "Invoice payment received and marked as paid."
            : "Invoice payment received and due updated.",
        invoice: {
          invoice_no: invoice.invoice_no,
          payment_mode: paymentSnapshot.paymentMode,
          payment_status: paymentSnapshot.paymentStatus,
          amount_paid: paymentSnapshot.amountPaid,
          amount_due: paymentSnapshot.amountDue,
          amount_received: paymentSnapshot.amountReceived,
        },
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error("Invoice settlement failed:", error);
      return res.status(500).json({
        success: false,
        message: "Could not receive payment for this invoice right now.",
      });
    } finally {
      client.release();
    }
  },
);

/*
 * =========================================================
 * BLOCK 19: invoice PDF download ও page rendering
 * =========================================================
 * Sanitized invoice number ও current user id দিয়ে invoice/items/serial data, shop settings এবং payment collections load করে।
 * Bank/UPI detail থাকলে payment panel ও local QR matrix তৈরি হয়; remote service ব্যবহার করা হয় না।
 * PDFKit দিয়ে A4 header, customer info, multipage item table, payment/amount summary, account panel ও footer আঁকে।
 */
router.get(
  "/invoices/:invoiceNo/pdf",

  // Cookie-based auth only; first-party frontend downloads PDFs with credentials.
  authMiddleware,
  requirePermission("sale_invoice"),

  async (req, res) => {
    const userId = getUserId(req);
    // Quote/percent character বাদ দিয়ে route parameter query value হিসেবে ব্যবহার করা হয়; SQL value parameterized থাকে।
    const invoiceNo = req.params.invoiceNo.replace(/['"%]+/g, "").trim();

    try {
      /* PDF PHASE A: invoice header-এর সঙ্গে item এবং প্রতিটি item-এর serial list এক query-তে JSON aggregate করে আনা। */
      const q = `
          SELECT i.id, i.invoice_no, i.customer_name, i.contact, i.address, i.gst_no,
                 i.date, i.subtotal, i.gst_amount, i.total_amount,
                 i.payment_mode, i.payment_status, i.amount_paid, i.amount_due,
                 COALESCE(json_agg(json_build_object(
                   'description', ii.description,
                   'quantity', ii.quantity,
                   'rate', ii.rate,
                   'amount', ii.amount,
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
                       WHERE isn.user_id = i.user_id
                         AND isn.invoice_item_id = ii.id
                     ),
                     '[]'::json
                   )
                 ) ORDER BY ii.id) FILTER (WHERE ii.id IS NOT NULL), '[]') AS items
          FROM invoices i
          LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
          WHERE i.user_id = $2 AND TRIM(i.invoice_no) = TRIM($1)
          GROUP BY i.id
          LIMIT 1;
        `;
      const { rows } = await pool.query(q, [invoiceNo, userId]);
      if (!rows[0])
        return res
          .status(404)
          .json({ success: false, message: "Invoice not found" });

      const inv = rows[0];

      /* PDF PHASE B: seller/shop identity, bank account ও UPI configuration load করে printable rows তৈরি। */
      const shopRes = await pool.query(
        `SELECT
           shop_name,
           shop_address,
           gst_no,
           bank_name,
           account_holder_name,
           account_number,
           ifsc_code,
           upi_id
         FROM settings
         WHERE user_id=$1`,
        [userId],
      );
      const shop = shopRes.rows[0] || {};
      const accountDetails = {
        bankName: normalizeDisplayText(shop.bank_name),
        accountHolderName: normalizeDisplayText(shop.account_holder_name),
        accountNumber: normalizeDisplayText(shop.account_number),
        ifscCode: normalizeDisplayText(shop.ifsc_code),
        upiId: normalizeDisplayText(shop.upi_id),
      };
      const accountRows = [
        ["Bank Name", accountDetails.bankName],
        ["Account Holder", accountDetails.accountHolderName],
        ["Account Number", accountDetails.accountNumber],
        ["IFSC Code", accountDetails.ifscCode],
        ["UPI ID", accountDetails.upiId],
      ].filter(([, value]) => value);
      const hasAccountDetails = accountRows.length > 0;
      const upiPaymentUri = buildUpiPaymentUri(
        accountDetails.upiId,
        accountDetails.accountHolderName || shop.shop_name || "Invoice Payment",
      );
      /* PDF PHASE C: configured UPI id থাকলে URI encode করে QR matrix বানানো; QR failure হলেও invoice PDF তৈরি চলতে থাকে। */
      let upiQrMatrix = null;

      if (upiPaymentUri) {
        try {
          upiQrMatrix = createQrCodeMatrix(upiPaymentUri);
        } catch (qrError) {
          console.warn("UPI QR generation skipped:", qrError.message);
        }
      }
      /* PDF PHASE D: invoice-এর payment/debt ledger rows আনা, যাতে payment summary ও শেষ collection time দেখানো যায়। */
      const settlementRes = await pool.query(
        `SELECT total, credit, created_at
         FROM debts
         WHERE user_id = $1 AND invoice_id = $2
         ORDER BY created_at ASC, id ASC`,
        [userId, inv.id],
      );
      const settlements = settlementRes.rows;

      /* PDF PHASE E: A4 PDF document, buffered pages এবং download/no-cache response headers প্রস্তুত করা। */
      const doc = new PDFDocument({
        size: "A4",
        margin: 28,
        bufferPages: true,
      });

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${inv.invoice_no}.pdf"`,
      );
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Cache-Control",
        "private, no-store, no-cache, must-revalidate, max-age=0",
      );
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Surrogate-Control", "no-store");

      doc.pipe(res);

      /*
       * PDF PHASE F: reusable layout constants ও helper functions।
       * এগুলো money/status format, QR drawing, account panel, header, customer info, table header ও page break পরিচালনা করে।
       */
      const pageHeight = doc.page.height;
      const leftX = 28;
      const contentWidth = 539;
      const colors = {
        ink: "#111111",
        muted: "#475569",
        line: "#1f2937",
        soft: "#e5e7eb",
      };

      const formatPdfMoney = (value) => Number(value || 0).toFixed(2);
      const formatPdfDateTime = (value) =>
        new Date(value).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
        });
      const formatInvoiceStatus = (value) => {
        const normalized = String(value || "paid")
          .trim()
          .toLowerCase();
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
      };
      const formatInvoiceMode = (value) => {
        const normalized = String(value || "cash")
          .trim()
          .toLowerCase();
        if (normalized === "upi") {
          return "UPI";
        }
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
      };
      const shortenPdfText = (value, maxLength = 44) => {
        const text = String(value || "").trim();
        return text.length > maxLength
          ? `${text.slice(0, Math.max(0, maxLength - 3))}...`
          : text;
      };
      const invoiceStatusText = formatInvoiceStatus(inv.payment_status);
      const invoiceModeText = formatInvoiceMode(inv.payment_mode);
      const paymentRows = settlements.filter(
        (row) => Number(row.credit || 0) > 0,
      );
      const openingEntry = settlements.find(
        (row) => Number(row.total || 0) > 0,
      );
      const openingPaid = Number(openingEntry?.credit || 0);
      const laterPaid = paymentRows.reduce((sum, row) => {
        if (Number(row.total || 0) > 0) {
          return sum;
        }
        return sum + (Number(row.credit || 0) || 0);
      }, 0);
      const transactionCount = paymentRows.length;
      const lastPayment = paymentRows[paymentRows.length - 1];

      function drawQrCode(matrix, x, y, drawSize) {
        if (!Array.isArray(matrix) || !matrix.length) {
          return;
        }

        const quietModules = 4;
        const moduleSize = drawSize / (matrix.length + quietModules * 2);

        doc.save();
        doc.rect(x, y, drawSize, drawSize).fill("#ffffff");
        doc.fillColor(colors.ink);
        matrix.forEach((row, rowIndex) => {
          row.forEach((dark, columnIndex) => {
            if (!dark) {
              return;
            }
            doc.rect(
              x + (columnIndex + quietModules) * moduleSize,
              y + (rowIndex + quietModules) * moduleSize,
              moduleSize,
              moduleSize,
            );
          });
        });
        doc.fill();
        doc.restore();
      }

      function drawPaymentAccountDetails(startY) {
        if (!hasAccountDetails) {
          return;
        }

        const panelX = leftX;
        const panelWidth = contentWidth;
        const panelHeight = 96;
        const textX = panelX + 12;
        const labelWidth = 76;
        const valueX = textX + labelWidth + 8;
        const valueWidth = upiQrMatrix ? 304 : 420;

        doc.save();
        doc
          .roundedRect(panelX, startY, panelWidth, panelHeight, 11)
          .fillAndStroke("#f8fafc", "#d7dee8");
        doc.restore();

        doc
          .font("Helvetica-Bold")
          .fontSize(9.5)
          .fillColor(colors.ink)
          .text("Payment Account Details", textX, startY + 10, {
            width: 250,
          });

        let rowY = startY + 27;
        accountRows.forEach(([label, value]) => {
          doc
            .font("Helvetica")
            .fontSize(8)
            .fillColor(colors.muted)
            .text(`${label}:`, textX, rowY, { width: labelWidth });
          doc
            .font("Helvetica-Bold")
            .fontSize(8.1)
            .fillColor(colors.ink)
            .text(shortenPdfText(value, upiQrMatrix ? 42 : 62), valueX, rowY, {
              width: valueWidth,
            });
          rowY += 11.5;
        });

        if (!upiQrMatrix) {
          return;
        }

        const qrSize = 64;
        const qrX = panelX + panelWidth - qrSize - 14;
        const qrY = startY + 14;

        doc.save();
        doc
          .roundedRect(qrX - 4, qrY - 4, qrSize + 8, qrSize + 17, 7)
          .fillAndStroke("#ffffff", "#e2e8f0");
        doc.restore();
        drawQrCode(upiQrMatrix, qrX, qrY, qrSize);
        doc
          .font("Helvetica-Bold")
          .fontSize(6.8)
          .fillColor(colors.muted)
          .text("Scan UPI", qrX, qrY + qrSize + 5, {
            width: qrSize,
            align: "center",
          });
      }

      function drawHeader() {
        doc.save();
        doc.rect(leftX, 24, contentWidth, 58).fill("#eef2f6");
        doc.restore();

        doc.fillColor(colors.ink);
        doc
          .font("Helvetica-Bold")
          .fontSize(15.5)
          .text(shop.shop_name || "Shop Inventory Management", leftX + 12, 37, {
            width: 330,
          });
        doc
          .font("Helvetica")
          .fontSize(7.8)
          .text(shop.shop_address || "", leftX + 12, 57, { width: 330 })
          .text(
            `GSTIN: ${shop.gst_no || inv.gst_no || "N/A"}`,
            leftX + 12,
            69,
            {
              width: 270,
            },
          );

        doc.font("Helvetica-Bold").fontSize(13).text("TAX INVOICE", 425, 45, {
          width: 128,
          align: "center",
        });
      }

      function drawInvoiceInfo(startY) {
        const leftWidth = 250;
        const rightX = 307;
        const rightWidth = 260;
        const labelWidth = 53;
        const rowGap = 2;

        const drawInfoRows = (rows, x, y, totalWidth) => {
          let cursorY = y;
          rows.forEach(([label, value], index) => {
            const safeValue = String(value || "-");
            const valueWidth = totalWidth - labelWidth - 8;
            const valueHeight = doc.heightOfString(safeValue, {
              width: valueWidth,
              align: "left",
            });
            const rowHeight = Math.max(10, valueHeight) + 1;

            doc
              .font("Helvetica-Bold")
              .fontSize(8)
              .fillColor(colors.ink)
              .text(`${label}:`, x, cursorY, {
                width: labelWidth,
              });
            doc
              .font("Helvetica")
              .fontSize(8.4)
              .fillColor(colors.ink)
              .text(safeValue, x + labelWidth + 8, cursorY, {
                width: valueWidth,
              });

            cursorY += rowHeight + rowGap;

            if (index < rows.length - 1) {
              doc
                .moveTo(x, cursorY - 2)
                .lineTo(x + totalWidth, cursorY - 2)
                .strokeColor("#d7dee8")
                .lineWidth(0.45)
                .stroke();
            }
          });

          return cursorY;
        };

        doc
          .moveTo(leftX, startY - 4)
          .lineTo(leftX + contentWidth, startY - 4)
          .strokeColor(colors.soft)
          .lineWidth(0.8)
          .stroke();

        const leftRows = [
          ["Invoice No", inv.invoice_no || "-"],
          ["Date", formatPdfDateTime(inv.date)],
          ["Customer", inv.customer_name || "-"],
        ];
        const rightRows = [
          ["Contact", inv.contact || "-"],
          ["Address", inv.address || "-"],
          ["Payment", `${invoiceStatusText} via ${invoiceModeText}`],
        ];

        const leftY = drawInfoRows(leftRows, leftX, startY, leftWidth);
        const rightY = drawInfoRows(rightRows, rightX, startY, rightWidth);
        const blockBottom = Math.max(leftY, rightY);

        doc
          .moveTo(leftX, blockBottom - 2)
          .lineTo(leftX + contentWidth, blockBottom - 2)
          .strokeColor(colors.soft)
          .lineWidth(0.8)
          .stroke();

        return blockBottom + 7;
      }

      function drawTableHeader(startY) {
        doc
          .moveTo(leftX, startY)
          .lineTo(leftX + contentWidth, startY)
          .strokeColor(colors.line)
          .stroke();
        const labelY = startY + 6;
        doc.font("Helvetica-Bold").fontSize(8).fillColor(colors.ink);
        doc.text("#", leftX, labelY, { width: 18 });
        doc.text("Product / Serial No.", leftX + 24, labelY, { width: 270 });
        doc.text("Qty", 326, labelY, { width: 42, align: "right" });
        doc.text("Rate", 382, labelY, { width: 70, align: "right" });
        doc.text("Amount", 462, labelY, { width: 105, align: "right" });
        doc
          .moveTo(leftX, startY + 19)
          .lineTo(leftX + contentWidth, startY + 19)
          .strokeColor(colors.line)
          .stroke();

        return startY + 24;
      }

      function ensureTableSpace(currentY, neededHeight) {
        if (currentY + neededHeight <= pageHeight - 88) {
          return currentY;
        }

        doc.addPage();
        drawHeader();
        return drawTableHeader(drawInvoiceInfo(96));
      }

      drawHeader();
      let y = drawTableHeader(drawInvoiceInfo(96));

      /* PDF PHASE G: product name, optional serial list, quantity, rate ও amount প্রতিটি table row-তে আঁকা। */
      (Array.isArray(inv.items) ? inv.items : []).forEach((item, index) => {
        const itemName = String(item.description || "-");
        const serialText = (
          Array.isArray(item.serial_numbers) ? item.serial_numbers : []
        )
          .map((serial) => normalizeSerialNumber(serial.serial_no))
          .filter(Boolean)
          .join(", ");
        doc.font("Helvetica-Bold").fontSize(8.7);
        const itemHeight = doc.heightOfString(itemName, { width: 270 });
        doc.font("Helvetica").fontSize(7.1);
        const serialHeight = serialText
          ? doc.heightOfString(`SN: ${serialText}`, { width: 270 })
          : 0;
        const rowHeight = Math.max(
          13,
          itemHeight + serialHeight + (serialText ? 2 : 0),
        );

        y = ensureTableSpace(y, rowHeight + 5);

        doc.font("Helvetica").fontSize(8).fillColor(colors.muted);
        doc.text(String(index + 1), leftX, y, { width: 18 });
        doc.font("Helvetica-Bold").fontSize(8.7).fillColor(colors.ink);
        doc.text(itemName, leftX + 24, y, { width: 270 });
        if (serialText) {
          doc
            .font("Helvetica")
            .fontSize(7.1)
            .fillColor(colors.muted)
            .text(`SN: ${serialText}`, leftX + 24, y + itemHeight + 1, {
              width: 270,
            });
        }
        doc.font("Helvetica").fontSize(8.4).fillColor(colors.ink);
        doc.text(String(item.quantity ?? "-"), 326, y, {
          width: 42,
          align: "right",
        });
        doc.text(formatPdfMoney(item.rate), 382, y, {
          width: 70,
          align: "right",
        });
        doc.text(formatPdfMoney(item.amount), 462, y, {
          width: 105,
          align: "right",
        });

        y += rowHeight + 4;
      });

      /* PDF PHASE H: payment status/mode/paid/due এবং subtotal/GST/total পাশাপাশি summary panel-এ আঁকা। */
      const summaryHeight = 90;
      const accountPanelHeight = hasAccountDetails ? 96 : 0;
      const accountFooterReserve = hasAccountDetails
        ? accountPanelHeight + 14
        : 0;
      y = ensureTableSpace(y + 10, summaryHeight + 12 + accountFooterReserve);

      const paymentBlockX = 276;
      const amountBlockX = 416;
      const blockTitleY = y;
      const dividerX = 402;
      const paymentLabelWidth = 68;
      const paymentValueWidth = 64;
      const amountLabelWidth = 50;
      const amountValueWidth = 84;

      doc
        .moveTo(paymentBlockX, y - 2)
        .lineTo(leftX + contentWidth, y - 2)
        .strokeColor("#d7dee8")
        .lineWidth(0.8)
        .stroke();

      doc
        .moveTo(dividerX, y + 2)
        .lineTo(dividerX, y + summaryHeight - 8)
        .strokeColor("#e2e8f0")
        .lineWidth(0.7)
        .stroke();

      doc.font("Helvetica-Bold").fontSize(8.7).fillColor(colors.ink);
      doc.text("Payment Details", paymentBlockX, blockTitleY, { width: 118 });
      doc.text("Amount Summary", amountBlockX, blockTitleY, {
        width: 134,
        align: "right",
      });

      doc
        .moveTo(paymentBlockX, blockTitleY + 12)
        .lineTo(paymentBlockX + 118, blockTitleY + 12)
        .strokeColor("#c7d2e1")
        .lineWidth(0.7)
        .stroke();
      doc
        .moveTo(amountBlockX, blockTitleY + 12)
        .lineTo(amountBlockX + 134, blockTitleY + 12)
        .strokeColor("#c7d2e1")
        .lineWidth(0.7)
        .stroke();

      const paymentSummaryRows = [
        ["Status", invoiceStatusText],
        ["Mode", invoiceModeText],
        ["Opening", formatPdfMoney(openingPaid)],
        ["Later Paid", formatPdfMoney(laterPaid)],
        ["Txn Count", String(transactionCount)],
      ];

      const amountSummaryRows = [
        ["Subtotal", formatPdfMoney(inv.subtotal)],
        ["GST", formatPdfMoney(inv.gst_amount)],
        ["Paid", formatPdfMoney(inv.amount_paid || 0)],
        ["Due", formatPdfMoney(inv.amount_due || 0)],
      ];

      let paymentY = y + 19;
      paymentSummaryRows.forEach(([label, value]) => {
        doc.font("Helvetica").fontSize(8.3).fillColor(colors.muted);
        doc.text(label, paymentBlockX, paymentY, { width: paymentLabelWidth });
        doc.font("Helvetica-Bold").fontSize(8.4).fillColor(colors.ink);
        doc.text(value, paymentBlockX + paymentLabelWidth + 4, paymentY, {
          width: paymentValueWidth,
          align: "right",
        });
        paymentY += 12.5;
      });

      if (lastPayment) {
        const lastTxnText = `Last Txn: ${new Date(
          lastPayment.created_at,
        ).toLocaleDateString("en-IN", {
          timeZone: "Asia/Kolkata",
        })}`;
        doc.font("Helvetica").fontSize(7.5).fillColor(colors.muted);
        doc.text(lastTxnText, paymentBlockX, y + 81, { width: 126 });
      }

      let amountY = y + 19;
      amountSummaryRows.forEach(([label, value]) => {
        doc.font("Helvetica").fontSize(8.3).fillColor(colors.muted);
        doc.text(label, amountBlockX, amountY, { width: amountLabelWidth });
        doc.font("Helvetica-Bold").fontSize(8.4).fillColor(colors.ink);
        doc.text(value, amountBlockX + amountLabelWidth + 6, amountY, {
          width: amountValueWidth,
          align: "right",
        });
        amountY += 12.5;
      });

      doc
        .moveTo(amountBlockX, y + 68)
        .lineTo(amountBlockX + 140, y + 68)
        .strokeColor(colors.line)
        .lineWidth(0.8)
        .stroke();

      doc.font("Helvetica-Bold").fontSize(11).fillColor(colors.ink);
      doc.text("Total:", amountBlockX, y + 74, {
        width: amountLabelWidth + 10,
      });
      doc.text(formatPdfMoney(inv.total_amount), amountBlockX + 56, y + 74, {
        width: 90,
        align: "right",
      });

      /* PDF PHASE I: buffered প্রতিটি page-এ footer/page number, আর শেষ page-এ bank/UPI payment panel বসানো। */
      const accountPanelY = hasAccountDetails
        ? Math.max(y + summaryHeight + 12, pageHeight - 184)
        : null;
      const range = doc.bufferedPageRange();
      const totalPages = range.count;

      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);

        doc.font("Helvetica").fontSize(9);

        if (i === totalPages - 1 && hasAccountDetails) {
          drawPaymentAccountDetails(accountPanelY);
        }

        doc.font("Helvetica").fontSize(9).fillColor(colors.ink);

        doc.text(
          "This is a system generated invoice. No signature required.",
          leftX,
          pageHeight - 70,
          { width: contentWidth, align: "center" },
        );

        doc.text(`Page ${i + 1} of ${totalPages}`, leftX, pageHeight - 54, {
          width: contentWidth,
          align: "right",
        });
      }

      // Document stream শেষ করলে PDFKit সম্পূর্ণ bytes response-এ flush করে download সম্পন্ন করে।
      doc.end();
    } catch (err) {
      console.error("❌ PDF error:", err);
      res
        .status(500)
        .json({ success: false, message: "PDF generation failed" });
    }
  },
);

/*
 * =========================================================
 * BLOCK 20: invoice-এ ব্যবহৃত shop ও payment settings save
 * =========================================================
 * শুধু owner shop identity, GST rate, bank account এবং UPI id update করতে পারে।
 * GST rate 0–100 range-এ validate হয়; text trim এবং IFSC uppercase করে per-user settings upsert করা হয়।
 * Save সফল হলে user cache invalidate হয়, যাতে পরের invoice/PDF নতুন settings পায়।
 */
router.post("/shop-info", authMiddleware, requireOwner, async (req, res) => {
  try {
    const {
      shop_name,
      shop_address,
      gst_no,
      gst_rate,
      bank_name,
      account_holder_name,
      account_number,
      ifsc_code,
      upi_id,
    } = req.body;
    const userId = getUserId(req);
    const normalizedGstRate = Number(gst_rate);
    const normalizedBankName = String(bank_name || "").trim();
    const normalizedAccountHolderName = String(
      account_holder_name || "",
    ).trim();
    const normalizedAccountNumber = String(account_number || "").trim();
    const normalizedIfscCode = String(ifsc_code || "")
      .trim()
      .toUpperCase();
    const normalizedUpiId = String(upi_id || "").trim();

    if (
      !Number.isFinite(normalizedGstRate) ||
      normalizedGstRate < 0 ||
      normalizedGstRate > 100
    ) {
      return res.status(400).json({
        success: false,
        message: "GST rate must be between 0 and 100.",
      });
    }

    await pool.query(
      `
        INSERT INTO settings (
          user_id,
          shop_name,
          shop_address,
          gst_no,
          gst_rate,
          bank_name,
          account_holder_name,
          account_number,
          ifsc_code,
          upi_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (user_id)
        DO UPDATE SET
          shop_name=EXCLUDED.shop_name,
          shop_address=EXCLUDED.shop_address,
          gst_no=EXCLUDED.gst_no,
          gst_rate=EXCLUDED.gst_rate,
          bank_name=EXCLUDED.bank_name,
          account_holder_name=EXCLUDED.account_holder_name,
          account_number=EXCLUDED.account_number,
          ifsc_code=EXCLUDED.ifsc_code,
          upi_id=EXCLUDED.upi_id
      `,
      [
        userId,
        String(shop_name || "").trim(),
        String(shop_address || "").trim(),
        String(gst_no || "").trim(),
        normalizedGstRate,
        normalizedBankName,
        normalizedAccountHolderName,
        normalizedAccountNumber,
        normalizedIfscCode,
        normalizedUpiId,
      ],
    );

    invalidateUserCache(userId);
    res.json({ success: true });
  } catch (error) {
    console.error("Shop info save error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to save shop info" });
  }
});

/*
 * =========================================================
 * BLOCK 21: invoice form-এর shop settings load
 * =========================================================
 * `sale_invoice` permission থাকা user-এর settings row থেকে shop, GST, bank ও UPI field ফেরায়।
 * এখনও settings তৈরি না হলে empty object পাঠায়, ফলে frontend default বা blank form দেখাতে পারে।
 */
router.get(
  "/shop-info",
  authMiddleware,
  requirePermission("sale_invoice"),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const { rows } = await pool.query(
        `SELECT
           shop_name,
           shop_address,
           gst_no,
           gst_rate,
           bank_name,
           account_holder_name,
           account_number,
           ifsc_code,
           upi_id
         FROM settings
         WHERE user_id=$1`,
        [userId],
      );
      res.json({ success: true, settings: rows[0] || {} });
    } catch (error) {
      console.error("Shop info load error:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to load shop info" });
    }
  },
);

/*
 * =========================================================
 * BLOCK 22: router export
 * =========================================================
 * প্রস্তুত Express router-টি main application-এ mount করার জন্য CommonJS module হিসেবে প্রকাশ করা হয়।
 */
module.exports = router;
