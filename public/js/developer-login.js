(function initDeveloperLoginPage() {
  // পড়ার নিয়ম: প্রতিটি বাংলা comment তার ঠিক উপরের সম্পূর্ণ code line বা code block-এর কাজ বোঝায়।
  const apiBase = window.location.origin.includes("localhost")
    ? "http://localhost:4000/api"
    : "/api";
  // Local ও production environment অনুযায়ী API base address নির্বাচন করে।
  const modeCopy = {
    login: {
      title: "Developer support login",
      lead: "Sign in with the developer admin email and password stored in the database. Successful login will open the support inbox.",
      note: "If you already have an active developer session, this page will send you directly to the support inbox.",
      status:
        "Use the developer admin email and password configured for support.",
    },
    register: {
      title: "Create developer account",
      lead: "Create a new developer admin account from this page using the private setup key. After the account is created, sign in with the same email and password.",
      note: "A valid private developer setup key is required before a new developer account can be created.",
      status:
        "Enter developer details and the private setup key to create the account.",
    },
  };
  // Login ও register mode-এ দেখানোর title, guide text ও status message।

  const state = {
    mode: "login",
  };
  // Page-এর বর্তমানে নির্বাচিত mode memory-তে রাখে।

  const dom = {
    accessTitle: document.getElementById("developerAccessTitle"),
    accessLead: document.getElementById("developerAccessLead"),
    supportNote: document.getElementById("developerSupportNote"),
    status: document.getElementById("developerStatus"),
    loginModeBtn: document.getElementById("developerLoginModeBtn"),
    registerModeBtn: document.getElementById("developerRegisterModeBtn"),
    loginForm: document.getElementById("developerLoginForm"),
    loginEmail: document.getElementById("developerEmail"),
    loginPassword: document.getElementById("developerPassword"),
    loginSubmit: document.getElementById("developerLoginBtn"),
    registerForm: document.getElementById("developerRegisterForm"),
    registerName: document.getElementById("developerRegisterName"),
    registerEmail: document.getElementById("developerRegisterEmail"),
    registerPassword: document.getElementById("developerRegisterPassword"),
    registerConfirmPassword: document.getElementById(
      "developerRegisterConfirmPassword",
    ),
    registerKey: document.getElementById("developerRegisterKey"),
    registerSubmit: document.getElementById("developerRegisterBtn"),
    currentYear: document.getElementById("currentYear"),
  };
  // প্রয়োজনীয় সব HTML element এক জায়গায় ধরে রাখে।

  function setStatus(message, tone = "info") {
    // Login/register form-এর নিচে tone-সহ user-facing status message দেখায়।
    if (!dom.status) {
      // Status element না থাকলে UI update করার কিছু নেই।
      return;
    }

    dom.status.textContent = message;
    // User-কে দেখানোর status text বসায়।
    dom.status.dataset.tone = tone;
    // CSS tone attribute দিয়ে info, success বা error style নির্বাচন করে।
  }

  function normalizeName(value) {
    // নামের অতিরিক্ত whitespace বাদ দিয়ে পরিষ্কার text ফেরত দেয়।
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeEmail(value) {
    // Email trim করে lowercase-এ রূপান্তর করে consistent login lookup নিশ্চিত করে।
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  function normalizeDeveloperAccessKey(value) {
    // Copy-paste থেকে আসা invisible character বাদ দিয়ে setup key পরিষ্কার করে।
    const rawValue = String(value || "");
    // Null/undefined হলেও নিরাপদে string input নেয়।
    const normalizedValue =
      typeof rawValue.normalize === "function"
        ? rawValue.normalize("NFKC")
        : rawValue;
    // Browser Unicode normalize support করলে visually similar character standard করে।

    // Mobile copy/paste can add invisible characters even when the key looks correct.
    return normalizedValue.replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, "");
  }

  function clearRegisterAccessKey() {
    // Mode বদলালে নিরাপত্তার জন্য register setup key field খালি করে।
    if (dom.registerKey) {
      // Register key input থাকলে তার sensitive value খালি করে।
      dom.registerKey.value = "";
    }
  }

  function setMode(mode, options = {}) {
    // Login অথবা register form দেখায় এবং সংশ্লিষ্ট UI text/button state মিলিয়ে দেয়।
    const normalizedMode = mode === "register" ? "register" : "login";
    // শুধু register mode আলাদা; অন্য value login হিসেবে safe fallback পায়।
    const copy = modeCopy[normalizedMode];
    // Selected mode-এর title, instruction ও status copy নেয়।

    state.mode = normalizedMode;
    // Current mode runtime state-এ রাখে।

    if (dom.loginForm) {
      // Login mode না হলে login form hidden করে।
      dom.loginForm.hidden = normalizedMode !== "login";
    }

    if (dom.registerForm) {
      // Register mode না হলে registration form hidden করে।
      dom.registerForm.hidden = normalizedMode !== "register";
    }

    if (dom.loginModeBtn) {
      // Login tab-এর active styling ও accessibility pressed state মিলিয়ে দেয়।
      const isActive = normalizedMode === "login";
      dom.loginModeBtn.classList.toggle("is-active", isActive);
      dom.loginModeBtn.setAttribute(
        "aria-pressed",
        isActive ? "true" : "false",
      );
    }

    if (dom.registerModeBtn) {
      // Register tab-এর active styling ও accessibility pressed state মিলিয়ে দেয়।
      const isActive = normalizedMode === "register";
      dom.registerModeBtn.classList.toggle("is-active", isActive);
      dom.registerModeBtn.setAttribute(
        "aria-pressed",
        isActive ? "true" : "false",
      );
    }

    if (dom.accessTitle) {
      // Selected mode-এর heading UI-তে বসায়।
      dom.accessTitle.textContent = copy.title;
    }

    if (dom.accessLead) {
      // Selected mode-এর main instruction UI-তে বসায়।
      dom.accessLead.textContent = copy.lead;
    }

    if (dom.supportNote) {
      // Selected mode-এর additional note UI-তে বসায়।
      dom.supportNote.textContent = copy.note;
    }

    if (!options.preserveStatus) {
      // Caller preserve না করলে mode-এর default status message reset করে।
      setStatus(copy.status);
    }

    if (normalizedMode !== "register") {
      // Register screen থেকে বেরোলে private setup key memory/input থেকে মুছে দেয়।
      clearRegisterAccessKey();
    }

    if (
      options.focusTarget &&
      typeof options.focusTarget.focus === "function"
    ) {
      // Caller নির্দিষ্ট focus target দিলে mode switch শেষে keyboard focus সেখানে দেয়।
      options.focusTarget.focus();
    }
  }

  async function requestJSON(path, options = {}) {
    // Developer API-তে credential-সহ JSON request পাঠিয়ে parsed success data ফেরত দেয়।
    const headers = { ...(options.headers || {}) };
    // Caller-এর optional header copy করে; original object mutate করে না।

    if (options.body && !headers["Content-Type"]) {
      // JSON body থাকলে content type আগে থেকে না দেওয়া থাকলে সেট করে।
      headers["Content-Type"] = "application/json";
    }

    const requestOptions = {
      ...options,
      credentials: "include",
      headers,
      cache: "no-store",
    };
    // Cookie credential, header ও cache policy-সহ fetch-ready option object তৈরি করে।

    const response = await fetch(`${apiBase}${path}`, {
      ...requestOptions,
    });
    // Developer auth API-তে network request পাঠায়।

    let payload = {};
    try {
      // Response JSON না হলেও fallback দিয়ে UI crash হওয়া ঠেকায়।
      payload = await response.json();
    } catch (_error) {
      payload = {};
    }

    if (!response.ok) {
      // HTTP failure হলে backend error message-সহ Error ছোড়ে।
      throw new Error(payload.error || payload.message || "Request failed");
    }

    return payload;
  }

  async function checkExistingSession() {
    // Active developer session থাকলে login page এড়িয়ে support inbox-এ পাঠায়।
    try {
      // Existing developer session থাকলে API response থেকে সেটি যাচাই করে।
      const data = await requestJSON("/developer-auth/me");
      if (data?.developer) {
        // Already logged in হলে login form বাদ দিয়ে support inbox খোলে।
        window.location.replace("developer-support.html");
      }
    } catch (_error) {
      // Session না থাকলে login screen-এই থাকা প্রত্যাশিত behavior।
      // Stay on the login form when there is no active developer session.
    }
  }

  async function handleLoginSubmit(event) {
    // Login form submit-এর input validate করে API login request চালায়।
    event.preventDefault();
    // Browser-এর default form submit/page reload বন্ধ করে async login flow চালায়।

    const email = normalizeEmail(dom.loginEmail?.value || "");
    // Email input থেকে cleaned lowercase email নেয়।
    const password = String(dom.loginPassword?.value || "");
    // Password input নিরাপদ string হিসেবে নেয়।

    if (!email || !password) {
      // কোনো required login field খালি থাকলে request না পাঠিয়ে focusসহ error দেখায়।
      setStatus("Enter the developer admin email and password.", "error");
      if (!email) {
        dom.loginEmail?.focus();
      } else {
        dom.loginPassword?.focus();
      }
      return;
    }

    const originalHtml = dom.loginSubmit?.innerHTML || "";
    // Loading শেষ হলে restore করার জন্য button-এর original content রাখে।

    try {
      if (dom.loginSubmit) {
        // Duplicate submit আটকাতে button disable ও loading UI দেখায়।
        dom.loginSubmit.disabled = true;
        dom.loginSubmit.innerHTML =
          '<i class="fa-solid fa-spinner fa-spin"></i> Signing In...';
      }

      setStatus(
        "Checking developer credentials and opening the support inbox...",
      );

      await requestJSON("/developer-auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      // Email/password server-এ পাঠিয়ে developer login session cookie তৈরি করে।

      await requestJSON("/developer-auth/me");
      // Login হওয়ার পর session endpoint দিয়ে নতুন cookie/session নিশ্চিত করে।

      setStatus(
        "Developer login successful. Redirecting to the inbox...",
        "success",
      );
      window.setTimeout(() => {
        window.location.replace("developer-support.html");
      }, 250);
      // Success message দেখানোর ছোট সময় দিয়ে support inbox-এ redirect করে।
    } catch (error) {
      // Network বা authentication failure হলে readable error status দেখায়।
      setStatus(
        error.message || "Developer login could not be completed right now.",
        "error",
      );
    } finally {
      // Success বা failure সব ক্ষেত্রেই login button আবার usable state-এ ফেরত দেয়।
      if (dom.loginSubmit) {
        dom.loginSubmit.disabled = false;
        dom.loginSubmit.innerHTML = originalHtml;
      }
    }
  }

  async function handleRegisterSubmit(event) {
    // Private setup key-সহ নতুন developer admin register করার form flow নিয়ন্ত্রণ করে।
    event.preventDefault();
    // Browser-এর normal form submit বন্ধ করে async account registration flow চালায়।

    const name = normalizeName(dom.registerName?.value || "");
    // Name input-এর duplicate whitespace বাদ দিয়ে নেয়।
    const email = normalizeEmail(dom.registerEmail?.value || "");
    const password = String(dom.registerPassword?.value || "");
    const confirmPassword = String(dom.registerConfirmPassword?.value || "");
    const accessKey = normalizeDeveloperAccessKey(dom.registerKey?.value || "");
    // Setup key-এর invisible copy-paste character বাদ দিয়ে validation-এর জন্য নেয়।

    if (dom.registerName) {
      // Cleaned name আবার input-এ দেখায়, যাতে user বুঝতে পারে কী submit হবে।
      dom.registerName.value = name;
    }

    if (dom.registerKey) {
      // Cleaned setup key input-এ ফিরিয়ে রাখে।
      dom.registerKey.value = accessKey;
    }

    if (!name || !email || !password || !confirmPassword || !accessKey) {
      // কোনো required registration field missing হলে API request বাদ দিয়ে প্রথম missing field focus করে।
      setStatus(
        "Enter name, email, password, confirm password, and the developer key.",
        "error",
      );

      if (!name) {
        dom.registerName?.focus();
      } else if (!email) {
        dom.registerEmail?.focus();
      } else if (!password) {
        dom.registerPassword?.focus();
      } else if (!confirmPassword) {
        dom.registerConfirmPassword?.focus();
      } else {
        dom.registerKey?.focus();
      }

      return;
    }

    if (name.length < 2) {
      // খুব ছোট নাম server-এ পাঠানোর আগে client-side validation করে।
      setStatus("Developer name must be at least 2 characters long.", "error");
      dom.registerName?.focus();
      return;
    }

    if (password.length < 6) {
      // Minimum password length client-side-এ যাচাই করে।
      setStatus("Password must be at least 6 characters long.", "error");
      dom.registerPassword?.focus();
      return;
    }

    if (password !== confirmPassword) {
      // Confirm password মূল password-এর সঙ্গে মিলেছে কি না দেখে।
      setStatus("Confirm password must match the password above.", "error");
      dom.registerConfirmPassword?.focus();
      return;
    }

    const originalHtml = dom.registerSubmit?.innerHTML || "";
    // Registration শেষ হলে restore করার জন্য submit button-এর original markup রাখে।

    try {
      if (dom.registerSubmit) {
        // Submit চলাকালীন duplicate account create আটকাতে button disable করে।
        dom.registerSubmit.disabled = true;
        dom.registerSubmit.innerHTML =
          '<i class="fa-solid fa-spinner fa-spin"></i> Creating...';
      }

      setStatus("Checking the developer key and creating the account...");

      const payload = await requestJSON("/developer-auth/register", {
        method: "POST",
        body: JSON.stringify({
          name,
          email,
          password,
          confirmPassword,
          accessKey,
        }),
      });
      // Name, email, password ও private setup key server-এ পাঠিয়ে account তৈরি করে।

      dom.registerForm?.reset();
      // সফল account creation-এর পরে registration form-এর visible field পরিষ্কার করে।
      clearRegisterAccessKey();

      if (dom.loginEmail) {
        // নতুন account-এর email login form-এ prefill করে দ্রুত sign-in সহজ করে।
        dom.loginEmail.value = email;
      }

      setMode("login", {
        preserveStatus: true,
      });
      // Registration শেষে user-কে login mode-এ নিয়ে যায়।
      setStatus(
        payload?.message ||
          "Developer account created. Sign in with the same email and password.",
        "success",
      );
      dom.loginPassword?.focus();
    } catch (error) {
      // Registration/API error হলে user-friendly status message তৈরি করে।
      const message = String(error?.message || "").trim();
      const isInvalidAccessKey = message
        .toLowerCase()
        .includes("invalid developer access key");
      // Invalid setup key error আলাদা করে চিহ্নিত করে mobile copy-paste সাহায্য দেখায়।

      setStatus(
        isInvalidAccessKey
          ? "Developer access key did not match. If you're on mobile, type it once manually to avoid hidden copy/paste characters."
          : message || "Developer account could not be created right now.",
        "error",
      );

      if (isInvalidAccessKey) {
        dom.registerKey?.focus();
      }
    } finally {
      // ফল যাই হোক sensitive setup key মুছে এবং submit button normal করে।
      clearRegisterAccessKey();

      if (dom.registerSubmit) {
        dom.registerSubmit.disabled = false;
        dom.registerSubmit.innerHTML = originalHtml;
      }
    }
  }

  function bindPasswordToggles() {
    // Password field-এর show/hide toggle buttonগুলো bind করে।
    document.querySelectorAll("[data-toggle-password]").forEach((toggle) => {
      // প্রতিটি password visibility button-এর জন্য তার target input ও icon খুঁজে bind করে।
      const targetInput = document.getElementById(
        toggle.dataset.togglePassword,
      );
      // data attribute-এ দেওয়া ID দিয়ে সংশ্লিষ্ট password input নেয়।
      const icon = toggle.querySelector("i");
      // Toggle button-এর eye icon element নেয়।

      if (!targetInput || !icon) {
        // প্রয়োজনীয় input বা icon না থাকলে সেই broken toggle বাদ দেয়।
        return;
      }

      const syncToggleState = () => {
        // Password visible/hidden state অনুযায়ী icon, button class এবং ARIA label মিলিয়ে দেয়।
        const isHidden = targetInput.type === "password";
        icon.classList.toggle("fa-eye", isHidden);
        icon.classList.toggle("fa-eye-slash", !isHidden);
        toggle.classList.toggle("active", !isHidden);
        toggle.setAttribute(
          "aria-label",
          isHidden ? "Show password" : "Hide password",
        );
      };

      syncToggleState();
      // Initial page state-এর সঙ্গে eye icon state মিলিয়ে নেয়।
      toggle.addEventListener("click", () => {
        // Click করলে password input type password ও text-এর মধ্যে toggle করে।
        targetInput.type =
          targetInput.type === "password" ? "text" : "password";
        syncToggleState();
      });
    });
  }

  function bindModeSwitch() {
    // Login ও register tab button-এ mode switch click handler বসায়।
    dom.loginModeBtn?.addEventListener("click", () => {
      // Login tab click করলে login form দেখিয়ে email/password field focus করে।
      setMode("login", { focusTarget: dom.loginEmail || dom.loginPassword });
    });

    dom.registerModeBtn?.addEventListener("click", () => {
      // Register tab click করলে register form দেখিয়ে name/email field focus করে।
      setMode("register", {
        focusTarget: dom.registerName || dom.registerEmail,
      });
    });
  }

  window.addEventListener("DOMContentLoaded", () => {
    // Page DOM প্রস্তুত হলে form event bind, current year এবং session check শুরু করে।
    if (dom.currentYear) {
      // Footer year element থাকলে browser-এর বর্তমান বছর বসায়।
      dom.currentYear.textContent = String(new Date().getFullYear());
    }

    bindPasswordToggles();
    // সব password show/hide button interactive করে।
    bindModeSwitch();
    // Login/register tab switch interactive করে।
    setMode("login", { preserveStatus: false });
    // Page প্রথম খুললে login mode ও তার guide/status দেখায়।

    dom.loginForm?.addEventListener("submit", handleLoginSubmit);
    // Login form submit হলে custom async login handler চালায়।
    dom.registerForm?.addEventListener("submit", handleRegisterSubmit);
    // Registration form submit হলে custom async registration handler চালায়।

    checkExistingSession();
    // Existing authenticated developer session থাকলে inbox-এ redirect পরীক্ষা করে।
  });
})();
