/**
 * =========================================================
 * FILE: routes/support.js
 * PURPOSE: DEVELOPER AUTHENTICATION ও TWO-SIDED SUPPORT CONVERSATION API
 * =========================================================
 * এই router developer account register/login/session এবং workspace user ↔ developer support messaging পরিচালনা করে।
 * Owner/staff-এর জন্য নিজস্ব support thread থাকে; developer queue থেকে conversation পড়তে, reply দিতে ও open/closed status বদলাতে পারেন।
 * Sensitive response cache হয় না, login/register rate-limited এবং multi-query message operations transaction-এর মধ্যে চলে।
 */

// ==================== BLOCK 01: DEPENDENCIES ও SHARED SECURITY/DATABASE SERVICES ====================
// Express routing, bcrypt password hashing, rate limiter ও database pool load করে। Auth helpers user/developer identity আলাদা করে;
// token utility signed developer session তৈরি করে, যাতে developer support access সাধারণ workspace session থেকে পৃথক থাকে।
const express = require("express");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const pool = require("../db");
const {
  DEVELOPER_SUPPORT_COOKIE_NAME,
  DEVELOPER_SUPPORT_ROLE,
  authMiddleware,
  developerAuthMiddleware,
  getActorId,
  getDeveloperId,
  getUserId,
} = require("../middleware/auth");
const { signDeveloperSessionToken } = require("../utils/token-security");

// ==================== BLOCK 02: ROUTER, LIMITS ও SUPPORT DOMAIN CONSTANTS ====================
// Developer session তিন দিন চলে, একটি message সর্বোচ্চ ২০০০ character এবং password-এর minimum length ৬।
// Registration key environment থেকে আসে; conversation status কেবল `open` অথবা `closed` হতে পারে।
const router = express.Router();

const SESSION_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MESSAGE_MAX_LENGTH = 2000;
const DEVELOPER_MIN_PASSWORD_LENGTH = 6;
const DEVELOPER_REGISTRATION_KEY = String(
  process.env.DEVELOPER_REGISTRATION_KEY || "",
).trim();
const conversationStatusValues = new Set(["open", "closed"]);

// Signed session verify করার secret ছাড়া authentication নিরাপদ নয়, তাই startup-তেই configuration error স্পষ্ট করে process বন্ধ হয়।
if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET not found in environment variables.");
  process.exit(1);
}

// ==================== BLOCK 03: DEVELOPER AUTH RATE LIMITERS ====================
// ১৫ মিনিটে failed login সর্বোচ্চ ১০ বার এবং failed registration সর্বোচ্চ ৫ বার অনুমোদিত। সফল request count থেকে বাদ যায়;
// standard rate-limit headers client-কে remaining limit জানায় এবং legacy headers বন্ধ রাখা হয়।
const developerLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error:
      "Too many developer login attempts. Please wait 15 minutes and try again.",
  },
});

const developerRegisterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error:
      "Too many developer account creation attempts. Please wait 15 minutes and try again.",
  },
});

/*
 * =========================================================
 * BLOCK 04: DATABASE READY GATE
 * =========================================================
 * প্রতিটি support route চালানোর আগে database initialization promise resolve হওয়া পর্যন্ত অপেক্ষা করে।
 * Startup/migration ব্যর্থ বা অসম্পূর্ণ থাকলে route handler-এ query না চালিয়ে temporary 503 response পাঠায়।
 */
router.use(async (_req, res, next) => {
  try {
    await pool.readyPromise;
    return next();
  } catch (error) {
    console.error(
      "Support routes unavailable while database is starting:",
      error.message,
    );
    return res.status(503).json({
      error: "Support service is starting. Please try again in a moment.",
    });
  }
});

// ==================== BLOCK 05: COOKIE, CACHE ও INPUT NORMALIZATION HELPERS ====================
// Cookie helper HttpOnly/Lax policy দেয় এবং production-এ Secure flag চালু করে। Sensitive response no-store হয়। Email/name/access-key/message/status
// normalizers case, whitespace, Unicode compatibility ও invisible copy-paste character পরিষ্কার করে validation/query consistent রাখে।
function getSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

function markSensitiveResponse(res) {
  res.set("Cache-Control", "no-store");
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDeveloperAccessKey(value) {
  const rawValue = String(value || "");
  const normalizedValue =
    typeof rawValue.normalize === "function"
      ? rawValue.normalize("NFKC")
      : rawValue;

  // Mobile copy/paste-এর invisible characters, spaces এবং full-width Unicode form সরিয়ে একই access key consistently compare করা হয়।
  return normalizedValue.replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, "");
}

function normalizeSupportMessage(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .trim();
}

function normalizeConversationStatus(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return conversationStatusValues.has(normalized) ? normalized : "";
}

// ==================== BLOCK 06: DEVELOPER SESSION COOKIE ও PUBLIC SESSION SHAPE ====================
// Token signer developer-specific JWT বানায়; set/clear helpers একই cookie name/path/options ব্যবহার করে login ও logout symmetric রাখে।
// Serializer database admin row থেকে password hash বাদ দিয়ে frontend-safe developer identity তৈরি করে।
function signDeveloperSession(payload) {
  return signDeveloperSessionToken(payload);
}

function setDeveloperSessionCookie(res, token) {
  res.cookie(DEVELOPER_SUPPORT_COOKIE_NAME, token, {
    ...getSessionCookieOptions(),
    maxAge: SESSION_MAX_AGE_MS,
  });
}

function clearDeveloperSessionCookie(res) {
  res.clearCookie(DEVELOPER_SUPPORT_COOKIE_NAME, getSessionCookieOptions());
}

function serializeDeveloperSession(admin) {
  return {
    id: admin.id,
    developerId: admin.id,
    role: DEVELOPER_SUPPORT_ROLE,
    accountType: DEVELOPER_SUPPORT_ROLE,
    name: admin.name,
    email: admin.email,
  };
}

// ==================== BLOCK 07: REQUESTER IDENTITY ও API SERIALIZERS ====================
// Authenticated workspace request-কে owner/staff context-এ রূপ দেয়। Owner user id conversation tenancy ধরে, actor id/role একই workspace-এর
// আলাদা staff thread চিহ্নিত করে। Conversation/message serializers snake_case database columns-কে frontend-friendly camelCase object বানায়।
function getRequesterContext(req) {
  const requesterRole =
    String(req.user?.role || "")
      .trim()
      .toLowerCase() === "staff"
      ? "staff"
      : "owner";

  return {
    ownerUserId: getUserId(req),
    requesterActorId: getActorId(req),
    requesterRole,
    requesterName: String(req.user?.name || "").trim() || "Workspace User",
    requesterIdentifier:
      requesterRole === "staff"
        ? String(req.user?.username || "").trim() || null
        : normalizeEmail(req.user?.email || "") || null,
  };
}

function serializeSupportConversation(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    requesterActorId: row.requester_actor_id,
    requesterRole: row.requester_role,
    requesterName: row.requester_name,
    requesterIdentifier: row.requester_identifier || null,
    status: row.status,
    unreadForUser: Number(row.unread_for_user) || 0,
    unreadForDeveloper: Number(row.unread_for_developer) || 0,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownerName: row.owner_name || null,
    ownerEmail: row.owner_email || null,
    lastMessageText: row.last_message_text || null,
    lastMessageSenderType: row.last_message_sender_type || null,
    lastMessageSenderName: row.last_message_sender_name || null,
  };
}

function serializeSupportMessage(row) {
  return {
    id: row.id,
    senderType: row.sender_type,
    senderRole: row.sender_role,
    senderActorId: row.sender_actor_id,
    senderName: row.sender_name,
    text: row.message_text,
    createdAt: row.created_at,
  };
}

// ==================== BLOCK 08: DEVELOPER ACCOUNT DATABASE HELPERS ====================
// Normalized email দিয়ে active/newest developer account খোঁজে এবং duplicate legacy row থাকলে warning দেয়। Account creator hashed passwordসহ
// active admin row insert করে; raw password কখনো database query বা returned object-এ যায় না।
async function getDeveloperByEmail(email) {
  const result = await pool.query(
    `
      SELECT id, name, email, password_hash, is_active
      FROM developer_admins
      WHERE LOWER(BTRIM(email)) = $1
      ORDER BY
        is_active DESC,
        updated_at DESC NULLS LAST,
        last_login_at DESC NULLS LAST,
        id DESC
      LIMIT 2
    `,
    [email],
  );

  if (result.rowCount > 1) {
    console.warn(
      `Multiple developer_admins rows matched normalized email "${email}". Using the newest active row.`,
    );
  }

  return result.rows[0] || null;
}

async function createDeveloperAccount({ name, email, passwordHash }) {
  const result = await pool.query(
    `
      INSERT INTO developer_admins (
        name,
        email,
        password_hash,
        is_active,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, TRUE, NOW(), NOW())
      RETURNING id, name, email, is_active
    `,
    [name, email, passwordHash],
  );

  return result.rows[0] || null;
}

// ==================== BLOCK 09: WORKSPACE REQUESTER CONVERSATION HELPERS ====================
// Owner+actor+role composite identity দিয়ে requester-এর একমাত্র thread load করে। Upsert helper thread না থাকলে open conversation বানায়;
// থাকলে বর্তমান display name/identifier refresh করে এবং existing messages/status অক্ষুণ্ণ রাখে।
async function getRequesterConversation(client, requester) {
  const result = await client.query(
    `
      SELECT
        c.*,
        owner_u.name AS owner_name,
        owner_u.email AS owner_email
      FROM support_conversations c
      JOIN users owner_u ON owner_u.id = c.owner_user_id
      WHERE c.owner_user_id = $1
        AND c.requester_actor_id = $2
        AND c.requester_role = $3
      LIMIT 1
    `,
    [
      requester.ownerUserId,
      requester.requesterActorId,
      requester.requesterRole,
    ],
  );

  return result.rows[0] || null;
}

async function upsertRequesterConversation(client, requester) {
  const result = await client.query(
    `
      INSERT INTO support_conversations (
        owner_user_id,
        requester_actor_id,
        requester_role,
        requester_name,
        requester_identifier,
        status,
        last_message_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 'open', NOW(), NOW(), NOW())
      ON CONFLICT (owner_user_id, requester_actor_id, requester_role)
      DO UPDATE SET
        requester_name = EXCLUDED.requester_name,
        requester_identifier = EXCLUDED.requester_identifier,
        updated_at = NOW()
      RETURNING *
    `,
    [
      requester.ownerUserId,
      requester.requesterActorId,
      requester.requesterRole,
      requester.requesterName,
      requester.requesterIdentifier,
    ],
  );

  return result.rows[0] || null;
}

// ==================== BLOCK 10: MESSAGE ও DEVELOPER QUEUE QUERY HELPERS ====================
// Message loader chronological history serialize করে। Developer detail query owner identity ও latest-message preview lateral join-এ আনে;
// queue loader সব conversation unread priority, তারপর last-message time অনুযায়ী সাজিয়ে developer dashboard-এর তালিকা বানায়।
async function loadConversationMessages(client, conversationId) {
  const result = await client.query(
    `
      SELECT
        id,
        sender_type,
        sender_actor_id,
        sender_role,
        sender_name,
        message_text,
        created_at
      FROM support_messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [conversationId],
  );

  return result.rows.map(serializeSupportMessage);
}

async function loadDeveloperConversationById(client, conversationId) {
  const result = await client.query(
    `
      SELECT
        c.*,
        owner_u.name AS owner_name,
        owner_u.email AS owner_email,
        last_message.message_text AS last_message_text,
        last_message.sender_type AS last_message_sender_type,
        last_message.sender_name AS last_message_sender_name
      FROM support_conversations c
      JOIN users owner_u ON owner_u.id = c.owner_user_id
      LEFT JOIN LATERAL (
        SELECT message_text, sender_type, sender_name
        FROM support_messages
        WHERE conversation_id = c.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) AS last_message ON TRUE
      WHERE c.id = $1
      LIMIT 1
    `,
    [conversationId],
  );

  return result.rows[0] || null;
}

async function loadDeveloperConversationList(client) {
  const result = await client.query(`
    SELECT
      c.*,
      owner_u.name AS owner_name,
      owner_u.email AS owner_email,
      last_message.message_text AS last_message_text,
      last_message.sender_type AS last_message_sender_type,
      last_message.sender_name AS last_message_sender_name
    FROM support_conversations c
    JOIN users owner_u ON owner_u.id = c.owner_user_id
    LEFT JOIN LATERAL (
      SELECT message_text, sender_type, sender_name
      FROM support_messages
      WHERE conversation_id = c.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) AS last_message ON TRUE
    ORDER BY
      c.unread_for_developer DESC,
      c.last_message_at DESC NULLS LAST,
      c.id DESC
  `);

  return result.rows.map(serializeSupportConversation);
}

/*
 * =========================================================
 * BLOCK 11: POST /developer-auth/register — developer account তৈরি
 * =========================================================
 * Rate limit-এর পরে name/email/password/confirmation/access-key normalize ও validate করে।
 * Valid registration key এবং unique email হলে bcrypt cost 12 দিয়ে password hash করে active developer account insert হয়।
 * Response-এ safe session-shaped profile থাকে; duplicate constraint race-ও পরিচিত 400 response হিসেবে handle হয়।
 */
router.post(
  "/developer-auth/register",
  developerRegisterLimiter,
  async (req, res) => {
    try {
      markSensitiveResponse(res);

      // Registration secret না থাকলে route fail-closed থাকে; কোনো built-in key ব্যবহার হয় না।
      if (!DEVELOPER_REGISTRATION_KEY) {
        return res.status(503).json({
          error: "Developer registration is not configured",
        });
      }

      /* REGISTER PHASE A: sensitive response cache বন্ধ করে body-এর সব credential ও profile field canonical form-এ আনা। */
      const name = normalizeName(req.body.name);
      const email = normalizeEmail(req.body.email);
      const password = String(req.body.password || "");
      const confirmPassword = String(
        req.body.confirmPassword || req.body.confirm_password || "",
      );
      const accessKey = normalizeDeveloperAccessKey(
        req.body.accessKey || req.body.developerKey || "",
      );
      const developerRegistrationKey = normalizeDeveloperAccessKey(
        DEVELOPER_REGISTRATION_KEY,
      );

      /* REGISTER PHASE B: required fields, name/password length, confirmation এবং secret registration key যাচাই। */
      if (!name || !email || !password || !confirmPassword || !accessKey) {
        return res.status(400).json({
          error:
            "Name, email, password, confirm password, and developer key are required",
        });
      }

      if (name.length < 2) {
        return res
          .status(400)
          .json({ error: "Developer name must be at least 2 characters" });
      }

      if (password.length < DEVELOPER_MIN_PASSWORD_LENGTH) {
        return res.status(400).json({
          error: `Password must be at least ${DEVELOPER_MIN_PASSWORD_LENGTH} characters`,
        });
      }

      if (password !== confirmPassword) {
        return res
          .status(400)
          .json({ error: "Confirm password must match the password above" });
      }

      if (accessKey !== developerRegistrationKey) {
        return res.status(403).json({ error: "Invalid developer access key" });
      }

      /* REGISTER PHASE C: normalized email আগে থেকে থাকলে duplicate account তৈরি বন্ধ করা। */
      const existingDeveloper = await getDeveloperByEmail(email);
      if (existingDeveloper) {
        return res
          .status(400)
          .json({ error: "Developer account already exists for this email" });
      }

      /* REGISTER PHASE D: plain password-এর one-way bcrypt hash বানিয়ে কেবল hash database-এ save করা। */
      const passwordHash = await bcrypt.hash(password, 12);
      const developer = await createDeveloperAccount({
        name,
        email,
        passwordHash,
      });

      return res.status(201).json({
        message: "Developer account created. You can now sign in.",
        developer: developer ? serializeDeveloperSession(developer) : null,
      });
    } catch (error) {
      // Concurrent registration unique constraint ভাঙলে user-friendly duplicate message; অন্য unexpected error generic 500 দেয়।
      if (error && error.code === "23505") {
        return res
          .status(400)
          .json({ error: "Developer account already exists for this email" });
      }

      console.error("Developer registration error:", error.message);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

/*
 * =========================================================
 * BLOCK 12: POST /developer-auth/login — credential verify ও session শুরু
 * =========================================================
 * Normalized email দিয়ে active developer account খোঁজে এবং bcrypt দিয়ে supplied password verify করে।
 * সফল হলে password-free session payload sign করে HttpOnly cookie বসায় ও last-login timestamp update করে।
 * Invalid email, inactive account এবং wrong password একই generic 401 message পায়, যাতে account existence প্রকাশ না হয়।
 */
router.post(
  "/developer-auth/login",
  developerLoginLimiter,
  async (req, res) => {
    try {
      const email = normalizeEmail(req.body.email);
      const password = String(req.body.password || "");

      if (!email || !password) {
        return res
          .status(400)
          .json({ error: "Email and password are required" });
      }

      /* LOGIN PHASE A: account lookup-এর পর inactive/missing account একই credential failure হিসেবে reject করা। */
      const developer = await getDeveloperByEmail(email);
      if (!developer || !developer.is_active) {
        return res.status(401).json({ error: "Invalid developer credentials" });
      }

      /* LOGIN PHASE B: stored bcrypt hash-এর সঙ্গে password timing-safe library operation দিয়ে যাচাই। */
      const isPasswordValid = await bcrypt.compare(
        password,
        developer.password_hash,
      );

      if (!isPasswordValid) {
        return res.status(401).json({ error: "Invalid developer credentials" });
      }

      /* LOGIN PHASE C: safe identity sign করে developer-specific session token বানানো। */
      const session = serializeDeveloperSession(developer);
      const token = signDeveloperSession(session);

      /* LOGIN PHASE D: audit/ordering-এর জন্য successful login time এবং row update time refresh করা। */
      await pool.query(
        `
        UPDATE developer_admins
        SET last_login_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
        [developer.id],
      );

      /* LOGIN PHASE E: auth response cache বন্ধ করে signed token browser-এর protected cookie-তে পাঠানো। */
      markSensitiveResponse(res);
      setDeveloperSessionCookie(res, token);

      return res.json({
        message: "Developer login successful",
        developer: session,
      });
    } catch (error) {
      console.error("Developer login error:", error.message);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

/*
 * =========================================================
 * BLOCK 13: DEVELOPER SESSION READ ও LOGOUT
 * =========================================================
 * `/developer-auth/me` middleware-verified developer-এর safe profile ফেরায়। Logout endpoint একই cookie options দিয়ে session cookie clear করে;
 * client এরপর authenticated developer endpoints ব্যবহার করতে পারে না। দুই response-ই sensitive বলে cache বন্ধ থাকে।
 */
router.get("/developer-auth/me", developerAuthMiddleware, async (req, res) => {
  markSensitiveResponse(res);
  return res.json({
    developer: serializeDeveloperSession(req.developer),
  });
});

router.post("/developer-auth/logout", (req, res) => {
  markSensitiveResponse(res);
  clearDeveloperSessionCookie(res);
  return res.json({ message: "Developer logged out successfully" });
});

/*
 * =========================================================
 * BLOCK 14: GET /support/thread — workspace user-এর thread পড়া
 * =========================================================
 * Login করা owner/staff-এর tenancy-aware requester identity দিয়ে তার support conversation খোঁজে।
 * Thread থাকলে user-side unread counter zero করে, বর্তমান name/identifier refresh করে এবং chronological messages ফেরায়।
 * Conversation না থাকলে empty state দেয়; read-marker update ও data load একই transaction-এ consistent থাকে।
 */
router.get("/support/thread", authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    /* USER THREAD PHASE A: cache বন্ধ, authenticated requester context তৈরি এবং transaction শুরু। */
    markSensitiveResponse(res);
    const requester = getRequesterContext(req);
    await client.query("BEGIN");

    /* USER THREAD PHASE B: owner/actor/role দিয়ে existing thread খোঁজা; না থাকলে clean empty response commit করা। */
    const conversation = await getRequesterConversation(client, requester);
    if (!conversation) {
      await client.query("COMMIT");
      return res.json({
        conversation: null,
        messages: [],
      });
    }

    /* USER THREAD PHASE C: thread দেখার কারণে user unread count clear এবং requester-এর latest identity metadata refresh। */
    await client.query(
      `
        UPDATE support_conversations
        SET
          requester_name = $2,
          requester_identifier = $3,
          unread_for_user = 0,
          updated_at = NOW()
        WHERE id = $1
      `,
      [conversation.id, requester.requesterName, requester.requesterIdentifier],
    );

    /* USER THREAD PHASE D: updated conversation ও সম্পূর্ণ chronological message history load করে commit করা। */
    const refreshedConversation = await getRequesterConversation(
      client,
      requester,
    );
    const messages = await loadConversationMessages(client, conversation.id);

    await client.query("COMMIT");

    return res.json({
      conversation: serializeSupportConversation(refreshedConversation),
      messages,
    });
  } catch (error) {
    // যেকোনো query failure-এ unread/metadata-এর partial change বাতিল করে generic server error পাঠানো হয়।
    await client.query("ROLLBACK");
    console.error("Support thread load error:", error.message);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

/*
 * =========================================================
 * BLOCK 15: POST /support/messages — user থেকে support message পাঠানো
 * =========================================================
 * Authenticated requester-এর message trim করে required/maximum-length validation চালায়।
 * Conversation না থাকলে upsert করে, user message insert করে, thread open করে এবং developer unread counter বাড়ায়।
 * Message, conversation metadata এবং unread state একই transaction-এ commit হয়, তাই partial support event থাকে না।
 */
router.post("/support/messages", authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    markSensitiveResponse(res);
    /* USER MESSAGE PHASE A: requester identity ও normalized message তৈরি করে blank/oversized input transaction-এর আগেই reject করা। */
    const requester = getRequesterContext(req);
    const message = normalizeSupportMessage(req.body.message);

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    if (message.length > MESSAGE_MAX_LENGTH) {
      return res.status(400).json({
        error: `Message cannot be longer than ${MESSAGE_MAX_LENGTH} characters`,
      });
    }

    /* USER MESSAGE PHASE B: atomic conversation/message/unread update-এর transaction শুরু। */
    await client.query("BEGIN");

    // একই requester-এর thread reuse হয়; প্রথম message হলে নতুন open conversation তৈরি হয়।
    const conversation = await upsertRequesterConversation(client, requester);
    if (!conversation) {
      throw new Error("Support conversation could not be created");
    }

    /* USER MESSAGE PHASE C: sender type `user`, actor/role/name এবং textসহ immutable message row insert। */
    const insertedMessage = await client.query(
      `
        INSERT INTO support_messages (
          conversation_id,
          sender_type,
          sender_actor_id,
          sender_role,
          sender_name,
          message_text
        )
        VALUES ($1, 'user', $2, $3, $4, $5)
        RETURNING
          id,
          sender_type,
          sender_actor_id,
          sender_role,
          sender_name,
          message_text,
          created_at
      `,
      [
        conversation.id,
        requester.requesterActorId,
        requester.requesterRole,
        requester.requesterName,
        message,
      ],
    );

    /* USER MESSAGE PHASE D: conversation reopen, developer unread increment এবং last-message timestamps refresh। */
    const refreshedConversation = await client.query(
      `
        UPDATE support_conversations
        SET
          requester_name = $2,
          requester_identifier = $3,
          status = 'open',
          unread_for_developer = unread_for_developer + 1,
          last_message_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [conversation.id, requester.requesterName, requester.requesterIdentifier],
    );

    /* USER MESSAGE PHASE E: developer queue-compatible latest preview load করে transaction commit ও serialized response পাঠানো। */
    const conversationRow = await loadDeveloperConversationById(
      client,
      conversation.id,
    );

    await client.query("COMMIT");

    return res.json({
      message: "Support message sent",
      conversation:
        serializeSupportConversation(
          conversationRow || refreshedConversation.rows[0],
        ) || null,
      supportMessage: serializeSupportMessage(insertedMessage.rows[0]),
    });
  } catch (error) {
    // Conversation/message/counter-এর কোনো write ব্যর্থ হলে সব পরিবর্তন rollback হয়।
    await client.query("ROLLBACK");
    console.error("Support message create error:", error.message);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

/*
 * =========================================================
 * BLOCK 16: GET /developer-support/conversations — developer inbox queue
 * =========================================================
 * Developer session middleware দিয়ে access সীমাবদ্ধ রেখে সব support conversation-এর serialized queue আনে।
 * Query helper unread-for-developer বেশি এমন thread আগে, তারপর latest activity অনুযায়ী সাজায় এবং last-message preview যুক্ত করে।
 * এটি read-only endpoint; acquired pool client success/error উভয় অবস্থায় finally block-এ release হয়।
 */
router.get(
  "/developer-support/conversations",
  developerAuthMiddleware,
  async (req, res) => {
    const client = await pool.connect();

    try {
      markSensitiveResponse(res);
      const conversations = await loadDeveloperConversationList(client);
      return res.json({ conversations });
    } catch (error) {
      console.error("Developer support queue load error:", error.message);
      return res.status(500).json({ error: "Server error" });
    } finally {
      client.release();
    }
  },
);

/*
 * =========================================================
 * BLOCK 17: GET /developer-support/conversations/:id/messages — developer thread খোলা
 * =========================================================
 * Positive integer conversation id validate করে thread existence পরীক্ষা করে। Thread খুললে developer unread counter zero হয়,
 * refreshed conversation metadata ও chronological message history একই transaction-এ load হয়। Missing thread 404 এবং invalid id 400 দেয়।
 */
router.get(
  "/developer-support/conversations/:conversationId/messages",
  developerAuthMiddleware,
  async (req, res) => {
    const client = await pool.connect();

    try {
      markSensitiveResponse(res);
      /* DEVELOPER THREAD PHASE A: route id integer হিসেবে parse করে invalid/non-positive value query-এর আগেই reject করা। */
      const conversationId = Number.parseInt(req.params.conversationId, 10);

      if (!Number.isInteger(conversationId) || conversationId <= 0) {
        return res.status(400).json({ error: "Invalid conversation" });
      }

      /* DEVELOPER THREAD PHASE B: existence check, read marker ও returned data consistent রাখতে transaction শুরু। */
      await client.query("BEGIN");

      const existingConversation = await loadDeveloperConversationById(
        client,
        conversationId,
      );

      if (!existingConversation) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Conversation not found" });
      }

      /* DEVELOPER THREAD PHASE C: inbox item পড়া হয়েছে বলে developer-side unread counter clear করা। */
      await client.query(
        `
          UPDATE support_conversations
          SET unread_for_developer = 0,
              updated_at = NOW()
          WHERE id = $1
        `,
        [conversationId],
      );

      /* DEVELOPER THREAD PHASE D: updated thread preview ও সব message load করে commit এবং response পাঠানো। */
      const conversation = await loadDeveloperConversationById(
        client,
        conversationId,
      );
      const messages = await loadConversationMessages(client, conversationId);

      await client.query("COMMIT");

      return res.json({
        conversation: serializeSupportConversation(conversation),
        messages,
      });
    } catch (error) {
      // Read-marker বা message load ব্যর্থ হলে transaction rollback করে partial read state আটকানো হয়।
      await client.query("ROLLBACK");
      console.error("Developer support thread load error:", error.message);
      return res.status(500).json({ error: "Server error" });
    } finally {
      client.release();
    }
  },
);

/*
 * =========================================================
 * BLOCK 18: POST /developer-support/conversations/:id/reply — developer reply
 * =========================================================
 * Authenticated developer id, validated conversation id এবং normalized reply text নেয়।
 * Developer message insert করে thread open রাখে, user unread counter বাড়ায় এবং last activity timestamp refresh করে।
 * Message ও conversation update একই transaction-এ হওয়ায় reply visible হলে notification state-ও একসঙ্গে visible হয়।
 */
router.post(
  "/developer-support/conversations/:conversationId/reply",
  developerAuthMiddleware,
  async (req, res) => {
    const client = await pool.connect();

    try {
      markSensitiveResponse(res);
      /* DEVELOPER REPLY PHASE A: verified session থেকে developer id এবং request থেকে conversation/message values নেওয়া। */
      const developerId = getDeveloperId(req);
      const conversationId = Number.parseInt(req.params.conversationId, 10);
      const message = normalizeSupportMessage(req.body.message);

      if (!Number.isInteger(conversationId) || conversationId <= 0) {
        return res.status(400).json({ error: "Invalid conversation" });
      }

      if (!message) {
        return res.status(400).json({ error: "Reply message is required" });
      }

      if (message.length > MESSAGE_MAX_LENGTH) {
        return res.status(400).json({
          error: `Reply cannot be longer than ${MESSAGE_MAX_LENGTH} characters`,
        });
      }

      /* DEVELOPER REPLY PHASE B: existence, message insert ও unread update atomic করার transaction শুরু। */
      await client.query("BEGIN");

      const existingConversation = await loadDeveloperConversationById(
        client,
        conversationId,
      );

      if (!existingConversation) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Conversation not found" });
      }

      /* DEVELOPER REPLY PHASE C: sender type `developer`, developer identity/name ও reply textসহ message row insert। */
      const insertedMessage = await client.query(
        `
          INSERT INTO support_messages (
            conversation_id,
            sender_type,
            sender_actor_id,
            sender_role,
            sender_name,
            message_text
          )
          VALUES ($1, 'developer', $2, $3, $4, $5)
          RETURNING
            id,
            sender_type,
            sender_actor_id,
            sender_role,
            sender_name,
            message_text,
            created_at
        `,
        [
          conversationId,
          developerId,
          DEVELOPER_SUPPORT_ROLE,
          String(req.developer?.name || "Developer Support").trim() ||
            "Developer Support",
          message,
        ],
      );

      /* DEVELOPER REPLY PHASE D: thread reopen, user-side unread increment এবং latest activity timestamp update। */
      await client.query(
        `
          UPDATE support_conversations
          SET
            status = 'open',
            unread_for_user = unread_for_user + 1,
            last_message_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
        `,
        [conversationId],
      );

      /* DEVELOPER REPLY PHASE E: latest-message previewসহ refreshed conversation load করে commit ও serialized reply পাঠানো। */
      const conversation = await loadDeveloperConversationById(
        client,
        conversationId,
      );

      await client.query("COMMIT");

      return res.json({
        message: "Reply sent",
        conversation: serializeSupportConversation(conversation),
        supportMessage: serializeSupportMessage(insertedMessage.rows[0]),
      });
    } catch (error) {
      // Reply insert বা counter update-এর কোনো ধাপ ব্যর্থ হলে সম্পূর্ণ operation rollback হয়।
      await client.query("ROLLBACK");
      console.error("Developer support reply error:", error.message);
      return res.status(500).json({ error: "Server error" });
    } finally {
      client.release();
    }
  },
);

/*
 * =========================================================
 * BLOCK 19: PATCH /developer-support/conversations/:id/status — open/closed state বদলানো
 * =========================================================
 * Developer-only endpoint positive conversation id ও allow-listed status validate করে।
 * Matching row-এর status/update time বদলে refreshed conversation detail ফেরায়; unknown id 404 দেয়।
 * Message history বা unread counters এখানে পরিবর্তিত হয় না।
 */
router.patch(
  "/developer-support/conversations/:conversationId/status",
  developerAuthMiddleware,
  async (req, res) => {
    const client = await pool.connect();

    try {
      markSensitiveResponse(res);
      const conversationId = Number.parseInt(req.params.conversationId, 10);
      const status = normalizeConversationStatus(req.body.status);

      if (!Number.isInteger(conversationId) || conversationId <= 0) {
        return res.status(400).json({ error: "Invalid conversation" });
      }

      if (!status) {
        return res.status(400).json({ error: "Invalid conversation status" });
      }

      // Parameterized update শুধু requested conversation-এর status ও updated timestamp বদলায় এবং affected row আছে কি না জানায়।
      const updated = await client.query(
        `
          UPDATE support_conversations
          SET status = $2,
              updated_at = NOW()
          WHERE id = $1
          RETURNING id
        `,
        [conversationId, status],
      );

      if (!updated.rowCount) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const conversation = await loadDeveloperConversationById(
        client,
        conversationId,
      );

      return res.json({
        message: "Conversation status updated",
        conversation: serializeSupportConversation(conversation),
      });
    } catch (error) {
      console.error("Developer support status update error:", error.message);
      return res.status(500).json({ error: "Server error" });
    } finally {
      client.release();
    }
  },
);

/*
 * =========================================================
 * BLOCK 20: ROUTER EXPORT
 * =========================================================
 * Developer authentication ও দুই দিকের support API-সহ প্রস্তুত Express router main application-এ mount করার জন্য export হয়।
 */
module.exports = router;
