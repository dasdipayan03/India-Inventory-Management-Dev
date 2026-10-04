(function bootstrapInventoryApp(global) {
  // পড়ার নিয়ম: প্রতিটি বাংলা comment তার ঠিক উপরের সম্পূর্ণ code line বা code block-এর কাজ বোঝায়।
  const permissionContract = global.InventoryPermissionContract || {};
  // Permission configuration না পেলে খালি object ব্যবহার করে page crash হওয়া ঠেকায়।
  const apiBase = global.location.origin.includes("localhost")
    ? "http://localhost:4000/api"
    : "/api";
  // Local development-এ আলাদা API address, production-এ current domain-এর /api ব্যবহার করে।

  const copyrightText =
    "© 2026 Shop Inventory Management - All rights reserved.";
  const staffPageConfig = permissionContract.STAFF_PAGE_CONFIG || {};
  // প্রতিটি staff permission-এর label, section ID ইত্যাদির configuration।
  const staffPermissionKeys = permissionContract.STAFF_PAGE_PERMISSIONS || [];
  // System-এ বৈধ সব staff permission-এর key list।
  const defaultStaffPermissions =
    permissionContract.DEFAULT_STAFF_PERMISSIONS || [
      "purchase_entry",
      "sale_invoice",
    ];
  // Permission না দিলে নতুন staff-এর জন্য default purchase ও sales page access।
  const invoicePagePermission = "sale_invoice";
  // Invoice page খুলতে যে permission প্রয়োজন তার central key।
  const mobileLayoutMediaQuery =
    typeof global.matchMedia === "function"
      ? global.matchMedia("(max-width: 991px)")
      : null;
  // Screen width 991px বা কম কি না দেখে mobile layout শনাক্ত করার media query।

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
  // Staff Access screen-এ প্রতিটি permission কী কাজ করে তার user-friendly ব্যাখ্যা।

  const staffPermissionOptions = staffPermissionKeys.map((permission) => ({
    value: permission,
    label: staffPageConfig[permission]?.label || permission,
    shortLabel: staffPageConfig[permission]?.shortLabel || permission,
    sectionId: staffPageConfig[permission]?.sectionId || "",
    description: permissionDescriptions[permission] || "",
  }));
  // Raw permission key-কে form/UI-তে ব্যবহারযোগ্য label, short label ও description-এ রূপান্তর করে।

  const sectionPermissionMap = Object.fromEntries(
    Object.entries(staffPageConfig)
      .filter(
        ([, config]) => config.sectionId && config.sectionId !== "invoicePage",
      )
      .map(([permission, config]) => [config.sectionId, permission]),
  );
  // কোন page section খুলতে কোন permission লাগে—তার দ্রুত lookup map।

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
  // Sidebar-এর সব menu item, তাদের icon, target section ও প্রয়োজনীয় permission।

  function preventFocusedNumberWheelChange() {
    // Number input focus থাকা অবস্থায় mouse wheel ঘুরিয়ে value অনিচ্ছাকৃত বদলানো বন্ধ করে।
    if (!global.document?.addEventListener) {
      // Browser document API না থাকলে event listener বসানো সম্ভব নয়।
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
    // Wheel event capture করে focused number input blur করানো হয়।
  }

  function escapeHtml(value) {
    // User input-এর special HTML character encode করে XSS ও broken markup ঠেকায়।
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
    // &, <, >, quote এবং apostrophe নিরাপদ HTML entity-তে বদলায়।
  }

  function normalizePermissions(values) {
    // Permission list-কে lowercase, valid ও duplicate-মুক্ত standard array বানায়।
    if (typeof permissionContract.normalizePermissions === "function") {
      // Shared permission contract-এ helper থাকলে একই central logic ব্যবহার করে।
      return permissionContract.normalizePermissions(values);
    }

    const list = Array.isArray(values) ? values : [];
    // Array ছাড়া অন্য value এলে খালি permission list ধরা হয়।
    const normalized = list
      .map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      )
      .filter((value) => staffPermissionKeys.includes(value));

    return [...new Set(normalized)];
    // Set দিয়ে duplicate permission বাদ দিয়ে array ফেরত দেয়।
  }

  function getPermissionOption(permission) {
    // একটি permission key দিয়ে তার label/description-সহ option object খুঁজে দেয়।
    return (
      staffPermissionOptions.find((option) => option.value === permission) ||
      null
    );
  }

  function formatPermissionSummary(permissions, options = {}) {
    // Permission list-কে UI-তে দেখানোর সংক্ষিপ্ত readable text বানায়।
    const short = Boolean(options.short);
    const normalized = normalizePermissions(permissions);

    if (!normalized.length) {
      // কোনো page assign না থাকলে তার স্পষ্ট message দেয়।
      return short ? "no assigned pages" : "No assigned pages";
    }

    if (normalized.length === staffPermissionKeys.length) {
      // সব permission থাকলে আলাদা আলাদা নাম না দেখিয়ে all business pages দেখায়।
      return short ? "all business pages" : "All business pages";
    }

    const labels = normalized.map((permission) => {
      const option = getPermissionOption(permission);
      return option ? option[short ? "shortLabel" : "label"] : permission;
    });
    // Permission key থেকে page label তৈরি করে।

    if (labels.length > 3) {
      // তিনটির বেশি page হলে লম্বা list-এর বদলে total page count দেখায়।
      return `${labels.length} pages`;
    }

    return labels.join(", ");
  }

  function clearStoredSession() {
    // Browser localStorage থেকে cached login token ও user data মুছে logout সম্পূর্ণ করে।
    global.localStorage.removeItem("token");
    global.localStorage.removeItem("user");
  }

  function isMobileLayout() {
    // Media query match করলে বর্তমানে mobile/tablet layout চলছে বলে true দেয়।
    return Boolean(mobileLayoutMediaQuery?.matches);
  }

  function normalizeSessionRole(value) {
    // Role text standard করে শুধু staff অথবা owner role গ্রহণ করে।
    const normalized = String(value || "")
      .trim()
      .toLowerCase();

    if (normalized === "staff") {
      // Staff role হলে standard staff value ফেরত দেয়।
      return "staff";
    }

    if (normalized === "owner" || normalized === "admin") {
      // পুরোনো admin role-কে owner হিসেবে ধরে backward compatibility রাখে।
      return "owner";
    }

    return "";
  }

  function hasKnownSession(user) {
    // User object এবং তার স্বীকৃত role থাকলেই valid session বলে।
    return Boolean(user && normalizeSessionRole(user.role));
  }

  function isOwnerUser(user) {
    // Logged-in user owner role-এ আছে কি না যাচাই করে।
    if (!hasKnownSession(user)) {
      return false;
    }

    return normalizeSessionRole(user?.role) === "owner";
  }

  function getUserPermissions(user) {
    // Owner-এর জন্য all permission, staff-এর জন্য assigned permission set ফেরত দেয়।
    if (isOwnerUser(user)) {
      return new Set(["all"]);
    }

    return new Set(normalizePermissions(user?.permissions));
  }

  function canAccessPermission(user, ...permissions) {
    // User-এর অন্তত একটি চাওয়া permission আছে কি না দেখে।
    if (!hasKnownSession(user)) {
      return false;
    }

    if (isOwnerUser(user)) {
      return true;
    }

    if (!permissions.length) {
      // কোনো permission চাওয়া না হলে অনিচ্ছাকৃত access অনুমোদন করে না।
      return false;
    }

    const granted = getUserPermissions(user);
    // Current user-এর permission set একবার নিয়ে দ্রুত lookup করা হয়।
    return permissions.some((permission) => granted.has(permission));
  }

  function canAccessSection(user, sectionId) {
    // Sidebar/page section-এ current user ঢুকতে পারবে কি না নির্ধারণ করে।
    if (!hasKnownSession(user)) {
      return false;
    }

    if (sectionId === "staffAccessSection") {
      // Staff account create/edit করার screen শুধু business owner-এর জন্য।
      return isOwnerUser(user);
    }

    const item = sidebarItems.find((entry) => entry.sectionId === sectionId);
    // Section-এর sidebar configuration খুঁজে নেয়।
    if (item?.availableToAll) {
      // Chat support ও account-এর মতো all-user section সবার জন্য খোলা।
      return true;
    }

    const permission = sectionPermissionMap[sectionId];
    // Section-এর mapping করা required permission বের করে।
    return permission
      ? canAccessPermission(user, permission)
      : isOwnerUser(user);
  }

  global.InventoryApp = Object.freeze({
    // Shared frontend helper/config read-only global object হিসেবে অন্য scripts-এ দেওয়া হয়।
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
  // App load হওয়ার সঙ্গে সঙ্গে number input wheel protection চালু করে।
})(window);
