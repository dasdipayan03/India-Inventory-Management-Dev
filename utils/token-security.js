/**
 * =========================================================
 * FILE: utils/token-security.js
 * PURPOSE: JWT SIGNING, PURPOSE/AUDIENCE ISOLATION ও LEGACY SESSION VERIFICATION
 * =========================================================
 * এই module application-এর সব JWT-এর shared issuer, আলাদা purpose/audience এবং mandatory secret policy নির্ধারণ করে।
 * সাধারণ owner/staff session ও developer-support session একই secret ব্যবহার করলেও purpose/audience mismatch-এর কারণে পরস্পরের জায়গায় চলে না।
 * পুরোনো session rollout-এর সময় সীমিত compatibility fallback পায়; environment strict হলে শুধু নতুন claim contract গ্রহণ করা হয়।
 */

// ==================== BLOCK 01: JWT LIBRARY, ISSUER ও TOKEN PURPOSE CATALOG ====================
// jsonwebtoken cryptographic sign/verify করে। Stable issuer token কোন application তৈরি করেছে জানায়। Frozen purpose catalog browser session,
// developer session, Google OAuth state/onboarding এবং Android transfer token-কে আলাদা security context হিসেবে নাম দেয়।
const jwt = require("jsonwebtoken");

const TOKEN_ISSUER = "india-inventory-management";
const TOKEN_PURPOSES = Object.freeze({
  SESSION: "app-session",
  DEVELOPER_SESSION: "developer-support-session",
  GOOGLE_OAUTH_STATE: "google-oauth-state",
  GOOGLE_ONBOARDING: "google-onboarding",
  ANDROID_GOOGLE_TRANSFER: "android-google-transfer",
});

/*
 * =========================================================
 * BLOCK 02: PURPOSE থেকে EXPECTED AUDIENCE MAPPING
 * =========================================================
 * প্রতিটি token purpose-এর নির্দিষ্ট consumer/audience আছে—app, developer portal, OAuth callback অথবা Android client।
 * Object freeze runtime mutation আটকায়; unsupported purpose mapping না পাওয়ায় sign/verify-এর আগেই reject হয়।
 */
const TOKEN_AUDIENCES = Object.freeze({
  [TOKEN_PURPOSES.SESSION]: "india-inventory-app",
  [TOKEN_PURPOSES.DEVELOPER_SESSION]: "india-inventory-developer-portal",
  [TOKEN_PURPOSES.GOOGLE_OAUTH_STATE]: "google-oauth-callback",
  [TOKEN_PURPOSES.GOOGLE_ONBOARDING]: "india-inventory-app",
  [TOKEN_PURPOSES.ANDROID_GOOGLE_TRANSFER]: "india-inventory-android",
});

/*
 * =========================================================
 * BLOCK 03: REQUIRED JWT SECRET LOADER
 * =========================================================
 * Environment value string/trim করে blank secret reject করে। Sign ও verify দুটোই এই function ব্যবহার করায় missing configuration-এ
 * insecure default secret silently ব্যবহৃত হয় না। Secret return হলেও কোনো log বা exported constant-এ রাখা হয় না।
 */
function getSecret() {
  const secret = String(process.env.JWT_SECRET || "").trim();
  if (!secret) throw new Error("JWT_SECRET not found in environment variables.");
  return secret;
}

/*
 * =========================================================
 * BLOCK 04: LEGACY-CLAIM COMPATIBILITY SWITCH
 * =========================================================
 * Migration চলাকালে default `compat` mode পুরোনো owner/staff/developer sessions-কে controlled fallback দেয়।
 * `JWT_CLAIMS_ENFORCEMENT=strict` হলে fallback পুরোপুরি বন্ধ এবং issuer/audience/purpose-সহ নতুন token-ই গ্রহণযোগ্য।
 */
function allowLegacyTokens() {
  // সবচেয়ে দীর্ঘ legacy session (৩ দিন) শেষ হওয়ার পরে deployment-এ strict value বসালে migration compatibility সরানো যায়।
  return String(process.env.JWT_CLAIMS_ENFORCEMENT || "compat")
    .trim()
    .toLowerCase() !== "strict";
}

/*
 * =========================================================
 * BLOCK 05: PURPOSE-BOUND TOKEN SIGNING
 * =========================================================
 * Requested purpose-এর audience lookup করে unsupported value reject করে। Caller payload-এর সঙ্গে authoritative purpose claim যোগ করে
 * configured expiry, shared issuer ও matching audienceসহ JWT sign করে। Payload-এর existing purpose spread-এর পরে overwrite হয়।
 */
function signToken(payload, purpose, expiresIn) {
  /* SIGN PHASE A: purpose allow-list mapping থেকে expected audience resolve ও validate করা। */
  const audience = TOKEN_AUDIENCES[purpose];
  if (!audience) throw new Error("Unsupported JWT token purpose.");
  /* SIGN PHASE B: payload + enforced purpose claim secret দিয়ে sign এবং expiry/issuer/audience registered claims বসানো। */
  return jwt.sign({ ...payload, purpose }, getSecret(), {
    expiresIn,
    issuer: TOKEN_ISSUER,
    audience,
  });
}

/*
 * =========================================================
 * BLOCK 06: LEGACY CLAIM-SHAPE DETECTION
 * =========================================================
 * পুরোনো token-এ purpose, issuer ও audience তিন claim-ই অনুপস্থিত কি না পরীক্ষা করে।
 * নামের `Unsigned` claim-set metadata বোঝায়; fallback `jwt.verify` দিয়ে signature ও expiry এখনও যাচাই করে।
 */
function isUnsignedLegacyClaimSet(decoded) {
  return !decoded?.purpose && !decoded?.iss && !decoded?.aud;
}

/*
 * =========================================================
 * BLOCK 07: STRICT VERIFY ও CONTROLLED LEGACY FALLBACK
 * =========================================================
 * প্রথমে secret, issuer ও purpose-specific audience দিয়ে signature/expiry/claims verify করে এবং decoded purpose exact match চায়।
 * Strict failure হলে fallback কেবল caller অনুমতি, global compat mode, old claim shape এবং caller role-validator—সব পাস করলে গ্রহণ হয়।
 * Legacy validation ব্যর্থ হলে original strict error পুনরায় throw হয়, যাতে weak token নতুন contract bypass করতে না পারে।
 */
function verifyToken(token, purpose, { allowLegacy = false, validateLegacy } = {}) {
  /* VERIFY PHASE A: requested purpose supported কি না নিশ্চিত করে expected audience নেওয়া। */
  const audience = TOKEN_AUDIENCES[purpose];
  if (!audience) throw new Error("Unsupported JWT token purpose.");

  /* VERIFY PHASE B: signature, expiry, issuer, audience এবং custom purpose claim strictভাবে যাচাই। */
  try {
    const decoded = jwt.verify(token, getSecret(), {
      issuer: TOKEN_ISSUER,
      audience,
    });
    if (decoded.purpose !== purpose) throw new Error("Invalid JWT token purpose.");
    return decoded;
  } catch (strictError) {
    /* VERIFY PHASE C: route policy বা environment strict হলে original verification failure সঙ্গে সঙ্গে propagate করা। */
    if (!allowLegacy || !allowLegacyTokens()) throw strictError;

    /* VERIFY PHASE D: legacy token-এর signature/expiry আবার verify এবং claim-shape + caller validator দিয়ে সীমাবদ্ধ করা। */
    const legacy = jwt.verify(token, getSecret());
    if (!isUnsignedLegacyClaimSet(legacy) || !validateLegacy?.(legacy)) {
      throw strictError;
    }
    return legacy;
  }
}

// ==================== BLOCK 08: APPLICATION SESSION ROLE VALIDATION ====================
// Legacy general session শুধু owner/admin/staff role হলে valid; trim/lowercase পুরোনো casing/spacing difference normalize করে।
function isOwnerOrStaffRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return role === "owner" || role === "admin" || role === "staff";
}

/*
 * =========================================================
 * BLOCK 09: OWNER/STAFF SESSION WRAPPERS
 * =========================================================
 * General application session fixed `app-session` purpose/audience ও ৩ দিনের expiry দিয়ে sign হয়।
 * Verification একই strict contract ব্যবহার করে; migration fallback শুধু recognized owner/admin/staff legacy role গ্রহণ করে।
 */
function signSessionToken(payload) {
  return signToken(payload, TOKEN_PURPOSES.SESSION, "3d");
}

function verifySessionToken(token) {
  return verifyToken(token, TOKEN_PURPOSES.SESSION, {
    allowLegacy: true,
    validateLegacy: (decoded) => isOwnerOrStaffRole(decoded.role),
  });
}

/*
 * =========================================================
 * BLOCK 10: DEVELOPER-SUPPORT SESSION WRAPPERS
 * =========================================================
 * Developer portal session আলাদা purpose/audience ও ৩ দিনের expiry পায়, তাই normal app token developer route-এ ব্যবহার করা যায় না।
 * Legacy fallback কেবল normalized role ঠিক `developer_support` হলে গ্রহণ করে।
 */
function signDeveloperSessionToken(payload) {
  return signToken(payload, TOKEN_PURPOSES.DEVELOPER_SESSION, "3d");
}

function verifyDeveloperSessionToken(token) {
  return verifyToken(token, TOKEN_PURPOSES.DEVELOPER_SESSION, {
    allowLegacy: true,
    validateLegacy: (decoded) => String(decoded.role || "").trim().toLowerCase() === "developer_support",
  });
}

/*
 * =========================================================
 * BLOCK 11: PUBLIC TOKEN-SECURITY API
 * =========================================================
 * Purpose/audience/issuer constants, generic sign/verify এবং দুই session domain-এর convenience wrappers export করা হয়।
 * Secret loader, compatibility decision ও legacy shape/role validators private থাকে।
 */
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
