const express = require("express");
const pool = require("../db");
const { authMiddleware, requireOwner } = require("../middleware/auth");
const {
  runCleanup,
  runInvoiceCounterCleanup,
  getBackgroundJobStatus,
} = require("../utils/background-jobs");
const { buildMonitoringSnapshot } = require("../utils/monitoring");
const { loadDatabaseOverview } = require("../repositories/ops-repository");

const router = express.Router();

router.use("/ops", authMiddleware, requireOwner);

router.get("/ops/metrics", async (req, res) => {
  try {
    const [snapshot, database] = await Promise.all([
      Promise.resolve(buildMonitoringSnapshot(pool)),
      loadDatabaseOverview(pool).catch((error) => ({
        error: error.message || "Database overview unavailable",
      })),
    ]);

    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      metrics: {
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

router.get("/ops/background-jobs", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    success: true,
    background_jobs: getBackgroundJobStatus(pool),
  });
});

router.post("/ops/background-jobs/cleanup", async (req, res) => {
  const cleanup = {
    ...runCleanup(),
    ...(await runInvoiceCounterCleanup(pool)),
  };
  res.set("Cache-Control", "no-store");
  res.json({
    success: true,
    cleanup,
    background_jobs: getBackgroundJobStatus(pool),
  });
});

module.exports = router;
