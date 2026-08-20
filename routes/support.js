const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
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

const router = express.Router();

const SESSION_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MESSAGE_MAX_LENGTH = 2000;
const DEVELOPER_MIN_PASSWORD_LENGTH = 6;
const DEVELOPER_REGISTRATION_KEY = String(
  process.env.DEVELOPER_REGISTRATION_KEY || "IIMDD@1999",
).trim();
const conversationStatusValues = new Set(["open", "closed"]);

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET not found in environment variables.");
  process.exit(1);
}

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

  // Mobile copy/paste can introduce invisible characters or full-width forms...
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

function signDeveloperSession(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "3d" });
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

router.post(
  "/developer-auth/register",
  developerRegisterLimiter,
  async (req, res) => {
    try {
      markSensitiveResponse(res);

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

      const existingDeveloper = await getDeveloperByEmail(email);
      if (existingDeveloper) {
        return res
          .status(400)
          .json({ error: "Developer account already exists for this email" });
      }

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

      const developer = await getDeveloperByEmail(email);
      if (!developer || !developer.is_active) {
        return res.status(401).json({ error: "Invalid developer credentials" });
      }

      const isPasswordValid = await bcrypt.compare(
        password,
        developer.password_hash,
      );

      if (!isPasswordValid) {
        return res.status(401).json({ error: "Invalid developer credentials" });
      }

      const session = serializeDeveloperSession(developer);
      const token = signDeveloperSession(session);

      await pool.query(
        `
        UPDATE developer_admins
        SET last_login_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
        [developer.id],
      );

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

router.get("/support/thread", authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    markSensitiveResponse(res);
    const requester = getRequesterContext(req);
    await client.query("BEGIN");

    const conversation = await getRequesterConversation(client, requester);
    if (!conversation) {
      await client.query("COMMIT");
      return res.json({
        conversation: null,
        messages: [],
      });
    }

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
    await client.query("ROLLBACK");
    console.error("Support thread load error:", error.message);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

router.post("/support/messages", authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    markSensitiveResponse(res);
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

    await client.query("BEGIN");

    const conversation = await upsertRequesterConversation(client, requester);
    if (!conversation) {
      throw new Error("Support conversation could not be created");
    }

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
    await client.query("ROLLBACK");
    console.error("Support message create error:", error.message);
    return res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

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

router.get(
  "/developer-support/conversations/:conversationId/messages",
  developerAuthMiddleware,
  async (req, res) => {
    const client = await pool.connect();

    try {
      markSensitiveResponse(res);
      const conversationId = Number.parseInt(req.params.conversationId, 10);

      if (!Number.isInteger(conversationId) || conversationId <= 0) {
        return res.status(400).json({ error: "Invalid conversation" });
      }

      await client.query("BEGIN");

      const existingConversation = await loadDeveloperConversationById(
        client,
        conversationId,
      );

      if (!existingConversation) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Conversation not found" });
      }

      await client.query(
        `
          UPDATE support_conversations
          SET unread_for_developer = 0,
              updated_at = NOW()
          WHERE id = $1
        `,
        [conversationId],
      );

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
      await client.query("ROLLBACK");
      console.error("Developer support thread load error:", error.message);
      return res.status(500).json({ error: "Server error" });
    } finally {
      client.release();
    }
  },
);

router.post(
  "/developer-support/conversations/:conversationId/reply",
  developerAuthMiddleware,
  async (req, res) => {
    const client = await pool.connect();

    try {
      markSensitiveResponse(res);
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

      await client.query("BEGIN");

      const existingConversation = await loadDeveloperConversationById(
        client,
        conversationId,
      );

      if (!existingConversation) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Conversation not found" });
      }

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
      await client.query("ROLLBACK");
      console.error("Developer support reply error:", error.message);
      return res.status(500).json({ error: "Server error" });
    } finally {
      client.release();
    }
  },
);

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

module.exports = router;
