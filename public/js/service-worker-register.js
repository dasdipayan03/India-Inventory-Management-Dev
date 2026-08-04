(function repairInventoryBrowserCache() {
  const CACHE_PREFIXES = [
    "shop-inventory-runtime-",
    "inventory-runtime-",
  ];
  const DEFAULT_REPAIR_VERSION = "2026-08-04-auto-cache-repair-1";
  const VERSION_STORAGE_KEY = "inventoryCacheRepairVersion";
  const RELOAD_STORAGE_KEY = "inventoryCacheRepairReloadAt";
  const RELOAD_GUARD_MS = 60 * 1000;

  function getRepairVersion() {
    const script = document.currentScript;
    return (
      script?.getAttribute("data-cache-repair-version") ||
      DEFAULT_REPAIR_VERSION
    );
  }

  function isInventoryRuntimeCache(cacheName) {
    return CACHE_PREFIXES.some((prefix) => cacheName.startsWith(prefix));
  }

  function readLocalStorage(key) {
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
    try {
      window.localStorage?.setItem(key, value);
    } catch (_error) {
      // Storage can be blocked in private modes; cache repair should still run.
    }
  }

  function removeLocalStorage(key) {
    try {
      window.localStorage?.removeItem(key);
    } catch (_error) {
      // Ignore storage cleanup failures.
    }
  }

  function getVersionRepairReason(repairVersion) {
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
})();
