/**
 * =========================================================
 * FILE: routes/ops.js
 * PURPOSE: OWNER-ONLY MONITORING, HEALTH ও MAINTENANCE ENDPOINTS
 * =========================================================
 * এই router application runtime metrics, database overview, background-job status এবং পূর্ণ health report দেখায়।
 * Owner চাইলে এখান থেকে in-memory cleanup ও পুরোনো invoice-counter cleanup manually চালাতে পারেন।
 * সব `/ops` route login ও owner authorization-এর পেছনে থাকে এবং live operational response browser-এ cache হতে দেয় না।
 */

// ==================== BLOCK 01: DEPENDENCIES ও OPERATIONS SERVICES ====================
// Express router ও shared database pool load করে। Auth middleware access control দেয়; background-job utilities status/cleanup চালায়;
// monitoring ও health-report utilities runtime diagnosis তৈরি করে; repository database-এর summarized operational তথ্য পড়ে।
const express = require("express");
const pool = require("../db");
const { authMiddleware, requireOwner } = require("../middleware/auth");
const {
  runCleanup,
  runInvoiceCounterCleanup,
  getBackgroundJobStatus,
} = require("../utils/background-jobs");
const { buildMonitoringSnapshot } = require("../utils/monitoring");
const { buildFullHealthReport } = require("../utils/health-report");
const { loadDatabaseOverview } = require("../repositories/ops-repository");

// ==================== BLOCK 02: ROUTER তৈরি ও OWNER-ONLY SECURITY GATE ====================
// `/ops` prefix-এর নিচের প্রতিটি route প্রথমে valid login যাচাই করে, তারপর account owner কি না দেখে।
// এই shared `router.use` থাকার কারণে নিচের endpoint-গুলোতে একই middleware বারবার লিখতে হয় না।
const router = express.Router();

router.use("/ops", authMiddleware, requireOwner);

/*
 * =========================================================
 * BLOCK 03: GET /ops/metrics — live monitoring snapshot
 * =========================================================
 * Application-এর runtime monitoring snapshot এবং database overview parallel-এ সংগ্রহ করে response দ্রুত রাখে।
 * Database overview ব্যর্থ হলেও পুরো endpoint fail না করে তার error message `database.error`-এ রাখা হয়।
 * শেষে background-job-এর বর্তমান state যোগ করে owner dashboard-এর জন্য একটি combined metrics object পাঠায়।
 */
router.get("/ops/metrics", async (req, res) => {
  try {
    // Runtime snapshot synchronous হলেও Promise wrapper-এ রাখায় database overview-এর সঙ্গে একই Promise.all flow-তে চলে।
    const [snapshot, database] = await Promise.all([
      Promise.resolve(buildMonitoringSnapshot(pool)),

      // Database statistics unavailable হলে partial metrics দেখানো যাবে—এই local catch সেই graceful fallback তৈরি করে।
      loadDatabaseOverview(pool).catch((error) => ({
        error: error.message || "Database overview unavailable",
      })),
    ]);

    // Operational data দ্রুত বদলায়, তাই proxy/browser-কে পুরোনো metrics reuse করতে নিষেধ করা হয়।
    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      metrics: {
        // Runtime counters/timing-এর সব field top level-এ ছড়িয়ে database ও job status একই metrics object-এ যোগ করা হয়।
        ...snapshot,
        database,
        background_jobs: getBackgroundJobStatus(pool),
      },
    });
  } catch (error) {
    console.error("Ops metrics error:", error);
    res.status(500).json({
      success: false,
      error: "Could not load monitoring metrics.",
    });
  }
});

/*
 * =========================================================
 * BLOCK 04: GET /ops/health-report — পূর্ণ system health analysis
 * =========================================================
 * প্রথমে runtime monitoring snapshot নেয়, তারপর database overview ও background-job status parallel-এ সংগ্রহ করে।
 * এগুলো health-report builder-কে দিয়ে database/runtime/job checks সমন্বিত diagnostic report তৈরি করায়।
 * Response-এ interpreted `health` report-এর পাশাপাশি raw metrics-ও থাকে, যাতে dashboard summary ও detail দুটোই দেখাতে পারে।
 */
router.get("/ops/health-report", async (req, res) => {
  try {
    // একই request-এর health calculation ও raw metrics যেন একই সময়ের কাছাকাছি data ব্যবহার করে, তাই snapshot একবারই নেওয়া হয়।
    const monitoring = buildMonitoringSnapshot(pool);

    // Database overview failure report generation থামায় না; background status-কে Promise বানিয়ে parallel result shape রাখা হয়।
    const [database, backgroundJobs] = await Promise.all([
      loadDatabaseOverview(pool).catch((error) => ({
        error: error.message || "Database overview unavailable",
      })),
      Promise.resolve(getBackgroundJobStatus(pool)),
    ]);

    // Full report builder pool-এর live checks এবং আগে নেওয়া monitoring/job snapshot মিলিয়ে health verdict তৈরি করে।
    const health = await buildFullHealthReport({
      pool,
      monitoring,
      backgroundJobs,
    });

    // Health report live diagnostic data হওয়ায় cached response ব্যবহার করা নিরাপদ নয়।
    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      health,
      metrics: { ...monitoring, database, background_jobs: backgroundJobs },
    });
  } catch (error) {
    console.error("Full health report error:", error);
    res.status(500).json({ success: false, error: "Could not build health report." });
  }
});

/*
 * =========================================================
 * BLOCK 05: GET /ops/background-jobs — scheduler status
 * =========================================================
 * Background maintenance job-গুলোর running state, last run/result এবং utility যেসব status field দেয় সেগুলো পড়ে।
 * এখানে database write বা job execution হয় না; এটি owner dashboard-এর read-only live-status endpoint।
 */
router.get("/ops/background-jobs", (req, res) => {
  // Status stale না দেখাতে response cache বন্ধ রাখা হয়।
  res.set("Cache-Control", "no-store");
  res.json({
    success: true,
    background_jobs: getBackgroundJobStatus(pool),
  });
});

/*
 * =========================================================
 * BLOCK 06: POST /ops/background-jobs/cleanup — manual maintenance run
 * =========================================================
 * Owner-এর request-এ সাধারণ application cleanup এবং database-এর invoice-counter cleanup পরপর চালায়।
 * দুই utility-এর result spread করে এক `cleanup` summary বানায়, তারপর updated background-job status ফেরায়।
 * এটি maintenance action হওয়ায় GET নয়, POST route ব্যবহার করা হয়েছে।
 */
router.post("/ops/background-jobs/cleanup", async (req, res) => {
  // In-memory/general cleanup আগে চলে; invoice counter cleanup async database operation হওয়ায় await করা হয়।
  const cleanup = {
    ...runCleanup(),
    ...(await runInvoiceCounterCleanup(pool)),
  };

  // Cleanup-এর পরের live state পাঠানো হয় এবং এই result-ও cache হতে দেওয়া হয় না।
  res.set("Cache-Control", "no-store");
  res.json({
    success: true,
    cleanup,
    background_jobs: getBackgroundJobStatus(pool),
  });
});

/*
 * =========================================================
 * BLOCK 07: ROUTER EXPORT
 * =========================================================
 * Owner operations endpoint-সহ প্রস্তুত Express router main application-এ mount করার জন্য CommonJS module হিসেবে export হয়।
 */
module.exports = router;
