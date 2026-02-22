// routes/inventory.js
const express = require("express");
const pool = require("../db");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const { authMiddleware, getUserId } = require("../middleware/auth");

const router = express.Router();

// ✅ Protect all routes
router.use(authMiddleware);

// ------------------------------- ADD ITEMS ---------------------------------------

// Add or update stock item
router.post("/items", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const { name, quantity, buying_rate, selling_rate } = req.body;

    if (
      !name ||
      quantity == null ||
      buying_rate == null ||
      selling_rate == null
    ) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const qty = parseFloat(quantity);
    const buyRate = parseFloat(buying_rate);
    const sellRate = parseFloat(selling_rate);


    const check = await pool.query(
      "SELECT * FROM items WHERE user_id=$1 AND LOWER(TRIM(name))=LOWER($2)",
      [user_id, name.trim()]
    );

    if (check.rows.length > 0) {
      const existing = check.rows[0];
      const newQty = parseFloat(existing.quantity) + qty;

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
        [newQty, buyRate, sellRate, existing.id, user_id]
      );

      return res.json({ message: "Stock updated", item: result.rows[0] });
    } else {
      const result = await pool.query(
        `
      INSERT INTO items (user_id, name, quantity, buying_rate, selling_rate)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
        [user_id, name.trim(), qty, buyRate, sellRate]
      );

      return res.json({ message: "New item added", item: result.rows[0] });
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "production") console.error("Error in POST /items:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Auto-suggest item names
router.get("/items/names", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const result = await pool.query(
      "SELECT name FROM items WHERE user_id=$1 ORDER BY name ASC",
      [user_id]
    );
    res.json(result.rows.map(r => r.name));
  } catch (err) {
    if (process.env.NODE_ENV !== "production") console.error("Error fetching item names:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/items/info", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: "Missing item name" });

    const result = await pool.query(
      `SELECT id, name, quantity, selling_rate
       FROM items
       WHERE user_id=$1 AND LOWER(TRIM(name))=LOWER($2)`,
      [user_id, name.trim()]
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
        i.selling_rate,
        COALESCE(SUM(s.quantity), 0) AS sold_qty
      FROM items i
      LEFT JOIN sales s
        ON s.item_id = i.id
        AND s.user_id = $1
      WHERE i.user_id = $1
      ${nameFilter}
      GROUP BY i.id, i.name, i.quantity, i.selling_rate
      ORDER BY i.name ASC
      `,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Item report error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------- ITEM WISE STOCK & SALES REPORT (PDF) -----------------
router.get("/items/report/pdf", async (req, res) => {
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
        i.selling_rate,
        COALESCE(SUM(s.quantity), 0) AS sold_qty
      FROM items i
      LEFT JOIN sales s
        ON s.item_id = i.id
        AND s.user_id = $1
      WHERE i.user_id = $1
      ${nameFilter}
      GROUP BY i.id, i.name, i.quantity, i.selling_rate
      ORDER BY i.name ASC
      `,
      params
    );

    const doc = new PDFDocument({ size: "A4", margin: 40 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=item_report.pdf`
    );

    doc.pipe(res);

    // ---- Header ----
    doc.fontSize(16).text("Stock Report", { align: "center" });
    doc.moveDown(0.5);

    // ---- Table Header ----
    function drawStockTableHeader(doc) {
      const startX = 40;
      const y = doc.y;

      doc.fontSize(10).font("Helvetica-Bold");
      doc.text("Sl", startX, y, { width: 30 });
      doc.text("Item Name", startX + 30, y, { width: 200 });
      doc.text("Available", startX + 230, y, { width: 80, align: "right" });
      doc.text("Rate", startX + 310, y, { width: 80, align: "right" });
      doc.text("Sold", startX + 390, y, { width: 80, align: "right" });

      doc.moveDown(0.5);
      doc.font("Helvetica");
    }

    // ✅ draw table header for first page
    drawStockTableHeader(doc);

    // ---- Rows ----
    const startX = 40;

    result.rows.forEach((r, i) => {

      // 🔒 Page overflow handling (same as Sales PDF)
      if (doc.y > 720) {
        doc.addPage();
        drawStockTableHeader(doc);
      }

      const y = doc.y;

      // 👉 Dynamic height based on item name
      const itemHeight = doc.heightOfString(r.item_name || "", {
        width: 200,
        align: "left",
      });

      doc.text(i + 1, startX, y, { width: 30 });
      doc.text(r.item_name || "", startX + 30, y, { width: 200 });
      doc.text(Number(r.available_qty).toFixed(2), startX + 230, y, { width: 80, align: "right" });
      doc.text(Number(r.selling_rate).toFixed(2), startX + 310, y, { width: 80, align: "right" });
      doc.text(Number(r.sold_qty).toFixed(2), startX + 390, y, { width: 80, align: "right" });

      // 👉 Move Y exactly like Sales PDF
      doc.y = y + Math.max(itemHeight, 18) + 6;
    });

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
      [user_id, from, to]
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
      [user_id, from, to]
    );

    const doc = new PDFDocument({ margin: 40, size: "A4" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=sales_report_${from}_to_${to}.pdf`
    );

    doc.pipe(res);

    // ---- Header ----
    doc.fontSize(16).text("Sales Report", { align: "center" });
    doc.moveDown(0.5);

    doc
      .fontSize(10)
      .text(`From: ${from}    To: ${to}`, { align: "center" });

    doc.moveDown(1);

    // ---- Table Header ----
    const startX = 40;
    let y = doc.y;

    doc.fontSize(10).font("Helvetica-Bold");
    doc.text("Sl", startX, y, { width: 30 });
    doc.text("Item", startX + 30, y, { width: 200 });
    doc.text("Qty", startX + 230, y, { width: 50, align: "right" });
    doc.text("Rate", startX + 280, y, { width: 80, align: "right" });
    doc.text("Total", startX + 360, y, { width: 100, align: "right" });

    doc.moveDown(0.5);
    doc.font("Helvetica");

    // ---- Rows ----
    // ---- Rows ----
    let grandTotal = 0;

    result.rows.forEach((r, i) => {

      // 🔒 Page overflow protection
      if (doc.y > 720) {
        doc.addPage();
        doc.fontSize(10).font("Helvetica-Bold");

        let yHeader = doc.y;
        doc.text("Sl", startX, yHeader, { width: 30 });
        doc.text("Item", startX + 30, yHeader, { width: 200 });
        doc.text("Qty", startX + 230, yHeader, { width: 50, align: "right" });
        doc.text("Rate", startX + 280, yHeader, { width: 80, align: "right" });
        doc.text("Total", startX + 360, yHeader, { width: 100, align: "right" });

        doc.moveDown(0.5);
        doc.font("Helvetica");
      }

      const y = doc.y;

      // 👉 calculate dynamic height for item name
      const itemHeight = doc.heightOfString(r.item_name || "", {
        width: 200,
        align: "left",
      });

      doc.text(i + 1, startX, y, { width: 30 });
      doc.text(r.item_name || "", startX + 30, y, { width: 200 });
      doc.text(r.quantity, startX + 230, y, { width: 50, align: "right" });
      doc.text(Number(r.selling_price).toFixed(2), startX + 280, y, { width: 80, align: "right" });
      doc.text(Number(r.total_price).toFixed(2), startX + 360, y, { width: 100, align: "right" });

      // 👉 move y based on tallest content
      doc.y = y + Math.max(itemHeight, 18) + 6;

      grandTotal += Number(r.total_price);
    });

    // ---- Footer Total ----
    doc.moveDown(1);
    doc.font("Helvetica-Bold");
    doc.text(`Grand Total: Rs. ${grandTotal.toFixed(2)}`, {
      align: "right",
    });



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
      [user_id, from, to]
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sales Report");

    // 1️⃣ Column headers FIRST
    sheet.columns = [
      { header: "Sl No", key: "sl", width: 8 },
      { header: "Item Name", key: "item", width: 30 },
      { header: "Quantity", key: "qty", width: 12 },
      { header: "Rate", key: "rate", width: 12 },
      { header: "Amount", key: "total", width: 14 },
    ];

    // style header row (row-1)
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = { horizontal: "center" };
    headerRow.eachCell(cell => {
      cell.border = {
        top: { style: "thin" },
        bottom: { style: "thin" },
        left: { style: "thin" },
        right: { style: "thin" },
      };
    });

    // 2️⃣ Insert title rows ABOVE data (not splice)
    sheet.insertRow(1, []);
    sheet.insertRow(1, [`Sales Report`]);
    sheet.mergeCells("A1:E1");
    sheet.getCell("A1").font = { size: 16, bold: true };
    sheet.getCell("A1").alignment = { horizontal: "center" };

    sheet.insertRow(2, [`From: ${from}   To: ${to}`]);
    sheet.mergeCells("A2:E2");
    sheet.getCell("A2").alignment = { horizontal: "center" };

    // 3️⃣ Data rows
    let grandTotal = 0;

    result.rows.forEach((r, i) => {
      const row = sheet.addRow({
        sl: i + 1,
        item: r.item_name,
        qty: r.quantity,
        rate: Number(r.selling_price),
        total: Number(r.total_price),
      });

      row.eachCell(cell => {
        cell.border = {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" },
        };
      });

      row.getCell(4).numFmt = "#,##0.00";
      row.getCell(5).numFmt = "#,##0.00";

      grandTotal += Number(r.total_price);
    });

    // ----------------- Grand Total -----------------
    sheet.addRow([]);

    const totalRow = sheet.addRow({
      item: "Grand Total (Rs.)",
      total: grandTotal,
    });

    totalRow.font = { bold: true };
    totalRow.getCell("E").numFmt = "#,##0.00";
    totalRow.alignment = { horizontal: "right" };

    // ----------------- Response -----------------
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=sales_report_${from}_to_${to}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error("Sales Excel error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});





// ------------------- CUSTOMER DEBTS -------------------

router.post("/debts", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const { customer_name, customer_number, total = 0, credit = 0 } = req.body;

    if (!customer_name || !/^\d{10}$/.test(customer_number))
      return res.status(400).json({ error: "Valid name and 10-digit number required" });

    const result = await pool.query(
      `INSERT INTO debts (user_id, customer_name, customer_number, total, credit)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [user_id, customer_name, customer_number, total, credit]
    );

    res.json({ message: "Debt entry added successfully", debt: result.rows[0] });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") console.error("Error in POST /debts:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Full ledger
router.get("/debts/:number", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const number = req.params.number;

    if (!/^\d{10}$/.test(number))
      return res.status(400).json({ error: "Customer number must be 10 digits" });

    const result = await pool.query(
      `SELECT id, customer_name, customer_number, total, credit, created_at
       FROM debts
       WHERE user_id=$1 AND customer_number=$2
       ORDER BY created_at ASC`,
      [user_id, number]
    );

    res.json(result.rows);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") console.error("Error in GET /debts/:number:", err);
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
      [user_id]
    );

    res.json(result.rows);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") console.error("Error in GET /debts:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Global error handler
router.use((err, req, res, next) => {
  console.error("Unhandled route error:", err.message);
  res.status(500).json({ error: "Unexpected server error" });
});


// ===================== ANALYTICS SUMMARY STOCK, TOTAL SALE, MONTHLY SALE CHART =====================
router.get("/analytics/summary", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);

    // Total Stock Value
    const stockResult = await pool.query(
      `SELECT COALESCE(SUM(quantity * selling_rate), 0) AS total_stock
       FROM items
       WHERE user_id = $1`,
      [userId]
    );

    // Total Sales Value
    const totalSalesResult = await pool.query(
      `SELECT COALESCE(SUM(total_price), 0) AS total_sales
       FROM sales
       WHERE user_id = $1`,
      [userId]
    );

    // Monthly Sales Value
    const monthlySalesResult = await pool.query(
      `SELECT COALESCE(SUM(total_price), 0) AS monthly_sales
       FROM sales
       WHERE user_id = $1
       AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)`,
      [userId]
    );

    res.json({
      total_stock: stockResult.rows[0].total_stock,
      total_sales: totalSalesResult.rows[0].total_sales,
      monthly_sales: monthlySalesResult.rows[0].monthly_sales,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load analytics" });
  }
});


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
      [user_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Last 13 months chart error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;