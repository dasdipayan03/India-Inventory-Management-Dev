// routes/inventory.js
const express = require("express");
const pool = require("../db");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const { authMiddleware, getUserId } = require("../middleware/auth");

const router = express.Router();

// ✅ Protect all routes
router.use(authMiddleware);

// ------------------------------- ITEMS ---------------------------------------

// Add or update stock item
router.post("/items", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const { name, quantity, buyingRate, sellingRate } = req.body;

    if (!name || quantity == null || buyingRate == null || sellingRate == null)
      return res.status(400).json({ error: "Missing fields" });
    const qty = parseFloat(quantity);
    const buy = parseFloat(buyingRate);
    const sell = parseFloat(sellingRate);

    if (isNaN(qty) || isNaN(buy) || isNaN(sell))
      return res.status(400).json({ error: "Invalid numeric values" });

    const check = await pool.query(
      "SELECT * FROM items WHERE user_id=$1 AND LOWER(TRIM(name))=LOWER($2)",
      [user_id, name.trim()]
    );

    if (check.rows.length > 0) {
      const existing = check.rows[0];
      const newQty = parseFloat(existing.quantity) + qty;

      const result = await pool.query(
        `UPDATE items
         SET quantity=$1,
             buying_rate=$2,
             selling_rate=$3,
             updated_at=NOW()
         WHERE id=$4 AND user_id=$5
         RETURNING *`,
        [newQty, buy, sell, existing.id, user_id]
      );

      return res.json({ message: "Stock updated", item: result.rows[0] });
    } else {
      const result = await pool.query(
        `INSERT INTO items
         (user_id, name, quantity, buying_rate, selling_rate)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [user_id, name.trim(), qty, buy, sell]
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
      [user_id]
    );
    res.json(result.rows.map(r => r.name));
  } catch (err) {
    if (process.env.NODE_ENV !== "production") console.error("Error fetching item names:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Get stock info
router.get("/items/info", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const name = req.query.name;

    if (!name) {
      return res.status(400).json({ error: "Missing item name" });
    }

    const result = await pool.query(
      `SELECT id, name, quantity, selling_rate
       FROM items
       WHERE user_id=$1
       AND LOWER(TRIM(name)) = LOWER($2)`,
      [user_id, name.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Item not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error in GET /items/info:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// ----------------- SALES -----------------

router.post("/sales", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const { name, quantity, actualPrice } = req.body;

    if (!name || !quantity || !actualPrice)
      return res.status(400).json({ error: "Missing fields" });

    const check = await pool.query(
      "SELECT * FROM items WHERE user_id=$1 AND LOWER(TRIM(name))=LOWER($2)",
      [user_id, name.trim()]
    );

    if (check.rows.length === 0)
      return res.status(404).json({ error: "Item not found" });

    const existing = check.rows[0];
    const qty = parseFloat(quantity);
    if (existing.quantity < qty)
      return res.status(400).json({ error: "Not enough stock" });

    const newQty = existing.quantity - qty;

    await pool.query(
      "UPDATE items SET quantity=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
      [newQty, existing.id, user_id]
    );

    const sale = await pool.query(
      "INSERT INTO sales (user_id, item_id, quantity, selling_price, actual_price) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [user_id, existing.id, qty, existing.rate * qty, actualPrice]
    );

    res.json({ message: "Sale recorded", sale: sale.rows[0] });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") console.error("Error in POST /sales:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------- SALES REPORTS -----------------

router.get("/sales/report/pdf", async (req, res) => {
  try {
    const user_id = getUserId(req);
    const { from, to } = req.query;
    if (!from || !to)
      return res.status(400).json({ error: "Missing date range" });

    const result = await pool.query(
      `SELECT s.id, i.name, s.quantity, s.selling_price, s.actual_price, s.created_at
      FROM sales s
      JOIN items i ON s.item_id = i.id
      WHERE s.user_id = $1
        AND s.created_at >= ($2::date)
        AND s.created_at < ($3::date + INTERVAL '1 day')
      ORDER BY s.created_at ASC`,
      [user_id, from, to]
    );


    const rows = result.rows;
    if (rows.length === 0)
      return res.status(404).json({ error: "No sales found" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=Sales_Report_${Date.now()}.pdf`);

    const doc = new PDFDocument({ margin: 30, size: "A4" });
    doc.pipe(res);

    doc.fontSize(18).text("Sales Report", { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(`From: ${from}  To: ${to}`);
    doc.moveDown();

    const headers = ["#", "Item", "Qty", "Calc Price", "Actual Price", "Date"];
    const columnWidths = [30, 120, 50, 80, 80, 100];
    let startY = doc.y + 10;
    let startX = doc.x;

    doc.font("Helvetica-Bold").fontSize(10);
    headers.forEach((h, i) => {
      doc.text(h, startX, startY, { width: columnWidths[i], align: "center" });
      startX += columnWidths[i];
    });
    doc.moveTo(30, startY + 15).lineTo(550, startY + 15).stroke();

    doc.font("Helvetica").fontSize(9);
    let y = startY + 20;
    let total = 0;

    rows.forEach((r, idx) => {
      let x = 30;
      const qty = Number(r.quantity) || 0;
      const calc = Number(r.selling_price) || 0;
      const actual = Number(r.actual_price) || 0;
      const date = new Date(r.created_at).toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata'
      });

      total += actual;

      const row = [
        (idx + 1).toString(),
        r.name || "",
        qty.toString(),
        calc.toFixed(2),
        actual.toFixed(2),
        date,
      ];

      row.forEach((val, i) => {
        doc.text(val, x, y, { width: columnWidths[i], align: "center" });
        x += columnWidths[i];
      });

      y += 20;
      if (y > 750) {
        doc.addPage();
        y = 50;
      }
    });

    doc.moveDown();
    doc.fontSize(12).font("Helvetica-Bold").text(`TOTAL: ${total.toFixed(2)}`, { align: "right" });
    doc.end();
  } catch (err) {
    if (process.env.NODE_ENV !== "production") console.error("Error generating PDF report:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Excel Report
router.get("/sales/report/excel", async (req, res) => {
  try {
    const user_id = getUserId(req);
    let { from, to } = req.query;
    if (!from || !to)
      return res.status(400).json({ error: "Missing date range" });

    const result = await pool.query(
      `SELECT s.id, i.name, s.quantity, s.selling_price, s.actual_price, s.created_at
       FROM sales s
       JOIN items i ON s.item_id = i.id
      AND s.created_at >= ($2::date)
      AND s.created_at < ($3::date + INTERVAL '1 day')
      BETWEEN $2 AND $3

       ORDER BY s.created_at ASC`,
      [user_id, from, to]
    );

    const rows = result.rows;
    if (rows.length === 0)
      return res.status(404).json({ error: "No sales found" });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sales Report");
    sheet.addRow(["#", "Item", "Quantity", "Calc Price", "Actual Price", "Date"]);

    let total = 0;
    rows.forEach((r, idx) => {
      sheet.addRow([
        idx + 1,
        r.name,
        r.quantity,
        r.selling_price,
        r.actual_price,
        new Date(r.created_at).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata'
        })

      ]);
      total += Number(r.actual_price);
    });

    sheet.addRow([]);
    sheet.addRow(["", "", "", "TOTAL", total]);

    res.setHeader("Content-Disposition", `attachment; filename=Sales_Report_${Date.now()}.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    if (process.env.NODE_ENV !== "production") console.error("Error generating Excel report:", err);
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

module.exports = router;