/* ---------------------- Config --------------------- */
const apiBase = window.location.origin.includes("localhost")
  ? "http://localhost:4000/api"
  : "/api";

let itemNames = [];

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

  const closeDropdown = (e) => {
    if (e.target.closest(".dropdown-item")) return;
    if (!input.contains(e.target) && !listEl.contains(e.target)) {
      listEl.style.display = "none";
    }
  };

  document.addEventListener("click", closeDropdown, { passive: true });


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
  const buyingRate = parseFloat(document.getElementById("newRate").value);
  const sellingRate = parseFloat(document.getElementById("newSellingRate").value);
  if (!item || isNaN(quantity) || isNaN(buyingRate) || isNaN(sellingRate))
    return alert("Fill all fields correctly");
  try {
    const res = await fetch(`${apiBase}/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
      body: JSON.stringify({ name: item, quantity, buyingRate, sellingRate }),

    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Add failed");
    alert(data.message || "Added");
    setTimeout(loadItemNames, 0);
    ["manualNewItem", "newItemSearch", "newQuantity", "newRate", "newSellingRate"].forEach(
      (id) => (document.getElementById(id).value = "")
    );
  } catch (err) {
    console.error("Add stock error:", err);
    alert(err.message || "Server error");
  }
}

/* ---------------------- Record Sale --------------------- */
async function updateSellingPrice() {
  const item = document.getElementById("saleItemSearch").value.trim();
  const quantity = parseInt(document.getElementById("saleQuantity").value) || 0;
  if (!item) return;
  try {
    const res = await fetch(
      `${apiBase}/items/info?name=${encodeURIComponent(item)}`,
      { headers: { Authorization: `Bearer ${localStorage.getItem("token")}` } }
    );
    const data = await res.json();
    if (!res.ok) return alert(data.error || "Item info error");
    document.getElementById("availableStock").value = data.quantity;
    document.getElementById("sellingPrice").value = (data.rate * quantity).toFixed(2);
  } catch (err) {
    console.error("Update price error:", err);
  }
}

async function recordSale() {
  const name = document.getElementById("saleItemSearch").value.trim();
  const quantity = parseFloat(document.getElementById("saleQuantity").value);
  const actualPrice = parseFloat(document.getElementById("actualSellingPrice").value);
  if (!name || isNaN(quantity) || isNaN(actualPrice))
    return alert("Invalid input");
  try {
    const res = await fetch(`${apiBase}/sales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("token")}`,
      },
      body: JSON.stringify({ name, quantity, actualPrice }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Sale failed");
    alert(data.message || "Sale recorded");
    setTimeout(loadItemNames, 0);
    ["saleItemSearch", "saleQuantity", "availableStock", "sellingPrice", "actualSellingPrice"].forEach(
      (id) => (document.getElementById(id).value = "")
    );
  } catch (err) {
    console.error("Record sale error:", err);
    alert(err.message || "Server error");
  }
}

/* ---------------------- Reports --------------------- */
async function downloadSalesPDF() {
  const from = document.getElementById("fromDate").value;
  const to = document.getElementById("toDate").value;
  if (!from || !to) return alert("Select both dates");
  try {
    const res = await fetch(`${apiBase}/sales/report/pdf?from=${from}&to=${to}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    });
    const blob = await res.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "Sales_Report.pdf";
    link.click();
  } catch (err) {
    console.error("PDF download error:", err);
    alert("Could not download PDF");
  }
}

async function downloadSalesExcel() {
  const from = document.getElementById("fromDate").value;
  const to = document.getElementById("toDate").value;
  if (!from || !to) return alert("Select both dates");
  try {
    const res = await fetch(`${apiBase}/sales/report/excel?from=${from}&to=${to}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    });
    const blob = await res.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "Sales_Report.xlsx";
    link.click();
  } catch (err) {
    console.error("Excel download error:", err);
    alert("Could not download Excel");
  }
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
  setupSidebar();

  document.getElementById("addStockBtn").addEventListener("click", addStock);
  document.getElementById("recordSaleBtn").addEventListener("click", recordSale);
  document.getElementById("pdfBtn").addEventListener("click", downloadSalesPDF);
  document.getElementById("excelBtn").addEventListener("click", downloadSalesExcel);
  document.getElementById("submitDebtBtn").addEventListener("click", submitDebt);
  document.getElementById("searchLedgerBtn").addEventListener("click", searchLedger);
  document.getElementById("showAllDuesBtn").addEventListener("click", showAllDues);
  document.getElementById("saleQuantity").addEventListener("input", updateSellingPrice);
  document.getElementById("invoiceBtn").addEventListener("click", (e) => {
    e.preventDefault();

    // 🔥 break gesture chain cleanly (mobile safe)
    setTimeout(() => {
      window.location.href = "invoice.html";
    }, 0);
  });


  // Auto calculate selling rate from buying rate (+30%)
  const buyingRateInput = document.getElementById("newRate");
  const sellingRateInput = document.getElementById("newSellingRate");

  if (buyingRateInput && sellingRateInput) {
    buyingRateInput.addEventListener("input", () => {
      const buying = parseFloat(buyingRateInput.value);
      if (!isNaN(buying)) {
        sellingRateInput.value = (buying * 1.3).toFixed(2);
      } else {
        sellingRateInput.value = "";
      }
    });
  }


  setupFilterInput("newItemSearch", "newItemDropdownList", (val) => {
    document.getElementById("manualNewItem").value = "";
  });
  setupFilterInput("saleItemSearch", "saleItemDropdownList");

  await checkAuth();
  await loadItemNames();
});


// Allow only digits in number fields
function restrictToDigits(id) {
  const input = document.getElementById(id);

  // Prevent typing letters
  input.addEventListener("keypress", (e) => {
    if (!/[0-9]/.test(e.key)) e.preventDefault();
  });

  // Prevent pasting letters
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