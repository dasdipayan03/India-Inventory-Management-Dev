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
const pool = require("../db");
const {
  DEFAULT_STAFF_PERMISSIONS,
  normalizePermissions,
} = require("../public/js/permission-contract");
const {
  verifyDeveloperSessionToken,
  verifySessionToken,
} = require("../utils/token-security");

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET not found in environment variables.");
  process.exit(1);
}

function readNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const STAFF_SESSION_CACHE_TTL_MS = readNonNegativeInt(
  process.env.STAFF_SESSION_CACHE_TTL_MS,
  0,
);
const STAFF_SESSION_CACHE_MAX_ENTRIES = 200;
const STAFF_ROLE = "staff";
const OWNER_ROLE = "owner";
const DEVELOPER_SUPPORT_ROLE = "developer_support";
const DEVELOPER_SUPPORT_COOKIE_NAME = "developer_support_token";
const staffSessionCache = new Map();

function normalizeSessionRole(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (normalized === STAFF_ROLE) {
    return STAFF_ROLE;
  }

  // Keep older admin tokens/sessions working while the app now speaks in owner terms.
  if (normalized === "admin" || normalized === OWNER_ROLE) {
    return OWNER_ROLE;
  }

  return normalized;
}

function getStaffSessionCacheKey(staffId) {
  const normalizedStaffId = Number(staffId);
  return Number.isInteger(normalizedStaffId) && normalizedStaffId > 0
    ? normalizedStaffId
    : 0;
}

function getCachedStaffSession(staffId) {
  if (STAFF_SESSION_CACHE_TTL_MS <= 0) {
    return null;
  }

  const cacheKey = getStaffSessionCacheKey(staffId);
  if (!cacheKey) {
    return null;
  }

  const cachedEntry = staffSessionCache.get(cacheKey);
  if (!cachedEntry) {
    return null;
  }

  if (cachedEntry.expiresAt <= Date.now()) {
    staffSessionCache.delete(cacheKey);
    return null;
  }

  return cachedEntry.value;
}

function setCachedStaffSession(staffId, sessionData) {
  if (STAFF_SESSION_CACHE_TTL_MS <= 0) {
    return sessionData;
  }

  const cacheKey = getStaffSessionCacheKey(staffId);
  if (!cacheKey) {
    return sessionData;
  }

  while (staffSessionCache.size >= STAFF_SESSION_CACHE_MAX_ENTRIES) {
    const oldestKey = staffSessionCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    staffSessionCache.delete(oldestKey);
  }

  staffSessionCache.set(cacheKey, {
    value: sessionData,
    expiresAt: Date.now() + STAFF_SESSION_CACHE_TTL_MS,
  });

  return sessionData;
}

function invalidateStaffSessionCache(staffId) {
  const cacheKey = getStaffSessionCacheKey(staffId);
  if (cacheKey) {
    staffSessionCache.delete(cacheKey);
  }
}

async function loadStaffSession(staffId) {
  const cachedStaff = getCachedStaffSession(staffId);
  if (cachedStaff) {
    return cachedStaff;
  }

  const result = await pool.query(
    `
      SELECT
        s.owner_user_id,
        s.name,
        s.username,
        s.is_active,
        s.page_permissions,
        u.name AS owner_name
      FROM staff_accounts s
      JOIN users u ON u.id = s.owner_user_id
      WHERE s.id = $1
      LIMIT 1
    `,
    [staffId],
  );

  if (!result.rowCount) {
    invalidateStaffSessionCache(staffId);
    return null;
  }

  const staff = result.rows[0];
  if (!staff.is_active) {
    invalidateStaffSessionCache(staffId);
    return {
      ownerUserId: staff.owner_user_id,
      name: staff.name,
      username: staff.username,
      isActive: false,
      pagePermissions: staff.page_permissions,
      ownerName: staff.owner_name,
    };
  }

  return setCachedStaffSession(staffId, {
    ownerUserId: staff.owner_user_id,
    name: staff.name,
    username: staff.username,
    isActive: true,
    pagePermissions: staff.page_permissions,
    ownerName: staff.owner_name,
  });
}

async function authMiddleware(req, res, next) {
  try {
    let token = null;

    if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    const header = req.headers.authorization;
    if (!token && header && header.startsWith("Bearer ")) {
      token = header.split(" ")[1];
    }

    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const decoded = verifySessionToken(token);

    if (normalizeSessionRole(decoded.role) === STAFF_ROLE) {
      const staffId = decoded.actorId || decoded.staffId || decoded.id;
      const staff = await loadStaffSession(staffId);

      if (!staff || !staff.isActive) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      req.user = {
        ...decoded,
        actorId: staffId,
        staffId,
        ownerId: staff.ownerUserId,
        role: STAFF_ROLE,
        accountType: STAFF_ROLE,
        name: staff.name,
        username: staff.username,
        ownerName: staff.ownerName,
        permissions: normalizePermissions(
          staff.pagePermissions || DEFAULT_STAFF_PERMISSIONS,
        ),
      };
      return next();
    }

    req.user = {
      ...decoded,
      actorId: decoded.actorId || decoded.id,
      ownerId: decoded.ownerId || decoded.id,
      role: OWNER_ROLE,
      accountType: OWNER_ROLE,
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

async function loadDeveloperSession(developerId) {
  const result = await pool.query(
    `
      SELECT id, name, email, is_active
      FROM developer_admins
      WHERE id = $1
      LIMIT 1
    `,
    [developerId],
  );

  if (!result.rowCount) {
    return null;
  }

  const developer = result.rows[0];
  return {
    id: developer.id,
    name: developer.name,
    email: developer.email,
    isActive: Boolean(developer.is_active),
  };
}

async function developerAuthMiddleware(req, res, next) {
  try {
    let token = null;

    if (req.cookies && req.cookies[DEVELOPER_SUPPORT_COOKIE_NAME]) {
      token = req.cookies[DEVELOPER_SUPPORT_COOKIE_NAME];
    }

    const header = req.headers.authorization;
    if (!token && header && header.startsWith("Bearer ")) {
      token = header.split(" ")[1];
    }

    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const decoded = verifyDeveloperSessionToken(token);
    if (
      String(decoded.role || "")
        .trim()
        .toLowerCase() !== DEVELOPER_SUPPORT_ROLE
    ) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const developerId = Number(decoded.developerId || decoded.id);
    if (!Number.isInteger(developerId) || developerId <= 0) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const developer = await loadDeveloperSession(developerId);
    if (!developer || !developer.isActive) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    req.developer = {
      ...decoded,
      id: developerId,
      developerId,
      role: DEVELOPER_SUPPORT_ROLE,
      accountType: DEVELOPER_SUPPORT_ROLE,
      name: developer.name,
      email: developer.email,
    };
    return next();
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("Developer JWT verification failed:", error.message);
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

function getDeveloperId(req) {
  const developerId = Number(req.developer?.developerId || req.developer?.id);
  if (!developerId) {
    throw new Error("Missing developer ID in request context");
  }
  return developerId;
}

function isOwnerSession(req) {
  return normalizeSessionRole(req.user?.role) === OWNER_ROLE;
}

function hasPermission(req, ...permissions) {
  if (isOwnerSession(req)) {
    return true;
  }

  const currentPermissions = normalizePermissions(req.user?.permissions);
  const requiredPermissions = normalizePermissions(permissions);

  return requiredPermissions.some((permission) =>
    currentPermissions.includes(permission),
  );
}

function requireOwner(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!isOwnerSession(req)) {
    return res.status(403).json({ error: "Owner access required" });
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
  const normalized = roles.map((role) => normalizeSessionRole(role));

  return (req, res, next) => {
    const currentRole = normalizeSessionRole(req.user?.role);
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!normalized.includes(currentRole)) {
      return res.status(403).json({ error: "Access denied" });
    }

    next();
  };
}

function requireDeveloperSupport(req, res, next) {
  if (!req.developer) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

module.exports = {
  DEVELOPER_SUPPORT_COOKIE_NAME,
  DEVELOPER_SUPPORT_ROLE,
  allowRoles,
  authMiddleware,
  developerAuthMiddleware,
  getDeveloperId,
  getActorId,
  getUserId,
  hasPermission,
  invalidateStaffSessionCache,
  isOwnerSession,
  requireDeveloperSupport,
  requireOwner,
  requirePermission,
};
