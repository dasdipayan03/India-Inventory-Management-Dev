/**
 * =========================================================
 * FILE: repositories/ops-repository.js
 * PURPOSE: OPERATIONAL DATABASE OVERVIEW REPOSITORY
 * =========================================================
 * এই repository operational/health-report layer-এর জন্য PostgreSQL connection সম্পর্কে read-only
 * summary আনে। Route/controller সরাসরি SQL না লিখে এই function call করতে পারে। Functionটি caller-এর
 * দেওয়া pool ব্যবহার করে এবং কোনো table row insert, update বা delete করে না। Query/connection error
 * এখানে swallow করা হয় না; Promise reject হয়ে caller-এর error-handling middleware পর্যন্ত যেতে পারে।
 */

// ==================== BLOCK 01: FUNCTION CONTRACT ====================
// `pool` এমন PostgreSQL pool/client object, যার async `query(sql)` method আছে। Functionটি Promise return করে;
// resolve হলে plain overview object পাওয়া যায়, reject হলে database/connection error caller handle করে।
async function loadDatabaseOverview(pool) {
  // ==================== BLOCK 02: READ-ONLY DATABASE METADATA QUERY ====================
  // এই SELECT কোনো application table পড়েও না; PostgreSQL-এর built-in functions/values থেকে চারটি metadata field নেয়।
  // Parameter interpolation নেই, তাই এখানে user input বা dynamic SQL ঢোকে না এবং query parameter binding প্রয়োজন হয় না।
  const result = await pool.query(`
    SELECT
      -- Database server যে সময় query execute করছে সেটি checked_at নামে return হয়।
      NOW() AS checked_at,

      -- Connection বর্তমানে যে database-এ যুক্ত তার নাম database_name field-এ আসে।
      current_database() AS database_name,

      -- Queryটি যে PostgreSQL role/user দিয়ে চলছে সেটি database_user field-এ আসে।
      current_user AS database_user,

      -- PostgreSQL server build/version-এর পূর্ণ description database_version field-এ আসে।
      version() AS database_version
  `);

  // ==================== BLOCK 03: QUERY RESULT NORMALIZATION ====================
  // PostgreSQL SELECT সাধারণত `result.rows` array-এ একটি row দেয়। Caller array নয়, সরাসরি overview object পায়।
  // অস্বাভাবিকভাবে row না এলে undefined return না করে empty object দেওয়া হয়, যাতে property access safer থাকে।
  return result.rows[0] || {};
}

// ==================== BLOCK 04: PUBLIC REPOSITORY EXPORT ====================
// CommonJS export repository functionটি service/controller layer-এ `require(...)` করে ব্যবহারযোগ্য করে।
// Object export রাখায় ভবিষ্যতে related operational queries একই module-এ named method হিসেবে যোগ করা সম্ভব।
module.exports = {
  loadDatabaseOverview,
};
