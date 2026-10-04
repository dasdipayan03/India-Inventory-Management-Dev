/**
 * =========================================================
 * FILE OVERVIEW: SERVICE WORKER CACHE ROLLBACK
 * =========================================================
 * এই worker নতুন offline/runtime cache বানায় না। আগের service-worker versions যে inventory runtime
 * caches রেখে থাকতে পারে সেগুলো install ও activate—দুই lifecycle-এই মুছে দেয়। Activate শেষ হলে
 * open clients claim করে এবং registration unregister করে, যাতে ভবিষ্যৎ navigation/asset/API request
 * browser-এর normal network path ব্যবহার করে। Fetch handler ইচ্ছাকৃতভাবে request intercept করে না।
 */

// ==================== BLOCK 01: ROLLBACK IDENTITY ও TARGET CACHE PREFIXES ====================
// এই version string deployed cleanup worker-টির release/rollback পরিচয় রাখে। এটি cache name হিসেবে ব্যবহৃত হয় না;
// deployment/debugging-এর সময় কোন rollback revision চলছে তা source থেকে বোঝার জন্য রাখা হয়েছে।
const ROLLBACK_VERSION = "2026-07-14-disable-low-network-cache-1";

// আগের worker implementations runtime cache-এর জন্য যে দুই ধরনের prefix ব্যবহার করত সেগুলো list-এ রাখা হয়েছে।
// Cleanup কেবল এই prefixes দিয়ে শুরু হওয়া cache মুছবে; অন্য application/domain cache নাম match না করলে অক্ষত থাকবে।
const CACHE_PREFIXES = ["shop-inventory-runtime-", "inventory-runtime-"];

// ==================== BLOCK 02: INVENTORY CACHE-NAME MATCHER ====================
// একটি cache name নেয় এবং CACHE_PREFIXES-এর অন্তত একটির সঙ্গে শুরু হলে true return করে।
// startsWith exact prefix boundary ব্যবহার করায় delete filter inventory runtime caches-এর মধ্যেই সীমাবদ্ধ থাকে।
function isInventoryRuntimeCache(cacheName) {
  return CACHE_PREFIXES.some((prefix) => cacheName.startsWith(prefix));
}

// ==================== BLOCK 03: RUNTIME CACHE CLEANUP ====================
// Cache Storage থেকে এই origin-এর সব cache names নেয়, matcher দিয়ে inventory runtime entries বেছে নেয়,
// তারপর Promise.all দিয়ে matching caches parallel delete করে। Await থাকায় lifecycle cleanup শেষ না হওয়া পর্যন্ত অপেক্ষা করতে পারে।
async function clearInventoryRuntimeCaches() {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((cacheName) => isInventoryRuntimeCache(cacheName))
      .map((cacheName) => caches.delete(cacheName)),
  );
}

// ==================== BLOCK 04: INSTALL LIFECYCLE ====================
// নতুন rollback worker install হলে skipWaiting() তাকে পুরোনো waiting worker-এর পেছনে আটকে না রেখে দ্রুত activate হতে বলে।
// event.waitUntil cleanup promise-কে install lifetime-এর অংশ করে, তাই browser cache deletion complete/fail হওয়া track করে।
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(clearInventoryRuntimeCaches());
});

// ==================== BLOCK 05: ACTIVATE, CLIENT CLAIM ও SELF-UNREGISTER ====================
// Activation-এ আবার cleanup চালানো হয়, কারণ install-এর পরেও old worker/request কোনো runtime cache রেখে যেতে পারে।
// clients.claim() open tabs-কে অবিলম্বে এই cleanup worker-এর control-এ আনে। এরপর unregister() registration সরিয়ে দেয়,
// যাতে পরবর্তী page load-এ এই worker আর স্থায়ী network intermediary হিসেবে না থাকে।
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await clearInventoryRuntimeCaches();
      await self.clients.claim();
      await self.registration.unregister();
    })(),
  );
});

// ==================== BLOCK 06: FETCH PASSTHROUGH / NO CACHING ====================
// Fetch listener থাকলেও event.respondWith() call করা হয়নি। তাই navigation, static assets, API calls ও health checks-এর
// response service worker তৈরি/cache করে না; browser সরাসরি network-এর normal request/response behavior ব্যবহার করে।
// Empty handler rollback intent স্পষ্ট করে এবং ভুল করে cache-first/network-fallback strategy পুনরায় চালু হওয়া আটকায়।
self.addEventListener("fetch", () => {});
