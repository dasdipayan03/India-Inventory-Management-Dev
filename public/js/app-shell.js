(function bootstrapInventoryShell(global) {
  const app = global.InventoryApp || {};
  const escapeHtml = app.escapeHtml || ((value) => String(value ?? ""));

  function buildMetaAttributes(item) {
    return [
      `data-eyebrow="${escapeHtml(item.eyebrow || "")}"`,
      `data-title="${escapeHtml(item.title || item.label || "")}"`,
      `data-description="${escapeHtml(item.description || "")}"`,
      `data-badge="${escapeHtml(item.badge || "")}"`,
    ].join(" ");
  }

  function buildDashboardButton(item) {
    const metaAttributes = buildMetaAttributes(item);

    if (item.kind === "invoice") {
      return `
        <button id="invoiceBtn" ${metaAttributes} type="button">
          <i class="${escapeHtml(item.iconClass)}"></i>
          <span>${escapeHtml(item.label)}</span>
        </button>
      `;
    }

    const classes = item.sectionId === "addStockSection" ? ' class="active"' : "";
    return `
      <button
        data-section="${escapeHtml(item.sectionId)}"
        ${metaAttributes}
       ${classes}
        type="button"
      >
        <i class="${escapeHtml(item.iconClass)}"></i>
        <span>${escapeHtml(item.label)}</span>
      </button>
    `;
  }

  function buildInvoiceButton(item) {
    const metaAttributes = buildMetaAttributes(item);

    if (item.kind === "invoice") {
      return `
        <button
          id="invoiceNavBtn"
          class="active"
          ${metaAttributes}
          type="button"
          aria-current="page"
        >
          <i class="${escapeHtml(item.iconClass)}"></i>
          <span>${escapeHtml(item.label)}</span>
        </button>
      `;
    }

    return `
      <button
        data-nav-section="${escapeHtml(item.sectionId)}"
        ${metaAttributes}
        type="button"
      >
        <i class="${escapeHtml(item.iconClass)}"></i>
        <span>${escapeHtml(item.label)}</span>
      </button>
    `;
  }

  function renderSidebar(pageType) {
    const container =
      document.getElementById("sidebarNav") ||
      document.querySelector(".sidebar__nav");

    if (!container || !Array.isArray(app.sidebarItems)) {
      return;
    }

    const buttonMarkup = app.sidebarItems
      .map((item) =>
        pageType === "invoice"
          ? buildInvoiceButton(item)
          : buildDashboardButton(item),
      )
      .join("");

    container.innerHTML = `
      ${buttonMarkup}
      <button id="logoutBtn" type="button">
        <i class="fas fa-sign-out-alt"></i>
        <span>Logout</span>
      </button>
    `;

    const footer =
      document.getElementById("sidebarFooterText") ||
      document.querySelector(".sidebar__footer p");

    if (footer && app.copyrightText) {
      footer.textContent = app.copyrightText;
    }
  }

  global.InventoryAppShell = {
    renderSidebar,
  };
})(window);
