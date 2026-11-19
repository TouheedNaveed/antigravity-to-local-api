import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseResetFromMessage, Budget, groupModels } from "./quota.mjs";
import { Metrics } from "./metrics.mjs";

test("parses reset times out of quota error messages", () => {
  const now = Date.parse("2026-11-19T10:00:00Z");
  assert.equal(parseResetFromMessage("quota exhausted, resets at 2026-11-19T14:42:21Z", now), Date.parse("2026-11-19T14:42:21Z") / 1000);
  assert.equal(parseResetFromMessage("Rate limit. Your quota will reset after 3 hours and 12 minutes.", now), now / 1000 + 3 * 3600 + 12 * 60);
  assert.equal(parseResetFromMessage("please retry in 45s", now), now / 1000 + 45);
  assert.equal(parseResetFromMessage("429 RESOURCE_EXHAUSTED", now), null);
});

test("groups models like agy /usage does", () => {
  const all = ["gemini-3.8-flash-low", "claude-sonnet-4-6", "gpt-oss-120b-medium"];
  assert.deepEqual(groupModels("Gemini Models", all), ["gemini-3.8-flash-low"]);
  assert.deepEqual(groupModels("Claude and GPT models", all), ["claude-sonnet-4-6", "gpt-oss-120b-medium"]);
});

test("budget windows and remaining tokens", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agybudget-"));
  const m = new Metrics(dir);
  const b = new Budget(dir, m);
  const now = new Date(2026, 10, 19, 15, 0, 0).getTime(); // local 15:00
  b.set({ tokens: 1000, period: "day", reset_time: "09:30" });
  let [s, e] = b.window(now);
  assert.equal(new Date(s).getHours() * 60 + new Date(s).getMinutes(), 9 * 60 + 30);
  assert.equal(new Date(s).getDate(), 19); assert.equal(e - s, 86400_000);
  b.set({ tokens: 1000, period: "day", reset_time: "18:00" }); [s] = b.window(now); assert.equal(new Date(s).getDate(), 18);
  b.set({ tokens: 1000, period: "5h", reset_time: "00:00" }); [s, e] = b.window(now); assert.equal(e - s, 5 * 3600_000); assert.ok(s <= now && now < e);
  b.set({ tokens: 1000, period: "week", reset_time: "00:00", reset_weekday: 1 }); [s, e] = b.window(now);
  assert.equal(new Date(s).getDay(), 1); assert.ok(s <= now && now < e); assert.equal(Math.round((e - s) / 86400_000), 7);
  b.set({ tokens: 1000, period: "day", reset_time: "00:00" });
  m.recordRequest({ model: "a", keyId: "k", promptTokens: 300, completionTokens: 100, at: Math.floor(now / 1000) - 60 });
  const st = b.status(now);
  assert.equal(st.used_tokens, 400); assert.equal(st.remaining_tokens, 600);
  assert.equal(new Budget(dir, m).cfg.tokens, 1000); // persisted
  assert.throws(() => b.set({ tokens: -5, period: "day", reset_time: "00:00" }));
  assert.throws(() => b.set({ tokens: 5, period: "month", reset_time: "00:00" }));
  m.close();
});
