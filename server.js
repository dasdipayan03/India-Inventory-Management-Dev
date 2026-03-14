/**
 * =========================================================
 * FILE: server.js
 * ENTRY POINT: Application Bootstrap File
 *
 * PURPOSE:
 *  - Initialize Express app
 *  - Configure global middleware
 *  - Register API routes
 *  - Serve frontend
 *  - Handle errors
 *  - Start HTTP server
 *  - Handle graceful shutdown
 * =========================================================
 */

// =========================================================
// 📦 CORE DEPENDENCIES
// =========================================================
const express = require("express");
const path = require("path");

// =========================================================
// 🔐 SECURITY & PERFORMANCE MIDDLEWARE
// =========================================================
const helmet = require("helmet"); // Security headers
const cors = require("cors"); // Cross-origin access
const rateLimit = require("express-rate-limit"); // Rate limiting
const compression = require("compression"); // Gzip compression
const cookieParser = require("cookie-parser"); // Cookie parsing

// =========================================================
// 🗄 DATABASE
// =========================================================
const pool = require("./db");

// =========================================================
// 🚀 CREATE EXPRESS APP
// =========================================================
const app = express();

// Required for deployment platforms like Railway / Render
app.set("trust proxy", 1);

// =========================================================
// 🌐 GLOBAL MIDDLEWARE CONFIGURATION
// =========================================================

/**
 * Enable CORS
 * Allows frontend to send cookies & requests
 */
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(express.json()); // Parse incoming JSON requests
app.use(cookieParser()); // Parse cookies from client
app.use(compression()); // Compress responses for better performance

// Rate Limiter
// Max 200 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
});
app.use(limiter);

// =========================================================
// 🛡 CONTENT SECURITY POLICY (Helmet)
// Allows required CDN for Bootstrap & FontAwesome
// =========================================================
app.use(
  helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": [
        "'self'",
        "'unsafe-inline'",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
      ],
      "style-src": [
        "'self'",
        "'unsafe-inline'",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
      ],
      "img-src": ["'self'", "data:", "https://cdn.jsdelivr.net"],
      "font-src": [
        "'self'",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
      ],
      "connect-src": [
        "'self'",
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com",
      ],
    },
  }),
);

// =========================================================
// 📡 API ROUTES REGISTRATION
// =========================================================
app.use("/api/auth", require("./routes/auth"));
app.use("/api", require("./routes/inventory"));
app.use("/api", require("./routes/invoices"));

// =========================================================
// ❤️ HEALTH CHECK ROUTE (Railway stability)
// =========================================================
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// =========================================================
// 🛠 DEBUG ROUTES (Only in Development Mode)
// =========================================================
if (process.env.NODE_ENV !== "production") {
  // Check environment variables
  app.get("/debug-env", (req, res) => {
    res.json({
      NODE_ENV: process.env.NODE_ENV || "not set",
      PORT: process.env.PORT || "not set",
      DATABASE_URL: process.env.DATABASE_URL ? "✅ exists" : "❌ missing",
      JWT_SECRET: process.env.JWT_SECRET ? "✅ exists" : "❌ missing",
      EMAIL_USER: process.env.EMAIL_USER ? "✅ exists" : "❌ missing",
      EMAIL_PASS: process.env.EMAIL_PASS ? "✅ exists" : "❌ missing",
    });
  });

  // Test database connectivity
  app.get("/debug-db", async (req, res) => {
    try {
      const result = await pool.query("SELECT NOW()");
      res.json({ status: "✅ DB Connected", time: result.rows[0] });
    } catch (err) {
      res.status(500).json({ status: "❌ DB Error", message: err.message });
    }
  });
}

// =========================================================
// 🌍 FRONTEND STATIC FILE SERVING
// =========================================================
app.use(express.static(path.join(__dirname, "public")));

//Default route → login page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

/**
 * Fallback Route
 * - If API → return JSON 404
 * - Else → return login page
 */
app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ error: "API route not found" });
  }
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// =========================================================
// 🔥 GLOBAL ERROR HANDLER
// Catches unhandled errors from anywhere in app
// =========================================================
app.use((err, req, res, next) => {
  console.error("🔥 Global Error:", err);

  res.status(err.status || 500).json({
    error: "Internal Server Error",
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Something went wrong",
  });
});

// =========================================================
// 🚀 START SERVER
// =========================================================
const PORT = process.env.PORT || 8080;

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// =========================================================
// 🛑 GRACEFUL SHUTDOWN
// Handles container shutdown safely
// =========================================================
process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received. Closing server...");

  server.close(async () => {
    console.log("🔌 HTTP server closed.");

    await pool.end();
    console.log("🔌 PostgreSQL pool closed.");

    process.exit(0);
  });
});

// =========================================================
// ⚠ GLOBAL PROCESS ERROR HANDLERS
// =========================================================
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
