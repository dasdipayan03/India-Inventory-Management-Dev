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
// Database থেকে staff ও developer account-এর বর্তমান অবস্থা নেওয়ার জন্য pool।
const {
  DEFAULT_STAFF_PERMISSIONS,
  normalizePermissions,
} = require("../public/js/permission-contract");
// Staff-এর permission list ঠিক format-এ আনা ও default permission দেওয়ার helper।
const {
  verifyDeveloperSessionToken,
  verifySessionToken,
} = require("../utils/token-security");
// দুই ধরনের JWT token সত্যি, অক্ষত ও মেয়াদে আছে কি না যাচাই করার function।

if (!process.env.JWT_SECRET) {
  // Secret না থাকলে token-এর signature যাচাই নিরাপদভাবে করা যাবে না।
  console.error("JWT_SECRET not found in environment variables.");
  process.exit(1);
}

function readNonNegativeInt(value, fallback) {
  // Environment variable-এর text-কে 0 বা তার চেয়ে বড় number বানায়।
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const STAFF_SESSION_CACHE_TTL_MS = readNonNegativeInt(
  process.env.STAFF_SESSION_CACHE_TTL_MS,
  0,
);
// কত millisecond staff session memory-তে থাকবে; 0 মানে cache ব্যবহার হবে না।
const STAFF_SESSION_CACHE_MAX_ENTRIES = 200;
const STAFF_ROLE = "staff";
const OWNER_ROLE = "owner";
const DEVELOPER_SUPPORT_ROLE = "developer_support";
const DEVELOPER_SUPPORT_COOKIE_NAME = "developer_support_token";
const staffSessionCache = new Map();
// staff ID-কে key করে সাময়িক staff/session data রাখার memory cache।

function normalizeSessionRole(value) {
  // Role-এর casing ও অপ্রয়োজনীয় space সরিয়ে একটিই standard role value দেয়।
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (normalized === STAFF_ROLE) {
    // Staff role হলে সরাসরি standard staff value ফেরত দেয়।
    return STAFF_ROLE;
  }

  // Keep older admin tokens/sessions working while the app now speaks in owner terms.
  if (normalized === "admin" || normalized === OWNER_ROLE) {
    return OWNER_ROLE;
  }

  return normalized;
  // অজানা role হলে সেটি অপরিবর্তিত রেখে caller-কে permission deny করার সুযোগ দেয়।
}

function getStaffSessionCacheKey(staffId) {
  // শুধু positive integer staff ID-ই cache key হতে পারবে।
  const normalizedStaffId = Number(staffId);
  return Number.isInteger(normalizedStaffId) && normalizedStaffId > 0
    ? normalizedStaffId
    : 0;
}

function getCachedStaffSession(staffId) {
  // Cache বন্ধ থাকলে database থেকে fresh data আনতে null ফেরত দেয়।
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
    // মেয়াদ শেষ হওয়া cache entry ব্যবহার না করে মুছে ফেলে।
    staffSessionCache.delete(cacheKey);
    return null;
  }

  return cachedEntry.value;
}

function setCachedStaffSession(staffId, sessionData) {
  // Valid staff data এবং তার expiry time একসঙ্গে cache-এ রাখে।
  if (STAFF_SESSION_CACHE_TTL_MS <= 0) {
    return sessionData;
  }

  const cacheKey = getStaffSessionCacheKey(staffId);
  if (!cacheKey) {
    return sessionData;
  }

  while (staffSessionCache.size >= STAFF_SESSION_CACHE_MAX_ENTRIES) {
    // Cache পূর্ণ হলে সবচেয়ে আগে রাখা entry সরিয়ে memory limit বজায় রাখে।
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
  // Staff disable/permission change হলে পুরোনো cached session সরানোর জন্য।
  const cacheKey = getStaffSessionCacheKey(staffId);
  if (cacheKey) {
    staffSessionCache.delete(cacheKey);
  }
}

async function loadStaffSession(staffId) {
  // Token-এর staff ID ব্যবহার করে database থেকে বর্তমান staff access data নেয়।
  const cachedStaff = getCachedStaffSession(staffId);
  if (cachedStaff) {
    return cachedStaff;
  }

  const result = await pool.query(
    // staff account-এর সঙ্গে তার owner user-কে join করে business owner-ও বের করে।
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
    // Staff ID database-এ না থাকলে session আর বৈধ নয়।
    invalidateStaffSessionCache(staffId);
    return null;
  }

  const staff = result.rows[0];
  if (!staff.is_active) {
    // Inactive staff-এর token থাকলেও তাকে route access দেওয়া হবে না।
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
    // Active staff-এর fresh data cache-এ রেখে ফেরত দেয়।
    ownerUserId: staff.owner_user_id,
    name: staff.name,
    username: staff.username,
    isActive: true,
    pagePermissions: staff.page_permissions,
    ownerName: staff.owner_name,
  });
}

async function authMiddleware(req, res, next) {
  // Owner ও staff-এর protected route-এ route handler-এর আগে এই middleware চলে।
  try {
    let token = null;

    if (req.cookies && req.cookies.token) {
      // Browser login-এর token সাধারণত cookie থেকে পাওয়া যায়।
      token = req.cookies.token;
    }

    const header = req.headers.authorization;
    if (!token && header && header.startsWith("Bearer ")) {
      // API client cookie না পাঠালে Authorization header-এর Bearer token নেয়।
      token = header.split(" ")[1];
    }

    if (!token) {
      // Login/token ছাড়া protected route ব্যবহার করা যাবে না।
      return res.status(401).json({ error: "Unauthorized" });
    }

    const decoded = verifySessionToken(token);
    // Signature ও expiry ঠিক থাকলে token payload (ID, role ইত্যাদি) পাওয়া যায়।

    if (normalizeSessionRole(decoded.role) === STAFF_ROLE) {
      // Staff token হলে database থেকে fresh active status ও permission যাচাই আবশ্যক।
      const staffId = decoded.actorId || decoded.staffId || decoded.id;
      // পুরোনো এবং নতুন format-এর token দুটোই support করার fallback।
      const staff = await loadStaffSession(staffId);

      if (!staff || !staff.isActive) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      req.user = {
        // পরের route handler-গুলোর জন্য verified staff context request-এ বসায়।
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
      // Authentication সফল, এখন পরের middleware বা আসল route handler চলবে।
    }

    req.user = {
      // Staff না হলে authenticated owner হিসেবে সম্পূর্ণ access context বসায়।
      ...decoded,
      actorId: decoded.actorId || decoded.id,
      ownerId: decoded.ownerId || decoded.id,
      role: OWNER_ROLE,
      accountType: OWNER_ROLE,
      permissions: ["all"],
    };
    return next();
  } catch (error) {
    // Tampered, malformed বা expired token verify করতে ব্যর্থ হলে এখানে আসে।
    if (process.env.NODE_ENV !== "production") {
      console.error("JWT verification failed:", error.message);
    }
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

async function loadDeveloperSession(developerId) {
  // Developer support token-এর ID ধরে account এখনও active কি না database থেকে দেখে।
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
  // Developer support panel-এর protected route-এর authentication middleware।
  try {
    let token = null;

    if (req.cookies && req.cookies[DEVELOPER_SUPPORT_COOKIE_NAME]) {
      // Developer panel-এর আলাদা cookie থেকে token নেয়।
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
    // সাধারণ user token যেন developer route-এ ব্যবহার না হয়, তার জন্য আলাদা verifier।
    if (
      String(decoded.role || "")
        .trim()
        .toLowerCase() !== DEVELOPER_SUPPORT_ROLE
    ) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const developerId = Number(decoded.developerId || decoded.id);
    // Token-এ থাকা developer ID-কে valid positive integer করা হয়।
    if (!Number.isInteger(developerId) || developerId <= 0) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const developer = await loadDeveloperSession(developerId);
    if (!developer || !developer.isActive) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    req.developer = {
      // Verified developer identity request-এ রাখে; support route এটি ব্যবহার করবে।
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
  // Business data query করার owner ID দেয়; staff হলেও তার owner-এর ID ফেরত দেয়।
  const ownerId = Number(req.user?.ownerId || req.user?.id);
  if (!ownerId) {
    throw new Error("Missing owner user ID in request context");
  }
  return ownerId;
}

function getActorId(req) {
  // Request/কাজটি আসলে কে করেছে তার ID দেয়: owner বা staff।
  const actorId = Number(req.user?.actorId || req.user?.id);
  if (!actorId) {
    throw new Error("Missing actor ID in request context");
  }
  return actorId;
}

function getDeveloperId(req) {
  // developerAuthMiddleware সফল হওয়ার পরে developer-এর ID নিরাপদে নেয়।
  const developerId = Number(req.developer?.developerId || req.developer?.id);
  if (!developerId) {
    throw new Error("Missing developer ID in request context");
  }
  return developerId;
}

function isOwnerSession(req) {
  // Current authenticated user owner role-এ আছে কি না বলে।
  return normalizeSessionRole(req.user?.role) === OWNER_ROLE;
}

function hasPermission(req, ...permissions) {
  // Owner সব permission পায়; staff-এর ক্ষেত্রে assigned permission list মিলিয়ে দেখে।
  if (isOwnerSession(req)) {
    return true;
  }

  const currentPermissions = normalizePermissions(req.user?.permissions);
  const requiredPermissions = normalizePermissions(permissions);

  return requiredPermissions.some((permission) =>
    // প্রয়োজনীয় permissionগুলোর অন্তত একটি staff-এর থাকলেই access অনুমোদন করে।
    currentPermissions.includes(permission),
  );
}

function requireOwner(req, res, next) {
  // Owner-only route guard; staff হলে 403 Forbidden দেয়।
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!isOwnerSession(req)) {
    return res.status(403).json({ error: "Owner access required" });
  }

  next();
}

function requirePermission(...permissions) {
  // Route-এ প্রয়োজনীয় permission দিয়ে reusable guard বানানো যায়।
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
  // Permission নয়, নির্দিষ্ট role-গুলোর ভিত্তিতে route guard বানায়।
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
  // req.developer না থাকলে developer authentication হয়নি ধরে access বন্ধ করে।
  if (!req.developer) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

module.exports = {
  // নিচের function ও constants অন্যান্য route/module-এ ব্যবহারের জন্য export করা হলো।
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
