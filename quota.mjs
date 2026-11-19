// Plan quota (read from the CLI's own `agy -p "/usage"` command) and an optional self-set token budget.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { trackChild } from "./agy-pool.mjs";
import { writeSecretFile } from "./keys.mjs";

const WINDOW_S = { "5h": 5 * 3600, weekly: 7 * 86400 };

export function groupModels(groupName, allModels) {
  const gem = /gemini/i.test(groupName);
  return allModels.filter(id => (gem ? /^gemini/i.test(id) : !/^gemini/i.test(id)));
}

/** Best-effort: find a reset time (epoch seconds) inside a provider quota error message. */
export function parseResetFromMessage(message, nowMs = Date.now()) {
  const m = String(message || "");
  const iso = m.match(/\b(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d))\b/);
  if (iso) { const t = Date.parse(iso[1]); if (Number.isFinite(t) && t > nowMs) return Math.floor(t / 1000); }
  const dur = m.match(/(?:reset|retry|try again|refresh)[^.\n]{0,40}?\b(?:in|after)\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b\s*(?:and\s*)?,?\s*)+)/i);
  if (dur) {
    let sec = 0;
    for (const x of dur[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
      const n = Number(x[1]), u = x[2].toLowerCase();
      sec += u.startsWith("d") ? n * 86400 : u.startsWith("h") ? n * 3600 : u.startsWith("m") ? n * 60 : n;
    }
    if (sec > 0) return Math.floor(nowMs / 1000) + sec;
  }
  const compact = m.match(/\b(?:reset|retry)[^.\n]{0,30}?(\d+)h(\d+)m(\d+)?s?/i);
  if (compact) return Math.floor(nowMs / 1000) + Number(compact[1]) * 3600 + Number(compact[2]) * 60 + Number(compact[3] || 0);
  return null;
}

export class QuotaMonitor {
  constructor({ cfg, metrics, models, pollMs, timeoutMs = 45000 }) {
    this.cfg = cfg; this.metrics = metrics; this.models = models; this.pollMs = pollMs; this.timeoutMs = timeoutMs;
    this.state = { fetched_at: null, ok: false, error: pollMs === 0 ? "Quota polling is disabled (AGY_QUOTA_POLL_MS=0)." : "Not fetched yet.", description: null, groups: [] };
    this.inflight = null;
    this.lastAttempt = 0;
  }

  /** Run `agy -p "/usage" --output-format json` (the CLI's own quota command; costs no tokens). */
  refresh() {
    if (this.inflight) return this.inflight;
    this.lastAttempt = Date.now();
    this.inflight = new Promise(resolve => {
      const env = { ...process.env };
      if (this.cfg.isolate) env.HOME = this.cfg.agyHome;
      let out = "", err = "", done = false;
      const child = spawn(this.cfg.agyBin, ["-p", "/usage", "--output-format", "json"], { env, cwd: this.cfg.isolate ? this.cfg.agyWork : process.cwd(), stdio: ["ignore", "pipe", "pipe"], detached: true });
      trackChild(child);
      const finish = (ok, payload) => {
        if (done) return; done = true; clearTimeout(timer);
        if (ok) this.state = { fetched_at: new Date().toISOString(), ok: true, error: null, ...payload };
        else this.state = { ...this.state, ok: false, error: payload, error_at: new Date().toISOString() };
        this.inflight = null; resolve(this.state);
      };
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } finish(false, "agy /usage timed out"); }, this.timeoutMs);
      child.stdout.on("data", d => { out += d; });
      child.stderr.on("data", d => { err = (err + d).slice(-800); });
      child.on("error", e => finish(false, `Could not run agy: ${e.message}`));
      child.on("close", code => {
        try {
          const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || "";
          const j = JSON.parse(line);
          const data = j.command?.data;
          if (!data || !Array.isArray(data.groups)) throw new Error("no quota data in /usage output");
          finish(true, { description: data.description || null, groups: data.groups });
        } catch (e) {
          finish(false, `agy /usage gave no quota data (exit ${code}): ${(err.trim() || e.message).slice(0, 300)}`);
        }
      });
    });
    return this.inflight;
  }

  maybeRefresh() {
    if (this.pollMs === 0) return null;
    if (this.inflight) return this.inflight;
    const age = Date.now() - (this.lastAttempt || 0);
    if (age >= (this.state.ok ? this.pollMs : Math.max(this.pollMs, 120000))) return this.refresh();
    return null;
  }

  /** Quota buckets plus the tokens this bridge has used inside each window. */
  status(now = Date.now()) {
    const s = this.state;
    const groups = (s.groups || []).map(g => {
      const models = groupModels(g.name, this.models);
      return {
        name: g.name, description: g.description, models,
        buckets: (g.buckets || []).map(b => {
          const len = WINDOW_S[b.window] || null;
          const resetMs = b.reset_time ? Date.parse(b.reset_time) : NaN;
          const hasReset = Number.isFinite(resetMs) && resetMs > now;
          const fromS = len ? (hasReset ? resetMs / 1000 - len : now / 1000 - len) : null;
          const used = fromS != null ? this.metrics.tokensBetween(fromS, now / 1000 + 60, models) : null;
          return {
            id: b.id, name: b.name, window: b.window, description: b.description,
            remaining_fraction: typeof b.remaining_fraction === "number" ? b.remaining_fraction : null,
            reset_time: hasReset ? new Date(resetMs).toISOString() : null,
            reset_in_seconds: hasReset ? Math.round((resetMs - now) / 1000) : null,
            bridge_tokens_in_window: used ? used.tokens : null, bridge_requests_in_window: used ? used.requests : null,
            window_start: fromS != null ? new Date(fromS * 1000).toISOString() : null,
            window_is_approximate: fromS != null && !hasReset
          };
        })
      };
    });
    return {
      source: "agy /usage (the Antigravity CLI's own quota command)", fetched_at: s.fetched_at, ok: s.ok, error: s.error, error_at: s.error_at || null,
      poll_seconds: this.pollMs / 1000, description: s.description, groups,
      last_quota_error: this.metrics.lastQuotaError()
    };
  }
}

/** Optional self-set token budget (clearly separate from the plan quota). */
export class Budget {
  constructor(dataDir, metrics) {
    this.file = path.join(dataDir, "settings.json");
    this.metrics = metrics;
    this.cfg = { enabled: false, tokens: 1_000_000, period: "day", reset_time: "00:00", reset_weekday: 1 };
    try { this.cfg = { ...this.cfg, ...JSON.parse(fs.readFileSync(this.file, "utf8")).budget }; } catch { /* defaults */ }
  }

  set(input) {
    const tokens = Number(input.tokens);
    if (!Number.isFinite(tokens) || tokens <= 0 || tokens > 1e12) throw Object.assign(new Error("tokens must be a positive number"), { status: 400 });
    if (!["day", "5h", "week"].includes(input.period)) throw Object.assign(new Error("period must be day, 5h or week"), { status: 400 });
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.reset_time))) throw Object.assign(new Error("reset_time must be HH:MM (24h, server local time)"), { status: 400 });
    const wd = Number(input.reset_weekday ?? 1);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw Object.assign(new Error("reset_weekday must be 0 (Sunday) to 6"), { status: 400 });
    this.cfg = { enabled: input.enabled !== false, tokens: Math.round(tokens), period: input.period, reset_time: input.reset_time, reset_weekday: wd };
    writeSecretFile(this.file, JSON.stringify({ version: 1, budget: this.cfg }, null, 2));
    return this.cfg;
  }

  disable() { this.cfg.enabled = false; writeSecretFile(this.file, JSON.stringify({ version: 1, budget: this.cfg }, null, 2)); }

  /** [startMs, endMs) of the window containing `now`, with the reset time of day in server local time. */
  window(now = Date.now()) {
    const [hh, mm] = this.cfg.reset_time.split(":").map(Number);
    const d = new Date(now);
    const anchorToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
    if (this.cfg.period === "day") {
      const start = anchorToday.getTime() <= now ? anchorToday : new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, hh, mm);
      return [start.getTime(), new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, hh, mm).getTime()];
    }
    if (this.cfg.period === "5h") {
      const len = 5 * 3600_000;
      const k = Math.floor((now - anchorToday.getTime()) / len);
      const start = anchorToday.getTime() + k * len;
      return [start, start + len];
    }
    let back = (d.getDay() - this.cfg.reset_weekday + 7) % 7;
    let start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, hh, mm);
    if (start.getTime() > now) start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back - 7, hh, mm);
    return [start.getTime(), new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7, hh, mm).getTime()];
  }

  status(now = Date.now()) {
    const c = this.cfg;
    if (!c.enabled) return { enabled: false, config: c };
    const [from, to] = this.window(now);
    const used = this.metrics.tokensBetween(from / 1000, to / 1000);
    return {
      enabled: true, label: "Self-set budget (not your plan quota)", config: c,
      window_start: new Date(from).toISOString(), reset_time: new Date(to).toISOString(), reset_in_seconds: Math.round((to - now) / 1000),
      used_tokens: used.tokens, requests: used.requests, remaining_tokens: Math.max(0, c.tokens - used.tokens),
      remaining_fraction: Math.max(0, 1 - used.tokens / c.tokens), over_budget: used.tokens > c.tokens
    };
  }
}
