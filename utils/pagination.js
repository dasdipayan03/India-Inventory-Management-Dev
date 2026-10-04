/**
 * =========================================================
 * FILE: utils/pagination.js
 * PURPOSE: QUERY PAGINATION PARSING, RESPONSE META ও HTTP HEADERS
 * =========================================================
 * এই module request query থেকে bounded `limit`, `page` ও `offset` হিসাব করে database list endpoints-এ consistent pagination দেয়।
 * Pagination optional হলে কোনো related query parameter না আসা পর্যন্ত feature disabled রাখা যায়।
 * Result rows পাঠানোর সময় একই pagination object থেকে JSON metadata অথবা `X-*` response headers তৈরি করা যায়।
 */

/*
 * =========================================================
 * BLOCK 01: QUERY থেকে PAGINATION OPTIONS PARSE
 * =========================================================
 * Query object, default page size, সর্বোচ্চ page size ও optional-mode configuration নেয়।
 * Return object সবসময় `enabled`, `limit`, `offset`, `page` shape রাখে, ফলে caller একই fields predictably ব্যবহার করতে পারে।
 */
function parsePagination(
  query,
  defaultLimit = 100,
  maxLimit = 500,
  options = {},
) {
  /* PARSE PHASE A: optional mode এবং client pagination-related কোনো key পাঠিয়েছে কি না detect করা। */
  const optional = Boolean(options.optional);
  const requested =
    Object.prototype.hasOwnProperty.call(query, "limit") ||
    Object.prototype.hasOwnProperty.call(query, "page") ||
    Object.prototype.hasOwnProperty.call(query, "offset");

  // Optional endpoint-এ limit/page/offset একটিও না থাকলে database query-তে pagination না বসানোর signal ফেরে।
  if (optional && !requested) {
    return { enabled: false, limit: null, offset: 0, page: 1 };
  }

  /*
   * PARSE PHASE B: `limit` base-10 integer হিসেবে parse করা। Invalid হলে default, ১-এর কম হলে ১ এবং maxLimit-এর বেশি হলে maxLimit হয়।
   * এই clamp empty/negative page size ও unbounded large response আটকায়।
   */
  const rawLimit = Number.parseInt(query.limit, 10);
  const limit = Math.min(
    Math.max(Number.isInteger(rawLimit) ? rawLimit : defaultLimit, 1),
    maxLimit,
  );
  /* PARSE PHASE C: positive integer page গ্রহণ; missing/invalid/zero/negative value প্রথম page-এ fallback। */
  const rawPage = Number.parseInt(query.page, 10);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  /*
   * PARSE PHASE D: explicit non-negative offset থাকলে সেটি priority পায়; না থাকলে `(page - 1) × limit` হিসাব হয়।
   * তাই caller page-based অথবা direct offset-based—দুই ধরনের request support করতে পারে।
   */
  const rawOffset = Number.parseInt(query.offset, 10);
  const offset =
    Number.isInteger(rawOffset) && rawOffset >= 0
      ? rawOffset
      : (page - 1) * limit;

  /* PARSE PHASE E: normalized values caller-এর SQL LIMIT/OFFSET ও response metadata-এর জন্য এক object-এ ফেরানো। */
  return { enabled: true, limit, offset, page };
}

/*
 * =========================================================
 * BLOCK 02: JSON PAGINATION METADATA তৈরি
 * =========================================================
 * Parsed pagination, database-এর total matching rows এবং current response row count নিয়ে client-facing metadata বানায়।
 * Optional pagination disabled হলে null দেয়। Total numeric না হলে zero হয়; `has_more` current offset-এর পর আরও row আছে কি না জানায়।
 */
function buildPaginationMeta(pagination, total, rowCount) {
  if (!pagination.enabled) {
    return null;
  }

  // Database driver count string হিসেবে দিলেও Number conversion response-এ numeric total নিশ্চিত করে।
  const normalizedTotal = Number(total) || 0;
  return {
    total: normalizedTotal,
    limit: pagination.limit,
    offset: pagination.offset,
    page: pagination.page,
    // এই page-এর শেষ position total-এর আগে থাকলেই client পরের page request করতে পারে।
    has_more: pagination.offset + rowCount < normalizedTotal,
  };
}

/*
 * =========================================================
 * BLOCK 03: PAGINATION HTTP RESPONSE HEADERS
 * =========================================================
 * JSON body shape না বদলে total/limit/offset/has-more তথ্য response headers-এ প্রকাশ করে।
 * Pagination disabled হলে কোনো header লেখা হয় না; Express/Node response API-তে সব header value string হিসেবে পাঠানো হয়।
 */
function setPaginationHeaders(res, pagination, total, rowCount) {
  if (!pagination.enabled) {
    return;
  }

  // Metadata builder-এর মতো একই total normalization ও has-more formula ব্যবহার করে body/header semantics consistent রাখা হয়।
  const normalizedTotal = Number(total) || 0;

  // Matching rows-এর মোট সংখ্যা—বর্তমান page-এর row count নয়।
  res.setHeader("X-Total-Count", String(normalizedTotal));

  // Server প্রয়োগ করা effective limit ও offset client-কে জানায়।
  res.setHeader("X-Limit", String(pagination.limit));
  res.setHeader("X-Offset", String(pagination.offset));

  // Header string `true`/`false`; current page position total-এর আগে শেষ হলে true।
  res.setHeader(
    "X-Has-More",
    pagination.offset + rowCount < normalizedTotal ? "true" : "false",
  );
}

/*
 * =========================================================
 * BLOCK 04: PUBLIC PAGINATION API EXPORT
 * =========================================================
 * Routes query parsing-এর জন্য `parsePagination`, JSON payload-এর জন্য `buildPaginationMeta` এবং header-based response-এর জন্য
 * `setPaginationHeaders` import করতে পারে। Internal calculation duplication এড়িয়ে সব list endpoint একই pagination contract অনুসরণ করে।
 */
module.exports = {
  buildPaginationMeta,
  parsePagination,
  setPaginationHeaders,
};
