const fs = require("fs");
const os = require("os");
const { getRecentRuntimeEvents } = require("./runtime-log");

const HEALTHY = "healthy";
const WARNING = "warning";
const CRITICAL = "critical";

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

async function loadDiskHealth() {
  if (typeof fs.promises.statfs !== "function") {
    return { available: false };
  }

  try {
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

async function buildFullHealthReport({ pool, monitoring, backgroundJobs }) {
  const [disk, database, recentEvents] = await Promise.all([
    loadDiskHealth(),
    loadDatabaseDiagnostics(pool),
    Promise.resolve(getRecentRuntimeEvents()),
  ]);
  const checks = [];
  const requestStats = monitoring.requests || {};
  const dbPool = monitoring.db_pool || {};
  const memory = monitoring.memory_mb || {};
  const fiveXx = Number(requestStats.by_status_class?.["5xx"] || 0);
  const errorRate = requestStats.total
    ? (Number(requestStats.errors || 0) / Number(requestStats.total)) * 100
    : 0;

  addCheck(checks, dbPool.ready ? HEALTHY : CRITICAL, "Database", "Database connection", dbPool.ready ? "PostgreSQL is connected and ready." : "The application cannot use PostgreSQL.", dbPool.ready ? null : "Check Railway PostgreSQL service and DATABASE_URL.");
  addCheck(checks, Number(dbPool.waiting || 0) === 0 ? HEALTHY : WARNING, "Database", "Connection-pool queue", `${Number(dbPool.waiting || 0)} requests are waiting for a database connection.`, Number(dbPool.waiting || 0) ? "Review database load and pool size." : null);
  if (database.available) {
    addCheck(checks, database.idle_in_transaction ? WARNING : HEALTHY, "Database", "Idle transactions", `${database.idle_in_transaction} connection(s) idle inside a transaction.`, database.idle_in_transaction ? "Find and close unfinished database transactions." : null);
    addCheck(checks, database.long_running_queries ? WARNING : HEALTHY, "Database", "Long-running queries", `${database.long_running_queries} query/queries running longer than 30 seconds.`, database.long_running_queries ? "Review slow SQL and indexes." : null);
  } else {
    addCheck(checks, WARNING, "Database", "Database diagnostics", "Detailed database statistics are unavailable.", "Confirm PostgreSQL monitoring permissions.");
  }

  addCheck(checks, backgroundJobs.started ? HEALTHY : CRITICAL, "Jobs", "Background jobs", backgroundJobs.started ? "Cleanup and heartbeat scheduler are running." : "Scheduled cleanup and heartbeat are stopped.", backgroundJobs.started ? null : "Restart the application and inspect logs.");
  addCheck(checks, Number(backgroundJobs.exports?.queued || 0) === 0 ? HEALTHY : WARNING, "Jobs", "Export queue", `${Number(backgroundJobs.exports?.queued || 0)} export job(s) queued; ${Number(backgroundJobs.exports?.active || 0)} active.`, Number(backgroundJobs.exports?.queued || 0) ? "Check stuck export jobs." : null);

  addCheck(checks, fiveXx ? WARNING : HEALTHY, "Performance", "Server errors", `${fiveXx} HTTP 5xx response(s) since the current app start.`, fiveXx ? "Open Railway logs and review recent error events below." : null);
  addCheck(checks, errorRate >= 5 ? WARNING : HEALTHY, "Performance", "HTTP error rate", `${errorRate.toFixed(1)}% of requests returned 4xx or 5xx since app start.`, errorRate >= 5 ? "Check whether the errors are expected authentication failures or user-facing issues." : null);
  addCheck(checks, Number(requestStats.slow || 0) ? WARNING : HEALTHY, "Performance", "Slow requests", `${Number(requestStats.slow || 0)} request(s) exceeded the slow-request threshold.`, Number(requestStats.slow || 0) ? "Review the slow routes and database queries." : null);
  addCheck(checks, Number(memory.rss || 0) < 220 ? HEALTHY : WARNING, "Server", "Memory usage", `Process RSS is ${Number(memory.rss || 0).toFixed(1)} MB.`, Number(memory.rss || 0) >= 220 ? "Monitor memory growth and Railway container limits." : null);
  if (disk.available) {
    addCheck(checks, disk.used_percent >= 85 ? WARNING : HEALTHY, "Server", "Disk space", `${disk.used_percent}% used (${disk.free_mb} MB free).`, disk.used_percent >= 85 ? "Free space or increase the server disk allocation." : null);
  } else {
    addCheck(checks, WARNING, "Server", "Disk space", "The deployment platform does not expose disk statistics to the application.", "Monitor disk usage in Railway.");
  }

  addCheck(checks, process.env.NODE_ENV === "production" ? HEALTHY : CRITICAL, "Security", "Production mode", `NODE_ENV is ${process.env.NODE_ENV || "not set"}.`, "Set NODE_ENV=production in Railway.");
  addCheck(checks, hasValue("JWT_SECRET") ? HEALTHY : CRITICAL, "Security", "JWT signing secret", hasValue("JWT_SECRET") ? "JWT_SECRET is configured." : "JWT_SECRET is missing.", hasValue("JWT_SECRET") ? null : "Set a long random JWT_SECRET immediately.");
  addCheck(checks, hasValue("BASE_URL") ? HEALTHY : WARNING, "Security", "Public base URL", hasValue("BASE_URL") ? "BASE_URL is configured." : "BASE_URL is not configured.", hasValue("BASE_URL") ? null : "Set BASE_URL to the public HTTPS application URL.");
  addCheck(checks, hasValue("DEVELOPER_REGISTRATION_KEY") ? HEALTHY : CRITICAL, "Security", "Developer registration key", hasValue("DEVELOPER_REGISTRATION_KEY") ? "A dedicated developer-registration key is configured." : "The built-in default developer-registration key is active.", hasValue("DEVELOPER_REGISTRATION_KEY") ? null : "Set a strong DEVELOPER_REGISTRATION_KEY in Railway immediately.");
  addCheck(checks, WARNING, "Resilience", "Database backup", "Backup and point-in-time recovery cannot be verified from application code.", "Enable scheduled Railway/PostgreSQL backups and test a restore.");
  addCheck(checks, WARNING, "Resilience", "External uptime alert", "External downtime monitoring cannot be verified from application code.", "Configure Uptime Kuma or Better Uptime to check /health every minute.");
  addCheck(checks, WARNING, "Security", "Dependency vulnerability audit", "No automated dependency vulnerability audit is configured in this deployment.", "Run npm audit in CI and update vulnerable packages.");

  const alertCount = {
    critical: checks.filter((check) => check.severity === CRITICAL).length,
    warning: checks.filter((check) => check.severity === WARNING).length,
    healthy: checks.filter((check) => check.severity === HEALTHY).length,
  };
  return {
    checked_at: new Date().toISOString(),
    overall_status: alertCount.critical ? CRITICAL : alertCount.warning ? WARNING : HEALTHY,
    summary: { ...alertCount, total_checks: checks.length },
    system: { hostname: os.hostname(), disk, database },
    checks,
    recent_events: recentEvents,
  };
}

module.exports = { buildFullHealthReport };
