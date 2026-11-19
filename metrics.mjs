// Persistent time-series metrics in SQLite (node:sqlite): per-minute buckets per model and per key,
// rolled up to hourly buckets once older than 48 h, kept for ~400 days.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { ensureDir } from "./keys.mjs";

const MINUTE_KEEP_S = 48 * 3600;
const HOUR_KEEP_S = 400 * 86400;
export const RANGES = {
  "1h": { seconds: 3600, bucket: 60 },
  "24h": { seconds: 86400, bucket: 300 },
  "7d": { seconds: 7 * 86400, bucket: 3600 },
  "30d": { seconds: 30 * 86400, bucket: 6 * 3600 }
};

const STATS_COLS = `ts INTEGER NOT NULL, model TEXT NOT NULL, key_id TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_sum_ms INTEGER NOT NULL DEFAULT 0, latency_count INTEGER NOT NULL DEFAULT 0, latency_max_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ts, model, key_id)`;
const GAUGE_COLS = `ts INTEGER PRIMARY KEY, active_max INTEGER NOT NULL DEFAULT 0, queued_max INTEGER NOT NULL DEFAULT 0,
  active_sum INTEGER NOT NULL DEFAULT 0, samples INTEGER NOT NULL DEFAULT 0`;

const nowS = () => Math.floor(Date.now() / 1000);

export class Metrics {
  constructor(dataDir, { file = "metrics.sqlite" } = {}) {
    ensureDir(dataDir);
    this.file = path.join(dataDir, file);
    this.db = new DatabaseSync(this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* ignore */ }
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS minute_stats (${STATS_COLS}) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS hour_stats (${STATS_COLS}) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS gauge_minute (${GAUGE_COLS});
      CREATE TABLE IF NOT EXISTS gauge_hour (${GAUGE_COLS});
      CREATE TABLE IF NOT EXISTS quota_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, model TEXT, message TEXT, reset_at INTEGER);`);
    this.upsert = this.db.prepare(`INSERT INTO minute_stats (ts, model, key_id, requests, errors, rejected, prompt_tokens, completion_tokens, latency_sum_ms, latency_count, latency_max_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ts, model, key_id) DO UPDATE SET requests=requests+excluded.requests, errors=errors+excluded.errors, rejected=rejected+excluded.rejected,
        prompt_tokens=prompt_tokens+excluded.prompt_tokens, completion_tokens=completion_tokens+excluded.completion_tokens,
        latency_sum_ms=latency_sum_ms+excluded.latency_sum_ms, latency_count=latency_count+excluded.latency_count,
        latency_max_ms=MAX(latency_max_ms, excluded.latency_max_ms)`);
    this.gaugeUpsert = this.db.prepare(`INSERT INTO gauge_minute (ts, active_max, queued_max, active_sum, samples) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(ts) DO UPDATE SET active_max=MAX(active_max, excluded.active_max), queued_max=MAX(queued_max, excluded.queued_max),
        active_sum=active_sum+excluded.active_sum, samples=samples+1`);
    this.rollup();
  }

  /** Record one finished chat request. outcome: 'ok' | 'error' | 'abort' */
  recordRequest({ model = "-", keyId = "-", outcome = "ok", promptTokens = 0, completionTokens = 0, latencyMs = 0, at = nowS() }) {
    const ts = at - (at % 60);
    const counted = outcome !== "abort";
    this.upsert.run(ts, model, keyId, counted ? 1 : 0, outcome === "error" ? 1 : 0, 0, promptTokens | 0, completionTokens | 0,
      counted ? Math.round(latencyMs) : 0, counted ? 1 : 0, counted ? Math.round(latencyMs) : 0);
  }

  recordRejected(at = nowS()) {
    this.upsert.run(at - (at % 60), "-", "-", 0, 0, 1, 0, 0, 0, 0, 0);
  }

  sampleGauge(active, queued, at = nowS()) {
    this.gaugeUpsert.run(at - (at % 60), active | 0, queued | 0, active | 0);
  }

  recordQuotaError({ model, message, resetAt = null, at = nowS() }) {
    this.db.prepare("INSERT INTO quota_errors (ts, model, message, reset_at) VALUES (?, ?, ?, ?)").run(at, model || null, String(message || "").slice(0, 600), resetAt);
    this.db.exec("DELETE FROM quota_errors WHERE id NOT IN (SELECT id FROM quota_errors ORDER BY id DESC LIMIT 50)");
  }

  lastQuotaError() {
    const r = this.db.prepare("SELECT ts, model, message, reset_at FROM quota_errors ORDER BY id DESC LIMIT 1").get();
    return r ? { at: new Date(r.ts * 1000).toISOString(), model: r.model, message: r.message, reset_at: r.reset_at ? new Date(r.reset_at * 1000).toISOString() : null } : null;
  }

  /** Move minute rows older than 48h into hourly rows; drop hourly rows older than ~400 days. */
  rollup(now = nowS()) {
    const cutoff = Math.floor((now - MINUTE_KEEP_S) / 3600) * 3600;
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`INSERT INTO hour_stats (ts, model, key_id, requests, errors, rejected, prompt_tokens, completion_tokens, latency_sum_ms, latency_count, latency_max_ms)
        SELECT (ts/3600)*3600, model, key_id, SUM(requests), SUM(errors), SUM(rejected), SUM(prompt_tokens), SUM(completion_tokens), SUM(latency_sum_ms), SUM(latency_count), MAX(latency_max_ms)
        FROM minute_stats WHERE ts < ? GROUP BY (ts/3600)*3600, model, key_id
        ON CONFLICT(ts, model, key_id) DO UPDATE SET requests=requests+excluded.requests, errors=errors+excluded.errors, rejected=rejected+excluded.rejected,
          prompt_tokens=prompt_tokens+excluded.prompt_tokens, completion_tokens=completion_tokens+excluded.completion_tokens,
          latency_sum_ms=latency_sum_ms+excluded.latency_sum_ms, latency_count=latency_count+excluded.latency_count, latency_max_ms=MAX(latency_max_ms, excluded.latency_max_ms)`).run(cutoff);
      this.db.prepare("DELETE FROM minute_stats WHERE ts < ?").run(cutoff);
      this.db.prepare(`INSERT INTO gauge_hour (ts, active_max, queued_max, active_sum, samples)
        SELECT (ts/3600)*3600, MAX(active_max), MAX(queued_max), SUM(active_sum), SUM(samples) FROM gauge_minute WHERE ts < ? GROUP BY (ts/3600)*3600
        ON CONFLICT(ts) DO UPDATE SET active_max=MAX(active_max, excluded.active_max), queued_max=MAX(queued_max, excluded.queued_max),
          active_sum=active_sum+excluded.active_sum, samples=samples+excluded.samples`).run(cutoff);
      this.db.prepare("DELETE FROM gauge_minute WHERE ts < ?").run(cutoff);
      this.db.prepare("DELETE FROM hour_stats WHERE ts < ?").run(now - HOUR_KEEP_S);
      this.db.prepare("DELETE FROM gauge_hour WHERE ts < ?").run(now - HOUR_KEEP_S);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  /** Time series for one of the RANGES, gaps filled with zeros, plus breakdowns. */
  query(range = "24h", { keyName = id => id, now = nowS() } = {}) {
    const r = RANGES[range];
    if (!r) throw Object.assign(new Error("range must be one of 1h, 24h, 7d, 30d"), { status: 400 });
    const b = r.bucket;
    const end = Math.floor(now / b) * b + b;
    const since = end - Math.ceil(r.seconds / b) * b;
    const union = `(SELECT * FROM minute_stats WHERE ts >= @since UNION ALL SELECT * FROM hour_stats WHERE ts >= @since)`;
    const rows = this.db.prepare(`SELECT (ts/${b})*${b} AS t, SUM(requests) requests, SUM(errors) errors, SUM(rejected) rejected, SUM(prompt_tokens) prompt_tokens,
      SUM(completion_tokens) completion_tokens, SUM(latency_sum_ms) ls, SUM(latency_count) lc, MAX(latency_max_ms) lmax FROM ${union} GROUP BY t`).all({ since });
    const gunion = `(SELECT * FROM gauge_minute WHERE ts >= @since UNION ALL SELECT * FROM gauge_hour WHERE ts >= @since)`;
    const grows = this.db.prepare(`SELECT (ts/${b})*${b} AS t, MAX(active_max) active_max, MAX(queued_max) queued_max, SUM(active_sum) asum, SUM(samples) samples FROM ${gunion} GROUP BY t`).all({ since });
    const byT = new Map(rows.map(x => [x.t, x]));
    const gT = new Map(grows.map(x => [x.t, x]));
    const series = [];
    for (let t = since; t < end; t += b) {
      const x = byT.get(t), g = gT.get(t);
      series.push({
        t, requests: x?.requests || 0, errors: x?.errors || 0, rejected: x?.rejected || 0,
        prompt_tokens: x?.prompt_tokens || 0, completion_tokens: x?.completion_tokens || 0,
        latency_avg_ms: x?.lc ? Math.round(x.ls / x.lc) : null, latency_max_ms: x?.lc ? x.lmax : null,
        active_max: g?.active_max || 0, queued_max: g?.queued_max || 0, active_avg: g?.samples ? +(g.asum / g.samples).toFixed(2) : 0
      });
    }
    const groupBy = col => this.db.prepare(`SELECT ${col} AS id, SUM(requests) requests, SUM(errors) errors, SUM(prompt_tokens) prompt_tokens, SUM(completion_tokens) completion_tokens,
      SUM(latency_sum_ms) ls, SUM(latency_count) lc FROM ${union} WHERE (requests > 0 OR prompt_tokens > 0) GROUP BY ${col} ORDER BY SUM(prompt_tokens)+SUM(completion_tokens) DESC`).all({ since });
    const fmt = x => ({ id: x.id, requests: x.requests, errors: x.errors, prompt_tokens: x.prompt_tokens, completion_tokens: x.completion_tokens, latency_avg_ms: x.lc ? Math.round(x.ls / x.lc) : null });
    const tot = series.reduce((a, s) => ({ requests: a.requests + s.requests, errors: a.errors + s.errors, rejected: a.rejected + s.rejected, prompt_tokens: a.prompt_tokens + s.prompt_tokens, completion_tokens: a.completion_tokens + s.completion_tokens }), { requests: 0, errors: 0, rejected: 0, prompt_tokens: 0, completion_tokens: 0 });
    const withLat = series.filter(s => s.latency_avg_ms != null);
    return {
      range, bucket_seconds: b, from: since, to: end, series, totals: tot,
      peak_active: Math.max(0, ...series.map(s => s.active_max)), peak_queued: Math.max(0, ...series.map(s => s.queued_max)),
      latency_avg_ms: withLat.length ? Math.round(this.db.prepare(`SELECT SUM(latency_sum_ms)*1.0/NULLIF(SUM(latency_count),0) v FROM ${union}`).get({ since }).v || 0) : null,
      by_model: groupBy("model").filter(x => x.id !== "-").map(fmt),
      by_key: groupBy("key_id").filter(x => x.id !== "-").map(x => ({ ...fmt(x), name: keyName(x.id) }))
    };
  }

  /** Tokens (prompt+completion) recorded in [fromS, toS) for the given models (null = all). Minute resolution (hour for older data). */
  tokensBetween(fromS, toS, models = null) {
    const ph = models ? ` AND model IN (${models.map(() => "?").join(",")})` : "";
    const args = [Math.floor(fromS), Math.floor(toS), ...(models || [])];
    const q = t => this.db.prepare(`SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c, COALESCE(SUM(requests),0) r FROM ${t} WHERE ts >= ? AND ts < ?${ph}`).get(...args);
    const a = q("minute_stats"), h = q("hour_stats");
    return { prompt_tokens: a.p + h.p, completion_tokens: a.c + h.c, requests: a.r + h.r, tokens: a.p + h.p + a.c + h.c };
  }

  lastMinutes(minutes = 5, now = nowS()) {
    const since = now - minutes * 60;
    const r = this.db.prepare("SELECT COALESCE(SUM(requests),0) requests, COALESCE(SUM(errors),0) errors, COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c FROM minute_stats WHERE ts >= ?").get(since - (since % 60));
    return { minutes, requests: r.requests, errors: r.errors, prompt_tokens: r.p, completion_tokens: r.c };
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}
