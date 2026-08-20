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

function isSensitiveKey(key) {
  const normalizedKey = String(key || "")
    .trim()
    .toLowerCase();

  if (!normalizedKey) {
    return false;
  }

  return sensitiveKeyFragments.some((fragment) =>
    normalizedKey.includes(fragment),
  );
}

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

function sanitizeValue(value, depth = 0) {
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

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return normalizeError(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }

  if (typeof value === "object") {
    if (depth >= 4) {
      return "[MaxDepth]";
    }

    const sanitized = {};

    for (const [key, entry] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        sanitized[key] = REDACTED_VALUE;
        continue;
      }

      const normalizedEntry = sanitizeValue(entry, depth + 1);
      if (normalizedEntry !== undefined) {
        sanitized[key] = normalizedEntry;
      }
    }

    return sanitized;
  }

  return String(value);
}

function logEvent(level, event, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
  };

  const sanitizedMeta = sanitizeValue(meta);
  if (sanitizedMeta && typeof sanitizedMeta === "object") {
    Object.assign(entry, sanitizedMeta);
  }

  const serialized = JSON.stringify(entry);

  // Keep a small, non-sensitive diagnostic trail for the owner-only health
  // report. Metadata is deliberately not retained in memory or exposed.
  recentEvents.push({ ts: entry.ts, level: entry.level, event: entry.event });
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.splice(0, recentEvents.length - MAX_RECENT_EVENTS);
  }

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

function getRecentRuntimeEvents(levels = ["error", "warn"], limit = 20) {
  const accepted = new Set(levels);
  return recentEvents
    .filter((entry) => accepted.has(entry.level))
    .slice(-Math.max(1, Math.min(Number(limit) || 20, MAX_RECENT_EVENTS)))
    .reverse();
}

module.exports = {
  getRecentRuntimeEvents,
  logEvent,
  normalizeError,
};
