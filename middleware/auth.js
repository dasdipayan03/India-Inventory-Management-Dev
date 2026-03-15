/**
 * =========================================================
 * FILE: middleware/auth.js
 * MODULE: Authentication & Access Control Middleware
 * PURPOSE:
 *  - Verify JWT token
 *  - Attach authenticated session to request
 *  - Resolve fresh staff permissions from the database
 *  - Provide reusable role and permission guards
 * =========================================================
 */
const jwt = require("jsonwebtoken");
const pool = require("../db");
const {
  DEFAULT_STAFF_PERMISSIONS,
  normalizePermissions,
} = require("../public/js/permission-contract");

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET not found in environment variables.");
  process.exit(1);
}

async function authMiddleware(req, res, next) {
  try {
    let token = null;

    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
      token = header.split(" ")[1];
    }

    if (!token && req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (String(decoded.role).toLowerCase() === "staff") {
      const result = await pool.query(
        `
          SELECT owner_user_id, name, username, is_active, page_permissions
          FROM staff_accounts
          WHERE id = $1
          LIMIT 1
        `,
        [decoded.actorId || decoded.staffId || decoded.id],
      );

      if (!result.rowCount || !result.rows[0].is_active) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      const staff = result.rows[0];
      req.user = {
        ...decoded,
        actorId: decoded.actorId || decoded.staffId || decoded.id,
        staffId: decoded.staffId || decoded.actorId || decoded.id,
        ownerId: staff.owner_user_id,
        role: "staff",
        accountType: "staff",
        name: staff.name,
        username: staff.username,
        permissions: normalizePermissions(
          staff.page_permissions || DEFAULT_STAFF_PERMISSIONS,
        ),
      };
      return next();
    }

    req.user = {
      ...decoded,
      actorId: decoded.actorId || decoded.id,
      ownerId: decoded.ownerId || decoded.id,
      role: "admin",
      accountType: "admin",
      permissions: ["all"],
    };
    return next();
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("JWT verification failed:", error.message);
    }
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function getUserId(req) {
  const ownerId = Number(req.user?.ownerId || req.user?.id);
  if (!ownerId) {
    throw new Error("Missing owner user ID in request context");
  }
  return ownerId;
}

function getActorId(req) {
  const actorId = Number(req.user?.actorId || req.user?.id);
  if (!actorId) {
    throw new Error("Missing actor ID in request context");
  }
  return actorId;
}

function isAdminSession(req) {
  return String(req.user?.role || "").toLowerCase() === "admin";
}

function hasPermission(req, ...permissions) {
  if (isAdminSession(req)) {
    return true;
  }

  const currentPermissions = Array.isArray(req.user?.permissions)
    ? req.user.permissions
    : [];

  return permissions.some((permission) => currentPermissions.includes(permission));
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!isAdminSession(req)) {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
}

function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!permissions.length || hasPermission(req, ...permissions)) {
      return next();
    }

    return res.status(403).json({ error: "Access denied" });
  };
}

function allowRoles(...roles) {
  const normalized = roles.map((role) => String(role).toLowerCase());

  return (req, res, next) => {
    const currentRole = String(req.user?.role || "").toLowerCase();
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!normalized.includes(currentRole)) {
      return res.status(403).json({ error: "Access denied" });
    }

    next();
  };
}

module.exports = {
  allowRoles,
  authMiddleware,
  getActorId,
  getUserId,
  hasPermission,
  isAdminSession,
  requireAdmin,
  requirePermission,
};
