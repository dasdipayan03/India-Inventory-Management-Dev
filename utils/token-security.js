const jwt = require("jsonwebtoken");

const TOKEN_ISSUER = "india-inventory-management";
const TOKEN_PURPOSES = Object.freeze({
  SESSION: "app-session",
  DEVELOPER_SESSION: "developer-support-session",
  GOOGLE_OAUTH_STATE: "google-oauth-state",
  GOOGLE_ONBOARDING: "google-onboarding",
  ANDROID_GOOGLE_TRANSFER: "android-google-transfer",
});

const TOKEN_AUDIENCES = Object.freeze({
  [TOKEN_PURPOSES.SESSION]: "india-inventory-app",
  [TOKEN_PURPOSES.DEVELOPER_SESSION]: "india-inventory-developer-portal",
  [TOKEN_PURPOSES.GOOGLE_OAUTH_STATE]: "google-oauth-callback",
  [TOKEN_PURPOSES.GOOGLE_ONBOARDING]: "india-inventory-app",
  [TOKEN_PURPOSES.ANDROID_GOOGLE_TRANSFER]: "india-inventory-android",
});

function getSecret() {
  const secret = String(process.env.JWT_SECRET || "").trim();
  if (!secret) throw new Error("JWT_SECRET not found in environment variables.");
  return secret;
}

function allowLegacyTokens() {
  // Keep existing owner/staff browser sessions alive during the rollout. Set
  // JWT_CLAIMS_ENFORCEMENT=strict after the longest legacy session (3 days).
  return String(process.env.JWT_CLAIMS_ENFORCEMENT || "compat")
    .trim()
    .toLowerCase() !== "strict";
}

function signToken(payload, purpose, expiresIn) {
  const audience = TOKEN_AUDIENCES[purpose];
  if (!audience) throw new Error("Unsupported JWT token purpose.");
  return jwt.sign({ ...payload, purpose }, getSecret(), {
    expiresIn,
    issuer: TOKEN_ISSUER,
    audience,
  });
}

function isUnsignedLegacyClaimSet(decoded) {
  return !decoded?.purpose && !decoded?.iss && !decoded?.aud;
}

function verifyToken(token, purpose, { allowLegacy = false, validateLegacy } = {}) {
  const audience = TOKEN_AUDIENCES[purpose];
  if (!audience) throw new Error("Unsupported JWT token purpose.");

  try {
    const decoded = jwt.verify(token, getSecret(), {
      issuer: TOKEN_ISSUER,
      audience,
    });
    if (decoded.purpose !== purpose) throw new Error("Invalid JWT token purpose.");
    return decoded;
  } catch (strictError) {
    if (!allowLegacy || !allowLegacyTokens()) throw strictError;
    const legacy = jwt.verify(token, getSecret());
    if (!isUnsignedLegacyClaimSet(legacy) || !validateLegacy?.(legacy)) {
      throw strictError;
    }
    return legacy;
  }
}

function isOwnerOrStaffRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return role === "owner" || role === "admin" || role === "staff";
}

function signSessionToken(payload) {
  return signToken(payload, TOKEN_PURPOSES.SESSION, "3d");
}

function verifySessionToken(token) {
  return verifyToken(token, TOKEN_PURPOSES.SESSION, {
    allowLegacy: true,
    validateLegacy: (decoded) => isOwnerOrStaffRole(decoded.role),
  });
}

function signDeveloperSessionToken(payload) {
  return signToken(payload, TOKEN_PURPOSES.DEVELOPER_SESSION, "3d");
}

function verifyDeveloperSessionToken(token) {
  return verifyToken(token, TOKEN_PURPOSES.DEVELOPER_SESSION, {
    allowLegacy: true,
    validateLegacy: (decoded) => String(decoded.role || "").trim().toLowerCase() === "developer_support",
  });
}

module.exports = {
  TOKEN_AUDIENCES,
  TOKEN_ISSUER,
  TOKEN_PURPOSES,
  signDeveloperSessionToken,
  signSessionToken,
  signToken,
  verifyDeveloperSessionToken,
  verifySessionToken,
  verifyToken,
};
