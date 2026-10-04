(function repairInventoryBrowserCache() {
  // পড়ার নিয়ম: প্রতিটি বাংলা comment তার ঠিক উপরের সম্পূর্ণ code line বা code block-এর কাজ বোঝায়।
  const CACHE_PREFIXES = [
    "shop-inventory-runtime-",
    "inventory-runtime-",
  ];
  // শুধু এই app-এর runtime cache চেনার prefix list।
  const DEFAULT_REPAIR_VERSION = "2026-08-04-auto-cache-repair-1";
  const VERSION_STORAGE_KEY = "inventoryCacheRepairVersion";
  const RELOAD_STORAGE_KEY = "inventoryCacheRepairReloadAt";
  const RELOAD_GUARD_MS = 60 * 1000;
  // Cache repair-এর কারণে এক মিনিটের মধ্যে বারবার page reload হওয়া ঠেকায়।

  function getRepairVersion() {
    // HTML script tag-এর version অথবা fallback version নিয়ে cache repair trigger নির্ধারণ করে।
    const script = document.currentScript;
    return (
      script?.getAttribute("data-cache-repair-version") ||
      DEFAULT_REPAIR_VERSION
    );
  }

  function isInventoryRuntimeCache(cacheName) {
    // দেওয়া cache name-টি এই inventory app-এর runtime cache কি না দেখে।
    return CACHE_PREFIXES.some((prefix) => cacheName.startsWith(prefix));
  }

  function readLocalStorage(key) {
    // Storage blocked/private mode হলেও error না ছড়িয়ে নিরাপদে stored value পড়ে।
    try {
      if (!window.localStorage) {
        return null;
      }
      return window.localStorage.getItem(key) || "";
    } catch (_error) {
      return null;
    }
  }

  function writeLocalStorage(key, value) {
    // Cache repair tracking value browser localStorage-এ রাখে।
    try {
      window.localStorage?.setItem(key, value);
    } catch (_error) {
      // Storage can be blocked in private modes; cache repair should still run.
    }
  }

  function removeLocalStorage(key) {
    // আর প্রয়োজন নেই এমন repair/reload tracking value পরিষ্কার করে।
    try {
      window.localStorage?.removeItem(key);
    } catch (_error) {
      // Ignore storage cleanup failures.
    }
  }

  function getVersionRepairReason(repairVersion) {
    // প্রথম run নাকি repair version বদলেছে—তার কারণ নির্ধারণ করে।
    const previousVersion = readLocalStorage(VERSION_STORAGE_KEY);
    if (previousVersion === null) {
      return "";
    }

    if (!previousVersion) {
      writeLocalStorage(VERSION_STORAGE_KEY, repairVersion);
      return "initial";
    }

    if (previousVersion === repairVersion) {
      return "";
    }

    return "version";
  }

  async function clearRuntimeCaches() {
    // পুরোনো inventory runtime cacheগুলো Cache Storage থেকে মুছে দেয়।
    if (!("caches" in window)) {
      return false;
    }

    const cacheNames = await caches.keys();
    const inventoryCacheNames = cacheNames.filter((cacheName) =>
      isInventoryRuntimeCache(cacheName),
    );

    if (inventoryCacheNames.length === 0) {
      return false;
    }

    const results = await Promise.all(
      inventoryCacheNames.map((cacheName) => caches.delete(cacheName)),
    );

    return results.some(Boolean);
  }

  async function unregisterInventoryWorkers() {
    // একই domain-এর পুরোনো service worker unregister করে stale asset দেওয়া বন্ধ করে।
    if (!("serviceWorker" in navigator)) {
      return false;
    }

    const hadController = Boolean(navigator.serviceWorker.controller);
    const registrations = await navigator.serviceWorker.getRegistrations();
    const sameOriginRegistrations = registrations.filter((registration) => {
      try {
        return new URL(registration.scope).origin === window.location.origin;
      } catch (_error) {
        return false;
      }
    });

    if (sameOriginRegistrations.length === 0) {
      return hadController;
    }

    const results = await Promise.all(
      sameOriginRegistrations.map((registration) => registration.unregister()),
    );

    return hadController || results.some(Boolean);
  }

  async function requestHttpCacheRepair(repairVersion, reason) {
    // Server-কে cache repair হওয়া জানায়, যাতে server-side repair endpoint কাজ করতে পারে।
    try {
      const url = `/cache-repair?v=${encodeURIComponent(
        repairVersion,
      )}&reason=${encodeURIComponent(reason || "runtime")}`;
      await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch (_error) {
      // The Cache Storage and Service Worker cleanup above still help offline/blocked cases.
    }
  }

  function canReloadAfterRepair() {
    // শেষ reload-এর সময় দেখে এখন reload করা নিরাপদ কি না বলে।
    const lastReloadValue = readLocalStorage(RELOAD_STORAGE_KEY);
    if (lastReloadValue === null) {
      return false;
    }

    const lastReloadAt = Number(lastReloadValue || 0);
    const now = Date.now();

    if (Number.isFinite(lastReloadAt) && now - lastReloadAt < RELOAD_GUARD_MS) {
      return false;
    }

    writeLocalStorage(RELOAD_STORAGE_KEY, String(now));
    return true;
  }

  async function runAutomaticCacheRepair() {
    // Version/runtime change পেলে worker, cache ও server cleanup চালিয়ে একটি controlled reload দেয়।
    const repairVersion = getRepairVersion();
    const versionReason = getVersionRepairReason(repairVersion);
    const results = await Promise.allSettled([
      unregisterInventoryWorkers(),
      clearRuntimeCaches(),
    ]);
    const repairedRuntime = results.some(
      (result) => result.status === "fulfilled" && result.value,
    );
    const repairReason = versionReason || (repairedRuntime ? "runtime" : "");

    if (!repairReason) {
      writeLocalStorage(VERSION_STORAGE_KEY, repairVersion);
      removeLocalStorage(RELOAD_STORAGE_KEY);
      return;
    }

    await requestHttpCacheRepair(repairVersion, repairReason);
    writeLocalStorage(VERSION_STORAGE_KEY, repairVersion);

    if (canReloadAfterRepair()) {
      window.location.reload();
    }
  }

  runAutomaticCacheRepair().catch(() => {});
  // Background cache repair fail করলেও page-এর স্বাভাবিক loading বন্ধ হতে দেয় না।
})();
