/**
 * =========================================================
 * FILE: utils/runtime-log.js
 * PURPOSE: STRUCTURED RUNTIME LOGGING, SECRET REDACTION ও RECENT EVENT TRAIL
 * =========================================================
 * এই module application event-কে timestamped JSON log হিসেবে console-এ লেখে এবং metadata log করার আগে recursive sanitization চালায়।
 * Password/token/cookie/secret-এর মতো key-এর value redact হয়; Error, Date, array ও plain object serializable shape-এ বদলায়।
 * Owner-only health report-এর জন্য সর্বশেষ event-এর শুধু time/level/name bounded memory list-এ থাকে—metadata সেখানে রাখা হয় না।
 */

// ==================== BLOCK 01: REDACTION MARKER, HISTORY LIMIT ও SENSITIVE KEY RULES ====================
// Sensitive value-এর জায়গায় fixed marker বসে। Process-local recent trail সর্বোচ্চ ৮০টি event রাখে। Fragment list key name-এর মধ্যে
// password, token, secret, authorization, cookie, API/access key অথবা JWT-এর ইঙ্গিত থাকলে case-insensitive redaction trigger করে।
const REDACTED_VALUE = "[REDACTED]";
const MAX_RECENT_EVENTS = 80;
const recentEvents = [];
const sensitiveKeyFragments = [
  "password",
  "token",
  "secret",
  "authorization",
  "cookie",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "jwt",
];

/*
 * =========================================================
 * BLOCK 02: SENSITIVE OBJECT KEY DETECTION
 * =========================================================
 * Key string-এ convert, trim ও lowercase করে; empty key sensitive নয়।
 * Allow-list নয়—যেকোনো configured fragment key-এর যে কোনো স্থানে থাকলেই sensitive ধরা হয়, যেমন `accessToken` বা `password_hash`।
 */
function isSensitiveKey(key) {
  const normalizedKey = String(key || "")
    .trim()
    .toLowerCase();

  if (!normalizedKey) {
    return false;
  }

  // প্রথম matching fragment পেলেই `some` true দেয়; actual value কখনো inspect করার প্রয়োজন হয় না।
  return sensitiveKeyFragments.some((fragment) =>
    normalizedKey.includes(fragment),
  );
}

/*
 * =========================================================
 * BLOCK 03: ERROR NORMALIZATION
 * =========================================================
 * Empty error null হয়। Native Error instance থেকে name/message/code/stack-এর serializable object তৈরি হয়।
 * String বা অন্য thrown value generic string message-এ রূপ নেয়, ফলে JSON.stringify-তে useful failure detail হারায় না।
 */
function normalizeError(error) {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: error.code || null,
      stack: error.stack || null,
    };
  }

  return {
    message: String(error),
  };
}

/*
 * =========================================================
 * BLOCK 04: RECURSIVE LOG METADATA SANITIZATION
 * =========================================================
 * Primitive অপরিবর্তিত, Date ISO string এবং Error normalized object হয়। Array entries recursively sanitize হয়ে undefined বাদ যায়।
 * Object key sensitive হলে value না পড়ে redact marker বসে; non-sensitive nested object চার level-এর পরে `[MaxDepth]` হয়।
 * Function/Symbol/BigInt বা অন্য unsupported type শেষ fallback-এ string হয়, যাতে structured log JSON serialization-friendly থাকে।
 */
function sanitizeValue(value, depth = 0) {
  /* SANITIZE PHASE A: undefined/null এবং directly JSON-safe primitive type handle করা। */
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  /* SANITIZE PHASE B: Date ও Error-এর meaningful serializable representation তৈরি। */
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return normalizeError(value);
  }

  /* SANITIZE PHASE C: array order রেখে প্রতিটি entry recursive sanitize এবং undefined results বাদ দেওয়া। */
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }

  /* SANITIZE PHASE D: nested object depth bound, key-based redaction এবং safe child-value copy। */
  if (typeof value === "object") {
    // Deep/cyclic-looking object traversal ও oversized logs সীমিত রাখতে চার object level-এর পরে placeholder ফেরে।
    if (depth >= 4) {
      return "[MaxDepth]";
    }

    const sanitized = {};

    for (const [key, entry] of Object.entries(value)) {
      // Sensitive key হলে original entry sanitize/serialize না করে সরাসরি marker বসানো হয়।
      if (isSensitiveKey(key)) {
        sanitized[key] = REDACTED_VALUE;
        continue;
      }

      // Undefined child JSON output থেকে বাদ যায়; অন্য sanitized value একই key-তে রাখা হয়।
      const normalizedEntry = sanitizeValue(entry, depth + 1);
      if (normalizedEntry !== undefined) {
        sanitized[key] = normalizedEntry;
      }
    }

    return sanitized;
  }

  /* SANITIZE PHASE E: আগের category-তে না পড়া value safe string representation-এ নামানো। */
  return String(value);
}

/*
 * =========================================================
 * BLOCK 05: STRUCTURED EVENT LOG লেখা
 * =========================================================
 * UTC ISO timestamp, caller level ও event name দিয়ে base entry বানায়; sanitized metadata object হলে তার fields merge হয়।
 * Full entry এক-line JSON হয়, যাতে hosting log collector সহজে parse/search করতে পারে।
 * Recent in-memory trail minimal থাকে এবং level অনুযায়ী console.error/warn/log ব্যবহার হয়।
 */
function logEvent(level, event, meta = {}) {
  /* LOG PHASE A: base identity/time fields তৈরি এবং sanitized metadata shallow-merge। */
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
  };

  const sanitizedMeta = sanitizeValue(meta);
  if (sanitizedMeta && typeof sanitizedMeta === "object") {
    Object.assign(entry, sanitizedMeta);
  }

  /* LOG PHASE B: final safe entry compact JSON string-এ serialize করা। */
  const serialized = JSON.stringify(entry);

  /*
   * LOG PHASE C: owner health report-এর জন্য শুধু timestamp/level/event রাখা।
   * Full metadata console log-এ গেলেও recentEvents memory/API trail-এ ইচ্ছাকৃতভাবে retained বা exposed হয় না।
   */
  recentEvents.push({ ts: entry.ts, level: entry.level, event: entry.event });

  // Limit ছাড়ালে array-এর শুরু থেকে oldest overflow events একবারে বাদ যায়।
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.splice(0, recentEvents.length - MAX_RECENT_EVENTS);
  }

  /* LOG PHASE D: error → stderr error, warn → stderr warning, অন্য সব level → standard console log। */
  if (level === "error") {
    console.error(serialized);
    return;
  }

  if (level === "warn") {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
}

/*
 * =========================================================
 * BLOCK 06: RECENT RUNTIME EVENT QUERY
 * =========================================================
 * Default-এ শুধু error/warn event নেয়; caller custom accepted levels ও result limit দিতে পারে।
 * Limit minimum ১, maximum history capacity ৮০ এবং invalid value-এ ২০ হয়। শেষের matching events নিয়ে reverse করায় newest event আগে আসে।
 */
function getRecentRuntimeEvents(levels = ["error", "warn"], limit = 20) {
  // Set membership filtering repeated level comparison concise ও efficient রাখে।
  const accepted = new Set(levels);
  return recentEvents
    .filter((entry) => accepted.has(entry.level))
    .slice(-Math.max(1, Math.min(Number(limit) || 20, MAX_RECENT_EVENTS)))
    .reverse();
}

/*
 * =========================================================
 * BLOCK 07: PUBLIC RUNTIME-LOG API
 * =========================================================
 * Application code structured event লেখে, health report recent minimal events পড়ে এবং caller চাইলে Error normalize helper reuse করে।
 * Sanitization/redaction internals private থাকে, তাই সব metadata `logEvent` flow দিয়েই নিরাপদভাবে যায়।
 */
module.exports = {
  getRecentRuntimeEvents,
  logEvent,
  normalizeError,
};
