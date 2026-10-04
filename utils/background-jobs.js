/**
 * =========================================================
 * FILE: utils/background-jobs.js
 * PURPOSE: APPLICATION MAINTENANCE SCHEDULER ও RUNTIME JOB STATUS
 * =========================================================
 * এই module expired response-cache entry ও পুরোনো export job পরিষ্কার করে, monitoring heartbeat log করে এবং পুরোনো daily invoice counter মুছে দেয়।
 * Scheduler start/stop lifecycle, timer reference, run count, last-run time/result এবং database-pool snapshot এক জায়গায় রাখে।
 * Invoice-counter cleanup Asia/Kolkata সময় অনুযায়ী প্রতিদিন 00:10-এ চলে এবং overlap guard একই কাজ একসঙ্গে দুবার চলতে দেয় না।
 */

// ==================== BLOCK 01: CLEANUP TARGETS ও RUNTIME LOGGING DEPENDENCIES ====================
// Response cache expired entry prune করে, export queue finished/expired job cleanup করে এবং runtime logger গুরুত্বপূর্ণ job event লিখে।
const { responseCache } = require("./cache");
const { exportQueue } = require("./export-queue");
const { logEvent } = require("./runtime-log");

// ==================== BLOCK 02: DEFAULT INTERVAL, RETENTION ও DAILY SCHEDULE ====================
// General cleanup default প্রতি ১ মিনিটে, heartbeat প্রতি ৫ মিনিটে এবং invoice counter default ১০ দিন রাখা হয়।
// Daily database cleanup IST রাত 00:10-এ scheduled; supported environment values পরে positive-integer parser দিয়ে validate হয়।
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_INVOICE_COUNTER_RETENTION_DAYS = 10;
const INVOICE_COUNTER_CLEANUP_HOUR_IST = 0;
const INVOICE_COUNTER_CLEANUP_MINUTE_IST = 10;

// ==================== BLOCK 03: PROCESS-LOCAL JOB STATE ====================
// Scheduler started কি না, কখন শুরু হয়েছে, প্রতিটি job কতবার চলেছে এবং সর্বশেষ execution-এর সময়/result memory-তে রাখা হয়।
// এটি process restart হলে reset হয় এবং operations/health endpoints live diagnostic snapshot হিসেবে পড়ে।
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

// ==================== BLOCK 04: TIMER REFERENCES ও CONCURRENCY GUARD ====================
// Timer handles রাখায় shutdown/test-এর সময় সঠিক interval/timeout cancel করা যায়। Invoice cleanup flag manual ও scheduled invocation overlap হলে
// দ্বিতীয় execution-কে existing last result দিয়ে ফেরায়, ফলে একই retention delete একসঙ্গে চালানো হয় না।
let cleanupTimer = null;
let heartbeatTimer = null;
let invoiceCounterCleanupTimer = null;
let invoiceCounterCleanupInterval = null;
let invoiceCounterCleanupInProgress = false;

// ==================== BLOCK 05: CONFIGURATION ও RESOURCE SNAPSHOT HELPERS ====================
// Positive integer parser invalid/zero/negative interval-এ safe fallback নেয়। Memory helper Node process bytes-কে readable MB-তে রূপ দেয়;
// pool helper total/idle/waiting PostgreSQL connection count দেখায় এবং pool না থাকলে null ফেরায়।
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

/*
 * =========================================================
 * BLOCK 06: EXPIRED DAILY INVOICE COUNTER DELETE
 * =========================================================
 * Configured retention days থেকে inclusive cutoff হিসাব করে `user_invoice_counter`-এর পুরোনো date-key row মুছে দেয়।
 * Kolkata database date ব্যবহারে server timezone বদলালেও business-day boundary ঠিক থাকে।
 * Return value-তে deleted row count ও কার্যকর cutoff date থাকে; pool না থাকলে safe zero-result দেয়।
 */
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
  // Retention inclusive: ১০ দিনের setting হলে ১ আগস্টের counter ১০ আগস্ট cleanup-এর যোগ্য হয়, তাই retention থেকে ১ বাদ যায়।
  const cutoffDays = retentionDays - 1;

  // Parameterized DELETE eligible rows ফেরায়, যাতে driver-এর rowCount দিয়েই exact removed count পাওয়া যায়।
  const result = await pool.query(
    `
      DELETE FROM user_invoice_counter
      WHERE date_key <= ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - $1::int)
      RETURNING date_key
    `,
    [cutoffDays],
  );

  // একই database/Kolkata expression আলাদা SELECT-এ চালিয়ে report-এর জন্য actual cutoff date নেওয়া হয়।
  const cutoffResult = await pool.query(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - $1::int) AS cutoff_date`,
    [cutoffDays],
  );

  return {
    removed_invoice_counters: result.rowCount,
    invoice_counter_cutoff_date: cutoffResult.rows[0]?.cutoff_date || null,
  };
}

/*
 * =========================================================
 * BLOCK 07: GENERAL CACHE ও EXPORT-QUEUE CLEANUP RUN
 * =========================================================
 * Expired response-cache entries prune এবং completed/expired export jobs cleanup করে।
 * Run counter, ISO timestamp ও removed counts state-এ save হয়; কিছু সরলেই structured info event log হয়।
 * Function result manual ops endpoint এবং scheduler দুটোই ব্যবহার করতে পারে।
 */
function runCleanup() {
  // দুই cleanup target independent হলেও একই periodic maintenance result-এ count করা হয়।
  const removedCacheEntries = responseCache.pruneExpired();
  const removedExportJobs = exportQueue.cleanup();

  state.cleanupRuns += 1;
  state.lastCleanupAt = new Date().toISOString();
  state.lastCleanup = {
    removed_cache_entries: removedCacheEntries,
    removed_export_jobs: removedExportJobs,
  };

  // কোনো resource না সরলে প্রতি মিনিটে অপ্রয়োজনীয় success log লিখে log volume বাড়ানো হয় না।
  if (removedCacheEntries || removedExportJobs) {
    logEvent("info", "background_cleanup_completed", state.lastCleanup);
  }

  return state.lastCleanup;
}

/*
 * =========================================================
 * BLOCK 08: GUARDED INVOICE-COUNTER CLEANUP RUN
 * =========================================================
 * Scheduled ও manual call একই সময়ে এলে in-progress guard duplicate database cleanup আটকায়।
 * Success-এ run count/time/result update ও deletion থাকলে info log হয়; failure throw না করে state-এ error result রেখে error event log হয়।
 * Finally block সব অবস্থায় guard ছাড়ে, যাতে পরবর্তী দিনের cleanup আবার চলতে পারে।
 */
async function runInvoiceCounterCleanup(pool) {
  // আগের run শেষ না হলে নতুন query না চালিয়ে last known result ফেরানো হয়।
  if (invoiceCounterCleanupInProgress) {
    return state.lastInvoiceCounterCleanup;
  }

  invoiceCounterCleanupInProgress = true;
  try {
    // Retention delete সম্পন্ন হওয়ার পরেই successful run counter এবং last result update করা হয়।
    const cleanup = await removeExpiredInvoiceCounters(pool);
    state.invoiceCounterCleanupRuns += 1;
    state.lastInvoiceCounterCleanupAt = new Date().toISOString();
    state.lastInvoiceCounterCleanup = cleanup;

    if (cleanup.removed_invoice_counters) {
      logEvent("info", "invoice_counter_cleanup_completed", cleanup);
    }

    return cleanup;
  } catch (error) {
    // Scheduler alive রাখতে database error result হিসেবে capture হয়; monitoring পরে এই error দেখতে পারে।
    state.lastInvoiceCounterCleanupAt = new Date().toISOString();
    state.lastInvoiceCounterCleanup = {
      removed_invoice_counters: 0,
      error: error.message || "Invoice counter cleanup failed",
    };
    logEvent("error", "invoice_counter_cleanup_failed", { error });
    return state.lastInvoiceCounterCleanup;
  } finally {
    // Success বা failure যাই হোক overlap lock অবশ্যই release করা হয়।
    invoiceCounterCleanupInProgress = false;
  }
}

/*
 * =========================================================
 * BLOCK 09: NEXT IST CLEANUP DELAY CALCULATION
 * =========================================================
 * Current instant-কে Asia/Kolkata wall-clock time-এ রূপ দিয়ে আজকের 00:10 target বানায়।
 * আজকের target পেরিয়ে গেলে পরের দিনের target নেয় এবং এখন থেকে target পর্যন্ত millisecond delay ফেরায়।
 * এই delay initial setTimeout-কে application start time থেকে সঠিক daily boundary-তে পৌঁছায়।
 */
function getMillisecondsUntilNextInvoiceCounterCleanup() {
  const now = new Date();

  // Locale conversion দিয়ে host machine-এর timezone থেকে স্বাধীন Kolkata wall-clock Date representation নেওয়া হয়।
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

  // 00:10 ইতিমধ্যে হয়ে গেলে আজ সঙ্গে সঙ্গে না চালিয়ে আগামী রাতের scheduled run নির্বাচন করা হয়।
  if (nextRun <= kolkataNow) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  return nextRun.getTime() - kolkataNow.getTime();
}

/*
 * =========================================================
 * BLOCK 10: DAILY INVOICE CLEANUP SCHEDULER
 * =========================================================
 * প্রথম run-এর জন্য calculated delay-সহ one-time timeout বসায়। সেটি fire করলে cleanup চালিয়ে প্রতি ২৪ ঘণ্টার interval শুরু করে।
 * `void` promise-টি deliberately fire-and-forget করে; cleanup function নিজেই error capture করে।
 * Timer-এ `unref` থাকায় শুধু maintenance timer-এর কারণে Node process shutdown আটকে থাকে না।
 */
function scheduleInvoiceCounterCleanup(pool) {
  const delayMs = getMillisecondsUntilNextInvoiceCounterCleanup();

  // Initial timeout application start থেকে পরবর্তী IST 00:10 পর্যন্ত অপেক্ষা করে।
  invoiceCounterCleanupTimer = setTimeout(() => {
    void runInvoiceCounterCleanup(pool);

    // প্রথম aligned run-এর পর India timezone-এ DST না থাকায় fixed ২৪ ঘণ্টার interval একই local time ধরে রাখে।
    invoiceCounterCleanupInterval = setInterval(() => {
      void runInvoiceCounterCleanup(pool);
    }, 24 * 60 * 60 * 1000);
    invoiceCounterCleanupInterval.unref?.();
  }, delayMs);
  invoiceCounterCleanupTimer.unref?.();

  return delayMs;
}

/*
 * =========================================================
 * BLOCK 11: ALL BACKGROUND JOBS START
 * =========================================================
 * Scheduler একবারই start হয়; repeated call নতুন timer না বানিয়ে বর্তমান status ফেরায়।
 * Validated cleanup/heartbeat intervals নেয়, state initialize করে, general cleanup ও daily invoice cleanup schedule করে এবং heartbeat timer বসায়।
 * Startup event log করার পর একবার immediate general cleanup চালায়, তাই প্রথম interval পর্যন্ত expired data পড়ে থাকে না।
 */
function startBackgroundJobs(options = {}) {
  // Idempotency guard server reload/bootstrap-এর duplicate start call থেকে multiple intervals আটকায়।
  if (state.started) {
    return getBackgroundJobStatus(options.pool);
  }

  /* START PHASE A: explicit options আগে, তারপর environment value, শেষে safe default—এই priority-তে interval resolve করা। */
  const cleanupIntervalMs = readPositiveInt(
    options.cleanupIntervalMs || process.env.BACKGROUND_CLEANUP_INTERVAL_MS,
    DEFAULT_CLEANUP_INTERVAL_MS,
  );
  const heartbeatIntervalMs = readPositiveInt(
    options.heartbeatIntervalMs || process.env.MONITOR_HEARTBEAT_INTERVAL_MS,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
  );

  /* START PHASE B: scheduler state active করে process-local start timestamp লেখা। */
  state.started = true;
  state.startedAt = new Date().toISOString();

  /* START PHASE C: periodic cache/export cleanup timer তৈরি এবং event loop hold না করতে unref করা। */
  cleanupTimer = setInterval(runCleanup, cleanupIntervalMs);
  cleanupTimer.unref?.();

  /* START PHASE D: database pool দিয়ে পরবর্তী IST 00:10 invoice-counter cleanup schedule ও initial delay capture করা। */
  const invoiceCounterCleanupDelayMs = scheduleInvoiceCounterCleanup(options.pool);

  /* START PHASE E: runtime health heartbeat-এ memory, DB pool, cache, export queue ও cleanup count structured log করা। */
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

  /* START PHASE F: effective intervals/schedule log করে observability-তে actual configuration দৃশ্যমান রাখা। */
  logEvent("info", "background_jobs_started", {
    cleanupIntervalMs,
    heartbeatIntervalMs,
    invoiceCounterCleanupSchedule: "00:10 Asia/Kolkata daily",
    invoiceCounterCleanupDelayMs,
  });

  /* START PHASE G: startup-এই stale cache/export data cleanup করে current combined status ফেরানো। */
  runCleanup();
  return getBackgroundJobStatus(options.pool);
}

/*
 * =========================================================
 * BLOCK 12: ALL BACKGROUND JOBS STOP
 * =========================================================
 * General cleanup interval, heartbeat interval, initial invoice timeout এবং daily invoice interval—প্রতিটি active timer clear করে reference null করে।
 * Scheduler active থাকলে state stopped করে final run counts-সহ shutdown event log হয়।
 * Function বারবার call করা নিরাপদ; absent timer clear করার চেষ্টা করে না।
 */
function stopBackgroundJobs() {
  // প্রতিটি handle তার timer type অনুযায়ী clear হয় এবং stale reference সরানো হয়।
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

  // কেবল active → stopped transition-এ event log হয়, repeated stop call duplicate log তৈরি করে না।
  if (state.started) {
    state.started = false;
    logEvent("info", "background_jobs_stopped", {
      cleanupRuns: state.cleanupRuns,
      heartbeatRuns: state.heartbeatRuns,
    });
  }
}

/*
 * =========================================================
 * BLOCK 13: OPERATIONS STATUS SNAPSHOT
 * =========================================================
 * Process-local scheduler state copy করে তার সঙ্গে live cache/export statistics ও optional database-pool counts যোগ করে।
 * Spread copy top-level state mutation আটকায়; ops routes এই snapshot monitoring response-এ ব্যবহার করে।
 */
function getBackgroundJobStatus(pool = null) {
  return {
    ...state,
    cache: responseCache.stats(),
    exports: exportQueue.stats(),
    db_pool: getPoolStats(pool),
  };
}

/*
 * =========================================================
 * BLOCK 14: PUBLIC BACKGROUND-JOB API EXPORT
 * =========================================================
 * Bootstrap-এর জন্য start/stop, ops manual action-এর জন্য দুই cleanup function এবং monitoring-এর জন্য status reader export করা হয়।
 * Internal timing, retention ও resource helper-গুলো module-private থাকে।
 */
module.exports = {
  getBackgroundJobStatus,
  runCleanup,
  runInvoiceCounterCleanup,
  startBackgroundJobs,
  stopBackgroundJobs,
};
