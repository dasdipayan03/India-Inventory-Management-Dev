(function bootstrapInventoryApp(global) {
  const permissionContract = global.InventoryPermissionContract || {};
  const apiBase = global.location.origin.includes("localhost")
    ? "http://localhost:4000/api"
    : "/api";

  const copyrightText = "© 2026 India Inventory Management - All rights reserved.";
  const staffPageConfig = permissionContract.STAFF_PAGE_CONFIG || {};
  const staffPermissionKeys = permissionContract.STAFF_PAGE_PERMISSIONS || [];
  const defaultStaffPermissions = permissionContract.DEFAULT_STAFF_PERMISSIONS || [
    "add_stock",
    "sale_invoice",
  ];
  const invoicePagePermission = "sale_invoice";

  const permissionDescriptions = {
    add_stock: "Create or update stock entries from the main inventory form.",
    sale_invoice:
      "Create sales bills, generate invoices, and open invoice history.",
    stock_report: "Review stock availability, sold quantity, and low stock report.",
    sales_report:
      "Open sales analytics, export reports, and check date-wise totals.",
    gst_report: "See GST report data for filing and invoice-wise tax review.",
    customer_due:
      "Manage due balances, ledger history, and customer collections.",
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
      .filter(([, config]) => config.sectionId && config.sectionId !== "invoicePage")
      .map(([permission, config]) => [config.sectionId, permission]),
  );

  const sidebarItems = [
    {
      kind: "section",
      sectionId: "addStockSection",
      permission: "add_stock",
      iconClass: "fas fa-plus-circle",
      label: staffPageConfig.add_stock?.label || "Add New Stock",
      eyebrow: "Inventory Intake",
      title: staffPageConfig.add_stock?.label || "Add New Stock",
      description:
        "Keep quantity, buying rate, and selling rate aligned when fresh stock arrives.",
      badge: "Stock",
    },
    {
      kind: "invoice",
      route: "invoice.html",
      permission: invoicePagePermission,
      iconClass: "fa-solid fa-file-invoice",
      label: staffPageConfig.sale_invoice?.label || "Sale and Invoice",
      eyebrow: "Billing Workspace",
      title: staffPageConfig.sale_invoice?.label || "Sale and Invoice",
      description:
        "Create sale entries, generate polished invoices, and review recent billing activity.",
      badge: "Invoice",
    },
    {
      kind: "section",
      sectionId: "itemReportSection",
      permission: "stock_report",
      iconClass: "fas fa-boxes",
      label: staffPageConfig.stock_report?.label || "Stock Report",
      eyebrow: "Inventory Insights",
      title: staffPageConfig.stock_report?.label || "Stock Report",
      description:
        "Search any item, review availability, and spot low stock before it becomes urgent.",
      badge: "Reports",
    },
    {
      kind: "section",
      sectionId: "salesReportSection",
      permission: "sales_report",
      iconClass: "fas fa-chart-line",
      label: staffPageConfig.sales_report?.label || "Sales Report",
      eyebrow: "Revenue Tracking",
      title: staffPageConfig.sales_report?.label || "Sales Report",
      description:
        "Explore date-wise sales, export PDF or Excel files, and monitor trend charts month after month.",
      badge: "Sales",
    },
    {
      kind: "section",
      sectionId: "gstReportSection",
      permission: "gst_report",
      iconClass: "fas fa-receipt",
      label: staffPageConfig.gst_report?.label || "GST Report",
      eyebrow: "Tax Compliance",
      title: staffPageConfig.gst_report?.label || "GST Report",
      description:
        "Review invoice-wise GST for any date range, then export polished reports for filing and bookkeeping.",
      badge: "GST",
    },
    {
      kind: "section",
      sectionId: "customerDebtSection",
      permission: "customer_due",
      iconClass: "fas fa-user-clock",
      label: staffPageConfig.customer_due?.label || "Customer Due",
      eyebrow: "Collections",
      title: staffPageConfig.customer_due?.label || "Customer Due",
      description:
        "Capture customer balances, search dues quickly, and keep ledger follow-up organized.",
      badge: "Ledger",
    },
    {
      kind: "section",
      sectionId: "staffAccessSection",
      adminOnly: true,
      iconClass: "fa-solid fa-users-gear",
      label: "Staff Access",
      eyebrow: "Access Control",
      title: "Staff Access",
      description:
        "Create up to two staff accounts, keep credentials organized, and control who can work inside the shop workspace.",
      badge: "Team",
    },
  ];

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
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => staffPermissionKeys.includes(value));

    return [...new Set(normalized)];
  }

  function getPermissionOption(permission) {
    return (
      staffPermissionOptions.find((option) => option.value === permission) || null
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
    return global.matchMedia("(max-width: 991px)").matches;
  }

  function isAdminUser(user) {
    return String(user?.role || "").toLowerCase() !== "staff";
  }

  function getUserPermissions(user) {
    if (isAdminUser(user)) {
      return new Set(["all"]);
    }

    return new Set(normalizePermissions(user?.permissions));
  }

  function canAccessPermission(user, ...permissions) {
    if (isAdminUser(user)) {
      return true;
    }

    const granted = getUserPermissions(user);
    return permissions.some((permission) => granted.has(permission));
  }

  function canAccessSection(user, sectionId) {
    if (sectionId === "staffAccessSection") {
      return isAdminUser(user);
    }

    const permission = sectionPermissionMap[sectionId];
    return permission ? canAccessPermission(user, permission) : isAdminUser(user);
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
    isAdminUser,
    isMobileLayout,
    normalizePermissions,
    sectionPermissionMap,
    sidebarItems,
    staffPageConfig,
    staffPermissionKeys,
    staffPermissionOptions,
  });
})(window);
