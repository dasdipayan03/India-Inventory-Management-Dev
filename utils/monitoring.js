/**
 * =========================================================
 * FILE: utils/monitoring.js
 * PURPOSE: PROCESS-LOCAL HTTP, ROUTE ও RESOURCE METRICS
 * =========================================================
 * এই module application start থেকে request count, active/error/slow request, duration, status/method buckets ও per-route aggregate ধরে।
 * Dynamic id/phone/UUID route segment normalize করায় একই logical endpoint হাজার আলাদা metric key তৈরি করে না।
 * Snapshot-এ process memory/uptime, database pool, response cache এবং export queue status একসঙ্গে পাওয়া যায়।
 */

// ==================== BLOCK 01: SHARED CACHE/EXPORT METRICS ও ROUTE CARDINALITY LIMIT ====================
// Cache ও export queue নিজেদের live statistics দেয়। সর্বোচ্চ ১২০টি route aggregate রাখার limit process memory/cardinality bounded রাখে।
const { responseCache } = require("./cache");
const { exportQueue } = require("./export-queue");

const MAX_ROUTE_STATS = 120;

// ==================== BLOCK 02: PROCESS-LIFETIME METRICS STATE ====================
// Module load time থেকে counters জমে এবং process restart হলে reset হয়। Global totals, active gauge, error/slow counts, cumulative/max duration,
// status/method buckets ও insertion-ordered route Map একই process-এর সব request recorder share করে।
const metrics = {
  // Module initialize হওয়ার ISO time—snapshot-এর metrics collection window কোথা থেকে শুরু তা বোঝায়।
  startedAt: new Date().toISOString(),

  // Finished/recorded HTTP request-এর cumulative সংখ্যা; active request এতে এখনও যোগ হয় না।
  requestTotal: 0,

  // এই মুহূর্তে শুরু হয়েছে কিন্তু finish/close হয়নি এমন request-এর live gauge।
  activeRequests: 0,

  // Status code 400 বা বেশি হওয়া response-এর cumulative count।
  errorResponses: 0,

  // Caller-supplied/default duration threshold পার হওয়া request-এর cumulative count।
  slowRequests: 0,

  // Average বের করার জন্য সব recorded request duration-এর sum এবং দেখা সর্বোচ্চ single duration।
  totalDurationMs: 0,
  maxDurationMs: 0,

  // `2xx`, `4xx`, `5xx` ইত্যাদি এবং GET/POST/PATCH ইত্যাদির independent count buckets।
  byStatusClass: {},
  byMethod: {},

  // Normalized `METHOD /path` key অনুযায়ী bounded detailed aggregate; Map insertion order eviction-এ ব্যবহৃত হয়।
  routes: new Map(),
};

// ==================== BLOCK 03: NUMBER ROUNDING ও MEMORY SNAPSHOT HELPERS ====================
// Generic decimal rounding report values compact রাখে। Node process memory bytes-কে MB-তে রূপ দিয়ে RSS, heap total/used ও external memory দেয়।
function roundTo(value, decimals = 2) {
  // Decimal places-এর power-of-ten factor দিয়ে scale → round → unscale করা হয়।
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getMemoryUsageMb() {
  // Node/V8 raw memory counters bytes-এ দেয়; প্রতিটি value 1024² দিয়ে ভাগ করে rounded MB করা হয়।
  const usage = process.memoryUsage();
  return {
    // RSS: process-এর মোট resident memory; heap-এর বাইরের native/buffer memory-ও অন্তর্ভুক্ত।
    rss: roundTo(usage.rss / (1024 * 1024)),

    // Heap total V8 allocated capacity, heap used তার বর্তমানে ব্যবহৃত অংশ।
    heap_total: roundTo(usage.heapTotal / (1024 * 1024)),
    heap_used: roundTo(usage.heapUsed / (1024 * 1024)),

    // External মূলত V8 heap-এর বাইরে JavaScript object-এর সঙ্গে যুক্ত native/Buffer memory।
    external: roundTo(usage.external / (1024 * 1024)),
  };
}

/*
 * =========================================================
 * BLOCK 04: ROUTE PATH NORMALIZATION ও AGGREGATION KEY
 * =========================================================
 * Query string বাদ দেয়, UUID-কে `:uuid`, exact 10-digit token-কে `:phone` এবং numeric path segment-কে `:id` বানায়।
 * Duplicate slash/trailing slash normalize করে method-এর uppercase valueসহ `METHOD /path` key তৈরি হয়।
 * এতে individual invoice/user ids আলাদা route metric না হয়ে একই logical endpoint-এ aggregate হয়।
 */
function normalizeRoutePath(pathname) {
  /*
   * NORMALIZE RULE 01: missing path `/` হয় এবং `?`-এর পর query বাদ যায়—query value metric key cardinality বাড়ায় না।
   * RULE 02: UUID-like token `:uuid`, standalone 10 digit token `:phone`, slash-delimited numeric id `:id` হয়।
   * RULE 03: repeated slash collapse ও final trailing slash remove; result empty হলে root `/` fallback।
   */
  return (
    String(pathname || "/")
      .split("?")[0]
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":uuid")
      .replace(/\b\d{10}\b/g, ":phone")
      .replace(/\/\d+(?=\/|$)/g, "/:id")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "") || "/"
  );
}

function getRouteStatsKey(method, pathname) {
  // Method missing হলে GET fallback এবং lowercase method uppercase হয়, তারপর এক space দিয়ে normalized path যুক্ত হয়।
  return `${String(method || "GET").toUpperCase()} ${normalizeRoutePath(pathname)}`;
}

// ==================== BLOCK 05: GENERIC BUCKET INCREMENT ====================
// Plain object-এর status-class বা HTTP-method counter না থাকলে zero ধরে এক বাড়ায়।
function incrementBucket(bucket, key) {
  bucket[key] = (bucket[key] || 0) + 1;
}

/*
 * =========================================================
 * BLOCK 06: ACTIVE REQUEST GAUGE LIFECYCLE
 * =========================================================
 * Request শুরু হলে gauge বাড়ে এবং response finish/close হলে কমে। Finish helper zero-এর নিচে যেতে দেয় না,
 * ফলে duplicate lifecycle callback হলেও monitoring snapshot negative active request দেখায় না।
 */
function markHttpRequestStarted() {
  // Middleware request গ্রহণের শুরুতে একবার call করে live concurrent request count বাড়ায়।
  metrics.activeRequests += 1;
}

function markHttpRequestFinished() {
  // Finish/close lifecycle-এ count কমে; Math.max defensiveভাবে minimum zero enforce করে।
  metrics.activeRequests = Math.max(0, metrics.activeRequests - 1);
}

/*
 * =========================================================
 * BLOCK 07: COMPLETED HTTP REQUEST RECORDING
 * =========================================================
 * Method/path/status/duration normalize করে global counters, status/method buckets ও per-route aggregate update করে।
 * Status 400+ error এবং configured/default 1500ms-এর বেশি duration slow হিসেবে গণনা হয়।
 * Route-map limit পূর্ণ হলে oldest inserted key সরিয়ে bounded cardinality বজায় রাখে।
 */
function recordHttpRequest({
  method,
  pathname,
  statusCode,
  durationMs,
  slowThresholdMs = 1500,
}) {
  /* RECORD PHASE A: numeric status/duration, status class, uppercase method ও normalized route key derive করা। */
  const normalizedDuration = Number(durationMs) || 0;
  const normalizedStatus = Number(statusCode) || 0;

  // Integer hundreds group status class বানায়: 200 → `2xx`, 404 → `4xx`, 500 → `5xx`।
  const statusClass = `${Math.floor(normalizedStatus / 100)}xx`;
  const methodName = String(method || "GET").toUpperCase();
  const routeKey = getRouteStatsKey(methodName, pathname);

  /* RECORD PHASE B: application-wide totals, cumulative/max duration এবং status/method buckets update। */
  metrics.requestTotal += 1;

  // Sum পরে overall average দেয়; max এখন পর্যন্ত সবচেয়ে ধীর recorded request ধরে।
  metrics.totalDurationMs += normalizedDuration;
  metrics.maxDurationMs = Math.max(metrics.maxDurationMs, normalizedDuration);
  incrementBucket(metrics.byStatusClass, statusClass);
  incrementBucket(metrics.byMethod, methodName);

  /* RECORD PHASE C: error ও slow thresholds অনুযায়ী global counters increment। */
  if (normalizedStatus >= 400) {
    // Client error ও server error দুটো combined error-rate numerator-এ যায়।
    metrics.errorResponses += 1;
  }

  if (normalizedDuration >= slowThresholdMs) {
    // Threshold equality-ও slow হিসেবে count হয়; default 1500 ms।
    metrics.slowRequests += 1;
  }

  /* RECORD PHASE D: নতুন route key-এর জন্য capacity পূর্ণ হলে Map-এর oldest inserted aggregate evict করা। */
  if (!metrics.routes.has(routeKey) && metrics.routes.size >= MAX_ROUTE_STATS) {
    // Eviction শুধু একেবারে নতুন key-র জন্য; existing route update করলে অন্য aggregate সরানো হয় না।
    const oldestKey = metrics.routes.keys().next().value;
    metrics.routes.delete(oldestKey);
  }

  /* RECORD PHASE E: existing অথবা zero-initialized per-route aggregate নিয়ে count/error/slow/duration fields update। */
  const routeStats = metrics.routes.get(routeKey) || {
    route: routeKey,
    count: 0,
    errors: 0,
    slow: 0,
    total_duration_ms: 0,
    max_duration_ms: 0,
  };

  routeStats.count += 1;

  // Route-specific average snapshot-এর সময় বের হয়, তাই এখানে raw cumulative duration রাখা হয়।
  routeStats.total_duration_ms += normalizedDuration;
  routeStats.max_duration_ms = Math.max(
    routeStats.max_duration_ms,
    normalizedDuration,
  );
  if (normalizedStatus >= 400) {
    // Global-এর পাশাপাশি এই logical route-এর নিজস্ব error count বাড়ে।
    routeStats.errors += 1;
  }
  if (normalizedDuration >= slowThresholdMs) {
    // কোন route বারবার slow হচ্ছে তা top-route detail-এ দেখাতে local slow count রাখা হয়।
    routeStats.slow += 1;
  }

  // Updated object Map-এ save হয়; existing key update insertion order বদলায় না।
  metrics.routes.set(routeKey, routeStats);
}

/*
 * =========================================================
 * BLOCK 08: DATABASE POOL SNAPSHOT
 * =========================================================
 * Optional pool থেকে total/idle/waiting connection counts, readiness function-এর result ও custom database state নেয়।
 * Pool supplied না হলে null দেয়, তাই monitoring utility database ছাড়া test/context-এও ব্যবহার করা যায়।
 */
function getPoolStats(pool) {
  if (!pool) {
    return null;
  }

  return {
    // Driver pool-এর বর্তমান opened, immediately available এবং acquisition queue-তে waiting connection/request counts।
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,

    // Project-specific pool API থাকলে readiness boolean; না থাকলে undefined রেখে false assumption এড়ানো হয়।
    ready: typeof pool.isReady === "function" ? pool.isReady() : undefined,

    // Database wrapper প্রকাশিত last lifecycle/state detail অথবা null।
    state: pool.dbState || null,
  };
}

/*
 * =========================================================
 * BLOCK 09: COMBINED MONITORING SNAPSHOT
 * =========================================================
 * Route aggregate-এ average/max duration হিসাব করে cumulative duration অনুযায়ী descending sort এবং top ২৫টি route রাখে।
 * তারপর service identity, uptime/time, memory, request summary, DB pool, cache ও export queue metrics এক immutable response shape-এ সাজায়।
 */
function buildMonitoringSnapshot(pool = null) {
  /* SNAPSHOT PHASE A: route objects copy, derived averages round, busiest cumulative-duration routes rank এবং limit করা। */
  const routeStats = Array.from(metrics.routes.values())
    // Original stored object mutate না করে response copy-তে derived average/max যোগ করা হয়।
    .map((route) => ({
      ...route,
      avg_duration_ms: route.count
        ? roundTo(route.total_duration_ms / route.count)
        : 0,
      max_duration_ms: roundTo(route.max_duration_ms),
    }))
    // Total time বেশি মানে overall server time বেশি খরচ করেছে—সেই route আগে আসে।
    .sort((a, b) => b.total_duration_ms - a.total_duration_ms)

    // Dashboard payload compact রাখতে সর্বোচ্চ ২৫টি ranked route প্রকাশ করা হয়।
    .slice(0, 25);

  /* SNAPSHOT PHASE B: process ও shared subsystem live values-এর সঙ্গে current request aggregates assemble করা। */
  return {
    // স্থির service identifier multi-service monitoring view-এ source চিনতে সাহায্য করে।
    service: "shop-inventory-management",

    // Collection-start, current process uptime এবং snapshot-generation time monitoring window বোঝায়।
    started_at: metrics.startedAt,
    uptime_seconds: roundTo(process.uptime(), 3),
    timestamp: new Date().toISOString(),
    // Function call-এর মুহূর্তের live process memory snapshot।
    memory_mb: getMemoryUsageMb(),
    requests: {
      // Global volume/gauges এবং performance summary।
      total: metrics.requestTotal,
      active: metrics.activeRequests,
      errors: metrics.errorResponses,
      slow: metrics.slowRequests,
      // কোনো recorded request না থাকলে division এড়িয়ে average zero রাখা হয়।
      avg_duration_ms: metrics.requestTotal
        ? roundTo(metrics.totalDurationMs / metrics.requestTotal)
        : 0,
      max_duration_ms: roundTo(metrics.maxDurationMs),
      // Breakdown objects ও ranked route detail operator-কে error/traffic source খুঁজতে সাহায্য করে।
      by_status_class: metrics.byStatusClass,
      by_method: metrics.byMethod,
      top_routes: routeStats,
    },
    // Shared subsystems-এর live stats একই timestamp-এর operational view সম্পূর্ণ করে।
    db_pool: getPoolStats(pool),
    cache: responseCache.stats(),
    exports: exportQueue.stats(),
  };
}

/*
 * =========================================================
 * BLOCK 10: PUBLIC MONITORING API
 * =========================================================
 * HTTP middleware-এর lifecycle/record functions, operations route-এর snapshot builder এবং direct diagnostics/tests-এর metrics state export হয়।
 * Normalization/rounding/pool helpers private implementation detail থাকে।
 */
module.exports = {
  buildMonitoringSnapshot,
  markHttpRequestFinished,
  markHttpRequestStarted,
  metrics,
  recordHttpRequest,
};
