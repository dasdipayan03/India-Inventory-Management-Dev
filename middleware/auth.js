/**
 * =========================================================
 * FILE: middleware/auth.js
 * MODULE: Authentication & Access Control Middleware
 * PURPOSE:
 *  - Verify JWT token
 *  - Attach authenticated session to request
 *  - Resolve business owner scope for admin/staff sessions
 *  - Provide reusable role guards
 * =========================================================
 */
const jwt = require("jsonwebtoken");

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET not found in environment variables.");
  process.exit(1);
}

function authMiddleware(req, res, next) {
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
    req.user = decoded;
    next();
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

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!isAdminSession(req)) {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
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
  isAdminSession,
  requireAdmin,
};
