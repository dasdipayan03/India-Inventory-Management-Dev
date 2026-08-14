(function bootstrapInventoryApp(global) {
  const permissionContract = global.InventoryPermissionContract || {};
  const apiBase = global.location.origin.includes("localhost")
    ? "http://localhost:4000/api"
    : "/api";

  const copyrightText =
    "© 2026 Shop Inventory Management - All rights reserved.";
  const staffPageConfig = permissionContract.STAFF_PAGE_CONFIG || {};
  const staffPermissionKeys = permissionContract.STAFF_PAGE_PERMISSIONS || [];
  const defaultStaffPermissions =
    permissionContract.DEFAULT_STAFF_PERMISSIONS || [
      "purchase_entry",
      "sale_invoice",
    ];
  const invoicePagePermission = "sale_invoice";
  const mobileLayoutMediaQuery =
    typeof global.matchMedia === "function"
      ? global.matchMedia("(max-width: 991px)")
      : null;

  const permissionDescriptions = {
    purchase_entry:
      "Record supplier purchases, increase stock from bills, and review supplier ledger balances.",
    sale_invoice:
      "Create sales bills, generate invoices, and open invoice history.",
    stock_report:
      "Review stock availability, sold quantity, and low stock report.",
    sales_report:
      "Open sales analytics, export reports, and check date-wise totals.",
    gst_report: "See GST report data for filing and invoice-wise tax review.",
    customer_due:
      "Manage due balances, ledger history, and customer collections.",
    expense_tracking:
      "Track business expenses and compare real net profit against gross profit.",
  };

  const staffPermissionOptions = staffPermissionKeys.map((permission) => ({
    value: permission,
    label: staffPageConfig[permission]?.label || permission,
    shortLabel: staffPageConfig[permission]?.shortLabel || permission,
    sectionId: staffPageConfig[permission]?.sectionId || "",
    description: permissionDescriptions[permission] || "",
  }));

  const sectionPermissionMap = Object.fromEntries(
    Object.entries(staffPageConfig)
      .filter(
        ([, config]) => config.sectionId && config.sectionId !== "invoicePage",
      )
      .map(([permission, config]) => [config.sectionId, permission]),
  );

  const sidebarItems = [
    {
      kind: "section",
      sectionId: "purchaseEntrySection",
      permission: "purchase_entry",
      iconClass: "fa-solid fa-truck-ramp-box",
      label:
        staffPageConfig.purchase_entry?.label || "Purchase Entry / Add Stock",
    },
    {
      kind: "invoice",
      route: "invoice.html",
      permission: invoicePagePermission,
      iconClass: "fa-solid fa-file-invoice",
      label: staffPageConfig.sale_invoice?.label || "Sale Entry / Invoice",
    },
    {
      kind: "section",
      sectionId: "itemReportSection",
      permission: "stock_report",
      iconClass: "fas fa-boxes",
      label: staffPageConfig.stock_report?.label || "Stock View / Report",
    },
    {
      kind: "section",
      sectionId: "salesReportSection",
      permission: "sales_report",
      iconClass: "fas fa-chart-line",
      label: staffPageConfig.sales_report?.label || "Sales View / Report",
    },
    {
      kind: "section",
      sectionId: "gstReportSection",
      permission: "gst_report",
      iconClass: "fas fa-receipt",
      label: staffPageConfig.gst_report?.label || "GST Report",
    },
    {
      kind: "section",
      sectionId: "customerDebtSection",
      permission: "customer_due",
      iconClass: "fas fa-user-clock",
      label: staffPageConfig.customer_due?.label || "Customer Due",
    },
    {
      kind: "section",
      sectionId: "expenseTrackingSection",
      permission: "expense_tracking",
      iconClass: "fa-solid fa-wallet",
      label: staffPageConfig.expense_tracking?.label || "Expenses",
    },
    {
      kind: "section",
      sectionId: "staffAccessSection",
      ownerOnly: true,
      iconClass: "fa-solid fa-users-gear",
      label: "Staff Access",
    },
    {
      kind: "section",
      sectionId: "supportChatSection",
      availableToAll: true,
      iconClass: "fa-solid fa-headset",
      label: "Chat Support",
    },
    {
      kind: "section",
      sectionId: "accountSection",
      availableToAll: true,
      iconClass: "fa-solid fa-user-gear",
      label: "Account",
    },
  ];

  function preventFocusedNumberWheelChange() {
    if (!global.document?.addEventListener) {
      return;
    }

    global.document.addEventListener(
      "wheel",
      (event) => {
        const activeElement = global.document.activeElement;
        if (
          activeElement instanceof HTMLInputElement &&
          activeElement.type === "number" &&
          event.target instanceof Element &&
          activeElement.contains(event.target)
        ) {
          activeElement.blur();
        }
      },
      { capture: true, passive: true },
    );
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizePermissions(values) {
    if (typeof permissionContract.normalizePermissions === "function") {
      return permissionContract.normalizePermissions(values);
    }

    const list = Array.isArray(values) ? values : [];
    const normalized = list
      .map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      )
      .filter((value) => staffPermissionKeys.includes(value));

    return [...new Set(normalized)];
  }

  function getPermissionOption(permission) {
    return (
      staffPermissionOptions.find((option) => option.value === permission) ||
      null
    );
  }

  function formatPermissionSummary(permissions, options = {}) {
    const short = Boolean(options.short);
    const normalized = normalizePermissions(permissions);

    if (!normalized.length) {
      return short ? "no assigned pages" : "No assigned pages";
    }

    if (normalized.length === staffPermissionKeys.length) {
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

  function clearStoredSession() {
    global.localStorage.removeItem("token");
    global.localStorage.removeItem("user");
  }

  function isMobileLayout() {
    return Boolean(mobileLayoutMediaQuery?.matches);
  }

  function normalizeSessionRole(value) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();

    if (normalized === "staff") {
      return "staff";
    }

    if (normalized === "owner" || normalized === "admin") {
      return "owner";
    }

    return "";
  }

  function hasKnownSession(user) {
    return Boolean(user && normalizeSessionRole(user.role));
  }

  function isOwnerUser(user) {
    if (!hasKnownSession(user)) {
      return false;
    }

    return normalizeSessionRole(user?.role) === "owner";
  }

  function getUserPermissions(user) {
    if (isOwnerUser(user)) {
      return new Set(["all"]);
    }

    return new Set(normalizePermissions(user?.permissions));
  }

  function canAccessPermission(user, ...permissions) {
    if (!hasKnownSession(user)) {
      return false;
    }

    if (isOwnerUser(user)) {
      return true;
    }

    if (!permissions.length) {
      return false;
    }

    const granted = getUserPermissions(user);
    return permissions.some((permission) => granted.has(permission));
  }

  function canAccessSection(user, sectionId) {
    if (!hasKnownSession(user)) {
      return false;
    }

    if (sectionId === "staffAccessSection") {
      return isOwnerUser(user);
    }

    const item = sidebarItems.find((entry) => entry.sectionId === sectionId);
    if (item?.availableToAll) {
      return true;
    }

    const permission = sectionPermissionMap[sectionId];
    return permission
      ? canAccessPermission(user, permission)
      : isOwnerUser(user);
  }

  global.InventoryApp = Object.freeze({
    apiBase,
    canAccessPermission,
    canAccessSection,
    clearStoredSession,
    copyrightText,
    defaultStaffPermissions,
    escapeHtml,
    formatPermissionSummary,
    getPermissionOption,
    getUserPermissions,
    invoicePagePermission,
    isOwnerUser,
    isMobileLayout,
    normalizePermissions,
    sectionPermissionMap,
    sidebarItems,
    staffPageConfig,
    staffPermissionKeys,
    staffPermissionOptions,
  });

  preventFocusedNumberWheelChange();
})(window);
