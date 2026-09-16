const {
  exportQueue,
  parseFilenameFromDisposition,
} = require("../utils/export-queue");
const { verifySessionToken } = require("../utils/token-security");

const EXPORT_TIMEOUT_MS = readPositiveInt(
  process.env.EXPORT_QUEUE_TIMEOUT_MS,
  110 * 1000,
);

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getAuthToken(req) {
  if (req.cookies?.token) {
    return req.cookies.token;
  }

  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    return header.split(" ")[1];
  }

  return null;
}

function getTokenSubject(req) {
  const token = getAuthToken(req);
  if (!token) {
    return null;
  }

  try {
    const decoded = verifySessionToken(token);
    return {
      ownerId: decoded.ownerId || decoded.id,
      actorId: decoded.actorId || decoded.staffId || decoded.id,
    };
  } catch (_error) {
    return null;
  }
}

function shouldQueueExport(req) {
  if (req.method !== "GET" || req.get("x-export-queue-bypass") === "1") {
    return false;
  }

  const queueRequested =
    req.query?._async_export === "1" ||
    req.query?.async_export === "1" ||
    req.query?.queue_export === "1";

  if (!queueRequested) {
    return false;
  }

  const path = String(req.path || "").toLowerCase();
  return path.endsWith("/pdf") || path.endsWith("/excel");
}

function buildInternalExportUrl(req, port) {
  const url = new URL(
    req.originalUrl,
    `http://127.0.0.1:${Number(port) || 8080}`,
  );
  url.searchParams.delete("_async_export");
  url.searchParams.delete("async_export");
  url.searchParams.delete("queue_export");
  url.searchParams.delete("_");

  return `http://127.0.0.1:${Number(port) || 8080}${url.pathname}${url.search}`;
}

async function fetchExportBuffer(internalUrl, req) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);

  try {
    const headers = {
      accept: req.get("accept") || "*/*",
      "x-export-queue-bypass": "1",
    };
    if (req.headers.cookie) {
      headers.cookie = req.headers.cookie;
    }
    if (req.headers.authorization) {
      headers.authorization = req.headers.authorization;
    }

    const response = await fetch(internalUrl, {
      headers,
      signal: controller.signal,
    });
    const contentType =
      response.headers.get("content-type") || "application/octet-stream";
    const disposition = response.headers.get("content-disposition") || "";
    const buffer = Buffer.from(await response.arrayBuffer());

    if (!response.ok) {
      let message = "Export failed";
      if (contentType.includes("application/json")) {
        try {
          const payload = JSON.parse(buffer.toString("utf8"));
          message = payload.error || payload.message || message;
        } catch (_error) {
          message = response.statusText || message;
        }
      } else {
        message = response.statusText || message;
      }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    return {
      buffer,
      contentType,
      filename: parseFilenameFromDisposition(disposition, "export"),
    };
  } finally {
    clearTimeout(timer);
  }
}

function createQueuedExportMiddleware(options = {}) {
  const port = options.port || process.env.PORT || 8080;

  return (req, res, next) => {
    if (!shouldQueueExport(req)) {
      return next();
    }

    const subject = getTokenSubject(req);
    if (!subject?.ownerId) {
      return next();
    }

    try {
      const internalUrl = buildInternalExportUrl(req, port);
      const job = exportQueue.enqueue({
        ownerId: subject.ownerId,
        actorId: subject.actorId,
        requestPath: req.originalUrl,
        run: () => fetchExportBuffer(internalUrl, req),
      });

      return res.status(202).json({
        success: true,
        export_job: {
          ...job,
          status_url: `/exports/${job.id}`,
          download_url: `/exports/${job.id}/download`,
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        success: false,
        error: error.message || "Could not queue export.",
      });
    }
  };
}

module.exports = {
  createQueuedExportMiddleware,
};
