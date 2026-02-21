// routes/auth.js
const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const router = express.Router();

// -------------------- ENVIRONMENT CHECK --------------------
if (!process.env.JWT_SECRET) {
  console.error("❌ JWT_SECRET not found in environment variables.");
  process.exit(1);
}

// -------------------- REGISTER --------------------
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ error: "All fields required" });

    const existing = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (existing.rowCount > 0)
      return res.status(400).json({ error: "Email already registered" });

    const password_hash = await bcrypt.hash(password, 12);
    await pool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3)",
      [name, email, password_hash]
    );

    return res.json({ message: "Account created. You can now log in." });
  } catch (err) {
    console.error("Register error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

// -------------------- LOGIN --------------------
// -------------------- LOGIN --------------------
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "All fields required" });

    const result = await pool.query(
      "SELECT id, name, email, password_hash FROM users WHERE email=$1",
      [email]
    );

    if (result.rowCount === 0)
      return res.status(400).json({ error: "Invalid credentials" });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(400).json({ error: "Invalid credentials" });

    // ✅ Generate JWT
    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    // ✅ ADD: set JWT cookie (for downloads / navigation)
    res.cookie("token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000 // ✅ 1 day expiry sync with JWT
    });

    // ✅ KEEP response SAME (frontend stays untouched)
    return res.json({
      message: "Login successful",
      user: { id: user.id, name: user.name, email: user.email },
      token,
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});



// -------------------- FORGOT PASSWORD --------------------
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    console.log("📩 Forgot password request for:", email);

    if (!email)
      return res.status(400).json({ error: "Email required" });

    const result = await pool.query(
      "SELECT id FROM users WHERE email=$1",
      [email]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({
        error: "Email does not exist"
      });
    }


    const reset_token = crypto.randomBytes(20).toString("hex");
    const expires = new Date(Date.now() + 1000 * 60 * 15);

    await pool.query(
      "UPDATE users SET reset_token=$1, reset_token_expires=$2 WHERE email=$3",
      [reset_token, expires, email]
    );

    const resetLink =
      `${process.env.BASE_URL}/reset.html?token=${reset_token}&email=${encodeURIComponent(email)}`;

    console.log("🔗 Reset link generated:", resetLink);

    // 🔥 SEND MAIL VIA GOOGLE APPS SCRIPT
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
        `
      })
    });

    console.log("✅ Mail sent via Google Apps Script");

    return res.json({
      message: "If account exists, reset link has been sent."
    });

  } catch (err) {
    console.error("❌ Forgot password error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// -------------------- RESET PASSWORD --------------------
router.post("/reset-password", async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;

    if (!email || !token || !newPassword) {
      return res.status(400).json({ error: "All fields required" });
    }

    const result = await pool.query(
      "SELECT id, reset_token_expires FROM users WHERE email=$1 AND reset_token=$2",
      [email, token]
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
      "UPDATE users SET password_hash=$1, reset_token=NULL, reset_token_expires=NULL WHERE id=$2",
      [password_hash, user.id]
    );

    return res.json({
      message: "Password reset successful. You can now log in."
    });

  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});




// ✅ Verify token and return user info
router.get("/me", async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = auth.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Find user in DB
    const result = await pool.query(
      "SELECT id, name, email FROM users WHERE id=$1",
      [decoded.id]
    );

    if (!result || result.rowCount === 0) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("/me error:", err.message);
    res.status(401).json({ error: "Unauthorized" });
  }
});



module.exports = router;