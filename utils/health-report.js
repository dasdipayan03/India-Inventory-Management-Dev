/**
 * =========================================================
 * FILE: utils/health-report.js
 * PURPOSE: FULL APPLICATION HEALTH DIAGNOSTIC REPORT
 * =========================================================
 * এই module runtime monitoring, background-job status, disk usage, PostgreSQL diagnostics ও environment configuration একত্র করে।
 * প্রতিটি condition-কে healthy/warning/critical check-এ রূপ দেয় এবং operator-এর জন্য detail ও recommended action যোগ করে।
 * শেষে severity count থেকে overall status, system snapshot এবং recent runtime events-সহ একটি পূর্ণ report ফেরায়।
 */

// ==================== BLOCK 01: SYSTEM DEPENDENCIES ও HEALTH SEVERITY VALUES ====================
// File-system API disk capacity পড়ে, OS hostname দেয় এবং runtime-log utility সাম্প্রতিক application events সরবরাহ করে।
// তিনটি shared string constant individual check ও final overall status consistent রাখে।
const fs = require("fs");
const os = require("os");
const { getRecentRuntimeEvents } = require("./runtime-log");

const HEALTHY = "healthy";
const WARNING = "warning";
const CRITICAL = "critical";

// ==================== BLOCK 02: ENVIRONMENT, CHECK-BUILDER ও BYTE CONVERSION HELPERS ====================
// Environment helper blank/whitespace-only secret/config-কে missing ধরে। Check builder readable title/area থেকে stable kebab-case id বানিয়ে
// severity/detail/action object list-এ যোগ করে। Byte helper raw size-কে এক decimal MB-তে রূপ দেয়।
function hasValue(name) {
  return Boolean(String(process.env[name] || "").trim());
}

function addCheck(checks, severity, area, title, detail, action = null) {
  checks.push({
    id: `${area}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    severity,
    area,
    title,
    detail,
    action,
  });
}

function mb(bytes) {
  return Math.round((Number(bytes) || 0) / (1024 * 1024) * 10) / 10;
}

/*
 * =========================================================
 * BLOCK 03: FILESYSTEM DISK HEALTH
 * =========================================================
 * Runtime `statfs` support করলে current working filesystem-এর total/available blocks পড়ে total/free MB ও used percentage হিসাব করে।
 * API unsupported, permission denied বা platform error হলে exception report builder-এ না ছড়িয়ে `{ available: false }` fallback দেয়।
 */
async function loadDiskHealth() {
  // পুরোনো Node/platform-এ statfs না থাকলে disk check unavailable হিসেবে চিহ্নিত হয়।
  if (typeof fs.promises.statfs !== "function") {
    return { available: false };
  }

  try {
    // Current application directory যে filesystem-এ আছে তার block count ও block size থেকে byte capacity বের হয়।
    const stats = await fs.promises.statfs(process.cwd());
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return {
      available: total > 0,
      total_mb: mb(total),
      free_mb: mb(free),
      used_percent: total ? Math.round(((total - free) / total) * 1000) / 10 : null,
    };
  } catch (_error) {
    return { available: false };
  }
}

/*
 * =========================================================
 * BLOCK 04: POSTGRESQL LIVE DIAGNOSTICS
 * =========================================================
 * এক query-তে current database size, মোট connection, idle-in-transaction এবং ৩০ সেকেন্ডের বেশি active query count আনে।
 * Numeric values normalize করে monitoring-friendly object ফেরায়; permission/connection/query error হলে unavailable fallback দেয়।
 */
async function loadDatabaseDiagnostics(pool) {
  try {
    const result = await pool.query(`
      SELECT
        pg_database_size(current_database()) AS database_size_bytes,
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS active_connections,
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction') AS idle_in_transaction,
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle' AND query_start < now() - interval '30 seconds') AS long_running_queries
    `);
    const row = result.rows[0] || {};
    return {
      available: true,
      database_size_mb: mb(row.database_size_bytes),
      active_connections: Number(row.active_connections) || 0,
      idle_in_transaction: Number(row.idle_in_transaction) || 0,
      long_running_queries: Number(row.long_running_queries) || 0,
    };
  } catch (_error) {
    return { available: false };
  }
}

/*
 * =========================================================
 * BLOCK 05: FULL HEALTH REPORT ORCHESTRATION
 * =========================================================
 * Caller-provided pool, monitoring snapshot ও background-job snapshot থেকে complete operational report বানায়।
 * Disk check, database diagnostics এবং recent event retrieval parallel-এ চলে; তারপর category-wise checks ও final severity summary তৈরি হয়।
 */
async function buildFullHealthReport({ pool, monitoring, backgroundJobs }) {
  /* REPORT PHASE A: independent live diagnostics parallel load করে report latency কমানো। */
  const [disk, database, recentEvents] = await Promise.all([
    loadDiskHealth(),
    loadDatabaseDiagnostics(pool),
    Promise.resolve(getRecentRuntimeEvents()),
  ]);
  /* REPORT PHASE B: optional nested metrics safe defaults-এ normalize এবং error rate derive করা। */
  const checks = [];
  const requestStats = monitoring.requests || {};
  const dbPool = monitoring.db_pool || {};
  const memory = monitoring.memory_mb || {};
  const fiveXx = Number(requestStats.by_status_class?.["5xx"] || 0);
  const errorRate = requestStats.total
    ? (Number(requestStats.errors || 0) / Number(requestStats.total)) * 100
    : 0;

  /*
   * BLOCK 06: DATABASE CHECK GROUP
   * Pool readiness critical availability জানায়; waiting queue load warning দেয়। Detailed diagnostics পাওয়া গেলে unfinished transaction ও
   * long-running query পরীক্ষা হয়, না পাওয়া গেলে monitoring permission/availability warning যোগ হয়।
   */
  // CHECK 01 — Pool application query নেওয়ার জন্য ready না হলে এটি সরাসরি service availability-এর critical সমস্যা।
  addCheck(checks, dbPool.ready ? HEALTHY : CRITICAL, "Database", "Database connection", dbPool.ready ? "PostgreSQL is connected and ready." : "The application cannot use PostgreSQL.", dbPool.ready ? null : "Check Railway PostgreSQL service and DATABASE_URL.");

  // CHECK 02 — Pool-এর waiting request শূন্য থাকা healthy; waiting থাকলে connection pressure বা undersized pool-এর warning।
  addCheck(checks, Number(dbPool.waiting || 0) === 0 ? HEALTHY : WARNING, "Database", "Connection-pool queue", `${Number(dbPool.waiting || 0)} requests are waiting for a database connection.`, Number(dbPool.waiting || 0) ? "Review database load and pool size." : null);
  if (database.available) {
    // CHECK 03 — Transaction খোলা রেখে idle connection lock/resource ধরে রাখতে পারে, তাই একটিও থাকলে warning।
    addCheck(checks, database.idle_in_transaction ? WARNING : HEALTHY, "Database", "Idle transactions", `${database.idle_in_transaction} connection(s) idle inside a transaction.`, database.idle_in_transaction ? "Find and close unfinished database transactions." : null);

    // CHECK 04 — ৩০ সেকেন্ডের বেশি non-idle query slow SQL, missing index বা blocking-এর signal হিসেবে warning পায়।
    addCheck(checks, database.long_running_queries ? WARNING : HEALTHY, "Database", "Long-running queries", `${database.long_running_queries} query/queries running longer than 30 seconds.`, database.long_running_queries ? "Review slow SQL and indexes." : null);
  } else {
    // CHECK 05 — Diagnostic query unavailable হলেও মূল report তৈরি হয়; operator permission/connectivity যাচাইয়ের warning পান।
    addCheck(checks, WARNING, "Database", "Database diagnostics", "Detailed database statistics are unavailable.", "Confirm PostgreSQL monitoring permissions.");
  }

  /*
   * BLOCK 07: BACKGROUND-JOB CHECK GROUP
   * Scheduler stopped থাকলে cleanup/heartbeat না চলার critical check হয়। Pending export থাকলে queue warning ও active count detail দেখায়।
   */
  // CHECK 06 — Scheduler বন্ধ মানে cleanup ও heartbeat দুটোই বন্ধ, তাই এটি critical operational state।
  addCheck(checks, backgroundJobs.started ? HEALTHY : CRITICAL, "Jobs", "Background jobs", backgroundJobs.started ? "Cleanup and heartbeat scheduler are running." : "Scheduled cleanup and heartbeat are stopped.", backgroundJobs.started ? null : "Restart the application and inspect logs.");

  // CHECK 07 — Pending export না থাকলে healthy; queue জমলে stuck/slow export investigation-এর warning।
  addCheck(checks, Number(backgroundJobs.exports?.queued || 0) === 0 ? HEALTHY : WARNING, "Jobs", "Export queue", `${Number(backgroundJobs.exports?.queued || 0)} export job(s) queued; ${Number(backgroundJobs.exports?.active || 0)} active.`, Number(backgroundJobs.exports?.queued || 0) ? "Check stuck export jobs." : null);

  /*
   * BLOCK 08: HTTP PERFORMANCE ও SERVER RESOURCE CHECKS
   * App-start থেকে 5xx count, combined 4xx/5xx rate, slow requests এবং process RSS evaluate করে। Disk available হলে 85% usage threshold,
   * unavailable হলে platform visibility warning দেওয়া হয়। এগুলো trend snapshot; external long-term monitoring-এর বিকল্প নয়।
   */
  // CHECK 08 — Process start-এর পর কোনো 5xx থাকলেই server-side failure review করার warning তৈরি হয়।
  addCheck(checks, fiveXx ? WARNING : HEALTHY, "Performance", "Server errors", `${fiveXx} HTTP 5xx response(s) since the current app start.`, fiveXx ? "Open Railway logs and review recent error events below." : null);

  // CHECK 09 — সমস্ত request-এর মধ্যে 4xx+5xx combined error response ৫% বা বেশি হলে warning threshold অতিক্রম করে।
  addCheck(checks, errorRate >= 5 ? WARNING : HEALTHY, "Performance", "HTTP error rate", `${errorRate.toFixed(1)}% of requests returned 4xx or 5xx since app start.`, errorRate >= 5 ? "Check whether the errors are expected authentication failures or user-facing issues." : null);

  // CHECK 10 — Monitoring middleware-এর slow threshold পার হওয়া অন্তত একটি request থাকলে route/query review চাওয়া হয়।
  addCheck(checks, Number(requestStats.slow || 0) ? WARNING : HEALTHY, "Performance", "Slow requests", `${Number(requestStats.slow || 0)} request(s) exceeded the slow-request threshold.`, Number(requestStats.slow || 0) ? "Review the slow routes and database queries." : null);

  // CHECK 11 — Process RSS 220 MB-এর নিচে healthy; সমান বা বেশি হলে container memory growth monitor করার warning।
  addCheck(checks, Number(memory.rss || 0) < 220 ? HEALTHY : WARNING, "Server", "Memory usage", `Process RSS is ${Number(memory.rss || 0).toFixed(1)} MB.`, Number(memory.rss || 0) >= 220 ? "Monitor memory growth and Railway container limits." : null);
  if (disk.available) {
    // CHECK 12 — Filesystem usage 85% বা বেশি হলে free space/allocation action-সহ warning হয়।
    addCheck(checks, disk.used_percent >= 85 ? WARNING : HEALTHY, "Server", "Disk space", `${disk.used_percent}% used (${disk.free_mb} MB free).`, disk.used_percent >= 85 ? "Free space or increase the server disk allocation." : null);
  } else {
    // CHECK 13 — Platform disk stats expose না করলে false healthy না দেখিয়ে visibility warning রাখা হয়।
    addCheck(checks, WARNING, "Server", "Disk space", "The deployment platform does not expose disk statistics to the application.", "Monitor disk usage in Railway.");
  }

  /*
   * BLOCK 09: SECURITY CONFIGURATION ও RESILIENCE CHECKS
   * Production mode, JWT secret, public URL ও dedicated developer key environment থেকে যাচাই হয়। Backup, external uptime monitoring এবং
   * dependency audit application নিজে নিশ্চিত করতে পারে না, তাই operator action-সহ explicit warning হিসেবে report-এ থাকে।
   */
  // CHECK 14 — Production optimization/security assumptions চালু আছে কি না `NODE_ENV` দিয়ে যাচাই; অন্য value critical।
  addCheck(checks, process.env.NODE_ENV === "production" ? HEALTHY : CRITICAL, "Security", "Production mode", `NODE_ENV is ${process.env.NODE_ENV || "not set"}.`, "Set NODE_ENV=production in Railway.");

  // CHECK 15 — JWT signing secret না থাকলে authentication token বিশ্বাসযোগ্যভাবে sign করা যায় না, তাই critical।
  addCheck(checks, hasValue("JWT_SECRET") ? HEALTHY : CRITICAL, "Security", "JWT signing secret", hasValue("JWT_SECRET") ? "JWT_SECRET is configured." : "JWT_SECRET is missing.", hasValue("JWT_SECRET") ? null : "Set a long random JWT_SECRET immediately.");

  // CHECK 16 — Public HTTPS base URL missing হলে absolute link/origin behavior ঝুঁকিপূর্ণ হতে পারে, তাই warning।
  addCheck(checks, hasValue("BASE_URL") ? HEALTHY : WARNING, "Security", "Public base URL", hasValue("BASE_URL") ? "BASE_URL is configured." : "BASE_URL is not configured.", hasValue("BASE_URL") ? null : "Set BASE_URL to the public HTTPS application URL.");

  // CHECK 17 — Environment-specific developer key না থাকলে registration fail-closed থাকে; account তৈরির আগে key configure করতে হবে।
  addCheck(checks, hasValue("DEVELOPER_REGISTRATION_KEY") ? HEALTHY : WARNING, "Security", "Developer registration key", hasValue("DEVELOPER_REGISTRATION_KEY") ? "A dedicated developer-registration key is configured." : "Developer registration is disabled until a key is configured.", hasValue("DEVELOPER_REGISTRATION_KEY") ? null : "Set a strong DEVELOPER_REGISTRATION_KEY in Railway before creating developer accounts.");

  // CHECK 18 — Application code backup/PITR configuration দেখতে পারে না; external platform setup ও restore test প্রয়োজন।
  addCheck(checks, WARNING, "Resilience", "Database backup", "Backup and point-in-time recovery cannot be verified from application code.", "Enable scheduled Railway/PostgreSQL backups and test a restore.");

  // CHECK 19 — Self-report server down হলে চলবে না, তাই independent uptime monitor application-এর বাইরে configure করতে হয়।
  addCheck(checks, WARNING, "Resilience", "External uptime alert", "External downtime monitoring cannot be verified from application code.", "Configure Uptime Kuma or Better Uptime to check /health every minute.");

  // CHECK 20 — Deployment-এ automated package vulnerability audit-এর প্রমাণ নেই বলে CI audit action-সহ warning থাকে।
  addCheck(checks, WARNING, "Security", "Dependency vulnerability audit", "No automated dependency vulnerability audit is configured in this deployment.", "Run npm audit in CI and update vulnerable packages.");

  /* REPORT PHASE C: সব check severity অনুযায়ী count করে critical > warning > healthy priority-তে overall status নির্ধারণ। */
  const alertCount = {
    critical: checks.filter((check) => check.severity === CRITICAL).length,
    warning: checks.filter((check) => check.severity === WARNING).length,
    healthy: checks.filter((check) => check.severity === HEALTHY).length,
  };
  /* REPORT PHASE D: timestamp, summary, host/disk/database snapshot, full checks ও recent logs এক final object-এ ফেরানো। */
  return {
    checked_at: new Date().toISOString(),
    overall_status: alertCount.critical ? CRITICAL : alertCount.warning ? WARNING : HEALTHY,
    summary: { ...alertCount, total_checks: checks.length },
    system: { hostname: os.hostname(), disk, database },
    checks,
    recent_events: recentEvents,
  };
}

/*
 * =========================================================
 * BLOCK 10: PUBLIC HEALTH-REPORT API
 * =========================================================
 * Operations route-এর জন্য orchestration function export হয়; low-level probes/check helpers private থাকে।
 */
module.exports = { buildFullHealthReport };
