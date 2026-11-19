import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Metrics } from "./metrics.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agymetrics-"));
const now = Math.floor(Date.now() / 1000);

test("records requests and returns a zero-filled series with breakdowns", () => {
  const m = new Metrics(tmp());
  m.recordRequest({ model: "a", keyId: "k1", promptTokens: 100, completionTokens: 10, latencyMs: 200, at: now });
  m.recordRequest({ model: "a", keyId: "k2", promptTokens: 50, completionTokens: 5, latencyMs: 400, at: now - 120 });
  m.recordRequest({ model: "b", keyId: "k1", outcome: "error", latencyMs: 50, at: now - 30 });
  m.recordRejected(now);
  m.sampleGauge(3, 2, now);
  const q = m.query("1h", { keyName: id => "name-" + id });
  assert.equal(q.series.length, 60);
  assert.equal(q.totals.requests, 3);
  assert.equal(q.totals.errors, 1);
  assert.equal(q.totals.rejected, 1);
  assert.equal(q.totals.prompt_tokens, 150);
  assert.equal(q.latency_avg_ms, 217);
  assert.equal(q.peak_active, 3);
  assert.deepEqual(q.by_model.map(x => [x.id, x.requests]).sort(), [["a", 2], ["b", 1]]);
  assert.equal(q.by_key.find(x => x.id === "k1").name, "name-k1");
  assert.equal(m.tokensBetween(now - 3600, now + 60).tokens, 165);
  assert.equal(m.tokensBetween(now - 3600, now + 60, ["b"]).tokens, 0);
  m.close();
});

test("minute rows older than 48h roll up into hourly rows without changing totals", () => {
  const m = new Metrics(tmp());
  const old = now - 3 * 86400;
  for (let i = 0; i < 5; i++) m.recordRequest({ model: "a", keyId: "k", promptTokens: 10, completionTokens: 1, latencyMs: 100, at: old + i * 60 });
  m.recordRequest({ model: "a", keyId: "k", promptTokens: 7, completionTokens: 1, at: now });
  m.sampleGauge(4, 1, old);
  const before = m.query("7d").totals;
  m.rollup();
  const counts = t => m.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  assert.ok(counts("hour_stats") >= 1);
  assert.equal(m.db.prepare("SELECT COUNT(*) n FROM minute_stats WHERE ts < ?").get(now - 49 * 3600).n, 0);
  assert.deepEqual(m.query("7d").totals, before);
  assert.equal(m.query("7d").peak_active, 4);
  m.rollup(); // idempotent
  assert.deepEqual(m.query("7d").totals, before);
  m.close();
});

test("last quota error is persisted", () => {
  const dir = tmp(); const m = new Metrics(dir);
  m.recordQuotaError({ model: "x", message: "RESOURCE_EXHAUSTED", resetAt: now + 3600 });
  m.close();
  const e = new Metrics(dir).lastQuotaError();
  assert.equal(e.model, "x");
  assert.ok(e.reset_at);
});
