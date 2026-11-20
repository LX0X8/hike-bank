require("dotenv").config();

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const fs = require("fs");
const path = require("path");

const app = express();
const port = Number(process.env.PORT || 10000);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || "replace-this-session-secret-before-launch",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: "draft-7", legacyHeaders: false });
const actionLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false });

function cleanUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function validAmount(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 1000000000000 ? amount : null;
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Please log in first." });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

async function applyBonus(userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT id, balance, next_bonus_at, role FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return null;
    }

    const user = result.rows[0];
    if (user.role === "player") {
      const now = Date.now();
      const next = new Date(user.next_bonus_at).getTime();
      if (next <= now) {
        const intervals = Math.floor((now - next) / (48 * 60 * 60 * 1000)) + 1;
        const bonus = intervals * 500000;
        await client.query(
          "UPDATE users SET balance = balance + $1, next_bonus_at = next_bonus_at + ($2 * INTERVAL '48 hours') WHERE id = $3",
          [bonus, intervals, userId]
        );
        await client.query(
          "INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, 'bonus', $2, $3)",
          [userId, bonus, "Automatic 48-hour player bonus"]
        );
      }
    }
    const updated = await client.query(
      "SELECT id, username, role, balance, next_bonus_at, created_at FROM users WHERE id = $1",
      [userId]
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function sendDiscordNotification(username, amount) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const recipientId = process.env.DISCORD_USER_ID;
  if (!token || !recipientId) {
    console.warn("Discord notification skipped: DISCORD_BOT_TOKEN or DISCORD_USER_ID is not configured.");
    return;
  }

  const dmResponse = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: { Authorization: "Bot " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: recipientId })
  });
  if (!dmResponse.ok) throw new Error("Discord DM channel creation failed: " + dmResponse.status);
  const channel = await dmResponse.json();

  const messageResponse = await fetch("https://discord.com/api/v10/channels/" + channel.id + "/messages", {
    method: "POST",
    headers: { Authorization: "Bot " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ content: "HIKE BANK withdrawal: " + username + " withdrew " + Number(amount).toLocaleString("en-US") + " credits." })
  });
  if (!messageResponse.ok) throw new Error("Discord message failed: " + messageResponse.status);
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/register", authLimiter, async (req, res) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || "");
    if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: "Username must be 3–24 characters using letters, numbers, or underscores." });
    if (password.length < 8 || password.length > 72) return res.status(400).json({ error: "Password must be at least 8 characters." });

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, role",
      [username, passwordHash]
    );
    req.session.user = result.rows[0];
    res.json({ ok: true, user: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That username is already taken." });
    console.error(error);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/login", authLimiter, async (req, res) => {
  try {
    const username = cleanUsername(req.body.username);
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    if (!result.rowCount || !(await bcrypt.compare(String(req.body.password || ""), result.rows[0].password_hash))) {
      return res.status(401).json({ error: "Incorrect username or password." });
    }
    const user = result.rows[0];
    req.session.user = { id: user.id, username: user.username, role: user.role };
    const current = await applyBonus(user.id);
    res.json({ ok: true, user: current });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not log in." });
  }
});

app.post("/api/logout", requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const user = await applyBonus(req.session.user.id);
    if (!user) return res.status(401).json({ error: "Account not found." });
    res.json({ user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load account." });
  }
});

app.get("/api/transactions", requireAuth, async (req, res) => {
  try {
    await applyBonus(req.session.user.id);
    const result = await pool.query(
      "SELECT id, type, amount, description, status, created_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
      [req.session.user.id]
    );
    res.json({ transactions: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load transactions." });
  }
});

app.post("/api/deposits", requireAuth, actionLimiter, async (req, res) => {
  const amount = validAmount(req.body.amount);
  if (!amount) return res.status(400).json({ error: "Enter a valid positive whole-number amount." });
  try {
    const result = await pool.query(
      "INSERT INTO deposit_requests (user_id, amount) VALUES ($1, $2) RETURNING id, amount, status, created_at",
      [req.session.user.id, amount]
    );
    res.json({ ok: true, request: result.rows[0], message: "Deposit request sent to an admin for approval." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not submit deposit request." });
  }
});

app.post("/api/withdraw", requireAuth, actionLimiter, async (req, res) => {
  const amount = validAmount(req.body.amount);
  if (!amount) return res.status(400).json({ error: "Enter a valid positive whole-number amount." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT id, username, balance FROM users WHERE id = $1 FOR UPDATE", [req.session.user.id]);
    if (!locked.rowCount || Number(locked.rows[0].balance) < amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient balance." });
    }
    const user = locked.rows[0];
    await client.query("UPDATE users SET balance = balance - $1 WHERE id = $2", [amount, user.id]);
    await client.query(
      "INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, 'withdrawal', $2, 'Player withdrawal')",
      [user.id, -amount]
    );
    await client.query("COMMIT");
    try {
      await sendDiscordNotification(user.username, amount);
    } catch (discordError) {
      console.error(discordError);
    }
    const updated = await applyBonus(user.id);
    res.json({ ok: true, user: updated, message: "Withdrawal recorded." });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Could not process withdrawal." });
  } finally {
    client.release();
  }
});

app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const result = await pool.query(
    "SELECT id, username, role, balance, next_bonus_at, created_at FROM users ORDER BY username"
  );
  res.json({ users: result.rows });
});

app.post("/api/admin/adjust", requireAuth, requireAdmin, actionLimiter, async (req, res) => {
  const username = cleanUsername(req.body.username);
  const amount = validAmount(req.body.amount);
  const action = req.body.action;
  if (!username || !amount || !["add", "remove"].includes(action)) return res.status(400).json({ error: "Provide a username, valid amount, and add/remove action." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT id, username, balance FROM users WHERE username = $1 FOR UPDATE", [username]);
    if (!found.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Player not found." });
    }
    const user = found.rows[0];
    if (action === "remove" && Number(user.balance) < amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Player does not have enough credits." });
    }
    const delta = action === "add" ? amount : -amount;
    await client.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [delta, user.id]);
    await client.query(
      "INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, 'admin_adjustment', $2, $3)",
      [user.id, delta, "Admin " + action + "ed credits"]
    );
    const updated = await client.query("SELECT id, username, role, balance FROM users WHERE id = $1", [user.id]);
    await client.query("COMMIT");
    res.json({ ok: true, user: updated.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Could not adjust balance." });
  } finally {
    client.release();
  }
});

app.get("/api/admin/deposits", requireAuth, requireAdmin, async (req, res) => {
  const result = await pool.query(
    "SELECT d.id, d.amount, d.status, d.created_at, u.username FROM deposit_requests d JOIN users u ON u.id = d.user_id ORDER BY d.created_at DESC LIMIT 100"
  );
  res.json({ requests: result.rows });
});

app.post("/api/admin/deposits/:id/approve", requireAuth, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const request = await client.query("SELECT * FROM deposit_requests WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!request.rowCount || request.rows[0].status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Pending deposit request not found." });
    }
    const item = request.rows[0];
    await client.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [item.amount, item.user_id]);
    await client.query(
      "INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, 'deposit', $2, 'Admin-approved deposit')",
      [item.user_id, item.amount]
    );
    await client.query("UPDATE deposit_requests SET status = 'approved', reviewed_at = NOW() WHERE id = $1", [item.id]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Could not approve deposit." });
  } finally {
    client.release();
  }
});

app.post("/api/admin/deposits/:id/reject", requireAuth, requireAdmin, async (req, res) => {
  const result = await pool.query(
    "UPDATE deposit_requests SET status = 'rejected', reviewed_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING id",
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Pending deposit request not found." });
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

async function start() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required. Add a PostgreSQL database in Render.");
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error("Set SESSION_SECRET to a random string at least 32 characters long in Render.");
  }
  const schema = fs.readFileSync(path.join(__dirname, "database", "schema.sql"), "utf8");
  await pool.query(schema);

  const adminUsername = cleanUsername(process.env.ADMIN_USERNAME || "ADMIN");
  const adminPassword = process.env.ADMIN_PASSWORD || "hike223";
  const existing = await pool.query("SELECT id FROM users WHERE username = $1", [adminUsername]);
  if (!existing.rowCount) {
    const hash = await bcrypt.hash(adminPassword, 12);
    await pool.query(
      "INSERT INTO users (username, password_hash, role, next_bonus_at) VALUES ($1, $2, 'admin', NOW() + INTERVAL '100 years')",
      [adminUsername, hash]
    );
    console.log("Initial admin account created. Change its password before public launch.");
  }
  app.listen(port, () => console.log("HIKE BANK listening on port " + port));
}

start().catch(error => {
  console.error(error);
  process.exit(1);
});