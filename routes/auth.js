const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const {
  DEFAULT_STAFF_PERMISSIONS,
  STAFF_PAGE_PERMISSIONS,
  normalizePermissions,
} = require("../permissions");
const {
  authMiddleware,
  getUserId,
  requireAdmin,
} = require("../middleware/auth");

const router = express.Router();

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,30}$/;

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET not found in environment variables.");
  process.exit(1);
}

function normalizeName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeUsername(value) {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
}

function signSession(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1d" });
}

function setSessionCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE_MS,
  });
}

function clearSessionCookie(res) {
  res.clearCookie("token", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

function buildAdminSession(user) {
  return {
    actorId: user.id,
    ownerId: user.id,
    role: "admin",
    accountType: "admin",
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
  return {
    id: session.actorId,
    actorId: session.actorId,
    ownerId: session.ownerId,
    role: session.role,
    accountType: session.accountType,
    name: session.name,
    email: session.email || null,
    username: session.username || null,
    ownerName: session.ownerName || session.name,
    permissions:
      session.role === "admin"
        ? ["all"]
        : normalizePermissions(session.permissions || DEFAULT_STAFF_PERMISSIONS),
  };
}

async function getAdminByEmail(email) {
  const result = await pool.query(
    `SELECT id, name, email, password_hash
     FROM users
     WHERE LOWER(email) = LOWER($1)
     LIMIT 1`,
    [email],
  );

  return result.rows[0] || null;
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

router.post("/register", async (req, res) => {
  try {
    const name = normalizeName(req.body.name);
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!name || !email || !password) {
      return res.status(400).json({ error: "All fields required" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE LOWER(email) = LOWER($1)",
      [email],
    );
    if (existing.rowCount > 0) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const password_hash = await bcrypt.hash(password, 12);
    await pool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)",
      [name, email, password_hash],
    );

    return res.json({ message: "Account created. You can now log in." });
  } catch (err) {
    console.error("Register error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({ error: "All fields required" });
    }

    const user = await getAdminByEmail(email);
    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const session = buildAdminSession(user);
    const token = signSession(session);
    setSessionCookie(res, token);

    return res.json({
      message: "Login successful",
      user: toClientUser(session),
      token,
    });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/staff/login", async (req, res) => {
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
    setSessionCookie(res, token);

    return res.json({
      message: "Staff login successful",
      user: toClientUser(session),
      token,
    });
  } catch (err) {
    console.error("Staff login error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  return res.json({ message: "Logged out successfully" });
});

router.post("/forgot-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).json({ error: "Email required" });
    }

    const result = await pool.query(
      "SELECT id FROM users WHERE LOWER(email) = LOWER($1)",
      [email],
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ error: "Email does not exist" });
    }

    const reset_token = crypto.randomBytes(20).toString("hex");
    const expires = new Date(Date.now() + 1000 * 60 * 15);

    await pool.query(
      "UPDATE users SET reset_token=$1, reset_token_expires=$2 WHERE LOWER(email)=LOWER($3)",
      [reset_token, expires, email],
    );

    const resetLink = `${process.env.BASE_URL}/reset.html?token=${reset_token}&email=${encodeURIComponent(email)}`;

    await fetch(process.env.MAIL_RELAY_URL, {
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

    return res.json({
      message: "If account exists, reset link has been sent.",
    });
  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/reset-password", async (req, res) => {
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

    const result = await pool.query(
      `
        SELECT id, reset_token_expires
        FROM users
        WHERE LOWER(email)=LOWER($1) AND reset_token=$2
      `,
      [email, token],
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

router.get("/staff", authMiddleware, requireAdmin, async (req, res) => {
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

router.post("/staff", authMiddleware, requireAdmin, async (req, res) => {
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
      return res
        .status(400)
        .json({ error: "Select at least one page access for the staff account" });
    }

    const currentStaff = await pool.query(
      "SELECT COUNT(*)::int AS total FROM staff_accounts WHERE owner_user_id = $1",
      [ownerId],
    );

    if ((currentStaff.rows[0]?.total || 0) >= 2) {
      return res.status(400).json({
        error: "Maximum 2 staff accounts allowed for one admin account",
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

router.patch("/staff/:staffId/permissions", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const ownerId = getUserId(req);
    const staffId = Number.parseInt(req.params.staffId, 10);
    const permissions = normalizePermissions(req.body.permissions || []);

    if (!Number.isInteger(staffId) || staffId <= 0) {
      return res.status(400).json({ error: "Invalid staff account" });
    }

    if (!permissions.length) {
      return res
        .status(400)
        .json({ error: "Select at least one page access for the staff account" });
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
});

router.delete("/staff/:staffId", authMiddleware, requireAdmin, async (req, res) => {
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

    return res.json({ message: "Staff account removed successfully" });
  } catch (error) {
    console.error("Staff delete error:", error.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/me", authMiddleware, async (req, res) => {
  try {
    if (req.user.role === "staff") {
      const result = await pool.query(
        `
          SELECT
            s.id AS actor_id,
            s.owner_user_id,
            s.name,
            s.username,
            s.page_permissions,
            s.is_active,
            u.name AS owner_name
          FROM staff_accounts s
          JOIN users u ON u.id = s.owner_user_id
          WHERE s.id = $1
          LIMIT 1
        `,
        [req.user.actorId],
      );

      if (!result.rowCount || !result.rows[0].is_active) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      const staff = result.rows[0];
      return res.json(
        toClientUser({
          actorId: staff.actor_id,
          ownerId: staff.owner_user_id,
          role: "staff",
          accountType: "staff",
          name: staff.name,
          username: staff.username,
          ownerName: staff.owner_name,
          permissions: normalizePermissions(
            staff.page_permissions || DEFAULT_STAFF_PERMISSIONS,
          ),
        }),
      );
    }

    const result = await pool.query(
      "SELECT id, name, email FROM users WHERE id = $1 LIMIT 1",
      [req.user.actorId || req.user.id],
    );

    if (!result.rowCount) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const user = result.rows[0];
    return res.json(toClientUser(buildAdminSession(user)));
  } catch (err) {
    console.error("/me error:", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }
});

module.exports = router;
