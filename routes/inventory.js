// routes/inventory.js
const express = require("express");
const pool = require("../db");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const { authMiddleware, getUserId } = require("../middleware/auth");

const router = express.Router();
// ===== STOCK ALERT CONFIG =====
const STOCK_CONFIG = {
  CRITICAL_DAYS: 4,
  WARNING_DAYS: 15,
  REORDER_TARGET_DAYS: 21,
  REORDER_LIMIT: 8,
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

function formatCurrency(value) {
  return currencyFormatter.format(Number(value) || 0);
}

function formatIstDate(value) {
  return dateFormatter.format(new Date(value));
}

function safeFilePart(value) {
  return String(value || "report")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

async function getShopName(userId) {
  const result = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(shop_name), ''), 'India Inventory Management') AS shop_name
     FROM settings
     WHERE user_id = $1
     LIMIT 1`,
    [userId],
  );

  return result.rows[0]?.shop_name || "India Inventory Management";
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

// ✅ Protect all routes
router.use(authMiddleware);

// ------------------------------- ADD ITEMS ---------------------------------------

// Add or update stock item

// Define POST API endpoint: /items
router.post("/items", async (req, res) => {
  try {
    const user_id = getUserId(req); // Extract logged-in user's ID from JWT token
    const { name, quantity, buying_rate, selling_rate } = req.body; // Get data sent from client
    // Validate required fields
    if (
      !name || // Item name must exist
      quantity == null || // Quantity must be provided
      buying_rate == null || // Buying rate must be provided
      selling_rate == null // Selling rate must be provided
    ) {
      return res.status(400).json({ error: "Missing fields" }); // Return 400 if validation fails
    }

    const qty = parseFloat(quantity); // Convert quantity to number
    const buyRate = parseFloat(buying_rate); // Convert buying_rate to number
    const sellRate = parseFloat(selling_rate); // Convert selling_rate to number
    if (qty < 0 || buyRate < 0 || sellRate < 0) {
      return res.status(400).json({ error: "Negative Quantity not allowed" });
    }

    // Check if the item already exists for this user
    const check = await pool.query(
      "SELECT * FROM items WHERE user_id=$1 AND LOWER(TRIM(name))=LOWER($2)",
      [user_id, name.trim()], // Parameterized query to prevent SQL injection
    );

    // If item already exists
    if (check.rows.length > 0) {
      const existing = check.rows[0]; // Get existing item data
      const newQty = parseFloat(existing.quantity) + qty; // Add new quantity to existing quantity

      const result = await pool.query(
        `
          UPDATE items
          SET
            quantity = $1,
            buying_rate = $2,
            selling_rate = $3,
            updated_at = NOW()
          WHERE id = $4 AND user_id = $5
          RETURNING *
          `,
        [newQty, buyRate, sellRate, existing.id, user_id],
      );

      return res.json({ message: "Stock updated", item: result.rows[0] });
    } else {
      const result = await pool.query(
        `
      INSERT INTO items (user_id, name, quantity, buying_rate, selling_rate)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
        [user_id, name.trim(), qty, buyRate, sellRate],
      );

      return res.json({ message: "New item added", item: result.rows[0] });
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "production")
      console.error("Error in POST /items:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Auto-suggest item names
router.get("/items/names", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const result = await pool.query(
      "SELECT name FROM items WHERE user_id=$1 ORDER BY name ASC",
      [user_id],
    );
    res.json(result.rows.map((r) => r.name));
  } catch (err) {
    if (process.env.NODE_ENV !== "production")
      console.error("Error fetching item names:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/items/info", async (req, res) => {
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
});

// ----------------- ITEM WISE STOCK & SALES REPORT (JSON) -----------------
router.get("/items/report", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const { name } = req.query;

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

    res.json(result.rows);
  } catch (err) {
    console.error("Item report error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------- STOCK ALERTS (Days of Stock Model) -----------------
router.get("/items/low-stock", async (req, res) => {
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
});

// ----------------- REORDER SUGGESTIONS (Replenishment Planner) -----------------
router.get("/items/reorder-suggestions", async (req, res) => {
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
        reorder_cost: Number(row.reorder_cost) || recommendedReorderQty * buyingRate,
      };
    });

    res.json(rowsWithPriority);
  } catch (err) {
    console.error("Reorder suggestions error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------- ITEM WISE STOCK & SALES REPORT (PDF) -----------------
router.get("/items/report/pdf", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const { name } = req.query;
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
    const stockColumns = [
      { label: "Sl", x: 46, width: 28 },
      { label: "Item Name", x: 78, width: 180 },
      { label: "Available", x: 262, width: 72, align: "right" },
      { label: "Buying", x: 338, width: 72, align: "right" },
      { label: "Selling", x: 414, width: 72, align: "right" },
      { label: "Sold", x: 490, width: 54, align: "right" },
    ];

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
    const startX = 40;
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
        width: 150,
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
      doc.text(i + 1, startX, y, { width: 30 });
      doc.text(r.item_name || "", startX + 30, y, { width: 190 });
      doc.text(qty.toFixed(2), startX + 220, y, { width: 70, align: "right" });
      doc.text(formatCurrency(buy), startX + 290, y, {
        width: 80,
        align: "right",
      });
      doc.text(formatCurrency(sell), startX + 370, y, {
        width: 80,
        align: "right",
      });
      doc.text(Number(r.sold_qty).toFixed(2), startX + 450, y, {
        width: 65,
        align: "right",
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
    const summaryHeight = 88;

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

    doc.fillColor(PDF_THEME.ink);
    doc.end();
  } catch (err) {
    console.error("Item report PDF error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------- SALES REPORT table (JSON PREVIEW) -----------------
router.get("/sales/report", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: "Missing date range" });
    }

    const result = await pool.query(
      `SELECT
        s.created_at,
        i.name AS item_name,
        s.quantity,
        s.selling_price,
        s.total_price
       FROM sales s
       JOIN items i ON i.id = s.item_id
        WHERE s.user_id = $1
          AND (s.created_at AT TIME ZONE 'Asia/Kolkata')::date >= $2::date
          AND (s.created_at AT TIME ZONE 'Asia/Kolkata')::date <= $3::date
      ORDER BY s.created_at ASC`,
      [user_id, from, to],
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Sales report JSON error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------- SALES REPORT (PDF DOWNLOAD) -----------------
router.get("/sales/report/pdf", async (req, res) => {
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
        s.total_price
       FROM sales s
       JOIN items i ON i.id = s.item_id
        WHERE s.user_id = $1
          AND (s.created_at AT TIME ZONE 'Asia/Kolkata')::date >= $2::date
          AND (s.created_at AT TIME ZONE 'Asia/Kolkata')::date <= $3::date
      ORDER BY s.created_at ASC`,
      [user_id, from, to],
    );

    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const salesColumns = [
      { label: "Sl", x: 46, width: 28 },
      { label: "Date", x: 78, width: 78 },
      { label: "Item", x: 160, width: 190 },
      { label: "Qty", x: 354, width: 44, align: "right" },
      { label: "Rate", x: 402, width: 68, align: "right" },
      { label: "Total", x: 474, width: 70, align: "right" },
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
    let grandTotal = 0;

    result.rows.forEach((r, i) => {
      // 🔒 Page overflow protection
      if (doc.y > 720) {
        doc.addPage();
        drawPdfTableHeader(doc, salesColumns);
      }

      const y = doc.y;

      // 👉 calculate dynamic height for item name
      const itemHeight = doc.heightOfString(r.item_name || "", {
        width: 200,
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
      doc.text(i + 1, startX, y, { width: 30 });
      doc.text(saleDate, startX + 30, y, { width: 80 });
      doc.text(r.item_name || "", startX + 110, y, { width: 170 });
      doc.text(r.quantity, startX + 280, y, { width: 50, align: "right" });
      doc.text(formatCurrency(r.selling_price), startX + 330, y, {
        width: 80,
        align: "right",
      });
      doc.text(formatCurrency(r.total_price), startX + 410, y, {
        width: 100,
        align: "right",
      });
      doc
        .moveTo(40, y + Math.max(itemHeight, 18) + 2)
        .lineTo(555, y + Math.max(itemHeight, 18) + 2)
        .strokeColor(PDF_THEME.line)
        .stroke();

      // 👉 move y based on tallest content
      doc.y = y + Math.max(itemHeight, 18) + 6;

      grandTotal += Number(r.total_price);
    });

    const totalBoxHeight = 46;
    ensurePdfSpace(doc, totalBoxHeight + 12, () =>
      drawPdfTableHeader(doc, salesColumns),
    );

    const totalY = doc.y + 6;
    doc.save();
    doc
      .roundedRect(360, totalY, 195, totalBoxHeight, 12)
      .fillAndStroke("#f8fbff", PDF_THEME.line);
    doc.restore();

    doc.font("Helvetica-Bold").fontSize(11).fillColor(PDF_THEME.navy);
    doc.text("Grand Total", 376, totalY + 12, { width: 90 });
    doc.text(`Rs. ${formatCurrency(grandTotal)}`, 446, totalY + 12, {
      width: 92,
      align: "right",
    });

    doc.fillColor(PDF_THEME.ink);

    doc.end();
  } catch (err) {
    console.error("Sales PDF error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------- SALES REPORT (EXCEL DOWNLOAD) -----------------
router.get("/sales/report/excel", async (req, res) => {
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
        s.total_price
       FROM sales s
       JOIN items i ON i.id = s.item_id
        WHERE s.user_id = $1
          AND (s.created_at AT TIME ZONE 'Asia/Kolkata')::date >= $2::date
          AND (s.created_at AT TIME ZONE 'Asia/Kolkata')::date <= $3::date
      ORDER BY s.created_at ASC`,
      [user_id, from, to],
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sales Report");
    workbook.creator = "India Inventory Management";
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
      { header: "Amount", key: "total", width: 14 },
    ];

    sheet.insertRow(1, [`Sales Report`]);
    sheet.mergeCells("A1:F1");
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

    sheet.insertRow(2, [shopName]);
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
      `From: ${from}   To: ${to}   |   Generated: ${formatIstDate(new Date())}`,
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

    let grandTotal = 0;

    result.rows.forEach((r, i) => {
      const saleDate = formatIstDate(r.created_at);
      const row = sheet.addRow({
        sl: i + 1,
        date: saleDate,
        item: r.item_name,
        qty: r.quantity,
        rate: Number(r.selling_price),
        total: Number(r.total_price),
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

      grandTotal += Number(r.total_price);
    });

    // ----------------- Grand Total -----------------
    sheet.addRow([]);

    const totalRow = sheet.addRow({
      item: "Grand Total (Rs.)",
      total: grandTotal,
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
    totalRow.getCell("F").numFmt = "#,##0.00";
    totalRow.getCell("C").alignment = { horizontal: "right" };
    totalRow.getCell("F").alignment = { horizontal: "right" };

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
});

async function fetchGstReportRows(userId, from, to) {
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
       AND (i.date AT TIME ZONE 'Asia/Kolkata')::date >= $2::date
       AND (i.date AT TIME ZONE 'Asia/Kolkata')::date <= $3::date
     ORDER BY i.date ASC, i.id ASC`,
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
router.get("/gst/report", async (req, res) => {
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
});

// ----------------- GST REPORT (PDF DOWNLOAD) -----------------
router.get("/gst/report/pdf", async (req, res) => {
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
});

// ----------------- GST REPORT (EXCEL DOWNLOAD) -----------------
router.get("/gst/report/excel", async (req, res) => {
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
    workbook.creator = "India Inventory Management";
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

    sheet.insertRow(2, [shopName]);
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
        invoice: row.invoice_no,
        customer: row.customer_name,
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
});

// ------------------- CUSTOMER DEBTS -------------------

router.post("/debts", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const {
      customer_name,
      customer_number,
      total = 0,
      credit = 0,
      remark,
    } = req.body;

    if (!customer_name || !/^\d{10}$/.test(customer_number))
      return res
        .status(400)
        .json({ error: "Valid name and 10-digit number required" });

    const result = await pool.query(
      `INSERT INTO debts (user_id, customer_name, customer_number, total, credit, remark)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [user_id, customer_name, customer_number, total, credit, remark],
    );

    res.json({
      message: "Debt entry added successfully",
      debt: result.rows[0],
    });
  } catch (err) {
    if (process.env.NODE_ENV !== "production")
      console.error("Error in POST /debts:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------- CUSTOMER AUTOSUGGEST -----------------
router.get("/debts/customers", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const { q } = req.query;

    let query = `
      SELECT DISTINCT customer_name, customer_number
      FROM debts
      WHERE user_id = $1
    `;
    let params = [user_id];

    if (q && q.trim()) {
      query += `
        AND (
          customer_name ILIKE $2
          OR customer_number ILIKE $2
        )
      `;
      params.push(`%${q.trim()}%`);
    }

    query += ` ORDER BY customer_name ASC LIMIT 20`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Customer dropdown error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Full ledger
router.get("/debts/:number", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const number = req.params.number;

    if (!/^\d{10}$/.test(number))
      return res
        .status(400)
        .json({ error: "Customer number must be 10 digits" });

    const result = await pool.query(
      `SELECT id, customer_name, customer_number, total, credit, remark, created_at
       FROM debts
       WHERE user_id=$1 AND customer_number=$2
       ORDER BY created_at ASC`,
      [user_id, number],
    );

    res.json(result.rows);
  } catch (err) {
    if (process.env.NODE_ENV !== "production")
      console.error("Error in GET /debts/:number:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Summary dues
router.get("/debts", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const result = await pool.query(
      `SELECT customer_name, customer_number,
              SUM(total) AS total,
              SUM(credit) AS credit,
              SUM(total - credit) AS balance
       FROM debts
       WHERE user_id=$1
       GROUP BY customer_name, customer_number
       ORDER BY customer_name ASC`,
      [user_id],
    );

    res.json(result.rows);
  } catch (err) {
    if (process.env.NODE_ENV !== "production")
      console.error("Error in GET /debts:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/dashboard/overview", async (req, res) => {
  try {
    const user_id = getUserId(req);

    const [catalogResult, lowStockResult, dueResult] = await Promise.all([
      pool.query(
        `
        SELECT
          COUNT(*) AS item_count,
          COALESCE(SUM(quantity), 0) AS total_units,
          COALESCE(SUM(quantity * buying_rate), 0) AS total_cost_value,
          COALESCE(SUM(quantity * selling_rate), 0) AS total_selling_value
        FROM items
        WHERE user_id = $1
        `,
        [user_id],
      ),
      pool.query(
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
        )
        SELECT
          COUNT(*) AS low_stock_count,
          MIN(days_left) AS shortest_days_left,
          (ARRAY_AGG(item_name ORDER BY days_left ASC NULLS LAST))[1] AS most_urgent_item
        FROM low_stock
        `,
        [user_id, STOCK_CONFIG.WARNING_DAYS],
      ),
      pool.query(
        `
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
        `,
        [user_id],
      ),
    ]);

    res.json({
      catalog: catalogResult.rows[0],
      alerts: lowStockResult.rows[0],
      dues: dueResult.rows[0],
    });
  } catch (err) {
    console.error("Dashboard overview error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Global error handler
router.use((err, req, res, next) => {
  console.error("Unhandled route error:", err.message);
  res.status(500).json({ error: "Unexpected server error" });
});

// ----------------- MONTHLY SALES + PROFIT TREND -----------------
router.get("/sales/monthly-trend", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const yearParam = req.query.year;

    let yearFilter = "";

    if (yearParam && yearParam !== "all") {
      yearFilter = "AND EXTRACT(YEAR FROM s.created_at) = $2";
    }

    const params =
      yearParam && yearParam !== "all" ? [user_id, yearParam] : [user_id];

    const result = await pool.query(
      `
      SELECT 
        TO_CHAR(s.created_at, 'Mon') AS month,
        SUM(s.total_price) AS total_sales,
        SUM((s.selling_price - i.buying_rate) * s.quantity) AS total_profit
      FROM sales s
      JOIN items i ON i.id = s.item_id
      WHERE s.user_id = $1
      ${yearFilter}
      GROUP BY month
      ORDER BY MIN(s.created_at)
      `,
      params,
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Monthly trend error:", err);
    res.status(500).json({ error: "Server error" });
  }
});
// ----------------- MONTHLY SALES + PROFIT TREND end -----------------

// ----------------- LAST 13 MONTH SALES CHART -----------------
router.get("/sales/last-13-months", async (req, res) => {
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
});
// ----------------- LAST 13 MONTH SALES CHART end -----------------

module.exports = router;
