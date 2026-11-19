// Dashboard + admin API. Admin password: scrypt hash in data/admin.json. Sessions: random id in an
// HttpOnly SameSite=Strict cookie. State-changing calls need the per-session CSRF token header, the
// X-Requested-With header and a same-origin Origin. Host header must be a loopback name (DNS rebinding).
import { RANGES } from "./metrics.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { KeyStore, writeSecretFile } from "./keys.mjs";

const COOKIE = "agy_admin";
const SESSION_MS = 12 * 3600_000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { salt: salt.toString("hex"), hash: hash.toString("hex"), params: SCRYPT };
}
function checkPassword(password, rec) {
  const p = rec.params || SCRYPT;
  const got = crypto.scryptSync(password, Buffer.from(rec.salt, "hex"), Buffer.from(rec.hash, "hex").length, { N: p.N, r: p.r, p: p.p });
  return crypto.timingSafeEqual(got, Buffer.from(rec.hash, "hex"));
}

export function createAdmin({ dataDir, keyStore, port, host, extraHosts = [], getStatus, getModels, readBody, handleChat, metrics, quota, budget, getLive }) {
  const adminFile = path.join(dataDir, "admin.json");
  const sessions = new Map(); // id -> {csrf, expires}
  const fails = []; // login failure timestamps
  const htmlTemplate = () => fs.readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");
  const allowedHosts = new Set(["127.0.0.1", "localhost", "[::1]", ...extraHosts.map(h => h.toLowerCase())]);

  const liveClients = new Set();
  const SPECIAL = { admin: "Dashboard playground", legacy: "Legacy AGY_API_KEY", open: "Open access (no key)" };
  const keyName = id => SPECIAL[id] || keyStore.find(id)?.name || `${id} (deleted)`;

  function openLive(req, res) {
    if (liveClients.size >= 8) return fail(res, 429, "Too many live connections");
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const push = () => {
      try { quota.maybeRefresh(); res.write(`event: snapshot\ndata: ${JSON.stringify(getLive())}\n\n`); }
      catch (e) { res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`); }
    };
    res.write("retry: 3000\n\n");
    push();
    const timer = setInterval(push, 2000);
    const client = { res, timer };
    liveClients.add(client);
    req.on("close", () => { clearInterval(timer); liveClients.delete(client); });
  }
  function closeLive() { for (const c of liveClients) { clearInterval(c.timer); try { c.res.end(); } catch { /* gone */ } } liveClients.clear(); }

  const loadAdmin = () => { try { return JSON.parse(fs.readFileSync(adminFile, "utf8")); } catch { return null; } };

  function hostOk(req) {
    const h = String(req.headers.host || "").toLowerCase();
    const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
    const p = h.startsWith("[") ? h.slice(h.indexOf("]") + 2) : h.split(":")[1];
    return allowedHosts.has(name) && (!p || Number(p) === port);
  }

  function send(res, status, data, headers = {}) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
    res.end(JSON.stringify(data));
  }
  const fail = (res, status, message, code = null) => send(res, status, { error: { message, type: status === 401 || status === 403 ? "authentication_error" : "invalid_request_error", code } });

  function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  function session(req) {
    const id = parseCookies(req)[COOKIE];
    if (!id) return null;
    const s = sessions.get(id);
    if (!s) return null;
    if (s.expires < Date.now()) { sessions.delete(id); return null; }
    return { id, ...s };
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return false;
    const site = req.headers["sec-fetch-site"];
    if (site && !["same-origin", "none"].includes(site)) return false;
    return true;
  }

  function startSession(res) {
    const id = crypto.randomBytes(32).toString("base64url");
    const csrf = crypto.randomBytes(24).toString("base64url");
    sessions.set(id, { csrf, expires: Date.now() + SESSION_MS });
    res.setHeader("set-cookie", `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
    return csrf;
  }

  function parseExpiry(body) {
    if (body.never === true || body.expires === "never" || (body.expires_in_days == null && body.expires_at == null)) return null;
    if (body.expires_in_days != null) {
      const d = Number(body.expires_in_days);
      if (!Number.isFinite(d) || d <= 0 || d > 3650) throw Object.assign(new Error("expires_in_days must be between 0 and 3650"), { status: 400 });
      return new Date(Date.now() + d * 86400_000).toISOString();
    }
    const t = Date.parse(body.expires_at);
    if (!Number.isFinite(t)) throw Object.assign(new Error("expires_at is not a valid date/time"), { status: 400 });
    if (t <= Date.now()) throw Object.assign(new Error("expires_at must be in the future"), { status: 400 });
    return new Date(t).toISOString();
  }

  function servePage(req, res) {
    const nonce = crypto.randomBytes(16).toString("base64");
    const html = htmlTemplate().replaceAll("__NONCE__", nonce);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    });
    res.end(html);
  }

  const ICONS = { "/favicon.svg": ["image/svg+xml", "favicon.svg"], "/favicon.png": ["image/png", "favicon.png"], "/favicon.ico": ["image/png", "favicon.png"], "/apple-touch-icon.png": ["image/png", "favicon.png"] };
  const recentIds = new Map(), recentNames = new Map();

  /** Returns true if the request was handled. */
  async function handle(req, res, url) {
    if (req.method === "GET" && ICONS[url.pathname]) {
      if (!hostOk(req)) { send(res, 403, { error: { message: "Forbidden host", type: "authentication_error", code: "bad_host" } }); return true; }
      try { const [type, file] = ICONS[url.pathname]; const buf = fs.readFileSync(new URL("./assets/" + file, import.meta.url)); res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" }); res.end(buf); } catch { res.writeHead(404); res.end(); }
      return true;
    }
    const isPage = req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/dashboard/");
    const isAdminApi = url.pathname.startsWith("/admin/api/");
    if (!isPage && !isAdminApi) return false;
    if (!hostOk(req)) { send(res, 403, { error: { message: "Forbidden host. The dashboard is only reachable via 127.0.0.1 or localhost.", type: "authentication_error", code: "bad_host" } }); return true; }
    if (isPage) { servePage(req, res); return true; }

    const route = url.pathname.slice("/admin/api/".length);
    const method = req.method;
    const admin = loadAdmin();

    // --- public (no session) endpoints: state, setup, login
    if (method === "GET" && route === "state") {
      const s = session(req);
      return send(res, 200, { setup_required: !admin, authenticated: Boolean(s && admin), csrf: s && admin ? s.csrf : null }), true;
    }
    const stateChanging = method !== "GET" && method !== "HEAD";
    if (stateChanging) {
      if (!sameOrigin(req)) { fail(res, 403, "Cross-origin request blocked", "bad_origin"); return true; }
      if (req.headers["x-requested-with"] !== "agy-dashboard") { fail(res, 403, "Missing X-Requested-With header", "csrf_header_missing"); return true; }
    }
    if (method === "POST" && (route === "setup" || route === "login")) {
      let body; try { body = await readBody(req); } catch (e) { fail(res, e.status || 400, e.message); return true; }
      const password = String(body.password || "");
      if (route === "setup") {
        if (loadAdmin()) { fail(res, 409, "Admin password is already set", "already_setup"); return true; }
        if (password.length < 8) { fail(res, 400, "Password must be at least 8 characters"); return true; }
        writeSecretFile(adminFile, JSON.stringify({ version: 1, created_at: new Date().toISOString(), ...hashPassword(password) }, null, 2));
        const csrf = startSession(res);
        return send(res, 200, { ok: true, csrf }), true;
      }
      if (!admin) { fail(res, 409, "Setup required", "setup_required"); return true; }
      const now = Date.now();
      while (fails.length && now - fails[0] > 60_000) fails.shift();
      if (fails.length >= 5) { send(res, 429, { error: { message: "Too many failed logins. Wait a minute.", type: "rate_limit_error", code: "login_throttled" } }, { "retry-after": "60" }); return true; }
      if (!checkPassword(password, admin)) { fails.push(now); fail(res, 401, "Wrong password", "bad_password"); return true; }
      const csrf = startSession(res);
      return send(res, 200, { ok: true, csrf }), true;
    }

    // --- everything below needs a session (+ CSRF token for state changes)
    const s = admin ? session(req) : null;
    if (!s) { fail(res, 401, admin ? "Admin login required" : "Setup required", admin ? "login_required" : "setup_required"); return true; }
    if (stateChanging && req.headers["x-csrf-token"] !== s.csrf) { fail(res, 403, "Missing or invalid CSRF token", "csrf_invalid"); return true; }

    try {
      if (method === "POST" && route === "logout") {
        sessions.delete(s.id);
        res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
        return send(res, 200, { ok: true }), true;
      }
      if (method === "POST" && route === "password") {
        const body = await readBody(req);
        if (!checkPassword(String(body.current || ""), admin)) return fail(res, 401, "Current password is wrong", "bad_password"), true;
        if (String(body.password || "").length < 8) return fail(res, 400, "Password must be at least 8 characters"), true;
        writeSecretFile(adminFile, JSON.stringify({ version: 1, created_at: admin.created_at, updated_at: new Date().toISOString(), ...hashPassword(String(body.password)) }, null, 2));
        sessions.clear();
        res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
        return send(res, 200, { ok: true }), true;
      }
      if (method === "GET" && route === "keys") return send(res, 200, { keys: keyStore.list() }), true;
      if (method === "POST" && route === "keys") {
        const body = await readBody(req);
        // Idempotency: a repeated request id replays the first answer; the same name within 5 s is rejected.
        const now = Date.now(), rid = String(body.request_id || "").slice(0, 64), nameKey = String(body.name || "").trim().toLowerCase();
        for (const [k, v] of recentIds) if (now - v.at > 30_000) recentIds.delete(k);
        for (const [k, t] of recentNames) if (now - t > 5_000) recentNames.delete(k);
        if (rid && recentIds.has(rid)) return send(res, 201, recentIds.get(rid).payload), true;
        if (nameKey && recentNames.has(nameKey)) { fail(res, 409, "A key with this name was just created", "duplicate_key"); return true; }
        const { key, record } = keyStore.create({ name: body.name, expiresAt: parseExpiry(body) });
        const payload = { key, record, notice: "Copy this key now. It cannot be shown again." };
        if (rid) recentIds.set(rid, { at: now, payload });
        if (nameKey) recentNames.set(nameKey, now);
        return send(res, 201, payload), true;
      }
      let m = route.match(/^keys\/([\w-]+)\/revoke$/);
      if (method === "POST" && m) return send(res, 200, { record: keyStore.revoke(m[1]) }), true;
      m = route.match(/^keys\/([\w-]+)$/);
      if (method === "DELETE" && m) { keyStore.delete(m[1]); return send(res, 200, { ok: true }), true; }
      if (method === "GET" && route === "status") return send(res, 200, getStatus()), true;
      if (method === "GET" && route === "models") return send(res, 200, getModels()), true;
      if (method === "GET" && route === "metrics") {
        const range = url.searchParams.get("range") || "24h";
        // prev=1: the equally long period just before this one (used for the dashboard's trend arrows)
        const now = url.searchParams.get("prev") === "1" && RANGES[range] ? Math.floor(Date.now() / 1000) - RANGES[range].seconds : undefined;
        return send(res, 200, metrics.query(range, now ? { keyName, now } : { keyName })), true;
      }
      if (method === "GET" && route === "live") { openLive(req, res); return true; }
      if (method === "GET" && route === "quota") { quota.maybeRefresh(); return send(res, 200, quota.status()), true; }
      if (method === "POST" && route === "quota/refresh") {
        if (Date.now() - quota.lastAttempt > 10_000) await quota.refresh(); else if (quota.inflight) await quota.inflight;
        return send(res, 200, quota.status()), true;
      }
      if (method === "GET" && route === "budget") return send(res, 200, { ...budget.status(), config: budget.cfg }), true;
      if (method === "POST" && route === "budget") { budget.set(await readBody(req)); return send(res, 200, { ...budget.status(), config: budget.cfg }), true; }
      if (method === "DELETE" && route === "budget") { budget.disable(); return send(res, 200, { ...budget.status(), config: budget.cfg }), true; }
      if (method === "POST" && route === "chat") {
        const body = await readBody(req);
        await handleChat(req, res, body, null);
        return true;
      }
    } catch (e) {
      if (!res.headersSent) fail(res, e.status || 500, e.message || "Error");
      return true;
    }
    fail(res, 404, "Unknown admin endpoint", "not_found");
    return true;
  }

  return { handle, hostOk, closeLive, hasAdmin: () => Boolean(loadAdmin()) };
}
