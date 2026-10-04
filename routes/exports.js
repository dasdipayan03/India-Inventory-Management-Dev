/**
 * =========================================================
 * FILE: routes/exports.js
 * PURPOSE: ASYNC EXPORT JOB STATUS ও FILE DOWNLOAD ROUTES
 * =========================================================
 * এই router export job তৈরি করে না; অন্য report/invoice route `exportQueue`-তে job enqueue করার পরে
 * frontend এই endpoints দিয়ে progress poll এবং completed file download করে। প্রতিটি request authenticated
 * এবং job owner-scoped, যাতে এক account অন্য account-এর export metadata বা buffer access করতে না পারে।
 */

// ==================== BLOCK 01: DEPENDENCIES ও ROUTER SETUP ====================
// Express endpoints তৈরি করে। authMiddleware session যাচাই করে, getUserId owner/account scope দেয় এবং shared
// exportQueue queued/running/completed/failed job state ও generated result buffer memory-তে পরিচালনা করে।
const express = require("express");
const { authMiddleware, getUserId } = require("../middleware/auth");
const { exportQueue } = require("../utils/export-queue");

const router = express.Router();

// ==================== BLOCK 02: OWNER-SCOPED JOB AUTHORIZATION ====================
// URL-এর jobId দিয়ে queue lookup করে। Job না থাকলে অথবা ownerId current authenticated user-এর সঙ্গে না মিললে একই 404 দেয়।
// একই response ব্যবহার job enumeration/account information leak কমায়। Authorized হলে route handler-এর জন্য original job return করে।
function getAuthorizedJob(req, res) {
  const job = exportQueue.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ success: false, error: "Export job not found." });
    return null;
  }

  if (String(job.ownerId) !== String(getUserId(req))) {
    res.status(404).json({ success: false, error: "Export job not found." });
    return null;
  }

  return job;
}

// ==================== BLOCK 03: DOWNLOAD FILENAME SANITIZATION ====================
// Queue result-এর filename string করে CR, LF ও double quote সরায়, যাতে Content-Disposition header injection/breakout না ঘটে।
// Empty/missing filename হলে stable `export` fallback দেয়; generated binary content বা extension logic এখানে বদলানো হয় না।
function safeAttachmentName(value) {
  return (
    String(value || "export")
      .replace(/[\r\n"]/g, "")
      .trim() || "export"
  );
}

// ==================== BLOCK 04: EXPORT JOB STATUS ENDPOINT ====================
// GET /exports/:jobId authenticated polling endpoint। Authorized job-এর internal object সরাসরি না পাঠিয়ে queue serializer-এর
// client-safe shape return করে। `no-store` browser/proxy-কে stale queued/running/completed status cache করতে নিষেধ করে।
router.get("/exports/:jobId", authMiddleware, (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) {
    return;
  }

  res.set("Cache-Control", "no-store");
  res.json({
    success: true,
    export_job: exportQueue.serialize(job),
  });
});

// ==================== BLOCK 05: STATUS-AWARE EXPORT DOWNLOAD ====================
// Download-এর আগে একই ownership guard ও no-store policy প্রয়োগ হয়। queued/running হলে 202 এবং serialized progress দেয়;
// failed হলে stored errorসহ 500 দেয়; completed হলেও buffer expiry/cleanup হয়ে গেলে 404 দেয়। কেবল available result buffer থাকলেই file পাঠায়।
router.get("/exports/:jobId/download", authMiddleware, (req, res) => {
  const job = getAuthorizedJob(req, res);
  if (!job) {
    return;
  }

  res.set("Cache-Control", "no-store");

  if (job.status === "queued" || job.status === "running") {
    return res.status(202).json({
      success: true,
      export_job: exportQueue.serialize(job),
    });
  }

  if (job.status === "failed") {
    return res.status(500).json({
      success: false,
      error: job.error || "Export failed.",
    });
  }

  if (!job.result?.buffer) {
    return res.status(404).json({
      success: false,
      error: "Export file is no longer available.",
    });
  }

  // ==================== BLOCK 06: BINARY RESPONSE HEADERS ও ROUTER EXPORT ====================
  // Result-provided MIME type Content-Type-এ এবং sanitized filename attachment disposition-এ বসে। res.send Buffer binary bytes
  // পাঠায়, তাই browser inline JSON দেখানোর বদলে download শুরু করে। শেষে CommonJS export router-কে server app-এ mount করতে দেয়।
  const filename = safeAttachmentName(job.result.filename);
  res.setHeader("Content-Type", job.result.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(job.result.buffer);
});

// Configured status/download router server application-এ mount করার জন্য CommonJS export করা হচ্ছে।
module.exports = router;
