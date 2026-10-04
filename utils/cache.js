/**
 * =========================================================
 * FILE: utils/cache.js
 * PURPOSE: PROCESS-LOCAL TTL RESPONSE CACHE ও USER-SCOPED INVALIDATION
 * =========================================================
 * এই module JavaScript `Map`-এর উপর bounded in-memory cache তৈরি করে, যেখানে প্রতিটি entry নির্দিষ্ট সময় পরে expire হয়।
 * Cache full হলে সবচেয়ে পুরোনো/কম-সম্প্রতি ব্যবহৃত key সরানো হয়; successful read entry-টিকে Map-এর শেষে নিয়ে recent হিসেবে চিহ্নিত করে।
 * User id, namespace ও request URL দিয়ে stable response key বানানো এবং data write-এর পরে user-specific cache মুছতে helper দেয়।
 */

// ==================== BLOCK 01: DEFAULT CAPACITY ও POSITIVE-INTEGER CONFIG PARSER ====================
// Default সর্বোচ্চ ৬০০টি entry process memory-তে রাখা হয়। Parser option/environment value-কে base-10 positive integer হিসেবে নেয়;
// invalid, zero বা negative value পেলে caller-provided fallback ব্যবহার করে, ফলে cache configuration bounded থাকে।
const DEFAULT_MAX_ENTRIES = 600;

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/*
 * =========================================================
 * BLOCK 02: TTL CACHE CLASS ও INSTANCE INITIALIZATION
 * =========================================================
 * Constructor-এর explicit `maxEntries` সর্বোচ্চ priority পায়; না থাকলে environment এবং শেষে default capacity ব্যবহৃত হয়।
 * `Map` insertion order ধরে রাখে, তাই extra linked-list ছাড়াই oldest entry eviction এবং recent-read promotion করা যায়।
 * Store process-local—server restart বা অন্য Node instance-এর সঙ্গে data share/persist করে না।
 */
class TtlCache {
  constructor(options = {}) {
    this.maxEntries = readPositiveInt(
      options.maxEntries,
      readPositiveInt(
        process.env.RESPONSE_CACHE_MAX_ENTRIES,
        DEFAULT_MAX_ENTRIES,
      ),
    );
    this.store = new Map();
  }

  /*
   * =========================================================
   * BLOCK 03: GET — VALID VALUE READ ও RECENCY PROMOTION
   * =========================================================
   * Key না থাকলে null দেয়। Entry থাকলেও expiry বর্তমান সময় পার হলে সঙ্গে সঙ্গে delete করে cache miss দেয়।
   * Valid hit-এ key delete করে একই entry আবার insert করা হয়; এতে Map order-এর শেষে গিয়ে entry most-recently-used হয়।
   */
  get(key) {
    // Map lookup O(1)-এর কাছাকাছি সময়ে stored wrapper `{ value, expiresAt }` আনে।
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    // Lazy expiry: কোনো expired key পড়ার সময় periodic cleanup-এর অপেক্ষা না করে তখনই সরানো হয়।
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }

    // Delete + set insertion order refresh করে, কিন্তু cached value বা original absolute expiry বাড়ায় না।
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /*
   * =========================================================
   * BLOCK 04: SET — TTL VALIDATION, CAPACITY EVICTION ও VALUE STORE
   * =========================================================
   * TTL positive না হলে value cache না করেই original value ফেরায়, যাতে caller একই return flow ব্যবহার করতে পারে।
   * Capacity পূর্ণ থাকলে Map-এর প্রথম অর্থাৎ oldest key একে একে সরিয়ে নতুন entry-এর জায়গা করে।
   * Stored entry-তে value-এর সঙ্গে absolute `expiresAt` থাকে; method সব অবস্থায় supplied value ফেরায়।
   */
  set(key, value, ttlMs) {
    /* SET PHASE A: TTL normalize; zero fallback মানে caching disabled। */
    const normalizedTtl = readPositiveInt(ttlMs, 0);
    if (!normalizedTtl) {
      return value;
    }

    /* SET PHASE B: configured capacity-এর নিচে না আসা পর্যন্ত least-recent insertion-order entry evict করা। */
    while (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.store.delete(oldestKey);
    }

    /* SET PHASE C: value ও current time + TTL absolute expiry দিয়ে নতুন wrapper save করা। */
    this.store.set(key, {
      value,
      expiresAt: Date.now() + normalizedTtl,
    });

    return value;
  }

  // ==================== BLOCK 05: EXACT KEY DELETE ====================
  // একটি নির্দিষ্ট key remove করে এবং native Map.delete-এর boolean result ফেরায়—key ছিল ও সরলে true, না থাকলে false।
  delete(key) {
    return this.store.delete(key);
  }

  /*
   * =========================================================
   * BLOCK 06: PREDICATE-BASED BULK DELETE
   * =========================================================
   * সব key iterate করে caller-এর predicate true হওয়া entry সরায় এবং মোট deleted count ফেরায়।
   * User/namespace prefix invalidation এই generic method ব্যবহার করে; predicate value নয়, cache key পায়।
   */
  deleteWhere(predicate) {
    let deleted = 0;
    for (const key of this.store.keys()) {
      if (predicate(key)) {
        this.store.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  /*
   * =========================================================
   * BLOCK 07: EXPIRED ENTRY PRUNING
   * =========================================================
   * Store-এর সব entry scan করে supplied/current timestamp-এর সমান বা পুরোনো expiry মুছে দেয়।
   * Optional `now` deterministic test বা এক scan-এ consistent cutoff দেয়; removed count maintenance metrics-এ ব্যবহার হয়।
   */
  pruneExpired(now = Date.now()) {
    let deleted = 0;
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  // ==================== BLOCK 08: FULL CACHE CLEAR ====================
  // সব key/value একবারে সরায়; configuration ও cache instance অক্ষুণ্ণ থাকে এবং method কোনো count ফেরায় না।
  clear() {
    this.store.clear();
  }

  /*
   * =========================================================
   * BLOCK 09: LIVE CACHE STATISTICS ও EFFECTIVE SIZE
   * =========================================================
   * `stats` ও `size` দুটোই আগে expired entry prune করে, তাই reported count stale TTL row অন্তর্ভুক্ত করে না।
   * Stats operations dashboard-এর জন্য current entries ও configured maximum দেয়; size শুধু numeric active count ফেরায়।
   */
  stats() {
    this.pruneExpired();
    return {
      entries: this.store.size,
      max_entries: this.maxEntries,
    };
  }

  size() {
    this.pruneExpired();
    return this.store.size;
  }
}

// ==================== BLOCK 10: SHARED RESPONSE-CACHE SINGLETON ====================
// Application middleware ও background cleanup একই instance import করে; ফলে route response write/read/invalidation একটি common store-এ কাজ করে।
const responseCache = new TtlCache();

// ==================== BLOCK 11: USER-SCOPED CACHE KEY BUILDERS ====================
// User id numeric canonical form-এ `user:<id>:` prefix পায়। তার সঙ্গে namespace ও exact request URL যুক্ত হওয়ায় একই endpoint/query-এর
// cache tenant অনুযায়ী আলাদা থাকে এবং namespace prefix দিয়ে related entries group করা যায়।
function getUserCachePrefix(userId) {
  return `user:${Number(userId) || 0}:`;
}

function makeUserCacheKey(userId, namespace, requestUrl) {
  return `${getUserCachePrefix(userId)}${namespace}:${requestUrl}`;
}

/*
 * =========================================================
 * BLOCK 12: USER অথবা USER+NAMESPACE CACHE INVALIDATION
 * =========================================================
 * Valid numeric user id থাকলে matching prefix দিয়ে shared cache-এর সব related key delete করে count ফেরায়।
 * Namespace blank হলে user-এর সম্পূর্ণ response cache, আর namespace দিলে সেই group-এর entry-গুলো মুছে যায়।
 * Invalid user id-এ `user:0` data accidently delete না করে সরাসরি zero result দেয়।
 */
function invalidateUserCache(userId, namespace = "") {
  const prefix = `${getUserCachePrefix(userId)}${namespace}`;
  if (!Number(userId)) {
    return 0;
  }

  return responseCache.deleteWhere((key) => key.startsWith(prefix));
}

/*
 * =========================================================
 * BLOCK 13: PUBLIC CACHE API EXPORT
 * =========================================================
 * Custom/test instance-এর জন্য class, application-এর shared singleton এবং route-level key/invalidation helpers export করা হয়।
 * Low-level prefix helper private থাকে, কারণ caller-দের complete key builder ব্যবহার করাই consistent।
 */
module.exports = {
  TtlCache,
  invalidateUserCache,
  makeUserCacheKey,
  responseCache,
};
