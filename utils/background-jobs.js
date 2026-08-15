const { responseCache } = require("./cache");
const { exportQueue } = require("./export-queue");
const { logEvent } = require("./runtime-log");

const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_INVOICE_COUNTER_RETENTION_DAYS = 10;
const INVOICE_COUNTER_CLEANUP_HOUR_IST = 0;
const INVOICE_COUNTER_CLEANUP_MINUTE_IST = 10;

const state = {
  started: false,
  startedAt: null,
  cleanupRuns: 0,
  lastCleanupAt: null,
  lastCleanup: null,
  heartbeatRuns: 0,
  lastHeartbeatAt: null,
  invoiceCounterCleanupRuns: 0,
  lastInvoiceCounterCleanupAt: null,
  lastInvoiceCounterCleanup: null,
};

let cleanupTimer = null;
let heartbeatTimer = null;
let invoiceCounterCleanupTimer = null;
let invoiceCounterCleanupInterval = null;
let invoiceCounterCleanupInProgress = false;

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getMemoryUsageMb() {
  const usage = process.memoryUsage();
  return {
    rss: Number((usage.rss / (1024 * 1024)).toFixed(2)),
    heap_used: Number((usage.heapUsed / (1024 * 1024)).toFixed(2)),
    heap_total: Number((usage.heapTotal / (1024 * 1024)).toFixed(2)),
    external: Number((usage.external / (1024 * 1024)).toFixed(2)),
  };
}

function getPoolStats(pool) {
  if (!pool) {
    return null;
  }

  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

async function removeExpiredInvoiceCounters(pool) {
  if (!pool) {
    return {
      removed_invoice_counters: 0,
      invoice_counter_cutoff_date: null,
    };
  }

  const retentionDays = readPositiveInt(
    process.env.INVOICE_COUNTER_RETENTION_DAYS,
    DEFAULT_INVOICE_COUNTER_RETENTION_DAYS,
  );
  // Date-key retention is inclusive: a 1 August counter is eligible on
  // 10 August when the configured retention is 10 days.
  const cutoffDays = retentionDays - 1;
  const result = await pool.query(
    `
      DELETE FROM user_invoice_counter
      WHERE date_key <= ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - $1::int)
      RETURNING date_key
    `,
    [cutoffDays],
  );

  const cutoffResult = await pool.query(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - $1::int) AS cutoff_date`,
    [cutoffDays],
  );

  return {
    removed_invoice_counters: result.rowCount,
    invoice_counter_cutoff_date: cutoffResult.rows[0]?.cutoff_date || null,
  };
}

function runCleanup() {
  const removedCacheEntries = responseCache.pruneExpired();
  const removedExportJobs = exportQueue.cleanup();

  state.cleanupRuns += 1;
  state.lastCleanupAt = new Date().toISOString();
  state.lastCleanup = {
    removed_cache_entries: removedCacheEntries,
    removed_export_jobs: removedExportJobs,
  };

  if (removedCacheEntries || removedExportJobs) {
    logEvent("info", "background_cleanup_completed", state.lastCleanup);
  }

  return state.lastCleanup;
}

async function runInvoiceCounterCleanup(pool) {
  if (invoiceCounterCleanupInProgress) {
    return state.lastInvoiceCounterCleanup;
  }

  invoiceCounterCleanupInProgress = true;
  try {
    const cleanup = await removeExpiredInvoiceCounters(pool);
    state.invoiceCounterCleanupRuns += 1;
    state.lastInvoiceCounterCleanupAt = new Date().toISOString();
    state.lastInvoiceCounterCleanup = cleanup;

    if (cleanup.removed_invoice_counters) {
      logEvent("info", "invoice_counter_cleanup_completed", cleanup);
    }

    return cleanup;
  } catch (error) {
    state.lastInvoiceCounterCleanupAt = new Date().toISOString();
    state.lastInvoiceCounterCleanup = {
      removed_invoice_counters: 0,
      error: error.message || "Invoice counter cleanup failed",
    };
    logEvent("error", "invoice_counter_cleanup_failed", { error });
    return state.lastInvoiceCounterCleanup;
  } finally {
    invoiceCounterCleanupInProgress = false;
  }
}

function getMillisecondsUntilNextInvoiceCounterCleanup() {
  const now = new Date();
  const kolkataNow = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
  const nextRun = new Date(kolkataNow);
  nextRun.setHours(
    INVOICE_COUNTER_CLEANUP_HOUR_IST,
    INVOICE_COUNTER_CLEANUP_MINUTE_IST,
    0,
    0,
  );

  if (nextRun <= kolkataNow) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  return nextRun.getTime() - kolkataNow.getTime();
}

function scheduleInvoiceCounterCleanup(pool) {
  const delayMs = getMillisecondsUntilNextInvoiceCounterCleanup();
  invoiceCounterCleanupTimer = setTimeout(() => {
    void runInvoiceCounterCleanup(pool);
    invoiceCounterCleanupInterval = setInterval(() => {
      void runInvoiceCounterCleanup(pool);
    }, 24 * 60 * 60 * 1000);
    invoiceCounterCleanupInterval.unref?.();
  }, delayMs);
  invoiceCounterCleanupTimer.unref?.();

  return delayMs;
}

function startBackgroundJobs(options = {}) {
  if (state.started) {
    return getBackgroundJobStatus(options.pool);
  }

  const cleanupIntervalMs = readPositiveInt(
    options.cleanupIntervalMs || process.env.BACKGROUND_CLEANUP_INTERVAL_MS,
    DEFAULT_CLEANUP_INTERVAL_MS,
  );
  const heartbeatIntervalMs = readPositiveInt(
    options.heartbeatIntervalMs || process.env.MONITOR_HEARTBEAT_INTERVAL_MS,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
  );

  state.started = true;
  state.startedAt = new Date().toISOString();

  cleanupTimer = setInterval(runCleanup, cleanupIntervalMs);
  cleanupTimer.unref?.();

  const invoiceCounterCleanupDelayMs = scheduleInvoiceCounterCleanup(options.pool);

  heartbeatTimer = setInterval(() => {
    state.heartbeatRuns += 1;
    state.lastHeartbeatAt = new Date().toISOString();
    logEvent("info", "app_monitor_heartbeat", {
      memoryMb: getMemoryUsageMb(),
      dbPool: getPoolStats(options.pool),
      cache: responseCache.stats(),
      exports: exportQueue.stats(),
      cleanupRuns: state.cleanupRuns,
    });
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  logEvent("info", "background_jobs_started", {
    cleanupIntervalMs,
    heartbeatIntervalMs,
    invoiceCounterCleanupSchedule: "00:10 Asia/Kolkata daily",
    invoiceCounterCleanupDelayMs,
  });

  runCleanup();
  return getBackgroundJobStatus(options.pool);
}

function stopBackgroundJobs() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (invoiceCounterCleanupTimer) {
    clearTimeout(invoiceCounterCleanupTimer);
    invoiceCounterCleanupTimer = null;
  }

  if (invoiceCounterCleanupInterval) {
    clearInterval(invoiceCounterCleanupInterval);
    invoiceCounterCleanupInterval = null;
  }

  if (state.started) {
    state.started = false;
    logEvent("info", "background_jobs_stopped", {
      cleanupRuns: state.cleanupRuns,
      heartbeatRuns: state.heartbeatRuns,
    });
  }
}

function getBackgroundJobStatus(pool = null) {
  return {
    ...state,
    cache: responseCache.stats(),
    exports: exportQueue.stats(),
    db_pool: getPoolStats(pool),
  };
}

module.exports = {
  getBackgroundJobStatus,
  runCleanup,
  runInvoiceCounterCleanup,
  startBackgroundJobs,
  stopBackgroundJobs,
};
