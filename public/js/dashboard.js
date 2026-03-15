const appConfig = window.InventoryApp || {};
const apiBase =
  appConfig.apiBase ||
  (window.location.origin.includes("localhost")
    ? "http://localhost:4000/api"
    : "/api");

const state = {
  itemNames: [],
  currentItemReportRows: [],
  currentSalesRows: [],
  currentGstRows: [],
  lowStockRows: [],
  reorderRows: [],
  ledgerMode: "empty",
  currentLedgerNumber: "",
  sidebarScrollY: 0,
  charts: {
    businessTrend: null,
    last13Months: null,
  },
  popupTimer: null,
  sessionUser: null,
};

const STAFF_PERMISSION_OPTIONS = appConfig.staffPermissionOptions || [];
const DEFAULT_STAFF_PERMISSIONS = appConfig.defaultStaffPermissions || [
  "add_stock",
  "sale_invoice",
];
const STAFF_PERMISSION_KEYS =
  appConfig.staffPermissionKeys ||
  STAFF_PERMISSION_OPTIONS.map((option) => option.value);
const SECTION_PERMISSION_MAP = appConfig.sectionPermissionMap || {
  addStockSection: "add_stock",
  itemReportSection: "stock_report",
  salesReportSection: "sales_report",
  gstReportSection: "gst_report",
  customerDebtSection: "customer_due",
};
const INVOICE_PAGE_PERMISSION = appConfig.invoicePagePermission || "sale_invoice";

const formatters = {
  whole: new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
  }),
  decimal: new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }),
  money: new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }),
};

const dom = {};

function getToken() {
  return localStorage.getItem("token") || "";
}

function authHeaders(headers = {}) {
  const token = getToken();
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

function formatCount(value) {
  return formatters.whole.format(Number(value) || 0);
}

function formatNumber(value) {
  return formatters.decimal.format(Number(value) || 0);
}

function formatCurrency(value) {
  return `Rs. ${formatters.money.format(Number(value) || 0)}`;
}

function formatDate(value) {
  return new Date(value).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function formatPercent(value) {
  return `${formatters.money.format(Number(value) || 0)}%`;
}

function formatInputDate(value) {
  return value ? formatDate(new Date(`${value}T00:00:00`)) : "-";
}

function getMonthBucket(value) {
  const parts = new Intl.DateTimeFormat("en-IN", {
    year: "numeric",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
  }).formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value || "0000";
  const month = parts.find((part) => part.type === "month")?.value || "01";
  return `${year}-${month}`;
}

function formatMonthBucket(bucket) {
  const [year, month] = String(bucket || "0000-01")
    .split("-")
    .map((part) => Number(part) || 0);

  return new Intl.DateTimeFormat("en-IN", {
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(new Date(Date.UTC(year, Math.max(month - 1, 0), 1)));
}

function toInputDate(date) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 991px)").matches;
}

function sanitizeFileName(value) {
  return String(value || "download")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

const escapeHtml =
  appConfig.escapeHtml ||
  ((value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;"));

function parseFormattedNumber(value) {
  return Number(String(value || "").replace(/[^0-9.]/g, "")) || 0;
}

function isAdminSession() {
  return state.sessionUser?.role !== "staff";
}

function normalizeStaffPermissions(values) {
  if (typeof appConfig.normalizePermissions === "function") {
    return appConfig.normalizePermissions(values);
  }

  const list = Array.isArray(values) ? values : [];
  const normalized = list
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => STAFF_PERMISSION_KEYS.includes(value));

  return [...new Set(normalized)];
}

function getUserPermissions() {
  if (isAdminSession()) {
    return new Set(["all"]);
  }

  return new Set(normalizeStaffPermissions(state.sessionUser?.permissions));
}

function getPermissionOption(permission) {
  if (typeof appConfig.getPermissionOption === "function") {
    return appConfig.getPermissionOption(permission);
  }

  return STAFF_PERMISSION_OPTIONS.find((option) => option.value === permission) || null;
}

function formatPermissionSummary(permissions, options = {}) {
  if (typeof appConfig.formatPermissionSummary === "function") {
    return appConfig.formatPermissionSummary(permissions, options);
  }

  const short = Boolean(options.short);
  const normalized = normalizeStaffPermissions(permissions);

  if (!normalized.length) {
    return short ? "no assigned pages" : "No assigned pages";
  }

  if (normalized.length === STAFF_PERMISSION_KEYS.length) {
    return short ? "all business pages" : "All business pages";
  }

  const labels = normalized.map((permission) => {
    const option = getPermissionOption(permission);
    return option ? option[short ? "shortLabel" : "label"] : permission;
  });

  if (labels.length > 3) {
    return `${labels.length} pages`;
  }

  return labels.join(", ");
}

function canAccessPermission(...permissions) {
  if (isAdminSession()) {
    return true;
  }

  const granted = getUserPermissions();
  return permissions.some((permission) => granted.has(permission));
}

function canAccessInvoicePage() {
  return canAccessPermission(INVOICE_PAGE_PERMISSION);
}

function canAccessSection(sectionId) {
  if (sectionId === "staffAccessSection") {
    return isAdminSession();
  }

  const permission = SECTION_PERMISSION_MAP[sectionId];
  return permission ? canAccessPermission(permission) : isAdminSession();
}

function getAccessibleSectionIds() {
  return (dom.sectionButtons || [])
    .map((button) => button.dataset.section)
    .filter((sectionId) => canAccessSection(sectionId));
}

function getFirstAccessibleSection() {
  return getAccessibleSectionIds()[0] || null;
}

function clearStoredSession() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
}

function cacheElements() {
  Object.assign(dom, {
    sidebar: document.getElementById("sidebar"),
    sidebarOverlay: document.getElementById("sidebarOverlay"),
    sidebarToggle: document.getElementById("sidebarToggle"),
    sectionButtons: Array.from(
      document.querySelectorAll(".sidebar button[data-section]"),
    ),
    formSections: Array.from(document.querySelectorAll(".form-section")),
    logoutBtn: document.getElementById("logoutBtn"),
    invoiceBtn: document.getElementById("invoiceBtn"),
    overviewGrid: document.getElementById("overviewGrid"),
    currentDateLabel: document.getElementById("currentDateLabel"),
    sessionRoleChip: document.getElementById("sessionRoleChip"),
    welcomeUser: document.getElementById("welcomeUser"),
    heroSubtitle: document.getElementById("heroSubtitle"),
    sectionEyebrow: document.getElementById("sectionEyebrow"),
    sectionHeading: document.getElementById("sectionHeading"),
    sectionLead: document.getElementById("sectionLead"),
    sectionBadge: document.getElementById("sectionBadge"),
    statCatalogCount: document.getElementById("statCatalogCount"),
    statCatalogNote: document.getElementById("statCatalogNote"),
    statCatalogValue: document.getElementById("statCatalogValue"),
    statCatalogValueNote: document.getElementById("statCatalogValueNote"),
    statLowStock: document.getElementById("statLowStock"),
    statLowStockNote: document.getElementById("statLowStockNote"),
    statDueBalance: document.getElementById("statDueBalance"),
    statDueNote: document.getElementById("statDueNote"),
    newItemSearch: document.getElementById("newItemSearch"),
    newItemDropdownList: document.getElementById("newItemDropdownList"),
    newQuantity: document.getElementById("newQuantity"),
    profitPercent: document.getElementById("profitPercent"),
    buyingRate: document.getElementById("buyingRate"),
    sellingRate: document.getElementById("sellingRate"),
    addStockBtn: document.getElementById("addStockBtn"),
    previousBuyingRate: document.getElementById("previousBuyingRate"),
    profitPreviewValue: document.getElementById("profitPreviewValue"),
    profitPreviewNote: document.getElementById("profitPreviewNote"),
    itemReportSearch: document.getElementById("itemReportSearch"),
    itemReportDropdown: document.getElementById("itemReportDropdown"),
    loadItemReportBtn: document.getElementById("loadItemReportBtn"),
    itemReportPdfBtn: document.getElementById("itemReportPdfBtn"),
    itemReportBody: document.getElementById("itemReportBody"),
    lowStockCard: document.getElementById("lowStockCard"),
    lowStockCount: document.getElementById("lowStockCount"),
    lowStockBody: document.getElementById("lowStockBody"),
    reorderPlannerCard: document.getElementById("reorderPlannerCard"),
    reorderCandidateCount: document.getElementById("reorderCandidateCount"),
    reorderUrgentCount: document.getElementById("reorderUrgentCount"),
    reorderSuggestedUnits: document.getElementById("reorderSuggestedUnits"),
    reorderEstimatedCost: document.getElementById("reorderEstimatedCost"),
    reorderFastestItem: document.getElementById("reorderFastestItem"),
    reorderTargetDays: document.getElementById("reorderTargetDays"),
    reorderAverageCover: document.getElementById("reorderAverageCover"),
    reorderPlanBody: document.getElementById("reorderPlanBody"),
    fromDate: document.getElementById("fromDate"),
    toDate: document.getElementById("toDate"),
    loadSalesBtn: document.getElementById("loadSalesBtn"),
    pdfBtn: document.getElementById("pdfBtn"),
    excelBtn: document.getElementById("excelBtn"),
    salesReportBody: document.getElementById("salesReportBody"),
    salesGrandTotal: document.getElementById("salesGrandTotal"),
    gstFromDate: document.getElementById("gstFromDate"),
    gstToDate: document.getElementById("gstToDate"),
    loadGstBtn: document.getElementById("loadGstBtn"),
    gstPdfBtn: document.getElementById("gstPdfBtn"),
    gstExcelBtn: document.getElementById("gstExcelBtn"),
    gstReportBody: document.getElementById("gstReportBody"),
    gstInvoiceCount: document.getElementById("gstInvoiceCount"),
    gstTaxableTotal: document.getElementById("gstTaxableTotal"),
    gstCollectedTotal: document.getElementById("gstCollectedTotal"),
    gstReportGrandTotal: document.getElementById("gstReportGrandTotal"),
    gstAveragePerInvoice: document.getElementById("gstAveragePerInvoice"),
    gstEffectiveRate: document.getElementById("gstEffectiveRate"),
    gstFilingPeriod: document.getElementById("gstFilingPeriod"),
    gstTopCollectionMonth: document.getElementById("gstTopCollectionMonth"),
    gstZeroRatedInvoices: document.getElementById("gstZeroRatedInvoices"),
    gstDominantRate: document.getElementById("gstDominantRate"),
    gstTaxableBar: document.getElementById("gstTaxableBar"),
    gstCollectedBar: document.getElementById("gstCollectedBar"),
    gstTaxableShare: document.getElementById("gstTaxableShare"),
    gstCollectedShare: document.getElementById("gstCollectedShare"),
    gstInvoiceShare: document.getElementById("gstInvoiceShare"),
    gstMonthlySummaryBody: document.getElementById("gstMonthlySummaryBody"),
    gstRateSummaryBody: document.getElementById("gstRateSummaryBody"),
    yearFilter: document.getElementById("yearFilter"),
    businessTrendChart: document.getElementById("businessTrendChart"),
    growthBadge: document.getElementById("growthBadge"),
    last12MonthsChart: document.getElementById("last12MonthsChart"),
    cdName: document.getElementById("cdName"),
    cdNumber: document.getElementById("cdNumber"),
    cdNumberDropdown: document.getElementById("cdNumberDropdown"),
    cdTotal: document.getElementById("cdTotal"),
    cdCredit: document.getElementById("cdCredit"),
    cdRemark: document.getElementById("cdRemark"),
    submitDebtBtn: document.getElementById("submitDebtBtn"),
    cdSearchInput: document.getElementById("cdSearchInput"),
    cdSearchDropdown: document.getElementById("cdSearchDropdown"),
    searchLedgerBtn: document.getElementById("searchLedgerBtn"),
    showAllDuesBtn: document.getElementById("showAllDuesBtn"),
    ledgerTable: document.getElementById("ledgerTable"),
    staffName: document.getElementById("staffName"),
    staffUsername: document.getElementById("staffUsername"),
    staffPassword: document.getElementById("staffPassword"),
    staffPermissionGrid: document.getElementById("staffPermissionGrid"),
    selectAllStaffPagesBtn: document.getElementById("selectAllStaffPagesBtn"),
    clearAllStaffPagesBtn: document.getElementById("clearAllStaffPagesBtn"),
    createStaffBtn: document.getElementById("createStaffBtn"),
    staffList: document.getElementById("staffList"),
    staffLimitValue: document.getElementById("staffLimitValue"),
    staffRemainingValue: document.getElementById("staffRemainingValue"),
    commonPopup: document.getElementById("commonPopup"),
    popupOverlay: document.getElementById("popupOverlay"),
    popupBox: document.getElementById("popupBox"),
    popupIcon: document.getElementById("popupIcon"),
    popupTitle: document.getElementById("popupTitle"),
    popupMessage: document.getElementById("popupMessage"),
    popupClose: document.getElementById("popupClose"),
  });
}

async function fetchJSON(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: authHeaders(headers),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (error) {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || payload.message || "Request failed");
  }

  return payload;
}

async function downloadAuthenticatedFile(path, fallbackName) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    let payload = {};
    try {
      payload = await response.json();
    } catch (error) {
      payload = {};
    }

    throw new Error(payload.error || payload.message || "Download failed");
  }

  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="?([^"]+)"?/i);
  const filename = match?.[1] || fallbackName;
  const blobUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.setTimeout(() => {
    window.URL.revokeObjectURL(blobUrl);
  }, 1500);
}

async function logoutAndRedirect() {
  try {
    await fetchJSON("/auth/logout", { method: "POST" });
  } catch (error) {
    console.error("Logout request failed:", error);
  } finally {
    clearStoredSession();
    window.location.replace("login.html");
  }
}

async function withButtonState(button, loadingHtml, task) {
  if (!button) {
    await task();
    return;
  }

  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.innerHTML = loadingHtml;

  try {
    await task();
  } finally {
    button.disabled = false;
    button.setAttribute("aria-busy", "false");
    button.innerHTML = originalHtml;
  }
}

function showPopup(type, title, message, options = {}) {
  if (!dom.commonPopup) {
    return;
  }

  const iconMap = {
    success: '<i class="fa-solid fa-circle-check"></i>',
    error: '<i class="fa-solid fa-circle-xmark"></i>',
    info: '<i class="fa-solid fa-circle-info"></i>',
  };

  window.clearTimeout(state.popupTimer);
  state.popupTimer = null;

  dom.popupBox.classList.remove("success", "error");
  if (type === "success" || type === "error") {
    dom.popupBox.classList.add(type);
  }

  dom.popupIcon.innerHTML = iconMap[type] || iconMap.info;
  dom.popupTitle.textContent = title;
  dom.popupMessage.textContent = message;
  dom.commonPopup.classList.add("active");
  dom.commonPopup.setAttribute("aria-hidden", "false");

  if (options.autoClose !== false && type === "success") {
    state.popupTimer = window.setTimeout(() => {
      hidePopup();
    }, options.delay || 2200);
  }
}

function hidePopup() {
  if (!dom.commonPopup) {
    return;
  }

  window.clearTimeout(state.popupTimer);
  state.popupTimer = null;
  dom.commonPopup.classList.remove("active");
  dom.commonPopup.setAttribute("aria-hidden", "true");
}

function updateCurrentDateLabel() {
  dom.currentDateLabel.textContent = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function setCustomerNameLocked(locked) {
  dom.cdName.disabled = locked;
  dom.cdName.classList.toggle("bg-light", locked);
}

function hidePreviousBuyingRate() {
  dom.previousBuyingRate.style.display = "none";
  dom.previousBuyingRate.textContent = "";
}

function updateProfitPreview() {
  const percent = Number(dom.profitPercent.value);
  const buyingRate = Number(dom.buyingRate.value);
  const sellingRate = Number(dom.sellingRate.value);

  dom.profitPreviewValue.textContent = `${formatNumber(percent || 0)}%`;

  if (buyingRate > 0 && sellingRate > 0) {
    dom.profitPreviewNote.textContent =
      `Buying ${formatCurrency(buyingRate)} suggests selling ${formatCurrency(sellingRate)}.`;
    return;
  }

  dom.profitPreviewNote.textContent =
    "Stored on this device to keep future stock entries faster and more consistent.";
}

function updateSellingRate() {
  const buyingRate = Number(dom.buyingRate.value);
  const percent = Number(dom.profitPercent.value);

  if (Number.isFinite(buyingRate) && Number.isFinite(percent)) {
    const sellingRate = buyingRate * (1 + percent / 100);
    dom.sellingRate.value = sellingRate.toFixed(2);
  }

  updateProfitPreview();
}

function updateProfitPercent() {
  const buyingRate = Number(dom.buyingRate.value);
  const sellingRate = Number(dom.sellingRate.value);

  if (buyingRate > 0 && Number.isFinite(sellingRate)) {
    const percent = ((sellingRate - buyingRate) / buyingRate) * 100;
    const rounded = percent.toFixed(2);
    dom.profitPercent.value = rounded;
    localStorage.setItem("defaultProfitPercent", rounded);
  }

  updateProfitPreview();
}

function updateHeroSummary(metrics = {}) {
  const bits = [];
  const itemCount = Number(metrics.itemCount) || 0;
  const lowStockCount = Number(metrics.lowStockCount) || 0;
  const dueCustomerCount = Number(metrics.dueCustomerCount) || 0;

  if (itemCount > 0) {
    bits.push(`${formatCount(itemCount)} catalog items tracked`);
  }

  if (lowStockCount > 0) {
    bits.push(`${formatCount(lowStockCount)} item${lowStockCount === 1 ? "" : "s"} need stock attention`);
  }

  if (dueCustomerCount > 0) {
    bits.push(`${formatCount(dueCustomerCount)} customer${dueCustomerCount === 1 ? "" : "s"} have pending dues`);
  }

  dom.heroSubtitle.textContent = bits.length
    ? `Today: ${bits.join(" | ")}.`
    : "Your dashboard is ready to track stock, reports, invoices, and dues from one polished workspace.";
}

function applySessionAccess(user) {
  state.sessionUser = user;

  const isStaff = user?.role === "staff";
  const accessibleSection = getFirstAccessibleSection();
  const ownerName = (user?.ownerName || "").trim();
  const accessSummary = formatPermissionSummary(user?.permissions, {
    short: true,
  });

  if (dom.sessionRoleChip) {
    dom.sessionRoleChip.innerHTML = isStaff
      ? '<i class="fa-solid fa-user-lock"></i> Staff Workspace'
      : '<i class="fa-solid fa-shield-halved"></i> Admin Workspace';
  }

  if (dom.overviewGrid) {
    dom.overviewGrid.hidden = isStaff;
  }

  if (dom.invoiceBtn) {
    dom.invoiceBtn.hidden = !canAccessInvoicePage();
  }

  dom.sectionButtons.forEach((button) => {
    const sectionId = button.dataset.section;
    button.hidden = !canAccessSection(sectionId);
  });

  dom.formSections.forEach((section) => {
    section.hidden = !canAccessSection(section.id);
  });

  const displayName = (user?.name || "").trim() || "Workspace User";
  dom.welcomeUser.textContent = `Welcome, ${displayName}`;
  dom.heroSubtitle.textContent = isStaff
    ? `${ownerName || "Your admin"} assigned access to ${accessSummary}.`
    : "Your dashboard is syncing the latest inventory and sales view.";

  if (isStaff && accessibleSection) {
    localStorage.setItem("activeSection", accessibleSection);
  }
}

function updateSectionMeta(button) {
  if (!button) {
    return;
  }

  dom.sectionEyebrow.textContent = button.dataset.eyebrow || "Workspace";
  dom.sectionHeading.textContent = button.dataset.title || "Dashboard";
  dom.sectionLead.textContent =
    button.dataset.description || "Manage inventory, reporting, and dues from one dashboard.";
  dom.sectionBadge.textContent = button.dataset.badge || "Live";
}

function lockBodyScroll() {
  if (!isMobileLayout() || document.body.classList.contains("body-scroll-lock")) {
    return;
  }

  state.sidebarScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.classList.add("body-scroll-lock");
  document.body.style.top = `-${state.sidebarScrollY}px`;
}

function unlockBodyScroll() {
  if (!document.body.classList.contains("body-scroll-lock")) {
    return;
  }

  const scrollY = state.sidebarScrollY || 0;
  document.body.classList.remove("body-scroll-lock");
  document.body.style.top = "";
  window.scrollTo(0, scrollY);
  state.sidebarScrollY = 0;
}

function closeSidebar() {
  dom.sidebar.classList.remove("sidebar--open");
  dom.sidebarOverlay.classList.remove("visible");
  dom.sidebarToggle.setAttribute("aria-expanded", "false");
  unlockBodyScroll();
}

function openSidebar() {
  dom.sidebar.classList.add("sidebar--open");
  dom.sidebarOverlay.classList.add("visible");
  dom.sidebarToggle.setAttribute("aria-expanded", "true");
  lockBodyScroll();
}

function setActiveSection(sectionId) {
  if (!canAccessSection(sectionId)) {
    const fallbackSection = getFirstAccessibleSection();
    if (!fallbackSection) {
      if (canAccessInvoicePage()) {
        closeSidebar();
        window.location.replace("invoice.html");
      }
      return;
    }
    sectionId = fallbackSection;
  }

  const target = document.getElementById(sectionId);
  if (!target) {
    return;
  }

  dom.formSections.forEach((section) => {
    section.classList.toggle("active", section.id === sectionId);
  });

  dom.sectionButtons.forEach((button) => {
    const isActive = button.dataset.section === sectionId;
    button.classList.toggle("active", isActive);
    if (isActive) {
      updateSectionMeta(button);
    }
  });

  localStorage.setItem("activeSection", sectionId);

  if (sectionId === "itemReportSection") {
    loadLowStock({ silent: true });
  }

  if (sectionId === "staffAccessSection" && isAdminSession()) {
    loadStaffAccounts({ silent: true });
  }

  if (isMobileLayout()) {
    closeSidebar();
  }
}

function renderDropdown(listEl, items, onSelect) {
  if (!items.length) {
    listEl.style.display = "none";
    listEl.innerHTML = "";
    return;
  }

  listEl.innerHTML = items
    .map((item) => {
      return `
        <div
          class="dropdown-item"
          data-value="${encodeURIComponent(item)}"
        >
          ${escapeHtml(item)}
        </div>
      `;
    })
    .join("");

  listEl.style.display = "block";
  listEl.querySelectorAll(".dropdown-item").forEach((entry) => {
    entry.addEventListener("click", () => {
      onSelect(decodeURIComponent(entry.dataset.value));
      listEl.style.display = "none";
    });
  });
}

function setupFilterInput(input, listEl, onSelect) {
  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();

    if (!query) {
      renderDropdown(listEl, state.itemNames.slice(0, 50), onSelect);
      return;
    }

    const matches = state.itemNames
      .filter((itemName) => itemName.toLowerCase().includes(query))
      .slice(0, 50);

    renderDropdown(listEl, matches, onSelect);
  });

  input.addEventListener("focus", () => {
    renderDropdown(listEl, state.itemNames.slice(0, 50), onSelect);
  });

  document.addEventListener("click", (event) => {
    if (!input.contains(event.target) && !listEl.contains(event.target)) {
      listEl.style.display = "none";
    }
  });
}

async function checkAuth() {
  const token = getToken();
  if (!token) {
    window.location.replace("login.html");
    return null;
  }

  try {
    const user = await fetchJSON("/auth/me");
    localStorage.setItem("user", JSON.stringify(user));
    document.body.style.visibility = "visible";
    return user;
  } catch (error) {
    console.error("Auth check failed:", error);
    clearStoredSession();
    document.body.style.visibility = "visible";
    showPopup("error", "Session expired", "Please log in again to continue.", {
      autoClose: false,
    });
    window.setTimeout(() => {
      window.location.replace("login.html");
    }, 1500);
    return null;
  }
}

async function loadItemNames(options = {}) {
  try {
    const rows = await fetchJSON("/items/names");
    state.itemNames = Array.isArray(rows) ? rows : [];
    return state.itemNames;
  } catch (error) {
    console.error("Item names load failed:", error);
    state.itemNames = [];
    if (!options.silent) {
      showPopup("error", "Load failed", "Could not load item names.", {
        autoClose: false,
      });
    }
    return [];
  }
}

async function showPreviousBuyingRate(itemName) {
  const trimmedName = itemName.trim();
  if (!trimmedName) {
    hidePreviousBuyingRate();
    return;
  }

  try {
    const item = await fetchJSON(
      `/items/info?name=${encodeURIComponent(trimmedName)}`,
    );
    const previousRate = Number(item.buying_rate);

    if (!Number.isFinite(previousRate)) {
      hidePreviousBuyingRate();
      return;
    }

    dom.previousBuyingRate.textContent =
      `Previous buying rate: ${formatCurrency(previousRate)}`;
    dom.previousBuyingRate.style.display = "block";
    dom.buyingRate.value = previousRate.toFixed(2);
    updateSellingRate();
  } catch (error) {
    hidePreviousBuyingRate();
  }
}

async function loadDashboardOverview(options = {}) {
  if (!isAdminSession()) {
    return null;
  }

  try {
    const overview = await fetchJSON("/dashboard/overview");
    const itemCount = Number(overview.catalog?.item_count) || 0;
    const totalUnits = Number(overview.catalog?.total_units) || 0;
    const totalCostValue = Number(overview.catalog?.total_cost_value) || 0;
    const totalSellingValue =
      Number(overview.catalog?.total_selling_value) || 0;
    const lowStockCount = Number(overview.alerts?.low_stock_count) || 0;
    const shortestDaysLeft = Number(overview.alerts?.shortest_days_left);
    const mostUrgentItem = overview.alerts?.most_urgent_item || "";
    const dueCustomerCount = Number(overview.dues?.due_customer_count) || 0;
    const dueBalance = Number(overview.dues?.due_balance) || 0;

    dom.statCatalogCount.textContent = formatCount(itemCount);
    dom.statCatalogNote.textContent = itemCount
      ? `${formatNumber(totalUnits)} total units currently available in catalog.`
      : "Add your first item to start tracking inventory.";

    dom.statCatalogValue.textContent = formatCurrency(totalCostValue);
    dom.statCatalogValueNote.textContent = itemCount
      ? `Estimated selling value can reach ${formatCurrency(totalSellingValue)}.`
      : "Catalog value updates as soon as stock is saved.";

    dom.statLowStock.textContent = formatCount(lowStockCount);
    dom.statLowStockNote.textContent = lowStockCount
      ? `${mostUrgentItem || "One active item"} needs attention${Number.isFinite(shortestDaysLeft) ? ` in about ${formatNumber(shortestDaysLeft)} day(s)` : ""}.`
      : "No active low-stock alert right now.";

    dom.statDueBalance.textContent = formatCurrency(dueBalance);
    dom.statDueNote.textContent = dueCustomerCount
      ? `${formatCount(dueCustomerCount)} customer${dueCustomerCount === 1 ? "" : "s"} currently have pending balances.`
      : "No outstanding due balance at the moment.";

    updateHeroSummary({ itemCount, lowStockCount, dueCustomerCount });
    return overview;
  } catch (error) {
    console.error("Overview load failed:", error);
    if (!options.silent) {
      showPopup(
        "error",
        "Overview unavailable",
        "Could not load the dashboard overview cards.",
        { autoClose: false },
      );
    }
    return null;
  }
}

async function addStock() {
  const item = dom.newItemSearch.value.trim();
  const quantity = Number(dom.newQuantity.value);
  const buyingRate = Number(dom.buyingRate.value);
  const sellingRate = Number(dom.sellingRate.value);

  if (!item) {
    showPopup("error", "Missing item", "Enter or select an item name.", {
      autoClose: false,
    });
    return;
  }

  if (!Number.isFinite(quantity) || quantity <= 0) {
    showPopup("error", "Invalid quantity", "Quantity must be greater than zero.", {
      autoClose: false,
    });
    return;
  }

  if (!Number.isFinite(buyingRate) || buyingRate < 0) {
    showPopup(
      "error",
      "Invalid buying rate",
      "Buying rate must be zero or greater.",
      { autoClose: false },
    );
    return;
  }

  if (!Number.isFinite(sellingRate) || sellingRate < 0) {
    showPopup(
      "error",
      "Invalid selling rate",
      "Selling rate must be zero or greater.",
      { autoClose: false },
    );
    return;
  }

  await withButtonState(
    dom.addStockBtn,
    '<i class="fa-solid fa-spinner fa-spin"></i> Saving stock...',
    async () => {
      const data = await fetchJSON("/items", {
        method: "POST",
        body: JSON.stringify({
          name: item,
          quantity,
          buying_rate: buyingRate,
          selling_rate: sellingRate,
        }),
      });

      showPopup(
        "success",
        "Stock saved",
        data.message || "Inventory entry has been updated successfully.",
      );

      ["newItemSearch", "newQuantity", "buyingRate", "sellingRate"].forEach((id) => {
        document.getElementById(id).value = "";
      });

      hidePreviousBuyingRate();
      updateProfitPreview();

      await Promise.allSettled([
        loadItemNames({ silent: true }),
        loadDashboardOverview({ silent: true }),
      ]);

      if (document.getElementById("itemReportSection").classList.contains("active")) {
        await Promise.allSettled([
          loadItemReport({ silent: true }),
          loadLowStock({ silent: true }),
        ]);
      }
    },
  );
}

function renderItemReport(rows) {
  dom.itemReportBody.innerHTML = "";

  if (!rows.length) {
    dom.itemReportBody.innerHTML =
      '<tr><td colspan="5" class="text-muted">No stock records found for this selection.</td></tr>';
    return;
  }

  let totalCostValue = 0;
  let totalSellingValue = 0;
  let totalUnits = 0;

  rows.forEach((row) => {
    const availableQty = Number(row.available_qty) || 0;
    const buyingRate = Number(row.buying_rate) || 0;
    const sellingRate = Number(row.selling_rate) || 0;
    const soldQty = Number(row.sold_qty) || 0;

    totalUnits += availableQty;
    totalCostValue += availableQty * buyingRate;
    totalSellingValue += availableQty * sellingRate;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.item_name)}</td>
      <td>${formatNumber(availableQty)}</td>
      <td>${formatCurrency(buyingRate)}</td>
      <td>${formatCurrency(sellingRate)}</td>
      <td>${formatNumber(soldQty)}</td>
    `;
    dom.itemReportBody.appendChild(tr);
  });

  const estimatedProfit = totalSellingValue - totalCostValue;
  const summaryRow = document.createElement("tr");
  summaryRow.innerHTML = `
    <td colspan="5" class="text-end fw-bold bg-light-subtle">
      <div>Total Units: ${formatNumber(totalUnits)}</div>
      <div>Total Cost Value: ${formatCurrency(totalCostValue)}</div>
      <div>Total Selling Value: ${formatCurrency(totalSellingValue)}</div>
      <div class="${estimatedProfit >= 0 ? "text-success" : "text-danger"}">
        Estimated Profit: ${formatCurrency(estimatedProfit)}
      </div>
    </td>
  `;
  dom.itemReportBody.appendChild(summaryRow);
}

async function loadItemReport(options = {}) {
  const item = dom.itemReportSearch.value.trim();
  const query = item ? `?name=${encodeURIComponent(item)}` : "";

  const task = async () => {
    const rows = await fetchJSON(`/items/report${query}`);
    state.currentItemReportRows = Array.isArray(rows) ? rows : [];
    renderItemReport(state.currentItemReportRows);

    if (!item) {
      await loadDashboardOverview({ silent: true });
    }
  };

  if (options.silent) {
    try {
      await task();
    } catch (error) {
      console.error("Item report load failed:", error);
    }
    return;
  }

  await withButtonState(
    dom.loadItemReportBtn,
    '<i class="fa-solid fa-spinner fa-spin"></i> Loading report...',
    async () => {
      try {
        await task();
      } catch (error) {
        console.error("Item report load failed:", error);
        showPopup(
          "error",
          "Report unavailable",
          "Could not load the stock report right now.",
          { autoClose: false },
        );
      }
    },
  );
}

function updateLowStockOverview(rows) {
  const count = rows.length;
  dom.statLowStock.textContent = formatCount(count);

  if (!count) {
    dom.statLowStockNote.textContent = "No active low-stock alert right now.";
    return;
  }

  const urgentRow = rows[0];
  const daysLeft = Number(urgentRow.days_left);
  dom.statLowStockNote.textContent =
    `${urgentRow.item_name} is most urgent${Number.isFinite(daysLeft) ? ` with about ${formatNumber(daysLeft)} day(s) left` : ""}.`;

  updateHeroSummary({
    itemCount: parseFormattedNumber(dom.statCatalogCount.textContent),
    lowStockCount: count,
    dueCustomerCount: parseFormattedNumber(dom.statDueNote.textContent),
  });
}

function getReorderBadgeClass(priority) {
  switch (priority) {
    case "URGENT":
      return "status-badge-pill status-badge-pill--urgent";
    case "SOON":
      return "status-badge-pill status-badge-pill--soon";
    default:
      return "status-badge-pill status-badge-pill--buffer";
  }
}

function resetReorderPlanner() {
  dom.reorderPlannerCard.hidden = true;
  dom.reorderCandidateCount.textContent = "0";
  dom.reorderUrgentCount.textContent = "0";
  dom.reorderSuggestedUnits.textContent = "0";
  dom.reorderEstimatedCost.textContent = "Rs. 0.00";
  dom.reorderFastestItem.textContent = "-";
  dom.reorderTargetDays.textContent = "21 days";
  dom.reorderAverageCover.textContent = "0.00 days";
  dom.reorderPlanBody.innerHTML =
    '<tr><td colspan="6" class="text-muted">Reorder suggestions will appear here.</td></tr>';
}

function renderReorderPlanner(rows) {
  dom.reorderPlannerCard.hidden = false;
  dom.reorderPlanBody.innerHTML = "";

  if (!rows.length) {
    dom.reorderCandidateCount.textContent = "0";
    dom.reorderUrgentCount.textContent = "0";
    dom.reorderSuggestedUnits.textContent = "0";
    dom.reorderEstimatedCost.textContent = "Rs. 0.00";
    dom.reorderFastestItem.textContent = "Inventory looks healthy";
    dom.reorderTargetDays.textContent = "21 days";
    dom.reorderAverageCover.textContent = "--";
    dom.reorderPlanBody.innerHTML =
      '<tr><td colspan="6" class="text-muted">No reorder suggestion is needed right now.</td></tr>';
    return;
  }

  let suggestedUnits = 0;
  let estimatedCost = 0;
  let urgentCount = 0;
  let totalCoverDays = 0;
  let coverCount = 0;
  let fastestMover = rows[0];

  rows.forEach((row) => {
    const availableQty = Number(row.available_qty) || 0;
    const dailyRunRate = Number(row.daily_run_rate) || 0;
    const soldLast30Days = Number(row.sold_30_days) || 0;
    const daysLeft = Number(row.days_left);
    const reorderQty = Number(row.recommended_reorder_qty) || 0;
    const reorderCost = Number(row.reorder_cost) || 0;
    const targetDays = Number(row.target_days) || 21;
    const priority = row.priority || "BUFFER";
    const tr = document.createElement("tr");

    if (priority === "URGENT") {
      urgentCount += 1;
      tr.classList.add("reorder-row--urgent");
    } else if (priority === "SOON") {
      tr.classList.add("reorder-row--soon");
    }

    if ((Number(fastestMover?.sold_30_days) || 0) < soldLast30Days) {
      fastestMover = row;
    }

    if (Number.isFinite(daysLeft)) {
      totalCoverDays += daysLeft;
      coverCount += 1;
    }

    suggestedUnits += reorderQty;
    estimatedCost += reorderCost;

    tr.innerHTML = `
      <td>
        <div class="table-primary-copy">${escapeHtml(row.item_name)}</div>
        <div class="table-secondary-copy">
          <span class="${getReorderBadgeClass(priority)}">${escapeHtml(priority)}</span>
        </div>
      </td>
      <td>${formatNumber(availableQty)}</td>
      <td>${formatNumber(dailyRunRate)}</td>
      <td>${Number.isFinite(daysLeft) ? `${formatNumber(daysLeft)} days` : "--"}</td>
      <td>${formatNumber(reorderQty)}</td>
      <td>${formatCurrency(reorderCost)}</td>
    `;
    dom.reorderPlanBody.appendChild(tr);
    dom.reorderTargetDays.textContent = `${formatCount(targetDays)} days`;
  });

  const averageCover = coverCount ? totalCoverDays / coverCount : 0;

  dom.reorderCandidateCount.textContent = formatCount(rows.length);
  dom.reorderUrgentCount.textContent = formatCount(urgentCount);
  dom.reorderSuggestedUnits.textContent = formatCount(suggestedUnits);
  dom.reorderEstimatedCost.textContent = formatCurrency(estimatedCost);
  dom.reorderFastestItem.textContent = fastestMover
    ? `${fastestMover.item_name} (${formatNumber(fastestMover.sold_30_days)} sold / 30d)`
    : "-";
  dom.reorderAverageCover.textContent = coverCount
    ? `${formatNumber(averageCover)} days`
    : "--";
}

function renderLowStock(rows) {
  dom.lowStockBody.innerHTML = "";
  dom.lowStockCard.hidden = rows.length === 0;
  dom.lowStockCount.textContent = formatCount(rows.length);

  if (!rows.length) {
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const availableQty = Number(row.available_qty) || 0;
    const soldLast30Days = Number(row.sold_30_days) || 0;
    const daysLeft = Number(row.days_left);
    const status = row.status || "MEDIUM";
    const badgeClass =
      status === "LOW" ? "badge bg-danger" : "badge bg-warning text-dark";

    if (status === "LOW") {
      tr.classList.add("critical-stock-row");
    }

    if (status === "MEDIUM") {
      tr.classList.add("warning-stock-row");
    }

    tr.innerHTML = `
      <td>${escapeHtml(row.item_name)}</td>
      <td>${formatNumber(availableQty)}</td>
      <td>${formatNumber(soldLast30Days)}</td>
      <td>${Number.isFinite(daysLeft) ? `${formatNumber(daysLeft)} days` : "--"}</td>
      <td><span class="${badgeClass}">${status}</span></td>
    `;
    dom.lowStockBody.appendChild(tr);
  });
}

async function loadLowStock(options = {}) {
  const [lowStockResult, reorderResult] = await Promise.allSettled([
    fetchJSON("/items/low-stock"),
    fetchJSON("/items/reorder-suggestions"),
  ]);

  const lowStockLoaded = lowStockResult.status === "fulfilled";
  const reorderLoaded = reorderResult.status === "fulfilled";

  if (lowStockLoaded) {
    state.lowStockRows = Array.isArray(lowStockResult.value) ? lowStockResult.value : [];
    renderLowStock(state.lowStockRows);
    updateLowStockOverview(state.lowStockRows);
  } else {
    console.error("Low stock load failed:", lowStockResult.reason);
    state.lowStockRows = [];
    renderLowStock([]);
    updateLowStockOverview([]);
  }

  if (reorderLoaded) {
    state.reorderRows = Array.isArray(reorderResult.value) ? reorderResult.value : [];
    renderReorderPlanner(state.reorderRows);
  } else {
    console.error("Reorder planner load failed:", reorderResult.reason);
    state.reorderRows = [];
    resetReorderPlanner();
  }

  if (!lowStockLoaded && !reorderLoaded && !options.silent) {
    showPopup(
      "error",
      "Alerts unavailable",
      "Could not load the stock planning insights right now.",
      { autoClose: false },
    );
  }
}

function validateSalesDates() {
  const fromDate = dom.fromDate.value;
  const toDate = dom.toDate.value;

  if (!fromDate || !toDate) {
    showPopup(
      "error",
      "Missing date range",
      "Select both From and To dates before loading sales data.",
      { autoClose: false },
    );
    return false;
  }

  if (fromDate > toDate) {
    showPopup(
      "error",
      "Invalid date range",
      "From date cannot be later than To date.",
      { autoClose: false },
    );
    return false;
  }

  return true;
}

function renderSalesReport(rows) {
  dom.salesReportBody.innerHTML = "";
  let grandTotal = 0;

  if (!rows.length) {
    dom.salesReportBody.innerHTML =
      '<tr><td colspan="5" class="text-muted">No sales records found for this range.</td></tr>';
    dom.salesGrandTotal.textContent = "0.00";
    return;
  }

  rows.forEach((row) => {
    const totalPrice = Number(row.total_price) || 0;
    const sellingPrice = Number(row.selling_price) || 0;
    const quantity = Number(row.quantity) || 0;

    grandTotal += totalPrice;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatDate(row.created_at)}</td>
      <td>${escapeHtml(row.item_name)}</td>
      <td>${formatNumber(quantity)}</td>
      <td>${formatCurrency(sellingPrice)}</td>
      <td>${formatCurrency(totalPrice)}</td>
    `;
    dom.salesReportBody.appendChild(tr);
  });

  dom.salesGrandTotal.textContent = formatters.money.format(grandTotal);
}

function validateGstDates() {
  const fromDate = dom.gstFromDate.value;
  const toDate = dom.gstToDate.value;

  if (!fromDate || !toDate) {
    showPopup(
      "error",
      "Missing date range",
      "Select both From and To dates before loading the GST report.",
      { autoClose: false },
    );
    return false;
  }

  if (fromDate > toDate) {
    showPopup(
      "error",
      "Invalid date range",
      "From date cannot be later than To date.",
      { autoClose: false },
    );
    return false;
  }

  return true;
}

function resetGstAdvancedSummary() {
  dom.gstFilingPeriod.textContent =
    dom.gstFromDate.value && dom.gstToDate.value
      ? `${formatInputDate(dom.gstFromDate.value)} - ${formatInputDate(dom.gstToDate.value)}`
      : "-";
  dom.gstTopCollectionMonth.textContent = "-";
  dom.gstZeroRatedInvoices.textContent = "0";
  dom.gstDominantRate.textContent = "0.00%";
  dom.gstCollectedShare.textContent = "0.00%";
  dom.gstTaxableShare.textContent = "0.00%";
  dom.gstInvoiceShare.textContent = "0.00%";
  dom.gstTaxableBar.style.width = "0%";
  dom.gstCollectedBar.style.width = "0%";
  dom.gstMonthlySummaryBody.innerHTML =
    '<tr><td colspan="5" class="text-muted">Load the GST report to view monthly summary.</td></tr>';
  dom.gstRateSummaryBody.innerHTML =
    '<tr><td colspan="5" class="text-muted">Load the GST report to view rate-wise breakup.</td></tr>';
}

function buildGstInsights(rows) {
  const monthlyMap = new Map();
  const rateMap = new Map();
  let taxableTotal = 0;
  let gstTotal = 0;
  let grandTotal = 0;
  let zeroRatedInvoices = 0;

  rows.forEach((row) => {
    const taxableAmount = Number(row.taxable_amount) || 0;
    const gstAmount = Number(row.gst_amount) || 0;
    const invoiceTotal = Number(row.invoice_total) || 0;
    const gstRate = Math.abs(Number(row.gst_rate) || 0);
    const monthBucket = getMonthBucket(row.created_at);
    const monthEntry = monthlyMap.get(monthBucket) || {
      bucket: monthBucket,
      label: formatMonthBucket(monthBucket),
      invoiceCount: 0,
      taxableTotal: 0,
      gstTotal: 0,
      invoiceTotal: 0,
    };
    const rateKey = gstRate.toFixed(2);
    const rateEntry = rateMap.get(rateKey) || {
      rate: gstRate,
      invoiceCount: 0,
      taxableTotal: 0,
      gstTotal: 0,
      invoiceTotal: 0,
    };

    taxableTotal += taxableAmount;
    gstTotal += gstAmount;
    grandTotal += invoiceTotal;

    if (Math.abs(gstAmount) < 0.005) {
      zeroRatedInvoices += 1;
    }

    monthEntry.invoiceCount += 1;
    monthEntry.taxableTotal += taxableAmount;
    monthEntry.gstTotal += gstAmount;
    monthEntry.invoiceTotal += invoiceTotal;
    monthlyMap.set(monthBucket, monthEntry);

    rateEntry.invoiceCount += 1;
    rateEntry.taxableTotal += taxableAmount;
    rateEntry.gstTotal += gstAmount;
    rateEntry.invoiceTotal += invoiceTotal;
    rateMap.set(rateKey, rateEntry);
  });

  const monthlyRows = Array.from(monthlyMap.values()).sort((left, right) =>
    left.bucket.localeCompare(right.bucket),
  );
  const rateRows = Array.from(rateMap.values()).sort(
    (left, right) => left.rate - right.rate || right.taxableTotal - left.taxableTotal,
  );
  const invoiceCount = rows.length;
  const averageGst = invoiceCount ? gstTotal / invoiceCount : 0;
  const effectiveRate = taxableTotal ? (gstTotal / taxableTotal) * 100 : 0;
  const taxMixBase = Math.abs(taxableTotal) + Math.abs(gstTotal);
  const taxableShare = taxMixBase ? (Math.abs(taxableTotal) / taxMixBase) * 100 : 0;
  const gstShare = taxMixBase ? (Math.abs(gstTotal) / taxMixBase) * 100 : 0;
  const topCollectionMonth = monthlyRows.reduce(
    (best, row) => (!best || row.gstTotal > best.gstTotal ? row : best),
    null,
  );
  const dominantRate = rateRows.reduce(
    (best, row) => (!best || row.taxableTotal > best.taxableTotal ? row : best),
    null,
  );

  return {
    invoiceCount,
    taxableTotal,
    gstTotal,
    grandTotal,
    averageGst,
    effectiveRate,
    taxableShare,
    gstShare,
    zeroRatedInvoices,
    monthlyRows,
    rateRows,
    topCollectionMonth,
    dominantRate,
  };
}

function renderGstAdvancedSummary(insights) {
  dom.gstFilingPeriod.textContent = `${formatInputDate(dom.gstFromDate.value)} - ${formatInputDate(dom.gstToDate.value)}`;
  dom.gstTopCollectionMonth.textContent = insights.topCollectionMonth?.label || "-";
  dom.gstZeroRatedInvoices.textContent = formatCount(insights.zeroRatedInvoices);
  dom.gstDominantRate.textContent = insights.dominantRate
    ? formatPercent(insights.dominantRate.rate)
    : "0.00%";
  dom.gstCollectedShare.textContent = formatPercent(insights.gstShare);
  dom.gstTaxableShare.textContent = formatPercent(insights.taxableShare);
  dom.gstInvoiceShare.textContent = formatPercent(insights.gstShare);
  dom.gstTaxableBar.style.width = `${Math.max(0, Math.min(insights.taxableShare, 100))}%`;
  dom.gstCollectedBar.style.width = `${Math.max(0, Math.min(insights.gstShare, 100))}%`;

  dom.gstMonthlySummaryBody.innerHTML = insights.monthlyRows.length
    ? insights.monthlyRows
        .map(
          (row) => `
            <tr>
              <td>${escapeHtml(row.label)}</td>
              <td>${formatCount(row.invoiceCount)}</td>
              <td>${formatCurrency(row.taxableTotal)}</td>
              <td>${formatCurrency(row.gstTotal)}</td>
              <td>${formatCurrency(row.invoiceTotal)}</td>
            </tr>
          `,
        )
        .join("")
    : '<tr><td colspan="5" class="text-muted">No monthly GST summary found.</td></tr>';

  dom.gstRateSummaryBody.innerHTML = insights.rateRows.length
    ? insights.rateRows
        .map(
          (row) => `
            <tr>
              <td>${formatPercent(row.rate)}</td>
              <td>${formatCount(row.invoiceCount)}</td>
              <td>${formatCurrency(row.taxableTotal)}</td>
              <td>${formatCurrency(row.gstTotal)}</td>
              <td>${formatCurrency(row.invoiceTotal)}</td>
            </tr>
          `,
        )
        .join("")
    : '<tr><td colspan="5" class="text-muted">No GST rate breakup found.</td></tr>';
}

function renderGstReport(rows) {
  dom.gstReportBody.innerHTML = "";

  if (!rows.length) {
    dom.gstReportBody.innerHTML =
      '<tr><td colspan="6" class="text-muted">No GST records found for this range.</td></tr>';
    dom.gstInvoiceCount.textContent = "0";
    dom.gstTaxableTotal.textContent = "Rs. 0.00";
    dom.gstCollectedTotal.textContent = "Rs. 0.00";
    dom.gstReportGrandTotal.textContent = "Rs. 0.00";
    dom.gstAveragePerInvoice.textContent = "0.00";
    dom.gstEffectiveRate.textContent = "0.00%";
    resetGstAdvancedSummary();
    return;
  }

  const insights = buildGstInsights(rows);

  rows.forEach((row) => {
    const taxableAmount = Number(row.taxable_amount) || 0;
    const gstAmount = Number(row.gst_amount) || 0;
    const invoiceTotal = Number(row.invoice_total) || 0;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatDate(row.created_at)}</td>
      <td>${escapeHtml(row.invoice_no || "-")}</td>
      <td>${escapeHtml(row.customer_name || "Walk-in Customer")}</td>
      <td>${formatCurrency(taxableAmount)}</td>
      <td>${formatCurrency(gstAmount)}</td>
      <td>${formatCurrency(invoiceTotal)}</td>
    `;
    dom.gstReportBody.appendChild(tr);
  });

  dom.gstInvoiceCount.textContent = formatCount(insights.invoiceCount);
  dom.gstTaxableTotal.textContent = formatCurrency(insights.taxableTotal);
  dom.gstCollectedTotal.textContent = formatCurrency(insights.gstTotal);
  dom.gstReportGrandTotal.textContent = formatCurrency(insights.grandTotal);
  dom.gstAveragePerInvoice.textContent = formatters.money.format(insights.averageGst);
  dom.gstEffectiveRate.textContent = formatPercent(Math.abs(insights.effectiveRate));
  renderGstAdvancedSummary(insights);
}

async function loadSalesReport(options = {}) {
  if (!validateSalesDates()) {
    return;
  }

  const fromDate = dom.fromDate.value;
  const toDate = dom.toDate.value;
  const query = `/sales/report?from=${fromDate}&to=${toDate}`;

  const task = async () => {
    const rows = await fetchJSON(query);
    state.currentSalesRows = Array.isArray(rows) ? rows : [];
    renderSalesReport(state.currentSalesRows);
  };

  if (options.silent) {
    try {
      await task();
    } catch (error) {
      console.error("Sales report load failed:", error);
    }
    return;
  }

  await withButtonState(
    dom.loadSalesBtn,
    '<i class="fa-solid fa-spinner fa-spin"></i> Loading sales...',
    async () => {
      try {
        await task();
      } catch (error) {
        console.error("Sales report load failed:", error);
        showPopup(
          "error",
          "Sales report unavailable",
          "Could not load sales data for the selected range.",
          { autoClose: false },
        );
      }
    },
  );
}

async function loadGstReport(options = {}) {
  if (!validateGstDates()) {
    return;
  }

  const fromDate = dom.gstFromDate.value;
  const toDate = dom.gstToDate.value;
  const query = `/gst/report?from=${fromDate}&to=${toDate}`;

  const task = async () => {
    const rows = await fetchJSON(query);
    state.currentGstRows = Array.isArray(rows) ? rows : [];
    renderGstReport(state.currentGstRows);
  };

  if (options.silent) {
    try {
      await task();
    } catch (error) {
      console.error("GST report load failed:", error);
    }
    return;
  }

  await withButtonState(
    dom.loadGstBtn,
    '<i class="fa-solid fa-spinner fa-spin"></i> Loading GST...',
    async () => {
      try {
        await task();
      } catch (error) {
        console.error("GST report load failed:", error);
        showPopup(
          "error",
          "GST report unavailable",
          "Could not load GST data for the selected range.",
          { autoClose: false },
        );
      }
    },
  );
}

async function downloadItemReportPDF() {
  const item = dom.itemReportSearch.value.trim();
  const query = item ? `?name=${encodeURIComponent(item)}` : "";
  const fallbackName = item
    ? `${sanitizeFileName(item)}-stock-report.pdf`
    : "stock-report.pdf";

  await withButtonState(
    dom.itemReportPdfBtn,
    '<i class="fa-solid fa-spinner fa-spin"></i> Preparing PDF...',
    async () => {
      try {
        await downloadAuthenticatedFile(`/items/report/pdf${query}`, fallbackName);
        showPopup(
          "success",
          "Download complete",
          "The stock report PDF has been downloaded.",
        );
      } catch (error) {
        console.error("Stock PDF download failed:", error);
        showPopup(
          "error",
          "Download failed",
          error.message || "Could not download the stock report PDF.",
          { autoClose: false },
        );
      }
    },
  );
}

async function downloadSalesPDF() {
  if (!validateSalesDates()) {
    return;
  }

  const fromDate = dom.fromDate.value;
  const toDate = dom.toDate.value;

  await withButtonState(
    dom.pdfBtn,
    '<i class="fa-solid fa-spinner fa-spin"></i> Preparing PDF...',
    async () => {
      try {
        await downloadAuthenticatedFile(
          `/sales/report/pdf?from=${fromDate}&to=${toDate}`,
          `sales-report-${fromDate}-to-${toDate}.pdf`,
        );
        showPopup(
          "success",
          "Download complete",
          "The sales report PDF has been downloaded.",
        );
      } catch (error) {
        console.error("Sales PDF download failed:", error);
        showPopup(
          "error",
          "Download failed",
          error.message || "Could not download the sales PDF.",
          { autoClose: false },
        );
      }
    },
  );
}

async function downloadSalesExcel() {
  if (!validateSalesDates()) {
    return;
  }

  const fromDate = dom.fromDate.value;
  const toDate = dom.toDate.value;

  await withButtonState(
    dom.excelBtn,
    '<i class="fa-solid fa-spinner fa-spin"></i> Preparing Excel...',
    async () => {
      try {
        await downloadAuthenticatedFile(
          `/sales/report/excel?from=${fromDate}&to=${toDate}`,
          `sales-report-${fromDate}-to-${toDate}.xlsx`,
        );
        showPopup(
          "success",
          "Download complete",
          "The sales report Excel file has been downloaded.",
        );
      } catch (error) {
        console.error("Sales Excel download failed:", error);
        showPopup(
          "error",
          "Download failed",
          error.message || "Could not download the sales Excel file.",
          { autoClose: false },
        );
      }
    },
  );
}

async function downloadGstPDF() {
  if (!validateGstDates()) {
    return;
  }

  const fromDate = dom.gstFromDate.value;
  const toDate = dom.gstToDate.value;

  await withButtonState(
    dom.gstPdfBtn,
    '<i class="fa-solid fa-spinner fa-spin"></i> Preparing PDF...',
    async () => {
      try {
        await downloadAuthenticatedFile(
          `/gst/report/pdf?from=${fromDate}&to=${toDate}`,
          `gst-report-${fromDate}-to-${toDate}.pdf`,
        );
        showPopup(
          "success",
          "Download complete",
          "The GST report PDF has been downloaded.",
        );
      } catch (error) {
        console.error("GST PDF download failed:", error);
        showPopup(
          "error",
          "Download failed",
          error.message || "Could not download the GST PDF.",
          { autoClose: false },
        );
      }
    },
  );
}

async function downloadGstExcel() {
  if (!validateGstDates()) {
    return;
  }

  const fromDate = dom.gstFromDate.value;
  const toDate = dom.gstToDate.value;

  await withButtonState(
    dom.gstExcelBtn,
    '<i class="fa-solid fa-spinner fa-spin"></i> Preparing Excel...',
    async () => {
      try {
        await downloadAuthenticatedFile(
          `/gst/report/excel?from=${fromDate}&to=${toDate}`,
          `gst-report-${fromDate}-to-${toDate}.xlsx`,
        );
        showPopup(
          "success",
          "Download complete",
          "The GST report Excel file has been downloaded.",
        );
      } catch (error) {
        console.error("GST Excel download failed:", error);
        showPopup(
          "error",
          "Download failed",
          error.message || "Could not download the GST Excel file.",
          { autoClose: false },
        );
      }
    },
  );
}

async function submitDebt() {
  const customerName = dom.cdName.value.trim();
  const customerNumber = dom.cdNumber.value.trim();
  const total = Number(dom.cdTotal.value) || 0;
  const credit = Number(dom.cdCredit.value) || 0;
  const remark = dom.cdRemark.value.trim();

  if (!customerName) {
    showPopup(
      "error",
      "Missing customer name",
      "Customer name is required before saving a due entry.",
      { autoClose: false },
    );
    return;
  }

  if (!/^\d{10}$/.test(customerNumber)) {
    showPopup(
      "error",
      "Invalid mobile number",
      "Enter a valid 10-digit mobile number.",
      { autoClose: false },
    );
    return;
  }

  if (total < 0 || credit < 0) {
    showPopup(
      "error",
      "Invalid amount",
      "Amount and credit cannot be negative.",
      { autoClose: false },
    );
    return;
  }

  if (total === 0 && credit === 0) {
    showPopup(
      "error",
      "Missing amount",
      "Enter an amount or a credit value before submitting.",
      { autoClose: false },
    );
    return;
  }

  await withButtonState(
    dom.submitDebtBtn,
    '<i class="fa-solid fa-spinner fa-spin"></i> Saving due...',
    async () => {
      try {
        const data = await fetchJSON("/debts", {
          method: "POST",
          body: JSON.stringify({
            customer_name: customerName,
            customer_number: customerNumber,
            total,
            credit,
            remark,
          }),
        });

        showPopup(
          "success",
          "Due saved",
          data.message || "Customer due entry added successfully.",
        );

        ["cdName", "cdNumber", "cdTotal", "cdCredit", "cdRemark"].forEach((id) => {
          document.getElementById(id).value = "";
        });

        setCustomerNameLocked(false);
        await loadDashboardOverview({ silent: true });

        if (state.ledgerMode === "summary") {
          await showAllDues({ silent: true });
        }

        if (state.ledgerMode === "ledger" && state.currentLedgerNumber === customerNumber) {
          await searchLedger({ value: customerNumber, silent: true });
        }
      } catch (error) {
        console.error("Due submit failed:", error);
        showPopup(
          "error",
          "Save failed",
          error.message || "Could not save the due entry.",
          { autoClose: false },
        );
      }
    },
  );
}

async function loadBusinessTrend(year = "all", options = {}) {
  if (!isAdminSession() || typeof Chart === "undefined" || !dom.businessTrendChart) {
    return;
  }

  try {
    const rows = await fetchJSON(`/sales/monthly-trend?year=${year}`);
    const labels = rows.map((row) => row.month);
    const sales = rows.map((row) => Number(row.total_sales) || 0);
    const profit = rows.map((row) => Number(row.total_profit) || 0);

    renderBusinessTrend(labels, sales, profit);
    updateGrowthBadge(sales);
  } catch (error) {
    console.error("Business trend load failed:", error);
    if (!options.silent) {
      showPopup(
        "error",
        "Chart unavailable",
        "Could not load the monthly business trend chart.",
        { autoClose: false },
      );
    }
  }
}

function renderBusinessTrend(labels, sales, profit) {
  const ctx = dom.businessTrendChart.getContext("2d");

  if (state.charts.businessTrend) {
    state.charts.businessTrend.destroy();
  }

  const salesGradient = ctx.createLinearGradient(0, 0, 0, 260);
  salesGradient.addColorStop(0, "rgba(14, 165, 233, 0.26)");
  salesGradient.addColorStop(1, "rgba(14, 165, 233, 0.02)");

  const profitGradient = ctx.createLinearGradient(0, 0, 0, 260);
  profitGradient.addColorStop(0, "rgba(20, 184, 166, 0.24)");
  profitGradient.addColorStop(1, "rgba(20, 184, 166, 0.02)");

  state.charts.businessTrend = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Sales",
          data: sales,
          borderColor: "#0ea5e9",
          backgroundColor: salesGradient,
          fill: true,
          borderWidth: 3,
          tension: 0.32,
          pointRadius: 3,
          pointHoverRadius: 5,
        },
        {
          label: "Profit",
          data: profit,
          borderColor: "#14b8a6",
          backgroundColor: profitGradient,
          fill: true,
          borderWidth: 3,
          tension: 0.32,
          pointRadius: 3,
          pointHoverRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "top",
          labels: {
            usePointStyle: true,
            boxWidth: 10,
          },
        },
        tooltip: {
          callbacks: {
            label(context) {
              return `${context.dataset.label}: ${formatCurrency(context.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: {
            display: false,
          },
        },
        y: {
          beginAtZero: true,
          ticks: {
            callback(value) {
              return formatCurrency(value);
            },
          },
        },
      },
    },
  });
}

function updateGrowthBadge(values) {
  if (!values.length || values.length < 2) {
    dom.growthBadge.innerHTML =
      '<span class="text-muted">Need at least two months of sales data to calculate growth.</span>';
    return;
  }

  const last = Number(values[values.length - 1]) || 0;
  const previous = Number(values[values.length - 2]) || 0;

  if (previous <= 0) {
    dom.growthBadge.innerHTML =
      '<span class="text-muted">Growth will appear once two comparable sales months are available.</span>';
    return;
  }

  const growth = ((last - previous) / previous) * 100;
  const directionIcon =
    growth >= 0
      ? '<i class="fa-solid fa-arrow-trend-up text-success"></i>'
      : '<i class="fa-solid fa-arrow-trend-down text-danger"></i>';
  const directionText = growth >= 0 ? "growth" : "drop";
  const directionClass = growth >= 0 ? "text-success" : "text-danger";

  dom.growthBadge.innerHTML = `
    ${directionIcon}
    <span class="${directionClass}">
      ${Math.abs(growth).toFixed(1)}% ${directionText} vs previous month
    </span>
  `;
}

function initYearFilter() {
  const currentYear = new Date().getFullYear();

  for (let year = currentYear; year >= currentYear - 5; year -= 1) {
    const option = document.createElement("option");
    option.value = String(year);
    option.textContent = String(year);
    dom.yearFilter.appendChild(option);
  }

  dom.yearFilter.addEventListener("change", () => {
    loadBusinessTrend(dom.yearFilter.value, { silent: true });
  });
}

async function loadLast13MonthsChart(options = {}) {
  if (!isAdminSession() || typeof Chart === "undefined" || !dom.last12MonthsChart) {
    return;
  }

  try {
    const rows = await fetchJSON("/sales/last-13-months");
    const labels = rows.map((row) => row.month);
    const data = rows.map((row) => Number(row.total_sales) || 0);
    renderLast13MonthsChart(labels, data);
  } catch (error) {
    console.error("Last 13 months chart failed:", error);
    if (!options.silent) {
      showPopup(
        "error",
        "Chart unavailable",
        "Could not load the recent sales chart.",
        { autoClose: false },
      );
    }
  }
}

function renderLast13MonthsChart(labels, values) {
  const ctx = dom.last12MonthsChart.getContext("2d");

  if (state.charts.last13Months) {
    state.charts.last13Months.destroy();
  }

  const barGradient = ctx.createLinearGradient(0, 0, 0, 260);
  barGradient.addColorStop(0, "rgba(37, 99, 235, 0.95)");
  barGradient.addColorStop(1, "rgba(14, 165, 233, 0.52)");

  state.charts.last13Months = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: barGradient,
          borderRadius: 10,
          maxBarThickness: 28,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          callbacks: {
            label(context) {
              return `Sales: ${formatCurrency(context.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: {
            display: false,
          },
        },
        y: {
          beginAtZero: true,
          ticks: {
            callback(value) {
              return formatCurrency(value);
            },
          },
        },
      },
    },
  });
}

async function loadCustomerSuggestions(query) {
  try {
    const rows = await fetchJSON(`/debts/customers?q=${encodeURIComponent(query)}`);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.error("Customer suggestions failed:", error);
    return [];
  }
}

function renderCustomerDropdown(listEl, customers, onSelect) {
  if (!customers.length) {
    listEl.style.display = "none";
    listEl.innerHTML = "";
    return;
  }

  listEl.innerHTML = customers
    .map((customer) => {
      const customerName = escapeHtml(customer.customer_name);
      const customerNumber = escapeHtml(customer.customer_number);

      return `
        <div
          class="dropdown-item"
          data-name="${encodeURIComponent(customer.customer_name)}"
          data-number="${encodeURIComponent(customer.customer_number)}"
        >
          ${customerName} - ${customerNumber}
        </div>
      `;
    })
    .join("");

  listEl.style.display = "block";

  listEl.querySelectorAll(".dropdown-item").forEach((item) => {
    item.addEventListener("click", () => {
      onSelect({
        name: decodeURIComponent(item.dataset.name),
        number: decodeURIComponent(item.dataset.number),
      });
      listEl.style.display = "none";
    });
  });
}

function renderEmptyLedger(message) {
  dom.ledgerTable.innerHTML = `<div class="empty-ledger">${escapeHtml(message)}</div>`;
  state.ledgerMode = "empty";
  state.currentLedgerNumber = "";
}

function updateDueOverviewFromRows(rows) {
  const totalBalance = rows.reduce((sum, row) => {
    return sum + (Number(row.balance) || 0);
  }, 0);

  dom.statDueBalance.textContent = formatCurrency(totalBalance);
  dom.statDueNote.textContent = rows.length
    ? `${formatCount(rows.length)} customer${rows.length === 1 ? "" : "s"} currently have pending balances.`
    : "No outstanding due balance at the moment.";

  updateHeroSummary({
    itemCount: parseFormattedNumber(dom.statCatalogCount.textContent),
    lowStockCount: parseFormattedNumber(dom.statLowStock.textContent),
    dueCustomerCount: rows.length,
  });
}

function renderLedgerTable(rows, mode = "summary") {
  if (!rows.length) {
    renderEmptyLedger("No records found for this customer selection.");
    return;
  }

  let totalOutstanding = 0;
  let tableHead = "";
  let tableBody = "";
  let summaryLabel = "";

  if (mode === "summary") {
    state.ledgerMode = "summary";
    state.currentLedgerNumber = "";

    tableHead = `
      <thead>
        <tr>
          <th>
            <span class="table-label-full">Name</span>
            <span class="table-label-compact">Name</span>
          </th>
          <th>
            <span class="table-label-full">Number</span>
            <span class="table-label-compact">No.</span>
          </th>
          <th>
            <span class="table-label-full">Total</span>
            <span class="table-label-compact">Total</span>
          </th>
          <th>
            <span class="table-label-full">Credit</span>
            <span class="table-label-compact">Credit</span>
          </th>
          <th>
            <span class="table-label-full">Balance</span>
            <span class="table-label-compact">Bal.</span>
          </th>
        </tr>
      </thead>
    `;

    rows.forEach((row) => {
      const total = Number(row.total) || 0;
      const credit = Number(row.credit) || 0;
      const balance = Number(row.balance) || 0;

      totalOutstanding += balance;
      tableBody += `
        <tr>
          <td>${escapeHtml(row.customer_name)}</td>
          <td>${escapeHtml(row.customer_number)}</td>
          <td>${formatCurrency(total)}</td>
          <td>${formatCurrency(credit)}</td>
          <td>${formatCurrency(balance)}</td>
        </tr>
      `;
    });

    updateDueOverviewFromRows(rows);
    summaryLabel = `${formatCount(rows.length)} customer${rows.length === 1 ? "" : "s"} with outstanding balance`;
  } else {
    const ledgerNumber = rows[0]?.customer_number || "";
    const customerName = rows[0]?.customer_name || "Selected customer";

    state.ledgerMode = "ledger";
    state.currentLedgerNumber = ledgerNumber;

    tableHead = `
      <thead>
        <tr>
          <th>
            <span class="table-label-full">Date</span>
            <span class="table-label-compact">Date</span>
          </th>
          <th>
            <span class="table-label-full">Total</span>
            <span class="table-label-compact">Total</span>
          </th>
          <th>
            <span class="table-label-full">Credit</span>
            <span class="table-label-compact">Credit</span>
          </th>
          <th>
            <span class="table-label-full">Balance</span>
            <span class="table-label-compact">Bal.</span>
          </th>
          <th>
            <span class="table-label-full">Remarks</span>
            <span class="table-label-compact">Note</span>
          </th>
        </tr>
      </thead>
    `;

    rows.forEach((row) => {
      totalOutstanding += (Number(row.total) || 0) - (Number(row.credit) || 0);

      tableBody += `
        <tr>
          <td>${formatDate(row.created_at)}</td>
          <td>${formatCurrency(row.total)}</td>
          <td>${formatCurrency(row.credit)}</td>
          <td>${formatCurrency(totalOutstanding)}</td>
          <td>${escapeHtml(row.remark || "-")}</td>
        </tr>
      `;
    });

    summaryLabel = `${escapeHtml(customerName)} - ${escapeHtml(ledgerNumber)}`;
  }

  dom.ledgerTable.innerHTML = `
    <div class="summary-strip mb-3">
      <span class="summary-pill">
        <i class="fa-solid fa-address-card"></i>
        ${summaryLabel}
      </span>
      <span class="summary-pill">
        <i class="fa-solid fa-hand-holding-dollar"></i>
        Outstanding: ${formatCurrency(totalOutstanding)}
      </span>
    </div>
    <table class="table table-sm text-center align-middle dashboard-table dashboard-table--ledger">
      ${tableHead}
      <tbody>${tableBody}</tbody>
    </table>
  `;
}

async function searchLedger(options = {}) {
  const value = (options.value || dom.cdSearchInput.value).trim();

  if (!value) {
    if (!options.silent) {
      showPopup(
        "error",
        "Missing search input",
        "Enter a customer name or 10-digit number to search ledger entries.",
        { autoClose: false },
      );
    }
    return;
  }

  if (!/^\d{10}$/.test(value)) {
    if (!options.silent) {
      showPopup(
        "error",
        "Select a customer",
        "Choose a customer from the dropdown to open the exact ledger.",
        { autoClose: false },
      );
    }
    return;
  }

  const task = async () => {
    const rows = await fetchJSON(`/debts/${value}`);
    renderLedgerTable(Array.isArray(rows) ? rows : [], "ledger");
  };

  if (options.silent) {
    try {
      await task();
    } catch (error) {
      console.error("Ledger search failed:", error);
      renderEmptyLedger("Could not load the selected customer ledger.");
    }
    return;
  }

  await withButtonState(
    dom.searchLedgerBtn,
    '<i class="fa-solid fa-spinner fa-spin"></i> Searching...',
    async () => {
      try {
        await task();
      } catch (error) {
        console.error("Ledger search failed:", error);
        showPopup(
          "error",
          "Search failed",
          error.message || "Could not load the customer ledger.",
          { autoClose: false },
        );
      }
    },
  );
}

async function showAllDues(options = {}) {
  const task = async () => {
    const rows = await fetchJSON("/debts");
    renderLedgerTable(Array.isArray(rows) ? rows : [], "summary");
  };

  if (options.silent) {
    try {
      await task();
    } catch (error) {
      console.error("All dues load failed:", error);
      renderEmptyLedger("Could not load customer due balances right now.");
    }
    return;
  }

  await withButtonState(
    dom.showAllDuesBtn,
    '<i class="fa-solid fa-spinner fa-spin"></i> Loading...',
    async () => {
      try {
        await task();
      } catch (error) {
        console.error("All dues load failed:", error);
        showPopup(
          "error",
          "Load failed",
          error.message || "Could not load customer due balances.",
          { autoClose: false },
        );
      }
    },
  );
}

function normalizeStaffUsername(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function renderStaffPermissionGrid(container, permissions = [], options = {}) {
  if (!container) {
    return;
  }

  const compact = Boolean(options.compact);
  const inputName = options.inputName || "staffPermissions";
  const idPrefix = options.idPrefix || inputName;
  const selected = new Set(normalizeStaffPermissions(permissions));

  container.innerHTML = STAFF_PERMISSION_OPTIONS.map((option, index) => {
    const inputId = `${idPrefix}-${index}`;
    const isChecked = selected.has(option.value);

    return `
      <label class="staff-permission-chip${isChecked ? " is-selected" : ""}" for="${inputId}">
        <input
          id="${inputId}"
          type="checkbox"
          name="${inputName}"
          value="${option.value}"
          ${isChecked ? "checked" : ""}
        />
        <div>
          <strong>${escapeHtml(option.label)}</strong>
          <span>${escapeHtml(option.description)}</span>
        </div>
      </label>
    `;
  }).join("");

  if (compact) {
    container.classList.add("staff-permission-grid--compact");
  } else {
    container.classList.remove("staff-permission-grid--compact");
  }

  const syncSelectionState = () => {
    container.querySelectorAll(".staff-permission-chip").forEach((chip) => {
      const input = chip.querySelector('input[type="checkbox"]');
      chip.classList.toggle("is-selected", Boolean(input?.checked));
    });
  };

  container
    .querySelectorAll('input[type="checkbox"]')
    .forEach((input) => input.addEventListener("change", syncSelectionState));

  syncSelectionState();
}

function readStaffPermissionSelection(container) {
  if (!container) {
    return [];
  }

  return normalizeStaffPermissions(
    Array.from(
      container.querySelectorAll('input[type="checkbox"]:checked'),
      (input) => input.value,
    ),
  );
}

function setStaffPermissionSelection(container, permissions) {
  if (!container) {
    return;
  }

  const selected = new Set(normalizeStaffPermissions(permissions));
  container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = selected.has(input.value);
    input
      .closest(".staff-permission-chip")
      ?.classList.toggle("is-selected", input.checked);
  });
}

function renderStaffPermissionBadges(permissions) {
  const normalized = normalizeStaffPermissions(permissions);

  if (!normalized.length) {
    return '<span class="staff-access-badge">No page access</span>';
  }

  return normalized
    .map((permission) => {
      const option = getPermissionOption(permission);
      return `<span class="staff-access-badge">${escapeHtml(option?.shortLabel || permission)}</span>`;
    })
    .join("");
}

function resetStaffForm() {
  if (!dom.staffName || !dom.staffUsername || !dom.staffPassword) {
    return;
  }

  dom.staffName.value = "";
  dom.staffUsername.value = "";
  dom.staffPassword.value = "";
  setStaffPermissionSelection(
    dom.staffPermissionGrid,
    DEFAULT_STAFF_PERMISSIONS,
  );
}

function renderStaffList(data = {}) {
  if (!dom.staffList) {
    return;
  }

  const staff = Array.isArray(data.staff) ? data.staff : [];
  const limit = Number(data.limit) || 2;
  const remaining = Math.max(Number(data.remaining) || 0, 0);

  if (dom.staffLimitValue) {
    dom.staffLimitValue.textContent = formatCount(limit);
  }

  if (dom.staffRemainingValue) {
    dom.staffRemainingValue.textContent = formatCount(remaining);
  }

  if (dom.createStaffBtn) {
    dom.createStaffBtn.disabled = remaining <= 0;
  }

  if (dom.selectAllStaffPagesBtn) {
    dom.selectAllStaffPagesBtn.disabled = remaining <= 0;
  }

  if (dom.clearAllStaffPagesBtn) {
    dom.clearAllStaffPagesBtn.disabled = remaining <= 0;
  }

  if (!staff.length) {
    dom.staffList.innerHTML = `
      <div class="empty-ledger">
        No staff accounts yet. Create the first staff login to get started.
      </div>
    `;
    return;
  }

  dom.staffList.innerHTML = `
    <div class="staff-card-list">
      ${staff
        .map((member) => {
          const permissions = normalizeStaffPermissions(
            member.permissions || DEFAULT_STAFF_PERMISSIONS,
          );

          return `
            <article class="staff-card" data-staff-id="${member.id}">
              <div class="staff-card__header">
                <div class="staff-card__meta">
                  <strong>${escapeHtml(member.name || "-")}</strong>
                  <span>@${escapeHtml(member.username || "-")} | Created ${formatDate(member.created_at)}</span>
                </div>
                <span class="summary-pill">
                  <i class="fa-solid fa-shield"></i>
                  ${member.is_active ? "Active" : "Inactive"}
                </span>
              </div>

              <div
                class="staff-access-badges"
                data-staff-badges="${member.id}"
              >
                ${renderStaffPermissionBadges(permissions)}
              </div>

              <div
                class="staff-permission-grid"
                data-permission-editor="${member.id}"
              ></div>

              <p class="staff-helper-text mt-3">
                Admin can revise this staff account access at any time. Staff management always stays admin only.
              </p>

              <div class="staff-card__actions mt-3">
                <button
                  type="button"
                  class="btn btn-info btn-sm staff-save-btn"
                  data-staff-id="${member.id}"
                >
                  <i class="fa-solid fa-floppy-disk"></i>
                  Save Access
                </button>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm staff-delete-btn"
                  data-staff-id="${member.id}"
                >
                  <i class="fa-solid fa-trash"></i>
                  Remove
                </button>
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;

  staff.forEach((member) => {
    const permissions = normalizeStaffPermissions(
      member.permissions || DEFAULT_STAFF_PERMISSIONS,
    );
    const editor = dom.staffList.querySelector(
      `[data-permission-editor="${member.id}"]`,
    );
    const badgeContainer = dom.staffList.querySelector(
      `[data-staff-badges="${member.id}"]`,
    );

    renderStaffPermissionGrid(editor, permissions, {
      compact: true,
      inputName: `staffPermission-${member.id}`,
      idPrefix: `staffPermission-${member.id}`,
    });

    editor?.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (badgeContainer) {
          badgeContainer.innerHTML = renderStaffPermissionBadges(
            readStaffPermissionSelection(editor),
          );
        }
      });
    });
  });

  dom.staffList.querySelectorAll(".staff-save-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const staffId = button.dataset.staffId;
      const editor = dom.staffList.querySelector(
        `[data-permission-editor="${staffId}"]`,
      );
      const permissions = readStaffPermissionSelection(editor);

      if (!permissions.length) {
        showPopup(
          "error",
          "Select page access",
          "Choose at least one page before saving staff access.",
          { autoClose: false },
        );
        return;
      }

      await withButtonState(
        button,
        '<i class="fa-solid fa-spinner fa-spin"></i> Saving...',
        async () => {
          try {
            await fetchJSON(`/auth/staff/${staffId}/permissions`, {
              method: "PATCH",
              body: JSON.stringify({ permissions }),
            });
            await loadStaffAccounts({ silent: true });
            showPopup(
              "success",
              "Access updated",
              "Staff page access has been updated successfully.",
            );
          } catch (error) {
            showPopup(
              "error",
              "Update failed",
              error.message || "Could not update staff page access.",
              { autoClose: false },
            );
          }
        },
      );
    });
  });

  dom.staffList.querySelectorAll(".staff-delete-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const staffId = button.dataset.staffId;
      await withButtonState(
        button,
        '<i class="fa-solid fa-spinner fa-spin"></i>',
        async () => {
          try {
            await fetchJSON(`/auth/staff/${staffId}`, { method: "DELETE" });
            await loadStaffAccounts({ silent: true });
            showPopup(
              "success",
              "Staff removed",
              "The staff account has been removed successfully.",
            );
          } catch (error) {
            showPopup(
              "error",
              "Delete failed",
              error.message || "Could not remove the staff account.",
              { autoClose: false },
            );
          }
        },
      );
    });
  });
}

async function loadStaffAccounts(options = {}) {
  if (!isAdminSession() || !dom.staffList) {
    return;
  }

  try {
    const data = await fetchJSON("/auth/staff");
    renderStaffList(data);
  } catch (error) {
    console.error("Staff list load failed:", error);
    if (!options.silent) {
      showPopup(
        "error",
        "Load failed",
        error.message || "Could not load staff accounts.",
        { autoClose: false },
      );
    }
  }
}

async function createStaffAccount() {
  const name = String(dom.staffName?.value || "").replace(/\s+/g, " ").trim();
  const username = normalizeStaffUsername(dom.staffUsername?.value);
  const password = String(dom.staffPassword?.value || "");
  const permissions = readStaffPermissionSelection(dom.staffPermissionGrid);

  dom.staffUsername.value = username;

  if (!name || !username || !password) {
    showPopup(
      "error",
      "Missing details",
      "Enter staff name, username, and password before creating the account.",
      { autoClose: false },
    );
    return;
  }

  if (!permissions.length) {
    showPopup(
      "error",
      "Select page access",
      "Choose at least one page permission before creating the staff account.",
      { autoClose: false },
    );
    return;
  }

  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(username)) {
    showPopup(
      "error",
      "Invalid username",
      "Username must be 3-30 characters and can use letters, numbers, dot, underscore, or hyphen.",
      { autoClose: false },
    );
    return;
  }

  if (password.length < 6) {
    showPopup(
      "error",
      "Weak password",
      "Staff password must be at least 6 characters long.",
      { autoClose: false },
    );
    return;
  }

  await withButtonState(
    dom.createStaffBtn,
    '<i class="fa-solid fa-spinner fa-spin"></i> Creating...',
    async () => {
      try {
        await fetchJSON("/auth/staff", {
          method: "POST",
          body: JSON.stringify({ name, username, password, permissions }),
        });
        resetStaffForm();
        await loadStaffAccounts({ silent: true });
        showPopup(
          "success",
          "Staff account created",
          "New staff login is ready to use.",
        );
      } catch (error) {
        showPopup(
          "error",
          "Create failed",
          error.message || "Could not create the staff account.",
          { autoClose: false },
        );
      }
    },
  );
}

function restrictToDigits(input) {
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 10);
  });
}

function setDefaultSalesDates() {
  const today = new Date();
  const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);

  dom.fromDate.value = toInputDate(firstDay);
  dom.toDate.value = toInputDate(today);
  dom.gstFromDate.value = toInputDate(firstDay);
  dom.gstToDate.value = toInputDate(today);
}

function bindSidebarEvents() {
  dom.sidebarToggle.addEventListener("click", () => {
    const isOpen = dom.sidebar.classList.contains("sidebar--open");
    if (isOpen) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  dom.sidebarOverlay.addEventListener("click", closeSidebar);

  dom.sectionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setActiveSection(button.dataset.section);
    });
  });

  dom.invoiceBtn.addEventListener("click", () => {
    window.location.href = "invoice.html";
  });

  dom.logoutBtn.addEventListener("click", logoutAndRedirect);

  window.addEventListener("resize", () => {
    if (!isMobileLayout()) {
      closeSidebar();
    }
  });
}

function bindPopupEvents() {
  dom.popupOverlay.addEventListener("click", hidePopup);
  dom.popupClose.addEventListener("click", hidePopup);
  dom.popupBox.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hidePopup();
      closeSidebar();
    }
  });
}

function bindInventoryEvents() {
  dom.profitPercent.addEventListener("input", () => {
    updateSellingRate();
    localStorage.setItem("defaultProfitPercent", dom.profitPercent.value);
  });

  dom.buyingRate.addEventListener("input", updateSellingRate);
  dom.sellingRate.addEventListener("input", updateProfitPercent);

  dom.newItemSearch.addEventListener("input", () => {
    if (!dom.newItemSearch.value.trim()) {
      hidePreviousBuyingRate();
      return;
    }

    if (!state.itemNames.includes(dom.newItemSearch.value.trim())) {
      hidePreviousBuyingRate();
    }
  });

  dom.newItemSearch.addEventListener("blur", () => {
    const itemName = dom.newItemSearch.value.trim();
    if (state.itemNames.includes(itemName)) {
      showPreviousBuyingRate(itemName);
    }
  });

  [
    dom.newItemSearch,
    dom.newQuantity,
    dom.profitPercent,
    dom.buyingRate,
    dom.sellingRate,
  ].forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addStock();
      }
    });
  });

  dom.addStockBtn.addEventListener("click", addStock);

  setupFilterInput(dom.newItemSearch, dom.newItemDropdownList, (value) => {
    dom.newItemSearch.value = value;
    showPreviousBuyingRate(value);
  });
}

function bindReportEvents() {
  setupFilterInput(dom.itemReportSearch, dom.itemReportDropdown, (value) => {
    dom.itemReportSearch.value = value;
  });

  dom.itemReportSearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadItemReport();
    }
  });

  dom.loadItemReportBtn.addEventListener("click", () => loadItemReport());
  dom.itemReportPdfBtn.addEventListener("click", downloadItemReportPDF);

  dom.fromDate.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadSalesReport();
    }
  });

  dom.toDate.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadSalesReport();
    }
  });

  dom.loadSalesBtn.addEventListener("click", () => loadSalesReport());
  dom.pdfBtn.addEventListener("click", downloadSalesPDF);
  dom.excelBtn.addEventListener("click", downloadSalesExcel);

  dom.gstFromDate.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadGstReport();
    }
  });

  dom.gstToDate.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadGstReport();
    }
  });

  dom.loadGstBtn.addEventListener("click", () => loadGstReport());
  dom.gstPdfBtn.addEventListener("click", downloadGstPDF);
  dom.gstExcelBtn.addEventListener("click", downloadGstExcel);
}

function bindCustomerDueEvents() {
  restrictToDigits(dom.cdNumber);

  dom.cdNumber.addEventListener("input", async () => {
    const query = dom.cdNumber.value.trim();
    setCustomerNameLocked(false);

    if (!query) {
      dom.cdNumberDropdown.style.display = "none";
      return;
    }

    const customers = await loadCustomerSuggestions(query);
    renderCustomerDropdown(dom.cdNumberDropdown, customers, ({ name, number }) => {
      dom.cdName.value = name;
      dom.cdNumber.value = number;
      setCustomerNameLocked(true);
    });
  });

  document.addEventListener("click", (event) => {
    if (
      !dom.cdNumber.contains(event.target) &&
      !dom.cdNumberDropdown.contains(event.target)
    ) {
      dom.cdNumberDropdown.style.display = "none";
    }
  });

  dom.submitDebtBtn.addEventListener("click", submitDebt);

  dom.cdSearchInput.addEventListener("input", async () => {
    const query = dom.cdSearchInput.value.trim();

    if (!query) {
      dom.cdSearchDropdown.style.display = "none";
      return;
    }

    const customers = await loadCustomerSuggestions(query);
    renderCustomerDropdown(dom.cdSearchDropdown, customers, ({ number }) => {
      dom.cdSearchInput.value = number;
      searchLedger({ value: number });
    });
  });

  dom.cdSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchLedger();
    }
  });

  document.addEventListener("click", (event) => {
    if (
      !dom.cdSearchInput.contains(event.target) &&
      !dom.cdSearchDropdown.contains(event.target)
    ) {
      dom.cdSearchDropdown.style.display = "none";
    }
  });

  dom.searchLedgerBtn.addEventListener("click", () => searchLedger());
  dom.showAllDuesBtn.addEventListener("click", () => showAllDues());
}

function bindStaffEvents() {
  if (!dom.createStaffBtn) {
    return;
  }

  renderStaffPermissionGrid(
    dom.staffPermissionGrid,
    DEFAULT_STAFF_PERMISSIONS,
    {
      inputName: "staffCreatePermission",
      idPrefix: "staffCreatePermission",
    },
  );

  [dom.staffName, dom.staffUsername, dom.staffPassword].forEach((input) => {
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        createStaffAccount();
      }
    });
  });

  dom.staffUsername?.addEventListener("blur", () => {
    dom.staffUsername.value = normalizeStaffUsername(dom.staffUsername.value);
  });

  dom.selectAllStaffPagesBtn?.addEventListener("click", () => {
    setStaffPermissionSelection(dom.staffPermissionGrid, STAFF_PERMISSION_KEYS);
  });

  dom.clearAllStaffPagesBtn?.addEventListener("click", () => {
    setStaffPermissionSelection(dom.staffPermissionGrid, []);
  });

  dom.createStaffBtn.addEventListener("click", createStaffAccount);
}

window.addEventListener("DOMContentLoaded", async () => {
  window.InventoryAppShell?.renderSidebar("dashboard");
  cacheElements();
  bindSidebarEvents();
  bindPopupEvents();
  bindInventoryEvents();
  bindReportEvents();
  bindCustomerDueEvents();
  bindStaffEvents();
  updateCurrentDateLabel();
  hidePreviousBuyingRate();
  renderEmptyLedger(
    "Search a customer or load all due balances to view the ledger.",
  );
  setDefaultSalesDates();

  const savedPercent = Number(localStorage.getItem("defaultProfitPercent"));
  if (Number.isFinite(savedPercent) && savedPercent > 0) {
    dom.profitPercent.value = savedPercent.toFixed(2);
  }
  updateProfitPreview();

  const user = await checkAuth();
  if (!user) {
    return;
  }

  applySessionAccess(user);

  const savedSection = localStorage.getItem("activeSection");
  const visibleButtons = dom.sectionButtons.filter((button) => !button.hidden);
  const validSection = visibleButtons.some(
    (button) => button.dataset.section === savedSection,
  )
    ? savedSection
    : visibleButtons[0]?.dataset.section;

  if (validSection) {
    setActiveSection(validSection);
  } else if (canAccessInvoicePage()) {
    window.location.replace("invoice.html");
    return;
  } else {
    showPopup(
      "error",
      "No workspace access",
      "This staff account does not have any dashboard page assigned yet.",
      { autoClose: false },
    );
    return;
  }

  if (canAccessPermission("add_stock", "sale_invoice", "stock_report")) {
    await loadItemNames({ silent: true });
  }

  if (isAdminSession()) {
    initYearFilter();
    await Promise.allSettled([
      loadDashboardOverview({ silent: true }),
      loadBusinessTrend("all", { silent: true }),
      loadLast13MonthsChart({ silent: true }),
      loadStaffAccounts({ silent: true }),
    ]);

    if (validSection === "itemReportSection") {
      await loadLowStock({ silent: true });
    }
  }
});

window.setTimeout(() => {
  if (document.body.style.visibility === "hidden") {
    document.body.style.visibility = "visible";
  }
}, 5000);
