(function initDeveloperSupportPage() {
  // পড়ার নিয়ম: প্রতিটি বাংলা comment তার ঠিক উপরের সম্পূর্ণ code line বা code block-এর কাজ বোঝায়।
  const apiBase = window.location.origin.includes("localhost")
    ? "http://localhost:4000/api"
    : "/api";
  // Local বা production API endpoint নির্বাচন করে।

  const state = {
    developer: null,
    conversations: [],
    activeConversation: null,
    messages: [],
    selectedConversationId: null,
    activeFilter: "needs_reply",
    pollTimer: null,
  };
  // Inbox list, selected conversation, message এবং request state এক জায়গায় রাখে।

  const dom = {
    developerIdentityChip: document.getElementById("developerIdentityChip"),
    refreshInboxBtn: document.getElementById("refreshInboxBtn"),
    developerLogoutBtn: document.getElementById("developerLogoutBtn"),
    pageStatus: document.getElementById("pageStatus"),
    statTotalThreads: document.getElementById("statTotalThreads"),
    statUnreadThreads: document.getElementById("statUnreadThreads"),
    statOpenThreads: document.getElementById("statOpenThreads"),
    conversationSearch: document.getElementById("conversationSearch"),
    conversationSearchDropdown: document.getElementById(
      "conversationSearchDropdown",
    ),
    filterRow: document.getElementById("filterRow"),
    conversationList: document.getElementById("conversationList"),
    detailList: document.getElementById("detailList"),
    threadTitle: document.getElementById("threadTitle"),
    threadLead: document.getElementById("threadLead"),
    threadStatusPill: document.getElementById("threadStatusPill"),
    threadOwnerPill: document.getElementById("threadOwnerPill"),
    threadUpdatedPill: document.getElementById("threadUpdatedPill"),
    markOpenBtn: document.getElementById("markOpenBtn"),
    markClosedBtn: document.getElementById("markClosedBtn"),
    threadMessages: document.getElementById("threadMessages"),
    replyInput: document.getElementById("replyInput"),
    composerStatus: document.getElementById("composerStatus"),
    replySendBtn: document.getElementById("replySendBtn"),
    currentYear: document.getElementById("currentYear"),
  };
  // Support inbox-এর প্রয়োজনীয় HTML element reference সংগ্রহ করে।

  function escapeHtml(value) {
    // User message নিরাপদ HTML text-এ রূপান্তর করে XSS ঠেকায়।
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDateTime(value) {
    // API timestamp-কে India locale-এর readable date/time বানায়।
    if (!value) {
      return "-";
    }

    return new Date(value).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Kolkata",
    });
  }

  function formatMessageText(value) {
    // Message text escape করে line break-কে HTML break-এ বদলায়।
    return escapeHtml(value || "").replace(/\n/g, "<br />");
  }

  function setPageStatus(message, tone = "info") {
    // পুরো inbox page-এর status/feedback message দেখায়।
    if (!dom.pageStatus) {
      // Status element না থাকলে page feedback update করার কিছু নেই।
      return;
    }

    dom.pageStatus.textContent = message;
    // Inbox-level status message UI-তে বসায়।
    dom.pageStatus.dataset.tone = tone;
    // CSS tone attribute দিয়ে info, success বা error style নির্বাচন করে।
  }

  function setComposerStatus(message, tone = "info") {
    // Reply composer-এর পাশে status/validation feedback দেখায়।
    if (!dom.composerStatus) {
      // Composer status element না থাকলে UI update এড়িয়ে যায়।
      return;
    }

    dom.composerStatus.textContent = message;
    // Reply submit বা validation feedback text UI-তে বসায়।
    dom.composerStatus.dataset.tone = tone;
    // Composer feedback-এর CSS tone নির্বাচন করে।
  }

  function setReplyEnabled(isEnabled) {
    // Conversation select ও permission অনুযায়ী reply controls চালু/বন্ধ করে।
    if (dom.replyInput) {
      // Conversation না থাকলে reply textarea disable করে।
      dom.replyInput.disabled = !isEnabled;
    }

    if (dom.replySendBtn) {
      // Conversation না থাকলে send reply button disable করে।
      dom.replySendBtn.disabled = !isEnabled;
    }

    if (dom.markOpenBtn) {
      // Conversation না থাকলে reopen action button disable করে।
      dom.markOpenBtn.disabled = !isEnabled;
    }

    if (dom.markClosedBtn) {
      // Conversation না থাকলে close action button disable করে।
      dom.markClosedBtn.disabled = !isEnabled;
    }
  }

  function setRefreshInboxLoading(isLoading) {
    // Inbox refresh চলার সময় refresh button-এর loading state দেখায়।
    if (!dom.refreshInboxBtn) {
      // Refresh button না থাকলে loading UI update এড়িয়ে যায়।
      return;
    }

    dom.refreshInboxBtn.classList.toggle("is-loading", Boolean(isLoading));
    // CSS loading class দিয়ে spinner/loading style চালু বা বন্ধ করে।
    dom.refreshInboxBtn.disabled = Boolean(isLoading);
    // Refresh চলার সময় duplicate inbox request আটকাতে button disable করে।
    dom.refreshInboxBtn.setAttribute("aria-busy", isLoading ? "true" : "false");
  }

  async function requestJSON(path, options = {}) {
    // Developer support API-তে authenticated JSON request পাঠায়।
    const headers = { ...(options.headers || {}) };
    // Caller header copy করে; original options object mutate করে না।

    if (options.body && !headers["Content-Type"]) {
      // JSON body থাকলে missing content type header সেট করে।
      headers["Content-Type"] = "application/json";
    }

    const requestOptions = {
      ...options,
      credentials: "include",
      headers,
      cache: "no-store",
    };
    // Cookie credential, header ও no-store cache policy-সহ fetch option তৈরি করে।

    const response = await fetch(`${apiBase}${path}`, {
      ...requestOptions,
    });
    // Developer support API-তে authenticated network request পাঠায়।

    let payload = {};
    try {
      // Non-JSON/malformed response হলেও safe empty payload রাখে।
      payload = await response.json();
    } catch (_error) {
      payload = {};
    }

    if (response.status === 401) {
      // Developer session expired হলে login screen-এ redirect করে।
      window.location.replace("developer-login.html");
      throw new Error(
        payload.error || payload.message || "Developer login required",
      );
    }

    if (!response.ok) {
      // অন্য HTTP failure backend-এর message-সহ Error হিসেবে caller-এ দেয়।
      throw new Error(payload.error || payload.message || "Request failed");
    }

    return payload;
  }

  function getConversationFilters() {
    // UI filter controls থেকে selected status/filter value নেয়।
    return Array.from(dom.filterRow?.querySelectorAll("[data-filter]") || []);
  }

  function renderFilterState() {
    // Current active filter অনুযায়ী filter button-এর selected styling update করে।
    getConversationFilters().forEach((button) => {
      button.classList.toggle(
        "is-active",
        button.dataset.filter === state.activeFilter,
      );
    });
  }

  function getSearchQuery() {
    // Search input clean lowercase string বানিয়ে case-insensitive search প্রস্তুত করে।
    return String(dom.conversationSearch?.value || "")
      .trim()
      .toLowerCase();
  }

  function buildConversationSearchValue(conversation) {
    // Conversation-এর requester, identifier ও owner-কে এক searchable string-এ মিলায়।
    return [
      conversation?.requesterName,
      conversation?.requesterIdentifier,
      conversation?.ownerName,
    ]
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .join(" ");
  }

  function getConversationSearchMeta(conversation) {
    // Search dropdown-এ দেখানোর requester role, owner ও updated-time meta text বানায়।
    const requesterMeta =
      conversation?.requesterRole === "staff"
        ? `Staff login - ${conversation?.requesterIdentifier || "username unavailable"}`
        : `Owner login - ${conversation?.requesterIdentifier || "email unavailable"}`;

    return [
      requesterMeta,
      conversation?.ownerName ? `Owner: ${conversation.ownerName}` : "",
      conversation?.lastMessageAt
        ? `Updated ${formatDateTime(conversation.lastMessageAt)}`
        : "",
    ]
      .filter(Boolean)
      .join(" | ");
  }

  function hideConversationSearchDropdown() {
    // Search suggestion UI লুকিয়ে তার পুরোনো option HTML পরিষ্কার করে।
    if (!dom.conversationSearchDropdown) {
      // Dropdown element না থাকলে hide operation এড়িয়ে যায়।
      return;
    }

    dom.conversationSearchDropdown.hidden = true;
    // CSS/layout থেকে search suggestion panel লুকায়।
    dom.conversationSearchDropdown.innerHTML = "";
    // পুরোনো search option HTML মুছে stale selection ঠেকায়।
  }

  function getFilteredConversations() {
    // Current filter ও typed search text ব্যবহার করে visible inbox conversations বের করে।
    // Search text ও status filter ব্যবহার করে visible conversation list তৈরি করে।
    const query = getSearchQuery();
    // Current user search text একবার নিয়ে সব conversation filtering-এ ব্যবহার করে।

    return state.conversations.filter((conversation) => {
      if (
        state.activeFilter === "needs_reply" &&
        !(conversation.unreadForDeveloper > 0)
      ) {
        // Needs-reply filter-এ developer unread message নেই এমন thread বাদ দেয়।
        return false;
      }

      if (state.activeFilter === "open" && conversation.status !== "open") {
        // Open filter-এ closed thread বাদ দেয়।
        return false;
      }

      if (state.activeFilter === "closed" && conversation.status !== "closed") {
        // Closed filter-এ open thread বাদ দেয়।
        return false;
      }

      if (!query) {
        // Search text খালি থাকলে status-matched thread সরাসরি রাখে।
        return true;
      }

      const haystack = [
        conversation.requesterName,
        conversation.requesterIdentifier,
        conversation.ownerName,
        conversation.ownerEmail,
        conversation.lastMessageText,
        conversation.lastMessageSenderName,
      ]
        .map((entry) => String(entry || "").toLowerCase())
        .join(" ");
      // Multiple conversation field মিলিয়ে one-string case-insensitive search target তৈরি করে।

      return haystack.includes(query);
    });
  }

  function renderConversationSearchDropdown() {
    // Matching conversation-এর selectable search suggestion dropdown render করে।
    // Matching conversation-এর দ্রুত নির্বাচনযোগ্য search dropdown render করে।
    if (!dom.conversationSearchDropdown || !dom.conversationSearch) {
      // Search input বা dropdown না থাকলে render করার মতো UI নেই।
      return;
    }

    const shouldShow = document.activeElement === dom.conversationSearch;
    // শুধু search field focused থাকলে suggestion panel দেখানো হবে।
    if (!shouldShow) {
      // Focus অন্যত্র গেলে existing dropdown লুকিয়ে দেয়।
      hideConversationSearchDropdown();
      return;
    }

    const matches = getFilteredConversations().slice(0, 8);
    // UI ছোট রাখতে সর্বোচ্চ আটটি matching thread দেখায়।

    if (!matches.length) {
      // কোনো result না থাকলে blank panel-এর বদলে clear empty message দেখায়।
      dom.conversationSearchDropdown.innerHTML = `
        <div class="search-dropdown__empty">
          No matching support threads for this search.
        </div>
      `;
      dom.conversationSearchDropdown.hidden = false;
      return;
    }

    dom.conversationSearchDropdown.innerHTML = matches
      .map((conversation) => {
        const isActive = conversation.id === state.selectedConversationId;

        return `
          <button
            class="search-option${isActive ? " is-active" : ""}"
            type="button"
            data-conversation-id="${escapeHtml(conversation.id)}"
          >
            <span class="search-option__title">
              ${escapeHtml(conversation.requesterName || "Unknown requester")}
            </span>
            <span class="search-option__meta">
              ${escapeHtml(getConversationSearchMeta(conversation))}
            </span>
          </button>
        `;
      })
      .join("");
    // Matching thread-গুলোকে safe escaped selectable button markup-এ রূপান্তর করে।

    dom.conversationSearchDropdown.hidden = false;
    // Populated search suggestion dropdown UI-তে দেখায়।
  }

  function updateHeroStats() {
    // Total, unread এবং open support thread count summary card-এ বসায়।
    // Inbox summary cards-এ open, closed ও unread conversation count বসায়।
    const totalThreads = state.conversations.length;
    // Inbox-এর সব loaded thread-এর total count নেয়।
    const unreadThreads = state.conversations.filter(
      (conversation) => Number(conversation.unreadForDeveloper) > 0,
    ).length;
    // Developer-এর reply প্রয়োজন এমন unread thread সংখ্যা হিসাব করে।
    const openThreads = state.conversations.filter(
      (conversation) => conversation.status === "open",
    ).length;
    // Closed নয় এমন open support thread সংখ্যা হিসাব করে।

    if (dom.statTotalThreads) {
      // Total thread stats element থাকলে calculated value বসায়।
      dom.statTotalThreads.textContent = String(totalThreads);
    }

    if (dom.statUnreadThreads) {
      // Unread stats element থাকলে calculated value বসায়।
      dom.statUnreadThreads.textContent = String(unreadThreads);
    }

    if (dom.statOpenThreads) {
      // Open stats element থাকলে calculated value বসায়।
      dom.statOpenThreads.textContent = String(openThreads);
    }
  }

  function renderConversationList() {
    // Filter হওয়া conversation list sidebar/inbox panel-এ render করে।
    // Filter হওয়া conversationগুলো inbox sidebar/list-এ render করে।
    if (!dom.conversationList) {
      return;
    }

    const conversations = getFilteredConversations();

    if (!conversations.length) {
      dom.conversationList.innerHTML = `
        <div class="queue-empty">
          <i class="fa-solid fa-inbox"></i>
          <strong>No matching conversations</strong>
          <p>Adjust the filter or search term to bring a support thread back into the queue.</p>
        </div>
      `;
      return;
    }

    dom.conversationList.innerHTML = conversations
      .map((conversation) => {
        const isActive = conversation.id === state.selectedConversationId;
        const requesterMeta =
          conversation.requesterRole === "staff"
            ? `Staff login • ${conversation.requesterIdentifier || "username unavailable"}`
            : `Owner login • ${conversation.requesterIdentifier || "email unavailable"}`;
        const preview = String(
          conversation.lastMessageText || "No messages yet",
        )
          .trim()
          .slice(0, 120);
        const statusClass =
          conversation.status === "closed"
            ? "queue-status queue-status--closed"
            : "queue-status queue-status--open";
        const statusLabel =
          conversation.status === "closed" ? "Closed" : "Open";
        const unreadBadge =
          conversation.unreadForDeveloper > 0
            ? `<span class="queue-badge">${escapeHtml(
                conversation.unreadForDeveloper,
              )}</span>`
            : `<span class="${statusClass}">${escapeHtml(statusLabel)}</span>`;

        return `
          <button
            class="queue-item${isActive ? " is-active" : ""}"
            type="button"
            data-conversation-id="${escapeHtml(conversation.id)}"
          >
            <div class="queue-item__top">
              <div class="queue-item__title">
                <strong>${escapeHtml(conversation.requesterName || "Unknown requester")}</strong>
                <span>${escapeHtml(requesterMeta)}</span>
              </div>
              ${unreadBadge}
            </div>
            <p class="queue-item__preview">${escapeHtml(preview || "No preview available")}</p>
            <div class="queue-item__bottom">
              <span>${escapeHtml(conversation.ownerName || "Owner unavailable")}</span>
              <span>${escapeHtml(formatDateTime(conversation.lastMessageAt || conversation.createdAt))}</span>
            </div>
          </button>
        `;
      })
      .join("");
  }

  function renderDetailCard() {
    // নির্বাচিত requester-এর identity, owner ও contact detail card-এ দেখায়।
    // নির্বাচিত conversation-এর customer/requester detail card দেখায়।
    if (!dom.detailList) {
      return;
    }

    const conversation = state.activeConversation;

    if (!conversation) {
      dom.detailList.innerHTML = `
        <div>
          <span>Requester</span>
          <strong>Select a conversation</strong>
        </div>
        <div>
          <span>Owner Account</span>
          <strong>Conversation details will appear here</strong>
        </div>
        <div>
          <span>Status</span>
          <strong>Waiting for selection</strong>
        </div>
      `;
      return;
    }

    const requesterLabel =
      conversation.requesterRole === "staff"
        ? `Staff login • ${conversation.requesterIdentifier || "username unavailable"}`
        : `Owner login • ${conversation.requesterIdentifier || "email unavailable"}`;
    const statusLabel =
      conversation.status === "closed"
        ? "Closed until the next user message"
        : "Open for developer reply";

    dom.detailList.innerHTML = `
      <div>
        <span>Requester</span>
        <strong>${escapeHtml(conversation.requesterName || "Unknown requester")}</strong>
        <small>${escapeHtml(requesterLabel)}</small>
      </div>
      <div>
        <span>Owner Account</span>
        <strong>${escapeHtml(conversation.ownerName || "Owner unavailable")}</strong>
        <small>${escapeHtml(conversation.ownerEmail || "No owner email available")}</small>
      </div>
      <div>
        <span>Status</span>
        <strong>${escapeHtml(statusLabel)}</strong>
        <small>Last update ${escapeHtml(formatDateTime(conversation.lastMessageAt || conversation.createdAt))}</small>
      </div>
    `;
  }

  function renderThreadEmpty() {
    // কোনো conversation select না থাকলে reply area-তে helpful empty state দেখায়।
    if (!dom.threadMessages) {
      return;
    }

    dom.threadMessages.innerHTML = `
      <div class="thread-empty">
        <i class="fa-solid fa-comments"></i>
        <strong>No support thread selected</strong>
        <p>Choose a conversation from the queue to open the full history here.</p>
      </div>
    `;
  }

  function renderThread() {
    // Selected conversation-এর messages, status এবং action state UI-তে render করে।
    // নির্বাচিত conversation-এর message thread নিরাপদভাবে render করে।
    const conversation = state.activeConversation;

    if (!conversation) {
      if (dom.threadTitle) {
        dom.threadTitle.textContent = "Select a support conversation";
      }

      if (dom.threadLead) {
        dom.threadLead.textContent =
          "Open a thread from the queue to read the full message history and send a reply.";
      }

      if (dom.threadStatusPill) {
        dom.threadStatusPill.innerHTML = `
          <i class="fa-solid fa-circle-nodes"></i>
          No thread selected
        `;
      }

      if (dom.threadOwnerPill) {
        dom.threadOwnerPill.innerHTML = `
          <i class="fa-solid fa-building"></i>
          Owner info pending
        `;
      }

      if (dom.threadUpdatedPill) {
        dom.threadUpdatedPill.innerHTML = `
          <i class="fa-solid fa-clock"></i>
          Waiting for activity
        `;
      }

      renderThreadEmpty();
      renderDetailCard();
      setReplyEnabled(false);
      return;
    }

    const requesterLabel =
      conversation.requesterRole === "staff"
        ? `Staff login using ${conversation.requesterIdentifier || "a staff username"}`
        : `Owner login using ${conversation.requesterIdentifier || "the registered email"}`;
    const statusLabel =
      conversation.status === "closed"
        ? "Closed until the user sends again"
        : "Open for reply";

    if (dom.threadTitle) {
      dom.threadTitle.textContent =
        conversation.requesterName || "Unknown requester";
    }

    if (dom.threadLead) {
      dom.threadLead.textContent = `${requesterLabel}. This thread is private to that same login.`;
    }

    if (dom.threadStatusPill) {
      dom.threadStatusPill.innerHTML = `
        <i class="fa-solid fa-circle-nodes"></i>
        ${escapeHtml(statusLabel)}
      `;
    }

    if (dom.threadOwnerPill) {
      dom.threadOwnerPill.innerHTML = `
        <i class="fa-solid fa-building"></i>
        ${escapeHtml(conversation.ownerName || "Owner unavailable")}
      `;
    }

    if (dom.threadUpdatedPill) {
      dom.threadUpdatedPill.innerHTML = `
        <i class="fa-solid fa-clock"></i>
        Updated ${escapeHtml(formatDateTime(conversation.lastMessageAt || conversation.createdAt))}
      `;
    }

    renderDetailCard();
    setReplyEnabled(true);

    if (!dom.threadMessages) {
      return;
    }

    if (!state.messages.length) {
      renderThreadEmpty();
      return;
    }

    dom.threadMessages.innerHTML = state.messages
      .map((message) => {
        const isDeveloper = message.senderType === "developer";
        const messageClass = isDeveloper
          ? "thread-message thread-message--developer"
          : "thread-message thread-message--user";
        const senderLabel = isDeveloper
          ? message.senderName || state.developer?.name || "Developer Support"
          : message.senderName || conversation.requesterName || "User";

        return `
          <article class="${messageClass}">
            <div class="thread-message__meta">
              <strong>${escapeHtml(senderLabel)}</strong>
              <span>${escapeHtml(formatDateTime(message.createdAt))}</span>
            </div>
            <div class="thread-message__bubble">
              <p>${formatMessageText(message.text)}</p>
            </div>
          </article>
        `;
      })
      .join("");

    dom.threadMessages.scrollTop = dom.threadMessages.scrollHeight;
  }

  async function loadConversations(options = {}) {
    // Server থেকে inbox conversation list নিয়ে filter/search/list UI refresh করে।
    // API থেকে inbox conversation list নিয়ে UI refresh করে।
    const data = await requestJSON("/developer-support/conversations");
    state.conversations = Array.isArray(data?.conversations)
      ? data.conversations
      : [];

    updateHeroStats();

    const filtered = getFilteredConversations();
    if (!filtered.some((item) => item.id === state.selectedConversationId)) {
      state.selectedConversationId = filtered[0]?.id || null;
    }

    renderFilterState();
    renderConversationList();
    renderConversationSearchDropdown();

    if (state.selectedConversationId && options.skipDetailLoad !== true) {
      await loadConversation(state.selectedConversationId, { silent: true });
    } else if (!state.selectedConversationId) {
      state.activeConversation = null;
      state.messages = [];
      renderThread();
    }

    return state.conversations;
  }

  async function loadConversation(conversationId, options = {}) {
    // নির্দিষ্ট thread detail ও messages API থেকে এনে selected state-এ রাখে।
    // নির্দিষ্ট conversation ও তার message detail API থেকে এনে দেখায়।
    if (!conversationId) {
      state.activeConversation = null;
      state.messages = [];
      renderThread();
      renderConversationList();
      return null;
    }

    try {
      const data = await requestJSON(
        `/developer-support/conversations/${conversationId}/messages`,
      );
      state.selectedConversationId = conversationId;
      state.activeConversation = data?.conversation || null;
      state.messages = Array.isArray(data?.messages) ? data.messages : [];
      renderConversationList();
      renderConversationSearchDropdown();
      renderThread();

      if (!options.silent) {
        setPageStatus("Support thread refreshed.");
      }

      return data;
    } catch (error) {
      if (!options.silent) {
        setPageStatus(
          error.message || "Support thread could not be loaded right now.",
          "error",
        );
      }
      throw error;
    }
  }

  async function refreshInbox(options = {}) {
    // Selected conversation বজায় রেখে inbox list ও active thread আবার load করে।
    // বর্তমান selection বজায় রেখে inbox list ও thread আবার load করে।
    const shouldAnimate = options.showRefreshAnimation === true;

    if (shouldAnimate) {
      setRefreshInboxLoading(true);
    }

    try {
      setPageStatus("Refreshing the support inbox...");
      await loadConversations();
      setPageStatus("Support inbox is up to date.", "success");
    } catch (error) {
      setPageStatus(
        error.message || "Support inbox could not be refreshed right now.",
        "error",
      );
    } finally {
      if (shouldAnimate) {
        setRefreshInboxLoading(false);
      }
    }
  }

  async function updateConversationStatus(status) {
    // Open বা closed status API-তে update করে UI-তে নতুন state দেখায়।
    // Open/closed status API-তে update করে UI refresh করে।
    if (!state.selectedConversationId) {
      setComposerStatus(
        "Select a conversation before updating its status.",
        "error",
      );
      return;
    }

    try {
      await requestJSON(
        `/developer-support/conversations/${state.selectedConversationId}/status`,
        {
          method: "PATCH",
          body: JSON.stringify({ status }),
        },
      );

      await loadConversations({ skipDetailLoad: true });
      await loadConversation(state.selectedConversationId, { silent: true });
      setComposerStatus(
        status === "closed"
          ? "Conversation marked closed. It will reopen when the user sends again."
          : "Conversation marked open for continued support.",
        "success",
      );
    } catch (error) {
      setComposerStatus(
        error.message || "Conversation status could not be updated right now.",
        "error",
      );
    }
  }

  async function submitReply() {
    // Developer reply validate করে API-তে পাঠিয়ে message thread refresh করে।
    // Typed developer reply validate করে selected conversation-এ পাঠায়।
    if (!state.selectedConversationId) {
      setComposerStatus(
        "Select a conversation before sending a reply.",
        "error",
      );
      return;
    }

    const message = String(dom.replyInput?.value || "")
      .replace(/\r/g, "")
      .trim();

    if (!message) {
      setComposerStatus(
        "Write a reply before sending it to the user.",
        "error",
      );
      dom.replyInput?.focus();
      return;
    }

    if (message.length > 2000) {
      setComposerStatus("Replies can be up to 2000 characters long.", "error");
      dom.replyInput?.focus();
      return;
    }

    const originalHtml = dom.replySendBtn?.innerHTML || "";

    try {
      if (dom.replySendBtn) {
        dom.replySendBtn.disabled = true;
        dom.replySendBtn.innerHTML =
          '<i class="fa-solid fa-spinner fa-spin"></i> Sending...';
      }

      setComposerStatus("Sending your developer reply...");

      await requestJSON(
        `/developer-support/conversations/${state.selectedConversationId}/reply`,
        {
          method: "POST",
          body: JSON.stringify({ message }),
        },
      );

      if (dom.replyInput) {
        dom.replyInput.value = "";
      }

      await loadConversations({ skipDetailLoad: true });
      await loadConversation(state.selectedConversationId, { silent: true });
      setComposerStatus(
        "Developer reply sent. The user will see it inside their private thread.",
        "success",
      );
    } catch (error) {
      setComposerStatus(
        error.message || "Developer reply could not be sent right now.",
        "error",
      );
    } finally {
      if (dom.replySendBtn) {
        dom.replySendBtn.disabled = false;
        dom.replySendBtn.innerHTML = originalHtml;
      }
    }
  }

  async function logoutDeveloper() {
    // Developer auth session server/local browser থেকে clear করে login page-এ ফেরায়।
    // Developer session logout করে login page-এ ফেরত পাঠায়।
    try {
      await requestJSON("/developer-auth/logout", { method: "POST" });
    } catch (_error) {
      // Redirect to login either way so the developer can recover quickly.
    } finally {
      clearStoredDeveloperToken();
      window.location.replace("developer-login.html");
    }
  }

  async function bootstrapPage() {
    // Developer identity check, initial inbox load ও first render পরিচালনা করে।
    // Initial developer identity check, event setup এবং inbox load পরিচালনা করে।
    const session = await requestJSON("/developer-auth/me");
    state.developer = session?.developer || null;

    if (dom.developerIdentityChip && state.developer) {
      dom.developerIdentityChip.innerHTML = `
        <i class="fa-solid fa-user-shield"></i>
        ${escapeHtml(state.developer.name || "Developer Support")}
      `;
    }

    await loadConversations();
    setPageStatus("Support inbox is ready.");
  }

  function handleQueueClick(event) {
    // Conversation list-এর delegated click থেকে কোন thread select হয়েছে নির্ধারণ করে।
    const item = event.target.closest("[data-conversation-id]");
    if (!item || !dom.conversationList?.contains(item)) {
      return;
    }

    const conversationId = Number(item.dataset.conversationId);
    if (!conversationId) {
      return;
    }

    loadConversation(conversationId).catch((error) => {
      setPageStatus(
        error.message || "Support thread could not be opened right now.",
        "error",
      );
    });
  }

  function bindEvents() {
    // Search, filters, status, reply, refresh, logout ও visibility event handler bind করে।
    // Search, reply, status, refresh এবং keyboard event handler বসায়।
    dom.refreshInboxBtn?.addEventListener("click", () =>
      refreshInbox({ showRefreshAnimation: true }),
    );
    dom.developerLogoutBtn?.addEventListener("click", logoutDeveloper);
    dom.conversationList?.addEventListener("click", handleQueueClick);
    dom.conversationSearchDropdown?.addEventListener("click", (event) => {
      const option = event.target.closest("[data-conversation-id]");
      if (!option || !dom.conversationSearchDropdown?.contains(option)) {
        return;
      }

      const conversationId = Number(option.dataset.conversationId);
      const conversation = state.conversations.find(
        (item) => item.id === conversationId,
      );

      if (!conversationId || !conversation) {
        return;
      }

      state.selectedConversationId = conversationId;
      dom.conversationSearch.value = buildConversationSearchValue(conversation);
      renderConversationList();
      hideConversationSearchDropdown();
      loadConversation(conversationId, { silent: true }).catch((error) => {
        setPageStatus(
          error.message || "Support thread could not be opened right now.",
          "error",
        );
      });
    });
    dom.replySendBtn?.addEventListener("click", submitReply);
    dom.markOpenBtn?.addEventListener("click", () =>
      updateConversationStatus("open"),
    );
    dom.markClosedBtn?.addEventListener("click", () =>
      updateConversationStatus("closed"),
    );

    dom.replyInput?.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        submitReply();
      }
    });

    dom.conversationSearch?.addEventListener("input", () => {
      const filtered = getFilteredConversations();
      if (!filtered.some((item) => item.id === state.selectedConversationId)) {
        state.selectedConversationId = filtered[0]?.id || null;
        if (state.selectedConversationId) {
          loadConversation(state.selectedConversationId, {
            silent: true,
          }).catch(() => {});
        } else {
          state.activeConversation = null;
          state.messages = [];
          renderThread();
        }
      }
      renderConversationList();
      renderConversationSearchDropdown();
    });

    dom.conversationSearch?.addEventListener("focus", () => {
      renderConversationSearchDropdown();
    });

    dom.conversationSearch?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideConversationSearchDropdown();
      }
    });

    getConversationFilters().forEach((button) => {
      button.addEventListener("click", () => {
        state.activeFilter = button.dataset.filter || "all";
        renderFilterState();

        const filtered = getFilteredConversations();
        if (
          !filtered.some((item) => item.id === state.selectedConversationId)
        ) {
          state.selectedConversationId = filtered[0]?.id || null;

          if (state.selectedConversationId) {
            loadConversation(state.selectedConversationId, {
              silent: true,
            }).catch(() => {});
          } else {
            state.activeConversation = null;
            state.messages = [];
            renderThread();
          }
        }

        renderConversationList();
        renderConversationSearchDropdown();
      });
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      const insideSearch =
        target instanceof Element && Boolean(target.closest(".search-shell"));

      if (!insideSearch) {
        hideConversationSearchDropdown();
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        refreshInbox();
      }
    });

    if (!state.pollTimer) {
      state.pollTimer = window.setInterval(async () => {
        if (document.hidden) {
          return;
        }

        try {
          await loadConversations({ skipDetailLoad: true });
          if (state.selectedConversationId) {
            await loadConversation(state.selectedConversationId, {
              silent: true,
            });
          }
        } catch (_error) {
          // Quiet polling keeps the current UI stable until a manual refresh.
        }
      }, 5000);
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    // Page ready হলে developer support inbox bootstrap শুরু করে।
    if (dom.currentYear) {
      dom.currentYear.textContent = String(new Date().getFullYear());
    }

    setReplyEnabled(false);
    bindEvents();
    bootstrapPage().catch((error) => {
      setPageStatus(
        error.message || "Developer support inbox could not be initialized.",
        "error",
      );
    });
  });
})();
