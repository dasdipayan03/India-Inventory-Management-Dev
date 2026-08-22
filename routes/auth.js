const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const pool = require("../db");
const {
  DEFAULT_STAFF_PERMISSIONS,
  STAFF_PAGE_PERMISSIONS,
  normalizePermissions,
} = require("../public/js/permission-contract");
const {
  authMiddleware,
  getUserId,
  invalidateStaffSessionCache,
  requireOwner,
} = require("../middleware/auth");
// aa

const router = express.Router();

const SESSION_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const RESET_TOKEN_BYTES = 32;
const GOOGLE_OAUTH_STATE_COOKIE = "google_oauth_state";
const GOOGLE_ONBOARDING_COOKIE = "google_onboarding";
const GOOGLE_OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const GOOGLE_ONBOARDING_MAX_AGE_MS = 15 * 60 * 1000;
const GOOGLE_OAUTH_CALLBACK_RESULT_MAX_AGE_MS = 5 * 60 * 1000;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const ANDROID_GOOGLE_CLIENT = "android";
const ANDROID_GOOGLE_DEEP_LINK_BASE = "indiainventory://google-auth";
const ANDROID_APP_PACKAGE_NAME = "india.inventory.management";
const OWNER_NAME_MAX_LENGTH = 50;
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,30}$/;
const MOBILE_NUMBER_PATTERN = /^\d{10}$/;
const PUBLIC_BASE_URL = normalizeBaseUrl(process.env.BASE_URL);
const androidGoogleCallbackResults = new Map();

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET not found in environment variables.");
  process.exit(1);
}

const loginAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error: "Too many login attempts. Please wait 15 minutes and try again.",
  },
});

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      "Too many password reset attempts. Please wait a few minutes and try again.",
  },
});

function normalizeBaseUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  try {
    return new URL(rawValue).toString().replace(/\/+$/, "");
  } catch (_error) {
    return "";
  }
}

function resolvePublicBaseUrl(req) {
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("BASE_URL must be configured in production");
  }

  return `${req.protocol}://${req.get("host")}`;
}

function getSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

function setTemporaryCookie(res, name, value, maxAge) {
  res.cookie(name, value, {
    ...getSessionCookieOptions(),
    maxAge,
  });
}

function clearGoogleOAuthStateCookie(res) {
  res.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, getSessionCookieOptions());
}

function clearGoogleOnboardingCookie(res) {
  res.clearCookie(GOOGLE_ONBOARDING_COOKIE, getSessionCookieOptions());
}

function hashResetToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || ""))
    .digest("hex");
}

function markSensitiveResponse(res) {
  res.set("Cache-Control", "no-store");
}

function normalizeName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeMobileNumber(value) {
  const digits = String(value || "").replace(/\D+/g, "");

  if (digits.length === 12 && digits.startsWith("91")) {
    return digits.slice(2);
  }

  if (digits.length === 11 && digits.startsWith("0")) {
    return digits.slice(1);
  }

  return digits;
}

function isValidMobileNumber(value) {
  return MOBILE_NUMBER_PATTERN.test(value);
}

function normalizeUsername(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function signSession(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "3d" });
}

function normalizeGoogleOAuthClient(value) {
  return String(value || "")
    .trim()
    .toLowerCase() === ANDROID_GOOGLE_CLIENT
    ? ANDROID_GOOGLE_CLIENT
    : "web";
}

function signGoogleOAuthState(client) {
  return jwt.sign(
    {
      type: "google_oauth_state",
      nonce: crypto.randomBytes(16).toString("hex"),
      client: normalizeGoogleOAuthClient(client),
    },
    process.env.JWT_SECRET,
    { expiresIn: "10m" },
  );
}

function readGoogleOAuthState(state) {
  try {
    const decoded = jwt.verify(state, process.env.JWT_SECRET);
    if (decoded.type !== "google_oauth_state" || !decoded.nonce) {
      return null;
    }

    return {
      client: normalizeGoogleOAuthClient(decoded.client),
    };
  } catch (_error) {
    return null;
  }
}

function pruneAndroidGoogleCallbackResults() {
  const now = Date.now();
  for (const [state, result] of androidGoogleCallbackResults.entries()) {
    if (!result || result.expiresAt <= now) {
      androidGoogleCallbackResults.delete(state);
    }
  }
}

function rememberAndroidGoogleCallbackResult(state, transferToken) {
  const normalizedState = String(state || "").trim();
  const normalizedTransferToken = String(transferToken || "").trim();
  if (!normalizedState || !normalizedTransferToken) {
    return;
  }

  pruneAndroidGoogleCallbackResults();
  androidGoogleCallbackResults.set(normalizedState, {
    transferToken: normalizedTransferToken,
    expiresAt: Date.now() + GOOGLE_OAUTH_CALLBACK_RESULT_MAX_AGE_MS,
  });
}

function readAndroidGoogleCallbackResult(state) {
  const normalizedState = String(state || "").trim();
  if (!normalizedState) {
    return null;
  }

  pruneAndroidGoogleCallbackResults();
  return androidGoogleCallbackResults.get(normalizedState) || null;
}

function signAndroidGoogleTransfer(payload) {
  return jwt.sign(
    {
      type: "android_google_transfer",
      ...payload,
    },
    process.env.JWT_SECRET,
    { expiresIn: "5m" },
  );
}

function verifyAndroidGoogleTransfer(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.type !== "android_google_transfer") {
    throw new Error("Invalid Android Google transfer token");
  }

  return decoded;
}

function signGoogleOnboarding(profile) {
  return jwt.sign(
    {
      type: "google_onboarding",
      sub: profile.sub,
      email: profile.email,
      name: profile.name,
      picture: profile.picture || "",
    },
    process.env.JWT_SECRET,
    { expiresIn: "15m" },
  );
}

function verifyGoogleOnboardingToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.type !== "google_onboarding") {
    throw new Error("Invalid Google onboarding token");
  }

  return {
    sub: String(decoded.sub || "").trim(),
    email: normalizeEmail(decoded.email),
    name: normalizeName(decoded.name),
    picture: String(decoded.picture || "").trim(),
  };
}

function setSessionCookie(res, token) {
  res.cookie("token", token, {
    ...getSessionCookieOptions(),
    maxAge: SESSION_MAX_AGE_MS,
  });
}

function clearSessionCookie(res) {
  res.clearCookie("token", getSessionCookieOptions());
}

function getGoogleOAuthConfig(req) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const configuredRedirectUri = String(
    process.env.GOOGLE_REDIRECT_URI || "",
  ).trim();
  const redirectUri =
    configuredRedirectUri ||
    `${resolvePublicBaseUrl(req)}/api/auth/google/callback`;

  if (!clientId || !clientSecret) {
    return null;
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
  };
}

function buildLoginRedirectUrl(req, params = {}) {
  const url = new URL(`${resolvePublicBaseUrl(req)}/login.html`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

function buildAndroidGoogleDeepLink(req, transferToken) {
  const url = new URL(ANDROID_GOOGLE_DEEP_LINK_BASE);
  url.searchParams.set("transfer", transferToken);
  url.searchParams.set("origin", resolvePublicBaseUrl(req));
  return url.toString();
}

function buildAndroidGoogleOpenUrl(req, transferToken) {
  const url = new URL(
    `${resolvePublicBaseUrl(req)}/api/auth/google/android-open`,
  );
  url.searchParams.set("transfer", transferToken);
  return url.toString();
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

function scriptJson(value) {
  return JSON.stringify(String(value || "")).replace(/</g, "\\u003c");
}

function buildAndroidGoogleIntentLink(req, transferToken) {
  const deepLink = new URL(buildAndroidGoogleDeepLink(req, transferToken));
  const fallbackUrl = buildAndroidGoogleOpenUrl(req, transferToken);
  const intentTarget = `${deepLink.host}${deepLink.pathname}${deepLink.search}`;
  return `intent://${intentTarget}#Intent;scheme=${deepLink.protocol.replace(
    ":",
    "",
  )};package=${ANDROID_APP_PACKAGE_NAME};S.browser_fallback_url=${encodeURIComponent(
    fallbackUrl,
  )};end`;
}

function sendAndroidGoogleReturnPage(req, res, transferToken) {
  markSensitiveResponse(res);
  return res.redirect(buildAndroidGoogleIntentLink(req, transferToken));
}

function renderAndroidGoogleOpenPage(req, res, transferToken) {
  const deepLink = buildAndroidGoogleDeepLink(req, transferToken);
  const intentLink = buildAndroidGoogleIntentLink(req, transferToken);
  const nonce = res.locals.cspNonce || "";

  markSensitiveResponse(res);
  return res.status(200).type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="5;url=${escapeHtml(intentLink)}" />
    <title>Returning to app</title>
    <style nonce="${escapeHtml(nonce)}">
      :root {
        color-scheme: light;
        font-family: Arial, sans-serif;
        background: #f3f8fb;
        color: #122744;
      }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      main {
        width: min(420px, 100%);
        padding: 24px;
        border: 1px solid #d4e8f2;
        border-radius: 14px;
        background: #fff;
        box-shadow: 0 18px 42px rgba(12, 31, 59, 0.12);
        text-align: center;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 22px;
      }
      p {
        margin: 0 0 18px;
        color: #5c6f86;
        line-height: 1.5;
      }
      a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        padding: 0 18px;
        border-radius: 10px;
        background: #0878b8;
        color: #fff;
        font-weight: 700;
        text-decoration: none;
      }
      .secondary {
        display: block;
        margin-top: 14px;
        min-height: auto;
        padding: 0;
        border-radius: 0;
        background: transparent;
        color: #0878b8;
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Returning to app</h1>
      <p>Google sign-in is complete. Tap Open app if it does not open automatically.</p>
      <a id="openApp" href="${escapeHtml(intentLink)}">Open app</a>
      <a class="secondary" id="openAppFallback" href="${escapeHtml(deepLink)}">Try alternate link</a>
    </main>
    <script nonce="${escapeHtml(nonce)}">
      const intentUrl = ${scriptJson(intentLink)};
      const deepLinkUrl = ${scriptJson(deepLink)};
      window.location.href = intentUrl;
      window.setTimeout(() => {
        window.location.href = deepLinkUrl;
      }, 1400);
    </script>
  </body>
</html>`);
}

async function exchangeGoogleCodeForTokens(code, config) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (_error) {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(
      payload.error_description ||
        payload.error ||
        "Google token exchange failed",
    );
  }

  return payload;
}

async function fetchGoogleUserProfile(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (_error) {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error_description || "Google profile fetch failed");
  }

  const email = normalizeEmail(payload.email);
  const emailVerified =
    payload.email_verified === true ||
    payload.email_verified === "true" ||
    payload.verified_email === true ||
    payload.verified_email === "true";
  const sub = String(payload.sub || "").trim();
  const name =
    normalizeName(payload.name || payload.given_name) ||
    normalizeName(email.split("@")[0] || "Google User");

  if (!sub || !email || !emailVerified) {
    throw new Error("Google account email could not be verified");
  }

  return {
    sub,
    email,
    name,
    picture: String(payload.picture || "").trim(),
  };
}

function normalizeSessionRole(value) {
  return String(value || "")
    .trim()
    .toLowerCase() === "staff"
    ? "staff"
    : "owner";
}

function buildOwnerSession(user) {
  return {
    actorId: user.id,
    ownerId: user.id,
    role: "owner",
    accountType: "owner",
    name: user.name,
    email: user.email,
    ownerName: user.name,
  };
}

function buildStaffSession(staff) {
  return {
    actorId: staff.id,
    staffId: staff.id,
    ownerId: staff.owner_user_id,
    role: "staff",
    accountType: "staff",
    name: staff.name,
    username: staff.username,
    ownerName: staff.owner_name,
    ownerEmail: staff.owner_email,
    permissions: normalizePermissions(
      staff.page_permissions || DEFAULT_STAFF_PERMISSIONS,
    ),
  };
}

function toClientUser(session) {
  const normalizedRole = normalizeSessionRole(session.role);
  return {
    id: session.actorId,
    actorId: session.actorId,
    ownerId: session.ownerId,
    role: normalizedRole,
    accountType: normalizedRole,
    name: session.name,
    email: session.email || null,
    username: session.username || null,
    ownerName: session.ownerName || session.name,
    permissions:
      normalizedRole === "owner"
        ? ["all"]
        : normalizePermissions(
            session.permissions || DEFAULT_STAFF_PERMISSIONS,
          ),
  };
}

async function getOwnersByIdentifier(identifier) {
  const rawIdentifier = String(identifier || "").trim();
  const email = normalizeEmail(rawIdentifier);
  const mobileNumber = rawIdentifier.includes("@")
    ? ""
    : normalizeMobileNumber(rawIdentifier);
  const result = await pool.query(
    `SELECT id, name, email, mobile_number, password_hash
     FROM users
     WHERE LOWER(email) = LOWER($1)
        OR ($2 <> '' AND mobile_number = $2)
     ORDER BY id ASC
     LIMIT 2`,
    [email, isValidMobileNumber(mobileNumber) ? mobileNumber : ""],
  );

  return result.rows;
}

async function getStaffByUsername(username) {
  const result = await pool.query(
    `
      SELECT
        s.id,
        s.owner_user_id,
        s.name,
        s.username,
        s.password_hash,
        s.page_permissions,
        s.is_active,
        u.name AS owner_name,
        u.email AS owner_email
      FROM staff_accounts s
      JOIN users u ON u.id = s.owner_user_id
      WHERE LOWER(TRIM(s.username)) = LOWER(TRIM($1))
      LIMIT 1
    `,
    [username],
  );

  return result.rows[0] || null;
}

async function getOwnerByGoogleProfile(profile) {
  const result = await pool.query(
    `
      SELECT id, name, email, mobile_number, password_hash, google_sub
      FROM users
      WHERE google_sub = $1 OR LOWER(email) = LOWER($2)
      ORDER BY
        CASE WHEN google_sub = $1 THEN 0 ELSE 1 END,
        id ASC
      LIMIT 2
    `,
    [profile.sub, profile.email],
  );

  const subMatch = result.rows.find((row) => row.google_sub === profile.sub);
  const emailMatch = result.rows.find(
    (row) => normalizeEmail(row.email) === profile.email,
  );

  if (subMatch && emailMatch && subMatch.id !== emailMatch.id) {
    throw new Error(
      "This Google account is linked to a different owner account.",
    );
  }

  return subMatch || emailMatch || null;
}

async function linkGoogleProfileToOwner(user, profile) {
  if (user.google_sub && user.google_sub !== profile.sub) {
    throw new Error(
      "This email is already linked with another Google account.",
    );
  }

  const result = await pool.query(
    `
      UPDATE users
      SET google_sub = COALESCE(google_sub, $2),
          google_email_verified = TRUE,
          google_picture_url = CASE
            WHEN $3 <> '' THEN $3
            ELSE google_picture_url
          END,
          is_verified = TRUE,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, email, mobile_number, password_hash, google_sub
    `,
    [user.id, profile.sub, profile.picture || ""],
  );

  return result.rows[0];
}

async function createOwnerFromGoogleProfile(profile, shopName, mobileNumber) {
  const passwordHash = await bcrypt.hash(
    crypto.randomBytes(32).toString("hex"),
    12,
  );
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(
      `
        INSERT INTO users (
          name,
          email,
          mobile_number,
          password_hash,
          is_verified,
          google_sub,
          google_email_verified,
          google_picture_url
        )
        VALUES ($1, $2, $3, $4, TRUE, $5, TRUE, NULLIF($6, ''))
        RETURNING id, name, email, mobile_number, password_hash, google_sub
      `,
      [
        shopName,
        profile.email,
        mobileNumber,
        passwordHash,
        profile.sub,
        profile.picture || "",
      ],
    );

    const user = userResult.rows[0];

    await client.query(
      `
        INSERT INTO settings (user_id, shop_name)
        VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE
        SET shop_name = EXCLUDED.shop_name
      `,
      [user.id, shopName],
    );

    await client.query("COMMIT");
    return user;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

router.get("/google/start", loginAttemptLimiter, async (req, res) => {
  try {
    const config = getGoogleOAuthConfig(req);
    if (!config) {
      return res.redirect(
        buildLoginRedirectUrl(req, {
          google_error:
            "Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
        }),
      );
    }

    const client = normalizeGoogleOAuthClient(req.query.client);
    const state = signGoogleOAuthState(client);
    const authUrl = new URL(GOOGLE_AUTH_URL);
    authUrl.searchParams.set("client_id", config.clientId);
    authUrl.searchParams.set("redirect_uri", config.redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid email profile");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("prompt", "select_account");
    authUrl.searchParams.set("access_type", "online");
    authUrl.searchParams.set("include_granted_scopes", "false");

    markSensitiveResponse(res);
    clearSessionCookie(res);
    clearGoogleOnboardingCookie(res);
    setTemporaryCookie(
      res,
      GOOGLE_OAUTH_STATE_COOKIE,
      state,
      GOOGLE_OAUTH_STATE_MAX_AGE_MS,
    );

    return res.redirect(authUrl.toString());
  } catch (error) {
    console.error("Google sign-in start error:", error.message);
    return res.redirect(
      buildLoginRedirectUrl(req, {
        google_error: "Google sign-in could not start. Please try again.",
      }),
    );
  }
});

router.get("/google/callback", async (req, res) => {
  try {
    markSensitiveResponse(res);

    const googleError = String(req.query.error || "").trim();
    if (googleError) {
      clearGoogleOAuthStateCookie(res);
      return res.redirect(
        buildLoginRedirectUrl(req, {
          google_error: "Google sign-in was cancelled or denied.",
        }),
      );
    }

    const code = String(req.query.code || "").trim();
    const state = String(req.query.state || "").trim();
    const expectedState = String(
      req.cookies?.[GOOGLE_OAUTH_STATE_COOKIE] || "",
    ).trim();
    clearGoogleOAuthStateCookie(res);

    const oauthState = readGoogleOAuthState(state);
    const stateMatchesCookie = expectedState && state === expectedState;
    const stateMatchesSignature = Boolean(oauthState);

    if (!code || !state || (!stateMatchesCookie && !stateMatchesSignature)) {
      return res.redirect(
        buildLoginRedirectUrl(req, {
          google_error: "Google sign-in expired. Please try again.",
        }),
      );
    }

    if (oauthState?.client === ANDROID_GOOGLE_CLIENT) {
      const cachedAndroidResult = readAndroidGoogleCallbackResult(state);
      if (cachedAndroidResult?.transferToken) {
        return sendAndroidGoogleReturnPage(
          req,
          res,
          cachedAndroidResult.transferToken,
        );
      }
    }

    const config = getGoogleOAuthConfig(req);
    if (!config) {
      return res.redirect(
        buildLoginRedirectUrl(req, {
          google_error:
            "Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
        }),
      );
    }

    const tokens = await exchangeGoogleCodeForTokens(code, config);
    const accessToken = String(tokens.access_token || "").trim();
    if (!accessToken) {
      throw new Error("Google did not return an access token");
    }

    const profile = await fetchGoogleUserProfile(accessToken);
    const existingUser = await getOwnerByGoogleProfile(profile);
    const isAndroidClient = oauthState?.client === ANDROID_GOOGLE_CLIENT;

    if (existingUser) {
      const linkedUser = await linkGoogleProfileToOwner(existingUser, profile);
      const session = buildOwnerSession(linkedUser);
      if (isAndroidClient) {
        const transferToken = signAndroidGoogleTransfer({
          mode: "session",
          session,
        });
        rememberAndroidGoogleCallbackResult(state, transferToken);
        return sendAndroidGoogleReturnPage(req, res, transferToken);
      }

      const token = signSession(session);
      clearGoogleOnboardingCookie(res);
      setSessionCookie(res, token);
      return res.redirect(`${resolvePublicBaseUrl(req)}/index.html`);
    }

    if (isAndroidClient) {
      const transferToken = signAndroidGoogleTransfer({
        mode: "onboarding",
        profile,
      });
      rememberAndroidGoogleCallbackResult(state, transferToken);
      return sendAndroidGoogleReturnPage(req, res, transferToken);
    }

    const onboardingToken = signGoogleOnboarding(profile);
    setTemporaryCookie(
      res,
      GOOGLE_ONBOARDING_COOKIE,
      onboardingToken,
      GOOGLE_ONBOARDING_MAX_AGE_MS,
    );

    return res.redirect(buildLoginRedirectUrl(req, { google_onboarding: "1" }));
  } catch (error) {
    console.error("Google sign-in callback error:", error.message);
    clearGoogleOnboardingCookie(res);
    const errorMessage = /bad request|invalid_grant/i.test(error.message || "")
      ? "Google sign-in expired. Please select your Google account again."
      : error.message || "Google sign-in could not be completed.";
    return res.redirect(
      buildLoginRedirectUrl(req, {
        google_error: errorMessage,
      }),
    );
  }
});

router.get("/google/android-open", async (req, res) => {
  const transferToken = String(req.query.transfer || "").trim();
  if (!transferToken) {
    return res.redirect(
      buildLoginRedirectUrl(req, {
        google_error: "Google sign-in expired. Please try again.",
      }),
    );
  }

  return renderAndroidGoogleOpenPage(req, res, transferToken);
});

router.get("/google/android-transfer", async (req, res) => {
  try {
    markSensitiveResponse(res);
    const transferToken = String(req.query.transfer || "").trim();
    if (!transferToken) {
      return res.redirect(
        buildLoginRedirectUrl(req, {
          google_error: "Google sign-in expired. Please try again.",
        }),
      );
    }

    const transfer = verifyAndroidGoogleTransfer(transferToken);
    if (transfer.mode === "session" && transfer.session) {
      const sessionToken = signSession(transfer.session);
      clearGoogleOnboardingCookie(res);
      setSessionCookie(res, sessionToken);
      return res.redirect(`${resolvePublicBaseUrl(req)}/index.html`);
    }

    if (transfer.mode === "onboarding" && transfer.profile) {
      const onboardingToken = signGoogleOnboarding(transfer.profile);
      clearSessionCookie(res);
      setTemporaryCookie(
        res,
        GOOGLE_ONBOARDING_COOKIE,
        onboardingToken,
        GOOGLE_ONBOARDING_MAX_AGE_MS,
      );
      return res.redirect(
        buildLoginRedirectUrl(req, { google_onboarding: "1" }),
      );
    }

    throw new Error("Unsupported Android Google transfer mode");
  } catch (error) {
    console.error("Android Google transfer error:", error.message);
    clearGoogleOnboardingCookie(res);
    return res.redirect(
      buildLoginRedirectUrl(req, {
        google_error: "Google sign-in expired. Please try again.",
      }),
    );
  }
});

router.get("/google/onboarding", async (req, res) => {
  try {
    markSensitiveResponse(res);
    const token = req.cookies?.[GOOGLE_ONBOARDING_COOKIE];
    if (!token) {
      return res.json({ pending: false });
    }

    const profile = verifyGoogleOnboardingToken(token);
    if (!profile.sub || !profile.email) {
      throw new Error("Invalid Google onboarding profile");
    }

    return res.json({
      pending: true,
      profile: {
        email: profile.email,
        name: profile.name,
      },
    });
  } catch (_error) {
    clearGoogleOnboardingCookie(res);
    return res.status(401).json({ pending: false });
  }
});

router.post(
  "/google/complete-profile",
  loginAttemptLimiter,
  async (req, res) => {
    try {
      markSensitiveResponse(res);
      const onboardingToken = req.cookies?.[GOOGLE_ONBOARDING_COOKIE];
      if (!onboardingToken) {
        return res.status(401).json({
          error:
            "Google sign-in expired. Please select your Google account again.",
        });
      }

      const profile = verifyGoogleOnboardingToken(onboardingToken);
      const shopName = normalizeName(req.body.shopName || req.body.shop_name);
      const mobileNumber = normalizeMobileNumber(
        req.body.mobileNumber || req.body.mobile_number,
      );

      if (!profile.sub || !profile.email) {
        return res.status(401).json({
          error:
            "Google sign-in expired. Please select your Google account again.",
        });
      }

      if (!shopName || !mobileNumber) {
        return res
          .status(400)
          .json({ error: "Shop name and mobile number are required." });
      }

      if (shopName.length < 3) {
        return res
          .status(400)
          .json({ error: "Shop name should be at least 3 characters long." });
      }

      if (shopName.length > OWNER_NAME_MAX_LENGTH) {
        return res.status(400).json({
          error: `Shop name should be ${OWNER_NAME_MAX_LENGTH} characters or less.`,
        });
      }

      if (!isValidMobileNumber(mobileNumber)) {
        return res
          .status(400)
          .json({ error: "Enter a valid 10-digit mobile number." });
      }

      const existing = await pool.query(
        `
        SELECT id, email, mobile_number, google_sub
        FROM users
        WHERE LOWER(email) = LOWER($1)
           OR mobile_number = $2
           OR google_sub = $3
        LIMIT 1
      `,
        [profile.email, mobileNumber, profile.sub],
      );

      if (existing.rowCount > 0) {
        const existingUser = existing.rows[0];
        const message =
          existingUser.google_sub === profile.sub ||
          normalizeEmail(existingUser.email) === profile.email
            ? "This Google email is already registered. Please try Google sign-in again."
            : "Mobile number already registered.";
        return res.status(400).json({ error: message });
      }

      const user = await createOwnerFromGoogleProfile(
        profile,
        shopName,
        mobileNumber,
      );
      const session = buildOwnerSession(user);
      const sessionToken = signSession(session);
      clearGoogleOnboardingCookie(res);
      setSessionCookie(res, sessionToken);

      return res.json({
        message: "Google account setup complete",
        user: toClientUser(session),
      });
    } catch (error) {
      console.error("Google profile completion error:", error.message);
      if (
        error.name === "JsonWebTokenError" ||
        error.name === "TokenExpiredError"
      ) {
        clearGoogleOnboardingCookie(res);
        return res.status(401).json({
          error:
            "Google sign-in expired. Please select your Google account again.",
        });
      }

      if (error.code === "23505") {
        return res.status(400).json({
          error:
            "This Google email or mobile number is already registered. Please try again.",
        });
      }

      return res.status(500).json({ error: "Server error" });
    }
  },
);

router.post("/register", async (req, res) => {
  try {
    const name = normalizeName(req.body.name);
    const email = normalizeEmail(req.body.email);
    const mobileNumber = normalizeMobileNumber(
      req.body.mobileNumber || req.body.mobile_number,
    );
    const password = String(req.body.password || "");

    if (!name || !email || !mobileNumber || !password) {
      return res.status(400).json({ error: "All fields required" });
    }

    if (!isValidMobileNumber(mobileNumber)) {
      return res
        .status(400)
        .json({ error: "Enter a valid 10-digit mobile number" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    const existing = await pool.query(
      `
        SELECT id, email, mobile_number
        FROM users
        WHERE LOWER(email) = LOWER($1) OR mobile_number = $2
        LIMIT 1
      `,
      [email, mobileNumber],
    );
    if (existing.rowCount > 0) {
      const existingUser = existing.rows[0];
      const errorMessage =
        normalizeEmail(existingUser.email) === email
          ? "Email already registered"
          : "Mobile number already registered";
      return res.status(400).json({ error: errorMessage });
    }

    const password_hash = await bcrypt.hash(password, 12);
    await pool.query(
      `
        INSERT INTO users (name, email, mobile_number, password_hash)
        VALUES ($1, $2, $3, $4)
      `,
      [name, email, mobileNumber, password_hash],
    );

    return res.json({ message: "Account created. You can now log in." });
  } catch (err) {
    console.error("Register error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/login", loginAttemptLimiter, async (req, res) => {
  try {
    const identifier = String(
      req.body.identifier || req.body.email || "",
    ).trim();
    const password = String(req.body.password || "");
    const normalizedMobileNumber = identifier.includes("@")
      ? ""
      : normalizeMobileNumber(identifier);

    if (!identifier || !password) {
      return res.status(400).json({ error: "All fields required" });
    }

    if (
      !identifier.includes("@") &&
      !isValidMobileNumber(normalizedMobileNumber)
    ) {
      return res.status(400).json({
        error: "Enter a valid email address or 10-digit mobile number",
      });
    }

    const users = await getOwnersByIdentifier(identifier);
    if (users.length > 1 && isValidMobileNumber(normalizedMobileNumber)) {
      return res.status(400).json({
        error:
          "This mobile number is linked to multiple accounts. Please log in with email.",
      });
    }

    const user = users[0] || null;
    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const session = buildOwnerSession(user);
    const token = signSession(session);
    markSensitiveResponse(res);
    clearGoogleOnboardingCookie(res);
    setSessionCookie(res, token);

    return res.json({
      message: "Login successful",
      user: toClientUser(session),
    });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/staff/login", loginAttemptLimiter, async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({ error: "All fields required" });
    }

    const staff = await getStaffByUsername(username);
    if (!staff || !staff.is_active) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, staff.password_hash);
    if (!valid) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const session = buildStaffSession(staff);
    const token = signSession(session);
    markSensitiveResponse(res);
    clearGoogleOnboardingCookie(res);
    setSessionCookie(res, token);
    invalidateStaffSessionCache(staff.id);

    return res.json({
      message: "Staff login successful",
      user: toClientUser(session),
    });
  } catch (err) {
    console.error("Staff login error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/logout", (req, res) => {
  markSensitiveResponse(res);
  clearSessionCookie(res);
  return res.json({ message: "Logged out successfully" });
});

router.post("/forgot-password", passwordResetLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).json({ error: "Email required" });
    }

    const genericMessage = {
      message: "If account exists, reset link has been sent.",
    };

    const result = await pool.query(
      "SELECT id FROM users WHERE LOWER(email) = LOWER($1)",
      [email],
    );

    if (result.rowCount === 0) {
      return res.json(genericMessage);
    }

    const reset_token = crypto.randomBytes(RESET_TOKEN_BYTES).toString("hex");
    const reset_token_hash = hashResetToken(reset_token);
    const expires = new Date(Date.now() + 1000 * 60 * 15);

    await pool.query(
      "UPDATE users SET reset_token=$1, reset_token_expires=$2 WHERE LOWER(email)=LOWER($3)",
      [reset_token_hash, expires, email],
    );

    const baseUrl = resolvePublicBaseUrl(req);
    const resetLink = `${baseUrl}/reset.html#token=${encodeURIComponent(reset_token)}&email=${encodeURIComponent(email)}`;

    if (process.env.MAIL_RELAY_URL && process.env.MAIL_RELAY_KEY) {
      const relayResponse = await fetch(process.env.MAIL_RELAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: process.env.MAIL_RELAY_KEY,
          to: email,
          subject: "Reset your password",
          html: `
            <p>You requested a password reset.</p>
            <p><a href="${resetLink}">Reset Password</a></p>
            <p>Valid for 15 minutes.</p>
          `,
        }),
      });

      if (!relayResponse.ok) {
        console.error(
          "Mail relay request failed with status:",
          relayResponse.status,
        );
      }
    } else {
      console.error(
        "Mail relay configuration missing. Reset email was not sent for:",
        email,
      );
    }

    return res.json(genericMessage);
  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/reset-password", passwordResetLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const token = String(req.body.token || "");
    const newPassword = String(req.body.newPassword || "");

    if (!email || !token || !newPassword) {
      return res.status(400).json({ error: "All fields required" });
    }

    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    const tokenHash = hashResetToken(token);

    const result = await pool.query(
      `
        SELECT id, reset_token_expires
        FROM users
        WHERE LOWER(email)=LOWER($1) AND reset_token=$2
      `,
      [email, tokenHash],
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ error: "Invalid token or email" });
    }

    const user = result.rows[0];
    if (new Date(user.reset_token_expires) < new Date()) {
      return res.status(400).json({ error: "Reset token expired" });
    }

    const password_hash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      `
        UPDATE users
        SET password_hash=$1, reset_token=NULL, reset_token_expires=NULL
        WHERE id=$2
      `,
      [password_hash, user.id],
    );

    return res.json({
      message: "Password reset successful. You can now log in.",
    });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/staff", authMiddleware, requireOwner, async (req, res) => {
  try {
    const ownerId = getUserId(req);
    const result = await pool.query(
      `
        SELECT id, name, username, page_permissions, is_active, created_at
        FROM staff_accounts
        WHERE owner_user_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [ownerId],
    );

    return res.json({
      staff: result.rows.map((row) => ({
        ...row,
        permissions: normalizePermissions(
          row.page_permissions || DEFAULT_STAFF_PERMISSIONS,
        ),
      })),
      permissionOptions: STAFF_PAGE_PERMISSIONS,
      limit: 2,
      remaining: Math.max(2 - result.rowCount, 0),
    });
  } catch (error) {
    console.error("Staff list error:", error.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/staff", authMiddleware, requireOwner, async (req, res) => {
  try {
    const ownerId = getUserId(req);
    const name = normalizeName(req.body.name);
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || "");
    const permissions = normalizePermissions(
      req.body.permissions || DEFAULT_STAFF_PERMISSIONS,
    );

    if (!name || !username || !password) {
      return res.status(400).json({ error: "All fields required" });
    }

    if (!USERNAME_PATTERN.test(username)) {
      return res.status(400).json({
        error:
          "Username must be 3-30 characters and can use letters, numbers, dot, underscore, or hyphen",
      });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    if (!permissions.length) {
      return res.status(400).json({
        error: "Select at least one page access for the staff account",
      });
    }

    const currentStaff = await pool.query(
      "SELECT COUNT(*)::int AS total FROM staff_accounts WHERE owner_user_id = $1",
      [ownerId],
    );

    if ((currentStaff.rows[0]?.total || 0) >= 2) {
      return res.status(400).json({
        error: "Maximum 2 staff accounts allowed for one owner account",
      });
    }

    const existing = await pool.query(
      `
        SELECT id
        FROM staff_accounts
        WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))
        LIMIT 1
      `,
      [username],
    );

    if (existing.rowCount > 0) {
      return res.status(400).json({ error: "Username already in use" });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `
        INSERT INTO staff_accounts (
          owner_user_id,
          name,
          username,
          password_hash,
          page_permissions
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, username, page_permissions, is_active, created_at
      `,
      [ownerId, name, username, password_hash, permissions],
    );

    return res.json({
      message: "Staff account created successfully",
      staff: {
        ...result.rows[0],
        permissions: normalizePermissions(result.rows[0].page_permissions),
      },
    });
  } catch (error) {
    console.error("Staff create error:", error.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.patch(
  "/staff/:staffId/permissions",
  authMiddleware,
  requireOwner,
  async (req, res) => {
    try {
      const ownerId = getUserId(req);
      const staffId = Number.parseInt(req.params.staffId, 10);
      const permissions = normalizePermissions(req.body.permissions || []);

      if (!Number.isInteger(staffId) || staffId <= 0) {
        return res.status(400).json({ error: "Invalid staff account" });
      }

      if (!permissions.length) {
        return res.status(400).json({
          error: "Select at least one page access for the staff account",
        });
      }

      const result = await pool.query(
        `
        UPDATE staff_accounts
        SET page_permissions = $1, updated_at = NOW()
        WHERE id = $2 AND owner_user_id = $3
        RETURNING id, name, username, page_permissions, is_active, created_at
      `,
        [permissions, staffId, ownerId],
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: "Staff account not found" });
      }

      invalidateStaffSessionCache(staffId);

      return res.json({
        message: "Staff page access updated successfully",
        staff: {
          ...result.rows[0],
          permissions: normalizePermissions(result.rows[0].page_permissions),
        },
      });
    } catch (error) {
      console.error("Staff permission update error:", error.message);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

router.delete(
  "/staff/:staffId",
  authMiddleware,
  requireOwner,
  async (req, res) => {
    try {
      const ownerId = getUserId(req);
      const staffId = Number.parseInt(req.params.staffId, 10);

      if (!Number.isInteger(staffId) || staffId <= 0) {
        return res.status(400).json({ error: "Invalid staff account" });
      }

      const result = await pool.query(
        `
        DELETE FROM staff_accounts
        WHERE id = $1 AND owner_user_id = $2
        RETURNING id
      `,
        [staffId, ownerId],
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Staff account not found" });
      }

      invalidateStaffSessionCache(staffId);

      return res.json({ message: "Staff account removed successfully" });
    } catch (error) {
      console.error("Staff delete error:", error.message);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

router.get("/account", authMiddleware, async (req, res) => {
  try {
    markSensitiveResponse(res);

    if (req.user.role === "staff") {
      const result = await pool.query(
        `
          SELECT
            s.name AS staff_name,
            s.username AS staff_username
          FROM staff_accounts s
          WHERE s.id = $1
          LIMIT 1
        `,
        [req.user.actorId],
      );

      if (!result.rowCount) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      const account = result.rows[0];
      return res.json({
        role: "staff",
        can_edit: false,
        staff: {
          name: account.staff_name,
          username: account.staff_username,
        },
      });
    }

    const result = await pool.query(
      `
        SELECT
          u.name,
          u.email,
          u.mobile_number,
          COALESCE(settings.shop_name, '') AS shop_name
        FROM users u
        LEFT JOIN settings ON settings.user_id = u.id
        WHERE u.id = $1
        LIMIT 1
      `,
      [getUserId(req)],
    );

    if (!result.rowCount) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const account = result.rows[0];
    return res.json({
      role: "owner",
      can_edit: true,
      owner: {
        name: account.name,
        email: account.email,
        mobile_number: account.mobile_number || "",
        shop_name: account.shop_name,
      },
    });
  } catch (error) {
    console.error("Account profile load error:", error.message);
    return res.status(500).json({ error: "Could not load account details" });
  }
});

router.patch("/account", authMiddleware, requireOwner, async (req, res) => {
  const client = await pool.connect();

  try {
    markSensitiveResponse(res);
    const name = normalizeName(req.body.name);
    const email = normalizeEmail(req.body.email);
    const mobileNumber = normalizeMobileNumber(
      req.body.mobile_number || req.body.mobileNumber,
    );
    const shopName = String(req.body.shop_name || "").trim();
    const currentPassword = String(req.body.current_password || "");

    if (name.length < 2 || name.length > OWNER_NAME_MAX_LENGTH) {
      return res.status(400).json({
        error: `Name must be between 2 and ${OWNER_NAME_MAX_LENGTH} characters`,
      });
    }

    if (!email || !email.includes("@") || email.length > 100) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }

    if (!isValidMobileNumber(mobileNumber)) {
      return res
        .status(400)
        .json({ error: "Enter a valid 10-digit mobile number" });
    }

    if (shopName.length > 150) {
      return res
        .status(400)
        .json({ error: "Shop name must be 150 characters or fewer" });
    }

    const userId = getUserId(req);
    await client.query("BEGIN");

    const currentAccountResult = await client.query(
      `
        SELECT
          u.id,
          u.name,
          u.email,
          u.mobile_number,
          u.password_hash,
          COALESCE(settings.shop_name, '') AS shop_name
        FROM users u
        LEFT JOIN settings ON settings.user_id = u.id
        WHERE u.id = $1
        FOR UPDATE OF u
      `,
      [userId],
    );

    const currentAccount = currentAccountResult.rows[0];
    if (!currentAccount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Account not found" });
    }

    const hasChanges =
      currentAccount.name !== name ||
      normalizeEmail(currentAccount.email) !== email ||
      String(currentAccount.mobile_number || "") !== mobileNumber ||
      String(currentAccount.shop_name || "").trim() !== shopName;

    if (!hasChanges) {
      await client.query("COMMIT");
      return res.json({ message: "No account changes to save" });
    }

    if (!currentPassword) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Enter your current password to save account changes",
      });
    }

    const passwordValid = await bcrypt.compare(
      currentPassword,
      currentAccount.password_hash,
    );
    if (!passwordValid) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Wrong password. Enter your current password and try again.",
      });
    }

    const userResult = await client.query(
      `
        UPDATE users
        SET name = $1, email = $2, mobile_number = $3
        WHERE id = $4
        RETURNING id, name, email, mobile_number
      `,
      [name, email, mobileNumber, userId],
    );

    if (!userResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Account not found" });
    }

    await client.query(
      `
        INSERT INTO settings (user_id, shop_name)
        VALUES ($1, $2)
        ON CONFLICT (user_id)
        DO UPDATE SET shop_name = EXCLUDED.shop_name
      `,
      [userId, shopName],
    );

    await client.query("COMMIT");
    const user = userResult.rows[0];
    const session = buildOwnerSession(user);
    setSessionCookie(res, signSession(session));
    markSensitiveResponse(res);
    return res.json({
      message: "Account details updated successfully",
      user: toClientUser(session),
      owner: {
        name: user.name,
        email: user.email,
        mobile_number: user.mobile_number,
        shop_name: shopName,
      },
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // The transaction may not have started when a connection error occurs.
    }

    if (error.code === "23505") {
      return res.status(400).json({ error: "This email is already registered" });
    }

    console.error("Account profile update error:", error.message);
    return res.status(500).json({ error: "Could not update account details" });
  } finally {
    client.release();
  }
});

router.get("/me", authMiddleware, async (req, res) => {
  try {
    markSensitiveResponse(res);
    if (req.user.role === "staff") {
      return res.json(toClientUser(req.user));
    }

    const result = await pool.query(
      "SELECT id, name, email FROM users WHERE id = $1 LIMIT 1",
      [req.user.actorId || req.user.id],
    );

    if (!result.rowCount) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const user = result.rows[0];
    return res.json(toClientUser(buildOwnerSession(user)));
  } catch (err) {
    console.error("/me error:", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }
});

module.exports = router;
