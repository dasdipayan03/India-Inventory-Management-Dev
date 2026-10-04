const {
  exportQueue,
  parseFilenameFromDisposition,
} = require("../utils/export-queue");
// Export job queue এবং HTTP response header থেকে filename বের করার helper import করা হয়েছে।
const { verifySessionToken } = require("../utils/token-security");
// Export request যে logged-in user-এর, তার token যাচাই করার helper।

const EXPORT_TIMEOUT_MS = readPositiveInt(
  process.env.EXPORT_QUEUE_TIMEOUT_MS,
  110 * 1000,
);
// Export তৈরি হতে সর্বোচ্চ 110 সেকেন্ড অপেক্ষা করা হবে; এরপর request বাতিল হবে।

function readPositiveInt(value, fallback) {
  // Environment variable থেকে valid positive number নেয়, ভুল হলে fallback দেয়।
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getAuthToken(req) {
  // Request-এর cookie অথবা Authorization header থেকে login token বের করে।
  if (req.cookies?.token) {
    // Browser-based login হলে সাধারণত token cookie-তে থাকে।
    return req.cookies.token;
  }

  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    // API client cookie না পাঠালে Bearer token ব্যবহার করতে পারে।
    return header.split(" ")[1];
  }

  return null;
}

function getTokenSubject(req) {
  // Valid token থেকে export job কার business-এর এবং কে শুরু করেছে তা বের করে।
  const token = getAuthToken(req);
  if (!token) {
    return null;
  }

  try {
    const decoded = verifySessionToken(token);
    // Token-এর signature ও expiry যাচাই করে তার payload নেয়।
    return {
      ownerId: decoded.ownerId || decoded.id,
      // Data ownership সবসময় দোকানের owner-এর; staff হলেও owner ID ব্যবহৃত হয়।
      actorId: decoded.actorId || decoded.staffId || decoded.id,
      // কাজটি owner না staff—সেটি audit করার জন্য actor ID রাখা হয়।
    };
  } catch (_error) {
    // Token invalid বা expired হলে queue job তৈরি করা যাবে না।
    return null;
  }
}

function shouldQueueExport(req) {
  // এই request সত্যিই asynchronous export queue-তে পাঠানোর উপযুক্ত কি না ঠিক করে।
  if (req.method !== "GET" || req.get("x-export-queue-bypass") === "1") {
    // শুধু GET export queue হয়; internal request-এ bypass header recursion আটকায়।
    return false;
  }

  const queueRequested =
    req.query?._async_export === "1" ||
    req.query?.async_export === "1" ||
    req.query?.queue_export === "1";
  // এই তিনটির যেকোনো query flag থাকলে client asynchronous export চেয়েছে।

  if (!queueRequested) {
    return false;
  }

  const path = String(req.path || "").toLowerCase();
  // শুধু PDF ও Excel export endpoint queue-তে পাঠানো হয়।
  return path.endsWith("/pdf") || path.endsWith("/excel");
}

function buildInternalExportUrl(req, port) {
  // একই server-এ আসল export endpoint call করার জন্য local/internal URL বানায়।
  const url = new URL(
    req.originalUrl,
    `http://127.0.0.1:${Number(port) || 8080}`,
  );
  url.searchParams.delete("_async_export");
  url.searchParams.delete("async_export");
  url.searchParams.delete("queue_export");
  url.searchParams.delete("_");
  // Queue-related এবং cache-busting query parameter মুছে দেয়, যাতে internal call আবার queue না হয়।

  return `http://127.0.0.1:${Number(port) || 8080}${url.pathname}${url.search}`;
}

async function fetchExportBuffer(internalUrl, req) {
  // Internal export response-কে file buffer হিসেবে নিয়ে আসে, যা job শেষে download করা যাবে।
  const controller = new AbortController();
  // Timeout হলে চলমান fetch বন্ধ করার controller।
  const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
  // নির্ধারিত সময় পেরুলে export generation আটকে দেওয়া হয়।

  try {
    const headers = {
      accept: req.get("accept") || "*/*",
      "x-export-queue-bypass": "1",
    };
    // আসল request-এর প্রয়োজনীয় header এবং queue bypass header internal request-এ পাঠানো হয়।
    if (req.headers.cookie) {
      // Original login cookie forward করে, যেন internal export request authenticated থাকে।
      headers.cookie = req.headers.cookie;
    }
    if (req.headers.authorization) {
      // Cookie-এর বিকল্প Bearer token-ও forward করে।
      headers.authorization = req.headers.authorization;
    }

    const response = await fetch(internalUrl, {
      headers,
      signal: controller.signal,
    });
    // Internal export route-এ server-to-server HTTP request পাঠানো হয়।
    const contentType =
      response.headers.get("content-type") || "application/octet-stream";
    const disposition = response.headers.get("content-disposition") || "";
    const buffer = Buffer.from(await response.arrayBuffer());
    // PDF/Excel binary response memory buffer-এ রূপান্তর করা হয়।

    if (!response.ok) {
      // Export endpoint 2xx status না দিলে job-কে failed হিসেবে চিহ্নিত করার error বানায়।
      let message = "Export failed";
      if (contentType.includes("application/json")) {
        // JSON error হলে API-এর নির্দিষ্ট error/message client-কে দেখানোর জন্য পড়ে।
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
    // Successful export-এর file bytes, type এবং download filename ফেরত দেয়।
  } finally {
    // সফল, ব্যর্থ বা timeout—সব অবস্থায় timer পরিষ্কার করে memory leak ঠেকায়।
    clearTimeout(timer);
  }
}

function createQueuedExportMiddleware(options = {}) {
  // Configurable port-সহ reusable export queue middleware তৈরি করে।
  const port = options.port || process.env.PORT || 8080;

  return (req, res, next) => {
    // প্রতিটি export request-এ Express এই function চালাবে।
    if (!shouldQueueExport(req)) {
      // Queue-এর উপযুক্ত নয় এমন request আগের মতো সরাসরি route handler-এ যায়।
      return next();
    }

    const subject = getTokenSubject(req);
    if (!subject?.ownerId) {
      // Verified user/owner না থাকলে auth middleware বা route handler পরের সিদ্ধান্ত নেবে।
      return next();
    }

    try {
      const internalUrl = buildInternalExportUrl(req, port);
      const job = exportQueue.enqueue({
        // Queue-তে export job যোগ করে; run function পরে worker execute করবে।
        ownerId: subject.ownerId,
        actorId: subject.actorId,
        requestPath: req.originalUrl,
        run: () => fetchExportBuffer(internalUrl, req),
        // Job চললে authenticated internal request দিয়ে আসল PDF/Excel তৈরি হবে।
      });

      return res.status(202).json({
        // 202 Accepted মানে কাজটি গ্রহণ করা হয়েছে, কিন্তু file এখনও তৈরি হচ্ছে।
        success: true,
        export_job: {
          ...job,
          status_url: `/exports/${job.id}`,
          // Client এই URL-এ job ready/failed/pending status দেখতে পারবে।
          download_url: `/exports/${job.id}/download`,
          // Job ready হলে এই URL দিয়ে তৈরি file download করা যাবে।
        },
      });
    } catch (error) {
      // Job queue করতে ব্যর্থ হলে উপযুক্ত HTTP error response পাঠায়।
      return res.status(error.status || 500).json({
        success: false,
        error: error.message || "Could not queue export.",
      });
    }
  };
}

module.exports = {
  // Server/routes-এ ব্যবহারের জন্য middleware factory export করা হলো।
  createQueuedExportMiddleware,
};
