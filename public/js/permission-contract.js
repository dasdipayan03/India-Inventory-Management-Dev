(function initInventoryPermissionContract(root, factory) {
  // পড়ার নিয়ম: প্রতিটি বাংলা comment তার ঠিক উপরের সম্পূর্ণ code line বা code block-এর কাজ বোঝায়।
  if (typeof module === "object" && module.exports) {
    // Node.js environment হলে CommonJS module হিসেবে contract export করে।
    module.exports = factory();
  } else {
    // Browser হলে একই contract window/globalThis-এ সবার ব্যবহারের জন্য রাখে।
    root.InventoryPermissionContract = factory();
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function createPermissionContract() {
    // Backend ও frontend উভয়ের জন্য একই permission configuration তৈরি করে।
    const STAFF_PAGE_CONFIG = {
      purchase_entry: {
        label: "Purchase Entry / Add Stock",
        shortLabel: "Purchases",
        sectionId: "purchaseEntrySection",
      },
      sale_invoice: {
        label: "Sale Entry / Invoice",
        shortLabel: "Invoice",
        sectionId: "invoicePage",
      },
      stock_report: {
        label: "Stock View / Report",
        shortLabel: "Stock Report",
        sectionId: "itemReportSection",
      },
      sales_report: {
        label: "Sales View / Report",
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
      expense_tracking: {
        label: "Expenses",
        shortLabel: "Expenses",
        sectionId: "expenseTrackingSection",
      },
    };
    // প্রতিটি staff page-এর display label, short label ও target section ID।

    const STAFF_PAGE_PERMISSIONS = Object.keys(STAFF_PAGE_CONFIG);
    // Configuration থেকে বৈধ permission key-গুলোর master list তৈরি করে।
    const DEFAULT_STAFF_PERMISSIONS = ["purchase_entry", "sale_invoice"];
    // নতুন staff defaultভাবে purchase ও sale invoice page ব্যবহার করতে পারে।
    const LEGACY_PERMISSION_ALIASES = {
      purchase: "purchase_entry",
      purchases: "purchase_entry",
      purchase_report: "purchase_entry",
      purchase_reports: "purchase_entry",
      purchaseEntrySection: "purchase_entry",
      invoice: "sale_invoice",
      invoices: "sale_invoice",
      sale: "sale_invoice",
      sales_invoice: "sale_invoice",
      saleInvoiceSection: "sale_invoice",
      item_report: "stock_report",
      item_reports: "stock_report",
      stock_reports: "stock_report",
      itemReportSection: "stock_report",
      sales: "sales_report",
      sale_report: "sales_report",
      sales_reports: "sales_report",
      salesReportSection: "sales_report",
      gst: "gst_report",
      gst_reports: "gst_report",
      gstReportSection: "gst_report",
      customer_dues: "customer_due",
      due: "customer_due",
      dues: "customer_due",
      customerDebtSection: "customer_due",
      expense: "expense_tracking",
      expenses: "expense_tracking",
      expense_report: "expense_tracking",
      expense_reports: "expense_tracking",
      expenseTrackingSection: "expense_tracking",
    };
    // পুরোনো permission name অথবা section name-কে নতুন standard permission-এ map করে।
    const PERMISSION_ALIASES = Object.fromEntries([
      ...Object.entries(LEGACY_PERMISSION_ALIASES),
      ...Object.entries(STAFF_PAGE_CONFIG).flatMap(([permission, config]) => [
        [permission, permission],
        [config.sectionId, permission],
        [config.label, permission],
        [config.shortLabel, permission],
      ]),
    ]);
    // Legacy alias ও current label/section alias মিলিয়ে সম্পূর্ণ lookup map তৈরি করে।

    function normalizePermissionToken(value) {
      // আলাদা casing, space, punctuation বা camelCase-সহ input-কে তুলনাযোগ্য token বানায়।
      return String(value || "")
        .trim()
        .replace(/^[\s"'[\]{}]+|[\s"'[\]{}]+$/g, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/[^a-zA-Z0-9 ]+/g, " ")
        .replace(/\s+/g, " ")
        .toLowerCase();
    }

    const NORMALIZED_PERMISSION_ALIASES = Object.fromEntries(
      Object.entries(PERMISSION_ALIASES).map(([alias, permission]) => [
        normalizePermissionToken(alias),
        permission,
      ]),
    );
    // সব alias আগেই normalized করে দ্রুত permission lookup-এর প্রস্তুতি নেয়।

    function normalizePermissions(values) {
      // Input permission value/list থেকে শুধু valid এবং duplicate-মুক্ত permission array ফেরত দেয়।
      const source = Array.isArray(values) ? values : [values];
      // Single value এলেও একই processing-এর জন্য array-তে আনে।
      const list = source
        .flatMap((value) => String(value || "").split(","))
        .map((value) => value.trim())
        .filter(Boolean);
      const normalized = list
        .map(
          (value) =>
            NORMALIZED_PERMISSION_ALIASES[normalizePermissionToken(value)],
        )
        .filter((value) => STAFF_PAGE_PERMISSIONS.includes(value));

      return [...new Set(normalized)];
      // একই permission বারবার থাকলে Set ব্যবহার করে একবারই রাখে।
    }

    return {
      DEFAULT_STAFF_PERMISSIONS,
      STAFF_PAGE_CONFIG,
      STAFF_PAGE_PERMISSIONS,
      normalizePermissions,
    };
    // অন্য file-এর প্রয়োজনীয় permission constants ও normalizer প্রকাশ করে।
  },
);
