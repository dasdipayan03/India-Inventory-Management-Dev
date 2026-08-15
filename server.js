/**
 * =========================================================
 * FILE: server.js
 * ENTRY POINT: Application Bootstrap File
 *
 * PURPOSE:
 *  - Initialize Express app
 *  - Configure global middleware
 *  - Register API routes
 *  - Serve frontend
 *  - Handle errors
 *  - Start HTTP server
 *  - Handle graceful shutdown
 * =========================================================
 */

// =========================================================
// 📦 CORE DEPENDENCIES
// =========================================================
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

// =========================================================
// 🔐 SECURITY & PERFORMANCE MIDDLEWARE
// =========================================================
const helmet = require("helmet"); // Security headers
const cors = require("cors"); // Cross-origin access
const rateLimitPackage = require("express-rate-limit"); // Rate limiting
const compression = require("compression"); // Gzip compression
const cookieParser = require("cookie-parser"); // Cookie parsing

// =========================================================
// 🗄 DATABASE
// =========================================================
const pool = require("./db");
const { logEvent } = require("./utils/runtime-log");
const { createQueuedExportMiddleware } = require("./middleware/export-queue");
const {
  markHttpRequestFinished,
  markHttpRequestStarted,
  recordHttpRequest,
} = require("./utils/monitoring");
const {
  startBackgroundJobs,
  stopBackgroundJobs,
} = require("./utils/background-jobs");

// =========================================================
// 🚀 CREATE EXPRESS APP
// =========================================================
const app = express();
const rateLimit = rateLimitPackage.rateLimit || rateLimitPackage;
const ipKeyGenerator =
  rateLimitPackage.ipKeyGenerator || ((ip) => ip || "unknown");
const publicDir = path.join(__dirname, "public");
const htmlTemplateCache = new Map();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const LOGIN_BANNER_LIMIT = 10;
const LOGIN_BANNER_PLACEHOLDER = "<!-- LOGIN_BANNER_SLIDES -->";
const LOGIN_BANNER_FILE_PATTERN =
  /^login_page_banner_([1-9]|10)\.(?:png|jpe?g|webp)$/i;
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "1mb";
const URLENCODED_BODY_LIMIT = process.env.URLENCODED_BODY_LIMIT || "200kb";
const STATIC_ASSET_CACHE_MS =
  process.env.NODE_ENV === "production" ? ONE_DAY_MS : 0;
const CACHE_REPAIR_BOOTSTRAP_VERSION =
  process.env.APP_CACHE_VERSION ||
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  "2026-08-04-auto-cache-repair-1";
const PROCESS_STARTED_AT = Date.now();
const PORT = process.env.PORT || 8080;
const ENABLE_REQUEST_LOGS = process.env.ENABLE_REQUEST_LOGS === "true";
const REQUEST_LOG_SLOW_MS = readPositiveInt(
  process.env.REQUEST_LOG_SLOW_MS,
  1500,
);
const DB_POOL_WAITING_REJECT_THRESHOLD = readPositiveInt(
  process.env.DB_POOL_WAITING_REJECT_THRESHOLD,
  20,
);
const MAINTENANCE_MODE = ["1", "true", "yes", "on"].includes(
  String(process.env.MAINTENANCE_MODE || "")
    .trim()
    .toLowerCase(),
);
const MAINTENANCE_MESSAGE =
  String(process.env.MAINTENANCE_MESSAGE || "").trim() ||
  "Sorry for the inconvenience.";
const MAINTENANCE_RETRY_AFTER_SECONDS = readPositiveInt(
  process.env.MAINTENANCE_RETRY_AFTER_SECONDS,
  3600,
);
const READINESS_ROUTE_PATHS = new Set([
  "/health",
  "/api/health",
  "/healthz",
  "/api/healthz",
  "/ready",
  "/api/ready",
  "/readyz",
  "/api/readyz",
]);
const LIVENESS_ROUTE_PATHS = new Set([
  "/live",
  "/api/live",
  "/livez",
  "/api/livez",
]);

let server = null;
let isShuttingDown = false;

// Required for deployment platforms like Railway / Render
app.set("trust proxy", 1);
app.disable("x-powered-by");

logEvent("info", "app_bootstrap_started", {
  pid: process.pid,
  nodeVersion: process.version,
  env: process.env.NODE_ENV || "development",
  port: Number(PORT),
  publicDirExists: fs.existsSync(publicDir),
  requestLoggingEnabled: ENABLE_REQUEST_LOGS,
  requestLogSlowMs: REQUEST_LOG_SLOW_MS,
  maintenanceMode: MAINTENANCE_MODE,
  baseUrlConfigured: Boolean(process.env.BASE_URL),
});

// =========================================================
// 🌐 GLOBAL MIDDLEWARE CONFIGURATION
// =========================================================

/**
 * Enable CORS
 * Allows frontend to send cookies & requests
 */
function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeOrigin(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  try {
    return new URL(rawValue).origin;
  } catch (_error) {
    return "";
  }
}

function buildAllowedOrigins() {
  const explicitOrigins = String(process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);

  if (explicitOrigins.length) {
    return explicitOrigins;
  }

  if (process.env.NODE_ENV !== "production") {
    return [
      "http://localhost:3000",
      "http://localhost:4000",
      "http://localhost:5173",
      "http://localhost:8080",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:4000",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:8080",
    ];
  }

  const baseOrigin = normalizeOrigin(process.env.BASE_URL);
  if (baseOrigin) {
    return [baseOrigin];
  }

  return [];
}

const allowedOrigins = new Set(buildAllowedOrigins());
const nonceDirective = (_req, res) => `'nonce-${res.locals.cspNonce}'`;

function normalizePathname(value) {
  const pathname = String(value || "")
    .split("?")[0]
    .trim();

  if (!pathname || pathname === "/") {
    return "/";
  }

  return pathname.replace(/\/+$/, "") || "/";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getRequestPath(req) {
  return normalizePathname(req.originalUrl || req.url || req.path);
}

function isHealthRoutePath(pathname) {
  return (
    READINESS_ROUTE_PATHS.has(pathname) || LIVENESS_ROUTE_PATHS.has(pathname)
  );
}

function roundTo(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getMemoryUsageMb() {
  const usage = process.memoryUsage();
  return {
    rss: roundTo(usage.rss / (1024 * 1024)),
    heapTotal: roundTo(usage.heapTotal / (1024 * 1024)),
    heapUsed: roundTo(usage.heapUsed / (1024 * 1024)),
    external: roundTo(usage.external / (1024 * 1024)),
  };
}

function buildDbHealth() {
  const dbState = pool.dbState || {};
  const isReady = typeof pool.isReady === "function" ? pool.isReady() : false;

  return {
    status: isReady ? "ready" : dbState.status || "unknown",
    ready: isReady,
    readyAt: dbState.readyAt || null,
    lastError: dbState.lastError || null,
    lastErrorAt: dbState.lastErrorAt || null,
  };
}

function buildHealthPayload(kind) {
  const db = buildDbHealth();
  const ok =
    kind === "liveness" ? !isShuttingDown : db.ready && !isShuttingDown;

  return {
    status: ok ? "ok" : "degraded",
    kind,
    service: "shop-inventory-management",
    uptimeSeconds: roundTo(process.uptime(), 3),
    timestamp: new Date().toISOString(),
    port: Number(PORT),
    nodeVersion: process.version,
    shuttingDown: isShuttingDown,
    serverListening: Boolean(server && server.listening),
    db,
    memoryMb: getMemoryUsageMb(),
  };
}

function sendHealthResponse(res, kind) {
  const payload = buildHealthPayload(kind);
  res.set("Cache-Control", "no-store");
  res.status(payload.status === "ok" ? 200 : 503).json(payload);
}

function getHtmlTemplate(fileName) {
  if (process.env.NODE_ENV !== "production") {
    return fs.readFileSync(path.join(publicDir, fileName), "utf8");
  }

  if (htmlTemplateCache.has(fileName)) {
    return htmlTemplateCache.get(fileName);
  }

  const fullPath = path.join(publicDir, fileName);
  const template = fs.readFileSync(fullPath, "utf8");
  htmlTemplateCache.set(fileName, template);
  return template;
}

function applyHtmlCacheHeaders(res) {
  res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
  res.set("Pragma", "no-cache");
}

function injectPerformanceBootstrap(html) {
  if (html.includes("/js/service-worker-register.js")) {
    return html;
  }

  const repairVersion = escapeHtml(CACHE_REPAIR_BOOTSTRAP_VERSION);
  const repairSrc = `/js/service-worker-register.js?v=${encodeURIComponent(
    CACHE_REPAIR_BOOTSTRAP_VERSION,
  )}`;
  const bootstrapTags = [
    '<link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin />',
    '<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />',
    `<script src="${repairSrc}" defer data-cache-repair-version="${repairVersion}"></script>`,
  ].join("\n    ");

  return html.replace("</head>", `    ${bootstrapTags}\n  </head>`);
}

function getLoginBannerFiles() {
  const imagesDir = path.join(publicDir, "images");

  let entries = [];
  try {
    entries = fs.readdirSync(imagesDir, { withFileTypes: true });
  } catch (err) {
    logEvent("warn", "login_banner_directory_read_failed", { error: err });
    return [];
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = entry.name.match(LOGIN_BANNER_FILE_PATTERN);
      if (!match) {
        return null;
      }

      const index = Number.parseInt(match[1], 10);
      const filePath = path.join(imagesDir, entry.name);

      try {
        const stat = fs.statSync(filePath);
        return {
          index,
          name: entry.name,
          version: `${Math.floor(stat.mtimeMs)}-${stat.size}`,
        };
      } catch (err) {
        logEvent("warn", "login_banner_stat_failed", {
          fileName: entry.name,
          error: err,
        });
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index || a.name.localeCompare(b.name))
    .slice(0, LOGIN_BANNER_LIMIT);
}

function buildLoginBannerSlides() {
  return getLoginBannerFiles()
    .map((banner, slideIndex) => {
      const loading = slideIndex === 0 ? "eager" : "lazy";
      const src = `/images/${encodeURIComponent(banner.name)}?v=${encodeURIComponent(
        banner.version,
      )}`;

      return [
        '<article class="feature-slide" data-feature-slide>',
        "  <img",
        `    src="${src}"`,
        `    alt="Shop Inventory Management login banner ${banner.index}"`,
        `    loading="${loading}"`,
        '    decoding="async"',
        "  />",
        "</article>",
      ].join("\n");
    })
    .join("\n");
}

function injectLoginBanners(html) {
  if (!html.includes(LOGIN_BANNER_PLACEHOLDER)) {
    return html;
  }

  return html.replace(LOGIN_BANNER_PLACEHOLDER, buildLoginBannerSlides());
}

function setStaticAssetCacheHeaders(res, filePath) {
  if (path.basename(filePath) === "service-worker.js") {
    res.set("Cache-Control", "no-cache, max-age=0, must-revalidate");
    res.set("Service-Worker-Allowed", "/");
    return;
  }

  if (path.basename(filePath) === "app_logo.png") {
    res.set("Cache-Control", "no-cache, max-age=0, must-revalidate");
    return;
  }

  if (LOGIN_BANNER_FILE_PATTERN.test(path.basename(filePath))) {
    res.set("Cache-Control", "no-cache, max-age=0, must-revalidate");
    return;
  }

  if (/\.html?$/i.test(filePath)) {
    applyHtmlCacheHeaders(res);
    return;
  }

  if (
    STATIC_ASSET_CACHE_MS > 0 &&
    /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/i.test(filePath)
  ) {
    res.set(
      "Cache-Control",
      `public, max-age=${Math.floor(STATIC_ASSET_CACHE_MS / 1000)}, must-revalidate`,
    );
    return;
  }

  res.set("Cache-Control", "no-cache");
}

function sendHtmlTemplate(res, fileName, statusCode = 200) {
  const template =
    fileName === "login.html"
      ? injectLoginBanners(getHtmlTemplate(fileName))
      : getHtmlTemplate(fileName);
  const html = injectPerformanceBootstrap(template).replace(
    /__CSP_NONCE__/g,
    res.locals.cspNonce || "",
  );

  applyHtmlCacheHeaders(res);
  res.status(statusCode).type("html").send(html);
}

function sendMaintenancePage(req, res) {
  const message = MAINTENANCE_MESSAGE;
  res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Retry-After", String(MAINTENANCE_RETRY_AFTER_SECONDS));

  if (req.path.startsWith("/api") || req.accepts(["html", "json"]) === "json") {
    return res.status(503).json({
      success: false,
      error: "maintenance",
      message,
    });
  }

  const nonce = res.locals.cspNonce || "";
  return res.status(503).type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Maintenance</title>
    <style nonce="${nonce}">
      :root {
        color-scheme: light;
        font-family: Inter, Arial, sans-serif;
        background: #eef6ff;
        color: #10233f;
      }
      * {
        box-sizing: border-box;
      }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(14, 165, 233, 0.18), transparent 34%),
          linear-gradient(135deg, #f8fbff, #e7f3ff);
      }
      main {
        width: min(100%, 520px);
        padding: 34px 28px;
        border: 1px solid rgba(125, 211, 252, 0.46);
        border-radius: 24px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
        text-align: center;
      }
      h1 {
        margin: 0 0 12px;
        font-size: clamp(28px, 5vw, 42px);
        line-height: 1.08;
      }
      p {
        margin: 0;
        color: #526581;
        font-size: 17px;
        line-height: 1.7;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>This App is under maintenance</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`);
}

function sendCacheRepairResponse(res) {
  res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Clear-Site-Data", '"cache"');
  res.json({
    success: true,
    cache: "clear-requested",
    version: CACHE_REPAIR_BOOTSTRAP_VERSION,
    timestamp: new Date().toISOString(),
  });
}

function sendNetworkCheckPage(req, res) {
  const nonce = escapeHtml(res.locals.cspNonce || "");

  res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("X-Robots-Tag", "noindex, nofollow");

  return res.status(200).type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Network Check</title>
    <style nonce="${nonce}">
      :root {
        color-scheme: light;
        font-family: Arial, sans-serif;
        background: #f4f8fb;
        color: #14243b;
      }
      * {
        box-sizing: border-box;
      }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 18px;
      }
      main {
        width: min(100%, 680px);
        padding: 22px;
        border: 1px solid #d7e5ee;
        border-radius: 14px;
        background: #fff;
        box-shadow: 0 18px 44px rgba(15, 35, 55, 0.1);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 24px;
      }
      p {
        margin: 0 0 18px;
        color: #5e7188;
        line-height: 1.55;
      }
      dl {
        display: grid;
        grid-template-columns: 150px 1fr;
        gap: 8px 12px;
        margin: 0 0 18px;
        font-size: 14px;
      }
      dt {
        color: #5e7188;
        font-weight: 700;
      }
      dd {
        margin: 0;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        overflow: hidden;
        border: 1px solid #d7e5ee;
        border-radius: 12px;
        font-size: 14px;
      }
      th,
      td {
        padding: 10px 12px;
        border-bottom: 1px solid #e7eef4;
        text-align: left;
        vertical-align: top;
      }
      th {
        background: #eef6fb;
        color: #405871;
        font-size: 12px;
        text-transform: uppercase;
      }
      tr:last-child td {
        border-bottom: 0;
      }
      .ok {
        color: #137a3d;
        font-weight: 700;
      }
      .bad {
        color: #b42318;
        font-weight: 700;
      }
      button {
        margin-top: 18px;
        min-height: 42px;
        border: 0;
        border-radius: 10px;
        padding: 0 16px;
        background: #1677b8;
        color: #fff;
        font-weight: 700;
      }
      @media (max-width: 520px) {
        dl {
          grid-template-columns: 1fr;
        }
        th,
        td {
          padding: 9px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Network Check</h1>
      <p>This page uses only first-party files and bypasses the app shell cache.</p>
      <dl>
        <dt>Page URL</dt>
        <dd id="pageUrl">Checking...</dd>
        <dt>Online flag</dt>
        <dd id="onlineState">Checking...</dd>
        <dt>Service worker</dt>
        <dd id="workerState">Checking...</dd>
        <dt>Checked at</dt>
        <dd id="checkedAt">Checking...</dd>
      </dl>
      <table>
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Status</th>
            <th>Time</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody id="results">
          <tr>
            <td colspan="4">Running checks...</td>
          </tr>
        </tbody>
      </table>
      <button type="button" id="rerunButton">Run Again</button>
    </main>
    <script nonce="${nonce}">
      const endpoints = ["/live", "/health", "/api/live"];
      const results = document.getElementById("results");
      const pageUrl = document.getElementById("pageUrl");
      const onlineState = document.getElementById("onlineState");
      const workerState = document.getElementById("workerState");
      const checkedAt = document.getElementById("checkedAt");
      const rerunButton = document.getElementById("rerunButton");

      function escapeText(value) {
        return String(value ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function renderRows(rows) {
        results.innerHTML = rows
          .map((row) => {
            const statusClass = row.ok ? "ok" : "bad";
            return [
              "<tr>",
              "<td>" + escapeText(row.path) + "</td>",
              "<td class=\\"" + statusClass + "\\">" + escapeText(row.status) + "</td>",
              "<td>" + escapeText(row.ms) + " ms</td>",
              "<td>" + escapeText(row.detail) + "</td>",
              "</tr>",
            ].join("");
          })
          .join("");
      }

      async function checkEndpoint(path) {
        const startedAt = performance.now();
        try {
          const response = await fetch(path + "?_network_check=" + Date.now(), {
            cache: "no-store",
            credentials: "include",
            headers: {
              accept: "application/json",
            },
          });
          const elapsedMs = Math.round(performance.now() - startedAt);
          const contentType = response.headers.get("content-type") || "";
          let detail = response.statusText || "response received";

          if (contentType.includes("application/json")) {
            const data = await response.json();
            detail = data.status || data.kind || detail;
          }

          return {
            path,
            ok: response.ok,
            status: String(response.status),
            ms: elapsedMs,
            detail,
          };
        } catch (error) {
          return {
            path,
            ok: false,
            status: "failed",
            ms: Math.round(performance.now() - startedAt),
            detail: error.message || "network error",
          };
        }
      }

      async function runChecks() {
        rerunButton.disabled = true;
        pageUrl.textContent = window.location.href;
        onlineState.textContent = navigator.onLine ? "online" : "offline";
        workerState.textContent = navigator.serviceWorker?.controller
          ? "active"
          : "not controlling this page";
        checkedAt.textContent = new Date().toLocaleString();
        results.innerHTML = '<tr><td colspan="4">Running checks...</td></tr>';
        renderRows(await Promise.all(endpoints.map(checkEndpoint)));
        rerunButton.disabled = false;
      }

      rerunButton.addEventListener("click", runChecks);
      runChecks();
    </script>
  </body>
</html>`);
}

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  const requestId = req.get("x-request-id") || crypto.randomUUID();

  req.requestId = requestId;
  res.set("X-Request-Id", requestId);
  markHttpRequestStarted();

  let completionRecorded = false;
  const recordRequestCompletion = () => {
    if (completionRecorded) {
      return;
    }

    completionRecorded = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const pathName = getRequestPath(req);
    const aborted = !res.writableEnded;
    markHttpRequestFinished();
    recordHttpRequest({
      method: req.method,
      pathname: pathName,
      statusCode: res.statusCode,
      durationMs,
      slowThresholdMs: REQUEST_LOG_SLOW_MS,
    });
    const shouldLog =
      ENABLE_REQUEST_LOGS ||
      res.statusCode >= 500 ||
      durationMs >= REQUEST_LOG_SLOW_MS ||
      (isHealthRoutePath(pathName) && res.statusCode >= 400);

    if (!shouldLog) {
      return;
    }

    logEvent(
      res.statusCode >= 500
        ? "error"
        : durationMs >= REQUEST_LOG_SLOW_MS
          ? "warn"
          : "info",
      "http_request",
      {
        requestId,
        method: req.method,
        path: pathName,
        statusCode: res.statusCode,
        durationMs: roundTo(durationMs, 2),
        ip: req.ip,
        userAgent: req.get("user-agent") || null,
        responseLength: res.getHeader("content-length") || null,
        aborted,
      },
    );
  };

  res.on("finish", recordRequestCompletion);
  res.on("close", recordRequestCompletion);

  next();
});

app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      }

      return callback(null, false);
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: JSON_BODY_LIMIT })); // Parse incoming JSON requests
app.use(express.urlencoded({ extended: false, limit: URLENCODED_BODY_LIMIT }));
app.use(cookieParser()); // Parse cookies from client
app.use(compression({ threshold: 1024 })); // Compress larger responses only

// Keep all health aliases ahead of /api middleware and routers so Railway and
// load balancers can check readiness without a user session.
app.get(Array.from(READINESS_ROUTE_PATHS), (req, res) => {
  sendHealthResponse(res, "readiness");
});

app.get(Array.from(LIVENESS_ROUTE_PATHS), (req, res) => {
  sendHealthResponse(res, "liveness");
});

function getAuthTokenFromRequest(req) {
  if (req.cookies?.token) {
    return req.cookies.token;
  }

  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    return header.split(" ")[1];
  }

  return null;
}

function getRateLimitKey(req) {
  const token = getAuthTokenFromRequest(req);
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const ownerId = decoded.ownerId || decoded.id;
      const actorId = decoded.actorId || decoded.staffId || decoded.id;
      const role = decoded.role || "user";
      if (ownerId) {
        return `user:${ownerId}:actor:${actorId || ownerId}:role:${role}`;
      }
    } catch (_error) {
      // Invalid tokens fall back to IP based limiting and auth middleware rejects them.
    }
  }

  return `ip:${ipKeyGenerator(req.ip)}`;
}

// Rate Limiter
// Authenticated users are limited by account/actor, anonymous requests by IP.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: readPositiveInt(process.env.API_RATE_LIMIT_MAX, 500),
  keyGenerator: getRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  skip(req) {
    return isHealthRoutePath(getRequestPath(req));
  },
  message: {
    error: "Too many requests. Please wait a moment and try again.",
  },
});
app.use("/api", limiter);
app.use("/api", (req, res, next) => {
  if (
    !isHealthRoutePath(getRequestPath(req)) &&
    Number(pool.waitingCount || 0) >= DB_POOL_WAITING_REJECT_THRESHOLD
  ) {
    logEvent("warn", "db_pool_backpressure_rejected_request", {
      requestId: req.requestId || null,
      method: req.method,
      path: getRequestPath(req),
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
      threshold: DB_POOL_WAITING_REJECT_THRESHOLD,
    });

    res.set("Retry-After", "3");
    return res.status(503).json({
      error: "Server is busy. Please try again in a moment.",
    });
  }

  return next();
});
app.use("/api", createQueuedExportMiddleware({ port: PORT }));

// =========================================================
// 🛡 CONTENT SECURITY POLICY (Helmet)
// Allows required CDN for Bootstrap & FontAwesome
// =========================================================
app.use(
  helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'none'"],
      "object-src": ["'none'"],
      "script-src": [
        "'self'",
        nonceDirective,
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
      ],
      "script-src-attr": ["'none'"],
      "style-src": [
        "'self'",
        nonceDirective,
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
      ],
      "style-src-attr": ["'none'"],
      "img-src": ["'self'", "data:", "https://cdn.jsdelivr.net"],
      "font-src": [
        "'self'",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
      ],
      "worker-src": ["'self'"],
      "connect-src": [
        "'self'",
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com",
      ],
    },
  }),
);
app.use(helmet.frameguard({ action: "deny" }));
app.use(helmet.noSniff());
app.use(helmet.referrerPolicy({ policy: "same-origin" }));

if (MAINTENANCE_MODE) {
  logEvent("warn", "maintenance_mode_enabled", {
    retryAfterSeconds: MAINTENANCE_RETRY_AFTER_SECONDS,
  });
}

app.use((req, res, next) => {
  if (!MAINTENANCE_MODE || isHealthRoutePath(getRequestPath(req))) {
    return next();
  }

  return sendMaintenancePage(req, res);
});

// =========================================================
// 📡 API ROUTES REGISTRATION
// =========================================================
app.use("/api/auth", require("./routes/auth"));
app.use("/api", require("./routes/support"));
app.use("/api", require("./routes/exports"));
app.use("/api", require("./routes/ops"));
app.use("/api", require("./routes/inventory"));
app.use("/api", require("./routes/business"));
app.use("/api", require("./routes/invoices"));

// =========================================================
// 🛠 DEBUG ROUTES (Only in Development Mode)
// =========================================================
if (
  process.env.NODE_ENV !== "production" &&
  process.env.ENABLE_DEBUG_ROUTES === "true"
) {
  // Check environment variables
  app.get("/debug-env", (req, res) => {
    res.json({
      NODE_ENV: process.env.NODE_ENV || "not set",
      PORT: process.env.PORT || "not set",
      DATABASE_URL: process.env.DATABASE_URL ? "✅ exists" : "❌ missing",
      JWT_SECRET: process.env.JWT_SECRET ? "✅ exists" : "❌ missing",
      BASE_URL: process.env.BASE_URL ? "✅ exists" : "❌ missing",
      MAIL_RELAY_URL: process.env.MAIL_RELAY_URL ? "✅ exists" : "❌ missing",
      MAIL_RELAY_KEY: process.env.MAIL_RELAY_KEY ? "✅ exists" : "❌ missing",
    });
  });

  // Test database connectivity
  app.get("/debug-db", async (req, res) => {
    try {
      const result = await pool.query("SELECT NOW()");
      res.json({ status: "✅ DB Connected", time: result.rows[0] });
    } catch (err) {
      res.status(500).json({ status: "❌ DB Error", message: err.message });
    }
  });
}

// =========================================================
// 🌍 FRONTEND STATIC FILE SERVING
// =========================================================
app.get("/", (req, res) => {
  sendHtmlTemplate(res, "login.html");
});

app.get("/login.html", (req, res) => {
  sendHtmlTemplate(res, "login.html");
});

app.get("/index.html", (req, res) => {
  sendHtmlTemplate(res, "index.html");
});

app.get("/invoice.html", (req, res) => {
  sendHtmlTemplate(res, "invoice.html");
});

app.get("/reset.html", (req, res) => {
  sendHtmlTemplate(res, "reset.html");
});

app.get(["/privacy-policy", "/privacy-policy.html"], (req, res) => {
  sendHtmlTemplate(res, "privacy-policy.html");
});

app.get(["/account-deletion", "/account-deletion.html"], (req, res) => {
  sendHtmlTemplate(res, "account-deletion.html");
});

app.get("/cache-repair", (req, res) => {
  sendCacheRepairResponse(res);
});

app.get(["/network-check", "/network-check.html"], (req, res) => {
  sendNetworkCheckPage(req, res);
});

app.get("/developer-login", (req, res) => {
  sendHtmlTemplate(res, "developer-login.html");
});

app.get("/developer-login.html", (req, res) => {
  sendHtmlTemplate(res, "developer-login.html");
});

app.get("/developer-support", (req, res) => {
  sendHtmlTemplate(res, "developer-support.html");
});

app.get("/developer-support.html", (req, res) => {
  sendHtmlTemplate(res, "developer-support.html");
});

app.use(
  express.static(publicDir, {
    etag: true,
    lastModified: true,
    maxAge: STATIC_ASSET_CACHE_MS,
    setHeaders: setStaticAssetCacheHeaders,
  }),
);

/**
 * Fallback Route
 * - If API → return JSON 404
 * - Else → return login page
 */
app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ error: "API route not found" });
  }
  sendHtmlTemplate(res, "login.html");
});

// =========================================================
// 🔥 GLOBAL ERROR HANDLER
// Catches unhandled errors from anywhere in app
// =========================================================
app.use((err, req, res, next) => {
  console.error("🔥 Global Error:", err);

  logEvent("error", "http_unhandled_error", {
    requestId: req.requestId || null,
    method: req.method,
    path: getRequestPath(req),
    error: err,
  });

  res.status(err.status || 500).json({
    error: "Internal Server Error",
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Something went wrong",
  });
});

// =========================================================
// 🚀 START SERVER
// =========================================================
server = app.listen(PORT, "0.0.0.0", () => {
  logEvent("info", "http_server_listening", {
    host: "0.0.0.0",
    port: Number(PORT),
    uptimeSeconds: roundTo((Date.now() - PROCESS_STARTED_AT) / 1000, 3),
    allowedOriginsCount: allowedOrigins.size,
  });
  console.log(`🚀 Server running on port ${PORT}`);
});

// =========================================================
// 🛑 GRACEFUL SHUTDOWN
// Handles container shutdown safely
// =========================================================
startBackgroundJobs({ pool });

server.on("error", (error) => {
  logEvent("error", "http_server_error", {
    host: "0.0.0.0",
    port: Number(PORT),
    error,
  });
});

server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;
server.requestTimeout = 120 * 1000;

pool.readyPromise
  .then(() => {
    logEvent("info", "application_ready", {
      port: Number(PORT),
      uptimeSeconds: roundTo((Date.now() - PROCESS_STARTED_AT) / 1000, 3),
    });
  })
  .catch((error) => {
    logEvent("error", "application_dependency_init_failed", {
      error,
      port: Number(PORT),
    });
  });

function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  stopBackgroundJobs();
  logEvent("warn", "shutdown_requested", {
    signal,
    uptimeSeconds: roundTo(process.uptime(), 3),
    memoryMb: getMemoryUsageMb(),
  });
  console.log(`${signal} received. Closing server...`);

  const forcedShutdownTimer = setTimeout(() => {
    logEvent("error", "shutdown_forced_timeout", {
      signal,
      timeoutMs: 10 * 1000,
    });
    console.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10 * 1000);
  forcedShutdownTimer.unref();

  server.close(async () => {
    clearTimeout(forcedShutdownTimer);
    logEvent("info", "http_server_closed", {
      signal,
    });
    console.log("HTTP server closed.");

    try {
      await pool.end();
      logEvent("info", "db_pool_closed", {
        signal,
      });
      console.log("PostgreSQL pool closed.");
      process.exit(0);
    } catch (error) {
      logEvent("error", "db_pool_close_failed", {
        signal,
        error,
      });
      console.error("Error closing PostgreSQL pool:", error);
      process.exit(1);
    }
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));

// =========================================================
// ⚠ GLOBAL PROCESS ERROR HANDLERS
// =========================================================
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (err) => {
  logEvent("error", "process_unhandled_rejection", {
    error: err,
  });
  console.error("Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
  logEvent("error", "process_uncaught_exception", {
    error: err,
  });
  console.error("Uncaught Exception:", err);
});
