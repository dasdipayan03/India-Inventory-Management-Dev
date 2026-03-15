(function bootstrapInventoryApp(global) {
  const apiBase = global.location.origin.includes("localhost")
    ? "http://localhost:4000/api"
    : "/api";

  const copyrightText = "© 2026 India Inventory Management - All rights reserved.";

  const staffPermissionOptions = [
    {
      value: "add_stock",
      label: "Add New Stock",
      shortLabel: "Stock Entry",
      description: "Create or update stock entries from the main inventory form.",
    },
    {
      value: "sale_invoice",
      label: "Sale and Invoice",
      shortLabel: "Invoice",
      description:
        "Create sales bills, generate invoices, and open invoice history.",
    },
    {
      value: "stock_report",
      label: "Stock Report",
      shortLabel: "Stock Report",
      description:
        "Review stock availability, sold quantity, and low stock report.",
    },
    {
      value: "sales_report",
      label: "Sales Report",
      shortLabel: "Sales Report",
      description:
        "Open sales analytics, export reports, and check date-wise totals.",
    },
    {
      value: "gst_report",
      label: "GST Report",
      shortLabel: "GST Report",
      description: "See GST report data for filing and invoice-wise tax review.",
    },
    {
      value: "customer_due",
      label: "Customer Due",
      shortLabel: "Customer Due",
      description:
        "Manage due balances, ledger history, and customer collections.",
    },
  ];

  const staffPermissionKeys = staffPermissionOptions.map((option) => option.value);
  const defaultStaffPermissions = ["add_stock", "sale_invoice"];
  const invoicePagePermission = "sale_invoice";

  const sectionPermissionMap = {
    addStockSection: "add_stock",
    itemReportSection: "stock_report",
    salesReportSection: "sales_report",
    gstReportSection: "gst_report",
    customerDebtSection: "customer_due",
  };

  const sidebarItems = [
    {
      kind: "section",
      sectionId: "addStockSection",
      permission: "add_stock",
      iconClass: "fas fa-plus-circle",
      label: "Add New Stock",
      eyebrow: "Inventory Intake",
      title: "Add New Stock",
      description:
        "Keep quantity, buying rate, and selling rate aligned when fresh stock arrives.",
      badge: "Stock",
    },
    {
      kind: "invoice",
      route: "invoice.html",
      permission: invoicePagePermission,
      iconClass: "fa-solid fa-file-invoice",
      label: "Sale and Invoice",
      eyebrow: "Billing Workspace",
      title: "Sale and Invoice",
      description:
        "Create sale entries, generate polished invoices, and review recent billing activity.",
      badge: "Invoice",
    },
    {
      kind: "section",
      sectionId: "itemReportSection",
      permission: "stock_report",
      iconClass: "fas fa-boxes",
      label: "Stock Report",
      eyebrow: "Inventory Insights",
      title: "Stock Report",
      description:
        "Search any item, review availability, and spot low stock before it becomes urgent.",
      badge: "Reports",
    },
    {
      kind: "section",
      sectionId: "salesReportSection",
      permission: "sales_report",
      iconClass: "fas fa-chart-line",
      label: "Sales Report",
      eyebrow: "Revenue Tracking",
      title: "Sales Report",
      description:
        "Explore date-wise sales, export PDF or Excel files, and monitor trend charts month after month.",
      badge: "Sales",
    },
    {
      kind: "section",
      sectionId: "gstReportSection",
      permission: "gst_report",
      iconClass: "fas fa-receipt",
      label: "GST Report",
      eyebrow: "Tax Compliance",
      title: "GST Report",
      description:
        "Review invoice-wise GST for any date range, then export polished reports for filing and bookkeeping.",
      badge: "GST",
    },
    {
      kind: "section",
      sectionId: "customerDebtSection",
      permission: "customer_due",
      iconClass: "fas fa-user-clock",
      label: "Customer Due",
      eyebrow: "Collections",
      title: "Customer Due",
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

  global.InventoryApp = Object.freeze({
    apiBase,
    copyrightText,
    defaultStaffPermissions,
    escapeHtml,
    formatPermissionSummary,
    getPermissionOption,
    invoicePagePermission,
    normalizePermissions,
    sectionPermissionMap,
    sidebarItems,
    staffPermissionKeys,
    staffPermissionOptions,
  });
})(window);
