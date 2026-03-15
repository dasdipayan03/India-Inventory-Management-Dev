(function initInventoryPermissionContract(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.InventoryPermissionContract = factory();
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function createPermissionContract() {
    const STAFF_PAGE_CONFIG = {
      add_stock: {
        label: "Add New Stock",
        shortLabel: "Stock Entry",
        sectionId: "addStockSection",
      },
      sale_invoice: {
        label: "Sale and Invoice",
        shortLabel: "Invoice",
        sectionId: "invoicePage",
      },
      stock_report: {
        label: "Stock Report",
        shortLabel: "Stock Report",
        sectionId: "itemReportSection",
      },
      sales_report: {
        label: "Sales Report",
        shortLabel: "Sales Report",
        sectionId: "salesReportSection",
      },
      gst_report: {
        label: "GST Report",
        shortLabel: "GST Report",
        sectionId: "gstReportSection",
      },
      customer_due: {
        label: "Customer Due",
        shortLabel: "Customer Due",
        sectionId: "customerDebtSection",
      },
    };

    const STAFF_PAGE_PERMISSIONS = Object.keys(STAFF_PAGE_CONFIG);
    const DEFAULT_STAFF_PERMISSIONS = ["add_stock", "sale_invoice"];

    function normalizePermissions(values) {
      const list = Array.isArray(values) ? values : [];
      const normalized = list
        .map((value) => String(value || "").trim().toLowerCase())
        .filter((value) => STAFF_PAGE_PERMISSIONS.includes(value));

      return [...new Set(normalized)];
    }

    return {
      DEFAULT_STAFF_PERMISSIONS,
      STAFF_PAGE_CONFIG,
      STAFF_PAGE_PERMISSIONS,
      normalizePermissions,
    };
  },
);
