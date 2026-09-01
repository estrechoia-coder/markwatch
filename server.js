// MarkWatch — fake-door demand-test server (S19 USPTO trademark watch API).
// Serves the landing page and records: page views, waitlist emails, and
// PAID-INTENT plan selections (the primary demand signal).
// Storage: Postgres when DATABASE_URL is set (durable), else JSONL fallback
// (ephemeral — free-tier hosts may wipe disk on restart; Postgres is the
// real measurement store, same pattern as EdgarFeed).
// Pure Node; the only optional dependency is `pg`.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = parseInt(process.env.PORT || "8788", 10);
const DATABASE_URL = process.env.DATABASE_URL || "";
const DATA_DIR = path.join(__dirname, "data");
const EVENTS = path.join(DATA_DIR, "events.jsonl");

// BOM-strip the landing page (PowerShell UTF-8 BOM broke JSON.parse before).
const raw = fs.readFileSync(path.join(__dirname, "landing.html"), "utf8");
const LANDING = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TIERS = ["free", "starter", "pro"];

// ---------------- storage abstraction ----------------
let pg = null;
let pool = null;

function logEvent(ev) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(EVENTS, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n");
}

async function initPg() {
  try {
    pg = require("pg");
    pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query(`CREATE TABLE IF NOT EXISTS markwatch_events (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      kind TEXT NOT NULL,
      email TEXT,
      tier TEXT,
      ref TEXT
    )`);
    console.log("storage: postgres (durable)");
    return true;
  } catch (e) {
    console.log("storage: jsonl-ephemeral (pg unavailable: " + e.message.slice(0, 80) + ")");
    pg = null; pool = null;
    return false;
  }
}

async function store(kind, email, tier, ref) {
  if (pool) {
    await pool.query("INSERT INTO markwatch_events (kind, email, tier, ref) VALUES ($1,$2,$3,$4)", [kind, email, tier, ref]);
  } else {
    logEvent({ kind, email: email || null, tier: tier || null, ref: ref || null });
  }
}

// ---------------- helpers ----------------
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 10000) { req.destroy(); resolve(null); } });
    req.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function isInternal(u) { return u.searchParams.get("internal") === "1"; }
function isTestEmail(e) { return /@markwatch\.example$/i.test(e || ""); }

// ---------------- stats ----------------
async function stats() {
  if (pool) {
    const r = await pool.query("SELECT kind, tier, count(*)::int AS n FROM markwatch_events GROUP BY kind, tier");
    const rows = r.rows || [];
    const pv = rows.filter(x => x.kind === "pv").reduce((a, x) => a + x.n, 0);
    const wl = rows.filter(x => x.kind === "waitlist").reduce((a, x) => a + x.n, 0);
    const intents = rows.filter(x => x.kind === "intent");
    const by_plan = {}; intents.forEach(x => { by_plan[x.tier || "?"] = x.n; });
    return { storage: "postgres", page_views: pv, waitlist: wl, paid_intent: { total: intents.reduce((a, x) => a + x.n, 0), by_plan } };
  }
  if (fs.existsSync(EVENTS)) {
    const lines = fs.readFileSync(EVENTS, "utf8").trim().split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const pv = lines.filter(e => e.kind === "pv").length;
    const wl = lines.filter(e => e.kind === "waitlist").length;
    const intents = lines.filter(e => e.kind === "intent");
    const by_plan = {}; intents.forEach(e => { by_plan[e.tier || "?"] = (by_plan[e.tier || "?"] || 0) + 1; });
    return { storage: "jsonl-ephemeral", page_views: pv, waitlist: wl, paid_intent: { total: intents.length, by_plan } };
  }
  return { storage: "empty", page_views: 0, waitlist: 0, paid_intent: { total: 0, by_plan: {} } };
}

// ---------------- server ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" }); return res.end(); }

    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(LANDING);
    }
    if (p === "/api/health") {
      const s = await stats();
      return send(res, 200, { ok: true, storage: s.storage });
    }
    if (p === "/api/stats") {
      if (!isInternal(u)) await store("pv", null, null, "stats-request");
      const s = await stats();
      return send(res, 200, { as_of: new Date().toISOString(), ...s, note: "Aggregate counters only (no emails exposed). Internal/verification traffic excluded." });
    }
    if (p === "/api/pv") {
      const body = await readBody(req);
      if (isInternal(u)) return send(res, 200, { ok: true, skipped: "internal" });
      await store("pv", null, null, (body && body.ref) || "");
      return send(res, 200, { ok: true });
    }
    if (p === "/api/waitlist") {
      const body = await readBody(req);
      const email = (body && body.email || "").trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return send(res, 400, { ok: false, error: "Please provide a valid email address." });
      if (isTestEmail(email)) return send(res, 200, { ok: true, skipped: "test email" });
      await store("waitlist", email, null, (body && body.ref) || "");
      return send(res, 200, { ok: true });
    }
    if (p === "/api/intent") {
      const body = await readBody(req);
      const email = (body && body.email || "").trim().toLowerCase();
      const tier = (body && body.tier || "").trim();
      if (!EMAIL_RE.test(email)) return send(res, 400, { ok: false, error: "Please provide a valid email address." });
      if (!TIERS.includes(tier)) return send(res, 400, { ok: false, error: "Please choose a plan." });
      if (isTestEmail(email)) return send(res, 200, { ok: true, skipped: "test email" });
      await store("intent", email, tier, (body && body.ref) || "");
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    console.log("ERROR:", e.message.slice(0, 200));
    return send(res, 500, { ok: false, error: "server error" });
  }
});

(async () => {
  if (DATABASE_URL) await initPg();
  server.listen(PORT, HOST, () => console.log("markwatch fake-door on http://" + HOST + ":" + PORT + " (storage=" + (pool ? "postgres" : "jsonl-ephemeral") + ")"));
})();
