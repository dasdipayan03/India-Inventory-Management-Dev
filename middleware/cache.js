const { getUserId } = require("./auth");
// Auth middleware থেকে owner/business ID নেওয়ার helper import করা হয়েছে।
const { makeUserCacheKey, responseCache } = require("../utils/cache");
// আলাদা user-এর data আলাদা cache-এ রাখতে key বানানো ও cache store ব্যবহারের helper।

const DEFAULT_TTL_MS = 10 * 1000;
// Cache-এ রাখা response-এর default lifetime 10 সেকেন্ড।

function readPositiveInt(value, fallback) {
  // Options থেকে আসা value valid positive integer না হলে fallback value দেয়।
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cacheJsonResponse(options = {}) {
  // Route-এ ব্যবহারযোগ্য JSON response caching middleware তৈরি করে।
  const namespace = String(options.namespace || "api").trim() || "api";
  // একই URL অন্য route group-এ থাকলেও namespace দিয়ে cache আলাদা রাখা যায়।
  const ttlMs = readPositiveInt(options.ttlMs, DEFAULT_TTL_MS);
  // Caller TTL না দিলে অথবা ভুল TTL দিলে 10 সেকেন্ড ব্যবহার হবে।

  return (req, res, next) => {
    // Express-এর request-response cycle-এ চলা আসল middleware function।
    if (req.method !== "GET" || req.query?._no_cache === "1") {
      // শুধু GET request cache হবে; _no_cache=1 দিলে developer/user fresh response চাইছে।
      return next();
    }

    let userId = 0;
    // Cache key তৈরির আগে request-এর business owner ID রাখার variable।
    try {
      userId = getUserId(req);
      // Staff login হলেও তার owner ID পাওয়া যায়; তাই staff ও owner একই business data দেখে।
    } catch (_error) {
      // Authentication context না থাকলে cache ব্যবহার না করে route-কে স্বাভাবিকভাবে চলতে দেয়।
      return next();
    }

    const cacheKey = makeUserCacheKey(userId, namespace, req.originalUrl);
    // Owner ID, namespace, এবং সম্পূর্ণ URL/query মিলিয়ে unique cache key তৈরি হয়।
    const cached = responseCache.get(cacheKey);
    // এই exact request-এর আগের valid response আছে কি না খোঁজে।
    if (cached) {
      // Cache hit হলে database/route handler না চালিয়েই পুরোনো response ফিরিয়ে দেয়।
      res.set("X-Cache", "HIT");
      // Browser DevTools বা debugging-এ বোঝা যায় response cache থেকে এসেছে।
      Object.entries(cached.headers || {}).forEach(([name, value]) => {
        // Pagination-সংক্রান্ত আগের response header-ও আবার পাঠায়।
        if (value !== undefined && value !== null) {
          res.set(name, value);
        }
      });
      res.type("json");
      // Cached body JSON text হওয়ায় response content type JSON সেট করা হয়।
      return res.send(cached.body);
    }

    const originalJson = res.json.bind(res);
    // Express-এর আসল res.json function bind করে রাখে, পরে সেটিই চালানো হবে।
    res.set("X-Cache", "MISS");
    // Cache-এ response না থাকায় handler/database query চালানো হবে—তা বোঝায়।
    res.json = (body) => {
      // Route handler যখন res.json() ডাকবে, তার আগে response cache-এ রাখার সুযোগ নেয়।
      if (
        res.statusCode === 200 &&
        !res.headersSent &&
        typeof body !== "undefined"
      ) {
        // শুধু সফল 200 response, পাঠানো হয়নি এমন header, এবং defined body cache করা নিরাপদ।
        const headers = {};
        // Pagination metadata রাখার জন্য একটি ছোট header object।
        ["X-Total-Count", "X-Limit", "X-Offset", "X-Has-More"].forEach(
          (name) => {
            // Response-এ pagination header থাকলে cache করার জন্য তুলে নেয়।
            const value = res.getHeader(name);
            if (value !== undefined) {
              headers[name] = String(value);
            }
          },
        );

        responseCache.set(
          // JSON body ও pagination header নির্দিষ্ট TTL পর্যন্ত cache store-এ রাখে।
          cacheKey,
          { body: JSON.stringify(body), headers },
          ttlMs,
        );
      }

      return originalJson(body);
      // Cache-এ রাখার পরও Express-এর আসল JSON response client-এ পাঠায়।
    };

    return next();
    // Cache miss হলে পরের middleware বা route handler চালায়।
  };
}

module.exports = {
  // অন্য route file-এ ব্যবহারের জন্য এই middleware factory export করা হচ্ছে।
  cacheJsonResponse,
};
