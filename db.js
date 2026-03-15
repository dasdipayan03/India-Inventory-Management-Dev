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
const { Pool } = require("pg");

function shouldUseSsl(databaseUrl) {
  if (process.env.DB_SSL === "true") {
    return true;
  }

  if (process.env.DB_SSL === "false") {
    return false;
  }

  return !/localhost|127\.0\.0\.1/i.test(databaseUrl);
}

// =========================================================
// 🔐 ENVIRONMENT VARIABLE CHECK
// Ensures DATABASE_URL exists before server starts.
// Without this, database connection is impossible.
// =========================================================
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not defined");
  process.exit(1); // Stop server immediately
}

// =========================================================
// 🗄️ CREATE POSTGRESQL CONNECTION POOL
//
// Instead of creating a new DB connection for every request,
// we create a pool (connection manager).
//
// Why Pool?
//  - Reuses connections
//  - Improves performance
//  - Prevents DB overload
// =========================================================
const pool = new Pool({
  // Database connection string from .env
  connectionString: process.env.DATABASE_URL,

  // 🔒 SSL Configuration (Required for cloud DB like Render)
  ssl: shouldUseSsl(process.env.DATABASE_URL)
    ? {
        require: true,
        rejectUnauthorized: false,
      }
    : false,

  // ⚙️ Pool Configuration
  // Maximum number of active DB connections at a time
  // Prevents too many simultaneous connections
  max: 10,
  connectionTimeoutMillis: 10000,

  // If a connection stays idle for 30 seconds,
  // it will be automatically closed
  idleTimeoutMillis: 30000,
});

// =========================================================
// ⚠️ GLOBAL ERROR LISTENER
//
// Listens for unexpected DB errors.
// Important for catching background connection issues.
// =========================================================
pool.on("error", (err) => {
  console.error("⚠️ Unexpected PostgreSQL error:", err);
  // We DO NOT exit the process here.
  // Let PostgreSQL auto-reconnect.
});

// =========================================================
// 🚀 INITIAL CONNECTION TEST
//
// Runs once when server starts.
// Helps confirm DB is connected properly.
// =========================================================
pool
  .query("SELECT 1")
  .then(() => console.log("✅ PostgreSQL connected"))
  .catch((err) => console.error("❌ PostgreSQL connection error:", err));

// =========================================================
// 📦 EXPORT DATABASE POOL
//
// Any file that needs DB access will:
// const pool = require('./db');
// =========================================================
module.exports = pool;
