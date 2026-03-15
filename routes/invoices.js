// routes/invoices.js
const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
const pool = require("../db");
const {
  authMiddleware,
  getUserId,
  requireAdmin,
  requirePermission,
} = require("../middleware/auth");

/* ---------------------- Helper: pad serial ---------------------- */
function padSerial(n) {
  return String(n).padStart(4, "0");
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

/* ---------------------- GET: Preview Next Invoice ---------------------- */
router.get("/invoices/new", authMiddleware, requirePermission("sale_invoice"), async (req, res) => {
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
});

/* ---------------------- POST: SAVE INVOICE (FINAL LOGIC) ---------------------- */
router.post("/invoices", authMiddleware, requirePermission("sale_invoice"), async (req, res) => {
  const userId = getUserId(req);
  const { customer_name, contact, address, gst_no, items } = req.body;

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ success: false, message: "No items" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { invoiceNo, dateKey } = await generateInvoiceNoWithClient(
      client,
      userId,
    );

    /* ---- calculate ---- */
    let subtotal = 0;
    const computed = items.map((i) => {
      const q = Number(i.quantity || 0);
      const r = Number(i.rate || 0);
      const a = +(q * r).toFixed(2);
      subtotal += a;
      return { description: i.description, quantity: q, rate: r, amount: a };
    });
    subtotal = +subtotal.toFixed(2);

    const gstR = await client.query(
      `SELECT gst_rate FROM settings WHERE user_id=$1`,
      [userId],
    );
    const gstRate = gstR.rows[0]?.gst_rate || 18;
    const gst_amount = +((subtotal * gstRate) / 100).toFixed(2);
    const total_amount = +(subtotal + gst_amount).toFixed(2);

    /* ---- invoice ---- */
    const inv = await client.query(
      `
          INSERT INTO invoices
          (invoice_no,user_id,gst_no,customer_name,contact,address,
           subtotal,gst_amount,total_amount,date)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING id
        `,
      [
        invoiceNo,
        userId,
        gst_no || null,
        customer_name || null,
        contact || null,
        address || null,
        subtotal,
        gst_amount,
        total_amount,
        new Date(),
      ],
    );

    const invoiceId = inv.rows[0].id;

    /* ---- invoice_items + stock + sales ---- */
    for (const it of computed) {
      await client.query(
        `
              INSERT INTO invoice_items
              (invoice_id,description,quantity,rate,amount)
              VALUES ($1,$2,$3,$4,$5)
            `,
        [invoiceId, it.description, it.quantity, it.rate, it.amount],
      );

      const itemRow = await client.query(
        `
              SELECT id, quantity FROM items
              WHERE user_id=$1 AND LOWER(TRIM(name))=LOWER(TRIM($2))
              FOR UPDATE
            `,
        [userId, it.description],
      );

      if (!itemRow.rowCount) {
        throw new Error(`Item not found: ${it.description}`);
      }
      if (itemRow.rows[0].quantity < it.quantity) {
        const available = itemRow.rows[0].quantity;
        throw new Error(`Faild !! Stock not sufficient`);
      }

      await client.query(
        `
              UPDATE items SET quantity = quantity - $1 WHERE id=$2
            `,
        [it.quantity, itemRow.rows[0].id],
      );

      await client.query(
        `
                INSERT INTO sales
                (user_id, item_id, quantity, selling_price, total_price)
                VALUES ($1, $2, $3, $4, $5)
                `,
        [
          userId,
          itemRow.rows[0].id,
          it.quantity,
          it.rate, // ✅ unit selling price
          it.amount, // ✅ total price
        ],
      );
    }

    await client.query("COMMIT");
    res.json({
      success: true,
      invoice_no: invoiceNo,
      date: new Date().toISOString(),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.message.includes("Stock not sufficient")) {
      res.status(400).json({ success: false, message: err.message });
    } else {
      res.status(500).json({ success: false, message: "Server error" });
    }
  } finally {
    client.release();
  }
});

//---------- invoice search dropdown -----------//
router.get("/invoices/numbers", authMiddleware, requirePermission("sale_invoice"), async (req, res) => {
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
});

/* ---------------------- GET: All Invoices List ---------------------- */
router.get("/invoices", authMiddleware, requirePermission("sale_invoice"), async (req, res) => {
  try {
    const rawQuery = String(req.query.q || "").trim().toLowerCase();
    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || 100, 1),
      200,
    );
    const params = [getUserId(req)];
    const filters = [];

    if (rawQuery) {
      params.push(`%${rawQuery}%`);
      const textFilterIndex = params.length;

      filters.push(`LOWER(i.invoice_no) LIKE $${textFilterIndex}`);
      filters.push(`LOWER(COALESCE(i.customer_name, '')) LIKE $${textFilterIndex}`);
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
    const { rows } = await pool.query(
      `
            SELECT
                i.date,
                i.invoice_no,
                i.customer_name,
                i.contact,
                i.total_amount,
                COUNT(ii.id)::int AS item_count
            FROM invoices i
            LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
            WHERE i.user_id = $1
            ${whereClause}
            GROUP BY i.id
            ORDER BY i.date DESC, i.id DESC
            LIMIT ${limit}
            `,
      params,
    );

    res.json({ success: true, invoices: rows });
  } catch (err) {
    console.error("All invoices fetch error:", err);
    res.status(500).json({ success: false });
  }
});

/* ---------------------- GET: Invoice Details ---------------------- */
router.get("/invoices/:invoiceNo", authMiddleware, requirePermission("sale_invoice"), async (req, res) => {
  const userId = getUserId(req);
  const { rows } = await pool.query(
    `
      SELECT i.*, COALESCE(json_agg(ii.*)
      FILTER (WHERE ii.id IS NOT NULL),'[]') AS items
      FROM invoices i
      LEFT JOIN invoice_items ii ON ii.invoice_id=i.id
      WHERE i.user_id=$2 AND i.invoice_no=$1
      GROUP BY i.id
    `,
    [req.params.invoiceNo, userId],
  );

  if (!rows[0]) return res.status(404).json({ success: false });
  res.json({ success: true, invoice: rows[0] });
});

//==================INVOICE PAGE FORMATING =========================
router.get(
  "/invoices/:invoiceNo/pdf",

  // 🔹 Token from URL support
  (req, res, next) => {
    if (req.query.token) {
      req.headers.authorization = "Bearer " + req.query.token;
    }
    next();
  },

  authMiddleware,
  requirePermission("sale_invoice"),

  async (req, res) => {
    const userId = getUserId(req);
    const invoiceNo = req.params.invoiceNo.replace(/['"%]+/g, "").trim();

    try {
      const q = `
          SELECT i.id, i.invoice_no, i.customer_name, i.contact, i.address, i.gst_no,
                 i.date, i.subtotal, i.gst_amount, i.total_amount,
                 COALESCE(json_agg(json_build_object(
                   'description', ii.description,
                   'quantity', ii.quantity,
                   'rate', ii.rate,
                   'amount', ii.amount
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

      const shopRes = await pool.query(
        `SELECT shop_name, shop_address, gst_no FROM settings WHERE user_id=$1`,
        [userId],
      );
      const shop = shopRes.rows[0] || {};

      const doc = new PDFDocument({
        size: "A4",
        margin: 40,
        bufferPages: true,
      });
      let pageNumber = 0;
      doc.on("pageAdded", () => {
        pageNumber++;
      });

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${inv.invoice_no}.pdf"`,
      );
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");

      doc.pipe(res);

      /* ================= PAGE HELPERS ================= */
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;

      function drawHeader() {
        doc.save();
        doc.rect(40, 30, 520, 70).fill("#f1f5f9");
        doc.restore();

        doc.fillColor("#000");

        doc
          .font("Helvetica-Bold")
          .fontSize(20)
          .text(shop.shop_name || "India Inventory Management", 50, 45);

        doc
          .font("Helvetica")
          .fontSize(10)
          .text(shop.shop_address || "", 50, 70)
          .text(`GSTIN: ${shop.gst_no || inv.gst_no || "N/A"}`, 50, 85);

        doc.font("Helvetica-Bold").fontSize(18).text("INVOICE", 430, 55);
      }

      function drawInvoiceInfo(startY) {
        doc.font("Helvetica").fontSize(10);

        doc.text(`Invoice No: ${inv.invoice_no}`, 40, startY);
        doc.text(
          `Date: ${new Date(inv.date).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
          })}`,
          40,
          startY + 15,
        );

        doc.text(`Customer: ${inv.customer_name || "-"}`, 320, startY);
        doc.text(`Contact: ${inv.contact || "-"}`, 320, startY + 15);
        doc.text(`Address: ${inv.address || "-"}`, 320, startY + 30, {
          width: 220,
        });
      }

      function drawTableHeader(startY) {
        doc.moveTo(40, startY).lineTo(560, startY).stroke();
        startY += 10;

        doc.font("Helvetica-Bold");
        doc.text("Item", 40, startY);
        doc.text("Qty", 280, startY, { width: 50, align: "right" });
        doc.text("Rate", 360, startY, { width: 70, align: "right" });
        doc.text("Amount", 460, startY, { width: 80, align: "right" });

        startY += 15;
        doc.moveTo(40, startY).lineTo(560, startY).stroke();

        doc.font("Helvetica");

        return startY + 5;
      }

      drawHeader();
      drawInvoiceInfo(130);
      let y = drawTableHeader(210);

      /* ================= TABLE ROWS ================= */
      for (const it of inv.items) {
        if (y > pageHeight - 120) {
          doc.addPage();
          drawHeader();
          drawInvoiceInfo(130);
          y = drawTableHeader(210);
        }

        y += 20;

        doc.text(it.description, 40, y, { width: 220 });
        doc.text(it.quantity, 280, y, { width: 50, align: "right" });
        doc.text(Number(it.rate).toFixed(2), 360, y, {
          width: 70,
          align: "right",
        });
        doc.text(Number(it.amount).toFixed(2), 460, y, {
          width: 80,
          align: "right",
        });
      }

      /* ================= TOTALS ================= */
      y += 30;
      if (y > pageHeight - 120) {
        doc.addPage();
        drawHeader();
        drawInvoiceInfo(130);
        y = drawTableHeader(210);
      }

      doc.font("Helvetica").fontSize(10);
      doc.text(
        `Subtotal: ${Number(inv.subtotal).toFixed(2)}`,
        360, // x position
        y,
        { width: 200, align: "right" },
      );

      doc.text(`GST: ${Number(inv.gst_amount).toFixed(2)}`, 360, y + 15, {
        width: 200,
        align: "right",
      });

      doc.font("Helvetica-Bold").fontSize(12);
      doc.text(`Total: ${Number(inv.total_amount).toFixed(2)}`, 360, y + 35, {
        width: 200,
        align: "right",
      });

      /* ================= FOOTER AND PAGE NUMBER ================= */
      const range = doc.bufferedPageRange();
      const totalPages = range.count;

      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);

        doc.font("Helvetica").fontSize(9);

        doc.text(
          "This is a system generated invoice. No signature required.",
          40,
          pageHeight - 80,
          { width: 520, align: "center" },
        );

        doc.text(`Page- ${i + 1} / ${totalPages}`, 40, pageHeight - 60, {
          width: 520,
          align: "right",
        });
      }

      doc.end();
    } catch (err) {
      console.error("❌ PDF error:", err);
      res
        .status(500)
        .json({ success: false, message: "PDF generation failed" });
    }
  },
);

/* ---------------------- SHOP INFO save ---------------------- */
router.post("/shop-info", authMiddleware, requireAdmin, async (req, res) => {
  const { shop_name, shop_address, gst_no, gst_rate } = req.body;
  const userId = getUserId(req);

  await pool.query(
    `
      INSERT INTO settings (user_id,shop_name,shop_address,gst_no,gst_rate)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (user_id)
      DO UPDATE SET
        shop_name=EXCLUDED.shop_name,
        shop_address=EXCLUDED.shop_address,
        gst_no=EXCLUDED.gst_no,
        gst_rate=EXCLUDED.gst_rate
    `,
    [userId, shop_name, shop_address, gst_no, gst_rate],
  );

  res.json({ success: true });
});

router.get("/shop-info", authMiddleware, requirePermission("sale_invoice"), async (req, res) => {
  const userId = getUserId(req);
  const { rows } = await pool.query(
    `SELECT shop_name,shop_address,gst_no,gst_rate FROM settings WHERE user_id=$1`,
    [userId],
  );
  res.json({ success: true, settings: rows[0] || {} });
});

module.exports = router;
