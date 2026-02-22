/* ---------------------- Config --------------------- */
const apiBase = window.location.origin.includes("localhost")
  ? "http://localhost:4000/api"
  : "/api";

let itemNames = [];
let currentItemReportRows = [];

/* ---------------------- AUTH ----------------------- */
async function checkAuth() {
  const token = localStorage.getItem("token");
  if (!token) return (location.href = "login.html");

  try {
    const res = await fetch(`${apiBase}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("unauthorized");

    const user = await res.json();
    localStorage.setItem("user", JSON.stringify(user));
    // document.getElementById("welcomeUser").innerText = `Welcome, ${user.name}`;
    document.getElementById("welcomeUser").innerText = user.name ? user.name.trim() : "";
    document.body.style.visibility = "visible";
  } catch (err) {
    console.error("Auth fail:", err);
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    alert("Session expired! Please log in again.");
    location.href = "login.html";
  }
}

/* ---------------------- UI / Sidebar --------------------- */
function setupSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const toggle = document.getElementById("sidebarToggle");

  toggle.addEventListener("click", () => {
    const open = sidebar.classList.toggle("sidebar--open");
    overlay.classList.toggle("visible", open);
  });

  overlay.addEventListener("click", () => {
    sidebar.classList.remove("sidebar--open");
    overlay.classList.remove("visible");
  });

  document.querySelectorAll(".sidebar button[data-section]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".form-section")
        .forEach((s) => s.classList.remove("active"));
      document.getElementById(btn.dataset.section).classList.add("active");
      document
        .querySelectorAll(".sidebar button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      localStorage.setItem("activeSection", btn.dataset.section);
      sidebar.classList.remove("sidebar--open");
      overlay.classList.remove("visible");
    });
  });

  document.getElementById("logoutBtn").addEventListener("click", () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    location.href = "login.html";
  });
}

/* ---------------------- Dropdown helpers --------------------- */
function renderDropdown(listEl, items, onSelect) {
  if (!items || items.length === 0) {
    listEl.style.display = "none";
    listEl.innerHTML = "";
    return;
  }
  listEl.innerHTML = items
    .map(
      (i) =>
        `<div class="dropdown-item" data-value="${escapeHtml(i)}">${escapeHtml(
          i
        )}</div>`
    )
    .join("");
  listEl.style.display = "block";
  listEl.querySelectorAll(".dropdown-item").forEach((el) =>
    el.addEventListener("click", () => {
      onSelect(el.dataset.value);
      listEl.style.display = "none";
    })
  );
}

function escapeHtml(s) {
  return (s + "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setupFilterInput(inputId, listId, onSelectCallback) {
  const input = document.getElementById(inputId);
  const listEl = document.getElementById(listId);

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      renderDropdown(listEl, itemNames.slice(0, 50), (val) => {
        input.value = val;
        if (onSelectCallback) onSelectCallback(val);
      });
      return;
    }
    const filtered = itemNames
      .filter((i) => i.toLowerCase().includes(q))
      .slice(0, 50);
    renderDropdown(listEl, filtered, (val) => {
      input.value = val;
      if (onSelectCallback) onSelectCallback(val);
    });
  });

  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !listEl.contains(e.target))
      listEl.style.display = "none";
  });

  input.addEventListener("focus", () => {
    renderDropdown(listEl, itemNames.slice(0, 50), (val) => {
      input.value = val;
      if (onSelectCallback) onSelectCallback(val);
    });
  });
}

/* ---------------------- Load Items --------------------- */
async function loadItemNames() {
  try {
    const res = await fetch(`${apiBase}/items/names`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    });
    if (!res.ok) throw new Error("Failed to fetch items");
    itemNames = await res.json();
  } catch (err) {
    console.error("Error loading item names:", err);
    itemNames = [];
  }
}

/* ---------------------- Add Stock --------------------- */
async function addStock() {
  const item =
    (document.getElementById("manualNewItem").value ||
      document.getElementById("newItemSearch").value ||
      "").trim();
  const quantity = parseFloat(document.getElementById("newQuantity").value);
  const buying_rate = parseFloat(document.getElementById("buyingRate").value);
  const selling_rate = parseFloat(document.getElementById("sellingRate").value);

  if (!item || isNaN(quantity) || isNaN(buying_rate) || isNaN(selling_rate)) {
    return alert("Fill all fields correctly");
  }

  try {
    const res = await fetch(`${apiBase}/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
      body: JSON.stringify({
        name: item,
        quantity,
        buying_rate,
        selling_rate
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Add failed");
    alert(data.message || "Added");
    await loadItemNames();
    await loadAnalytics();
    [
      "manualNewItem",
      "newItemSearch",
      "newQuantity",
      "buyingRate",
      "sellingRate"
    ].forEach(id => document.getElementById(id).value = "");
  } catch (err) {
    console.error("Add stock error:", err);
    alert(err.message || "Server error");
  }
}


// --- Add Stock rate inputs ---
const buyingRateInput = document.getElementById("buyingRate");
const sellingRateInput = document.getElementById("sellingRate");
// Auto calculate selling rate = buying + 30%
if (buyingRateInput && sellingRateInput) {
  buyingRateInput.addEventListener("input", () => {
    const buyingRate = parseFloat(buyingRateInput.value);

    if (!isNaN(buyingRate)) {
      const autoSelling = buyingRate * 1.3;
      sellingRateInput.value = autoSelling.toFixed(2);
    }
  });
}

//---------- stock view and download ----------------//
async function loadItemReport() {
  const item = document
    .getElementById("itemReportSearch")
    .value
    .trim();

  try {
    const url = item
      ? `${apiBase}/items/report?name=${encodeURIComponent(item)}`
      : `${apiBase}/items/report`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
    });

    if (!res.ok) throw new Error("Failed to load item report");

    const rows = await res.json();
    currentItemReportRows = rows; // 🔒 for PDF
    renderItemReport(rows);

  } catch (err) {
    console.error("Item report error:", err);
    alert("Could not load item report");
  }
}
function renderItemReport(rows) {
  const tbody = document.getElementById("itemReportBody");
  tbody.innerHTML = "";

  if (!rows || rows.length === 0) {
    tbody.innerHTML =
      `<tr><td colspan="4" class="text-muted">No records found</td></tr>`;
    return;
  }

  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.item_name)}</td>
      <td>${Number(r.available_qty).toFixed(2)}</td>
      <td>${Number(r.selling_rate).toFixed(2)}</td>
      <td>${Number(r.sold_qty).toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  });
}



/* ---------------------- sale report table --------------------- */
async function loadSalesReport() {
  const from = document.getElementById("fromDate").value;
  const to = document.getElementById("toDate").value;

  if (!from || !to) {
    return alert("Select both From and To date");
  }

  try {
    const res = await fetch(
      `${apiBase}/sales/report?from=${from}&to=${to}`,
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
      }
    );

    if (!res.ok) throw new Error("Failed to load report");

    const rows = await res.json();
    renderSalesReport(rows);

  } catch (err) {
    console.error("Load sales report error:", err);
    alert("Could not load sales report");
  }
}


function renderSalesReport(rows) {
  const tbody = document.getElementById("salesReportBody");
  const totalEl = document.getElementById("salesGrandTotal");

  tbody.innerHTML = "";
  let grandTotal = 0;

  if (!rows || rows.length === 0) {
    tbody.innerHTML =
      `<tr><td colspan="5" class="text-muted">No records found</td></tr>`;
    totalEl.textContent = "0.00";
    return;
  }

  rows.forEach((r) => {
    const date = new Date(r.created_at).toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
    });

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${date}</td>
      <td class="item-name">${escapeHtml(r.item_name)}</td>
      <td>${r.quantity}</td>
      <td>${Number(r.selling_price).toFixed(2)}</td>
      <td>${Number(r.total_price).toFixed(2)}</td>
    `;

    grandTotal += Number(r.total_price) || 0;
    tbody.appendChild(tr);
  });

  totalEl.textContent = grandTotal.toFixed(2);
}

function downloadItemReportPDF() {
  const item = document
    .getElementById("itemReportSearch")
    .value
    .trim();

  const url = item
    ? `/api/items/report/pdf?name=${encodeURIComponent(item)}`
    : `/api/items/report/pdf`;

  window.location.href = url;
}


// ----------------- PDF REPORT --------------------------
function downloadSalesPDF() {
  const from = document.getElementById("fromDate").value;
  const to = document.getElementById("toDate").value;

  if (!from || !to) {
    alert("Please select date range");
    return;
  }

  window.location.href = `/api/sales/report/pdf?from=${from}&to=${to}`;
}


// -------------------- EXCELL REPORT ----------------------------
function downloadSalesExcel() {
  const from = document.getElementById("fromDate").value;
  const to = document.getElementById("toDate").value;

  if (!from || !to) {
    alert("Please select date range");
    return;
  }

  window.location.href = `/api/sales/report/excel?from=${from}&to=${to}`;
}




/* ---------------------- Debts --------------------- */
async function submitDebt() {
  const entry = {
    customer_name: document.getElementById("cdName").value.trim(),
    customer_number: document.getElementById("cdNumber").value.trim(),
    total: parseFloat(document.getElementById("cdTotal").value) || 0,
    credit: parseFloat(document.getElementById("cdCredit").value) || 0,
  };
  if (!entry.customer_name || !/^\d{10}$/.test(entry.customer_number))
    return alert("Invalid number");
  try {
    const res = await fetch(`${apiBase}/debts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
      body: JSON.stringify(entry),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Debt save failed");
    alert(data.message || "Debt entry added");
    ["cdName", "cdNumber", "cdTotal", "cdCredit"].forEach(
      (id) => (document.getElementById(id).value = "")
    );
  } catch (err) {
    console.error("Submit debt error:", err);
    alert(err.message || "Server error");
  }
}
/* ---------------------- Debts End --------------------- */


/* ================= ANALYTICS SUMMARY STOCK, TOTAL SALE, MONTHLY SALE CHART ================= */

async function loadAnalytics() {
  const token = localStorage.getItem("token");

  const res = await fetch("/api/analytics/summary", {
    headers: {
      Authorization: "Bearer " + token
    }
  });

  if (res.status === 401) {
    localStorage.removeItem("token");
    window.location.href = "login.html";
    return;
  }

  const data = await res.json();
  renderAnalyticsChart(data);
}

function renderAnalyticsChart(data) {
  const ctx = document.getElementById("analyticsChart");

  if (window.analyticsChartInstance) {
    window.analyticsChartInstance.destroy();
  }

  window.analyticsChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Total Stock", "Total Sales", "Monthly Sales"],
      datasets: [{
        data: [
          Number(data.total_stock),
          Number(data.total_sales),
          Number(data.monthly_sales)
        ],
        backgroundColor: [
          "rgba(37, 99, 235, 0.85)",
          "rgba(22, 163, 74, 0.85)",
          "rgba(245, 158, 11, 0.85)"
        ],
        borderRadius: 0,          // ❌ no round
        borderSkipped: false,
        barPercentage: 0.5,       // 👈 thin
        categoryPercentage: 0.4   // 👈 spacing
      }]
    },
    options: {
      responsive: true,
      animation: {
        duration: 1000,
        easing: "easeOutQuart"
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#111827",
          padding: 10,
          callbacks: {
            label: function (context) {
              return "₹ " + context.parsed.y.toLocaleString("en-IN");
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false }
        },
        y: {
          beginAtZero: true,
          grid: {
            color: "rgba(0,0,0,0.05)"
          },
          ticks: {
            callback: function (value) {
              return "₹ " + value.toLocaleString("en-IN");
            }
          }
        }
      }
    }
  });
}





let last12Chart;

async function loadLast12MonthsChart() {
  try {
    const res = await fetch(`${apiBase}/sales/last-12-months`, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
    });

    if (!res.ok) throw new Error("Chart load failed");

    const rows = await res.json();

    const labels = rows.map(r => r.month);
    const data = rows.map(r => parseFloat(r.total_sales));

    const ctx = document.getElementById("last12MonthsChart");

    if (!ctx) return;

    if (last12Chart) {
      last12Chart.destroy();
    }

    last12Chart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [{
          label: "Monthly Sales",
          data: data,
          backgroundColor: "#2563eb",
          borderColor: "#1e40af",
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        animation: false,
        plugins: {
          legend: { display: true }
        },
        scales: {
          y: { beginAtZero: true }
        }
      }
    });

  } catch (err) {
    console.error("Chart error:", err);
  }
}





async function searchLedger() {
  const number = document.getElementById("cdSearchInput").value.trim();
  if (!/^\d{10}$/.test(number)) return alert("Invalid number");
  try {
    const res = await fetch(`${apiBase}/debts/${number}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    });
    const data = await res.json();
    renderLedgerTable(data, "ledger");
  } catch (err) {
    console.error("Search ledger error:", err);
  }
}

async function showAllDues() {
  try {
    const res = await fetch(`${apiBase}/debts`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    });
    const data = await res.json();
    renderLedgerTable(data, "summary");
  } catch (err) {
    console.error("Show dues error:", err);
  }
}

function renderLedgerTable(rows, mode = "summary") {
  const ledgerDiv = document.getElementById("ledgerTable");
  if (!rows || !rows.length) {
    ledgerDiv.innerHTML = "<p>No records.</p>";
    return;
  }

  let html = "<table>";
  let totalOutstanding = 0;

  if (mode === "summary") {
    html +=
      "<tr><th>Name</th><th>Number</th><th>Total</th><th>Credit</th><th>Balance</th></tr>";
    rows.forEach((r) => {
      const balance = parseFloat(r.balance) || 0;
      totalOutstanding += balance;
      html += `<tr>
        <td>${escapeHtml(r.customer_name)}</td>
        <td>${r.customer_number}</td>
        <td>${r.total}</td>
        <td>${r.credit}</td>
        <td>${balance.toFixed(2)}</td>
      </tr>`;
    });
  } else {
    html += "<tr><th>Date</th><th>Total</th><th>Credit</th><th>Balance</th></tr>";
    let balance = 0;
    rows.forEach((r) => {
      balance += r.total - r.credit;
      html += `<tr>
        <td>${new Date(r.created_at).toLocaleDateString()}</td>
        <td>${r.total}</td>
        <td>${r.credit}</td>
        <td>${balance.toFixed(2)}</td>
      </tr>`;
    });
    totalOutstanding = balance;
  }

  html += `</table>
    <div class="text-end mt-2 fw-bold text-primary">
      Total Outstanding Balance: ₹${totalOutstanding.toFixed(2)}
    </div>`;

  ledgerDiv.innerHTML = html;
}

/* ---------------------- Init --------------------- */
window.addEventListener("DOMContentLoaded", async () => {
  await checkAuth();

  setupSidebar();
  document.getElementById("addStockBtn").addEventListener("click", addStock);
  document.getElementById("loadItemReportBtn").addEventListener("click", loadItemReport);
  document.getElementById("itemReportPdfBtn").addEventListener("click", downloadItemReportPDF);
  document.getElementById("loadSalesBtn").addEventListener("click", loadSalesReport);
  document.getElementById("pdfBtn").addEventListener("click", downloadSalesPDF);
  document.getElementById("excelBtn").addEventListener("click", downloadSalesExcel);
  document.getElementById("submitDebtBtn").addEventListener("click", submitDebt);
  document.getElementById("searchLedgerBtn").addEventListener("click", searchLedger);
  document.getElementById("showAllDuesBtn").addEventListener("click", showAllDues);
  document.getElementById("invoiceBtn").addEventListener("click", () => {
    window.location.href = "invoice.html";
  });

  setupFilterInput("newItemSearch", "newItemDropdownList", (val) => {
    document.getElementById("manualNewItem").value = "";
  });

  // Item Report search dropdown
  setupFilterInput("itemReportSearch", "itemReportDropdown", () => { }
  );




  //-------------- AFTER REFRESH ALWASE LOAD IN SAME PAGE ---------------------
  const lastSection = localStorage.getItem("activeSection");

  if (lastSection && document.getElementById(lastSection)) {
    document
      .querySelectorAll(".form-section")
      .forEach((s) => s.classList.remove("active"));

    document
      .querySelectorAll(".sidebar button")
      .forEach((b) => b.classList.remove("active"));

    document.getElementById(lastSection).classList.add("active");

    const btn = document.querySelector(
      `.sidebar button[data-section="${lastSection}"]`
    );
    if (btn) btn.classList.add("active");
  }

  await loadItemNames();
  await loadAnalytics();
  await loadLast12MonthsChart();
});




// Allow only digits in number fields
// function restrictToDigits(id) {
//   const input = document.getElementById(id);

//   // Prevent typing letters
//   input.addEventListener("keypress", (e) => {
//     if (!/[0-9]/.test(e.key)) e.preventDefault();
//   });

//   // Prevent pasting letters
//   input.addEventListener("input", () => {
//     input.value = input.value.replace(/[^0-9]/g, "").slice(0, 10);
//   });
// }

function restrictToDigits(id) {
  const input = document.getElementById(id);
  if (!input) return;

  input.addEventListener("keypress", (e) => {
    if (!/[0-9]/.test(e.key)) e.preventDefault();
  });

  input.addEventListener("input", () => {
    input.value = input.value.replace(/[^0-9]/g, "").slice(0, 10);
  });
}


// Apply to both fields
restrictToDigits("cdNumber");
restrictToDigits("cdSearchInput");



setTimeout(() => {
  if (document.body.style.visibility === "hidden") {
    document.body.style.visibility = "visible";
  }
}, 5000);