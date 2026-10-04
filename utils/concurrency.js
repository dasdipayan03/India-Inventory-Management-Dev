/**
 * =========================================================
 * FILE: utils/concurrency.js
 * PURPOSE: TEXT NORMALIZATION ও POSTGRESQL SCOPED ADVISORY LOCK
 * =========================================================
 * এই module logical resource name-কে stable normalized/hash key-তে রূপ দিয়ে concurrent database write serialize করতে সাহায্য করে।
 * Lock-এর প্রথম key owner id এবং দ্বিতীয় key namespace+resource hash; তাই ভিন্ন owner-এর একই item/serial একে অপরকে block করে না।
 * `pg_advisory_xact_lock` transaction-scoped—COMMIT বা ROLLBACK হলে PostgreSQL নিজেই lock release করে।
 */

/*
 * =========================================================
 * BLOCK 01: LOOKUP TEXT NORMALIZATION
 * =========================================================
 * Null/undefined-কে empty string করে, দুই পাশের whitespace trim এবং text lowercase করে।
 * Database lookup, resource comparison ও advisory-lock key-তে case/outer-space variation যেন আলাদা resource না হয়, তাই এটি ব্যবহৃত হয়।
 * ভিতরের repeated whitespace এই helper বদলায় না; display normalizer-এর কাজ আলাদা।
 */
function normalizeLookupText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

/*
 * =========================================================
 * BLOCK 02: DISPLAY TEXT NORMALIZATION
 * =========================================================
 * যেকোনো input string-এ রূপ দিয়ে consecutive whitespace একটিমাত্র space করে এবং দুই পাশ trim করে।
 * User-facing name/description readable canonical form-এ থাকে, কিন্তু letter case সংরক্ষিত হয়।
 */
function normalizeDisplayText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/*
 * =========================================================
 * BLOCK 03: TEXT থেকে SIGNED 32-BIT HASH
 * =========================================================
 * FNV-1a style seed দিয়ে প্রতিটি UTF-16 code unit XOR করে fixed multiplier-এ 32-bit integer multiplication চালায়।
 * PostgreSQL advisory lock-এর integer key হিসেবে দীর্ঘ namespace/resource text compact করতে এই deterministic hash ব্যবহৃত হয়।
 * `| 0` final unsigned bit pattern-কে JavaScript signed 32-bit integer হিসেবে ফেরায়।
 */
function hashTextToInt(value) {
  const input = String(value ?? "");

  // FNV offset-basis দিয়ে একই input-এর hash প্রতিবার একই initial state থেকে শুরু হয়।
  let hash = 0x811c9dc5;

  /* HASH PHASE A: প্রতিটি character code বর্তমান hash-এর সঙ্গে XOR করে input order/content mix করা। */
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);

    // Math.imul 32-bit overflow semantics ধরে FNV prime দিয়ে গুণ করে result bounded রাখে।
    hash = Math.imul(hash, 0x01000193);
  }

  // Bitwise conversion PostgreSQL `integer` parameter-এর উপযোগী signed 32-bit number দেয়।
  return hash | 0;
}

/*
 * =========================================================
 * BLOCK 04: OWNER-SCOPED TRANSACTION ADVISORY LOCK
 * =========================================================
 * Database client, positive owner id, logical namespace ও resource id নিয়ে দুই-part PostgreSQL advisory lock নেয়।
 * Owner id tenant boundary তৈরি করে; namespace ও normalized resource hash একই tenant-এর resource boundary তৈরি করে।
 * অন্য transaction lock ধরে থাকলে query তার COMMIT/ROLLBACK পর্যন্ত অপেক্ষা করে, ফলে stock/serial/debt-এর read-modify-write race আটকানো যায়।
 */
async function lockScopedResource(client, ownerId, namespace, resourceId) {
  /* LOCK PHASE A: owner id number-এ convert করে positive integer tenancy scope নিশ্চিত করা। */
  const scopedOwnerId = Number(ownerId);

  if (!Number.isInteger(scopedOwnerId) || scopedOwnerId <= 0) {
    throw new Error("Invalid owner scope for advisory lock");
  }

  /* LOCK PHASE B: fallback namespace, separator ও case-normalized resource id থেকে deterministic second integer key বানানো। */
  const lockKey = hashTextToInt(
    `${String(namespace || "resource")}::${normalizeLookupText(resourceId)}`,
  );

  /*
   * LOCK PHASE C: parameterized PostgreSQL transaction-level advisory lock acquire হওয়া পর্যন্ত await করা।
   * Caller-কে এর আগে BEGIN এবং পরে COMMIT/ROLLBACK করতে হয়; explicit unlock প্রয়োজন হয় না।
   */
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
    scopedOwnerId,
    lockKey,
  ]);
}

/*
 * =========================================================
 * BLOCK 05: PUBLIC CONCURRENCY API EXPORT
 * =========================================================
 * Route/repository code-এর জন্য lock helper এবং দুই text normalizer export করা হয়।
 * Hash function internal implementation detail হিসেবে private থাকে, যাতে caller সরাসরি unscoped advisory key ব্যবহার না করে।
 */
module.exports = {
  lockScopedResource,
  normalizeDisplayText,
  normalizeLookupText,
};
