import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyStore } from "./keys.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agykeys-"));

test("key format, hashed storage, file mode 600", () => {
  const dir = tmp(); const ks = new KeyStore(dir);
  const { key, record } = ks.create({ name: "t" });
  assert.match(key, /^agy-[A-Za-z0-9_-]{43}$/);
  assert.equal(record.prefix, key.slice(0, 8) + "…");
  const raw = fs.readFileSync(path.join(dir, "keys.json"), "utf8");
  assert.ok(!raw.includes(key));
  assert.equal(fs.statSync(path.join(dir, "keys.json")).mode & 0o777, 0o600);
  assert.equal(new KeyStore(dir).verify(key).record.name, "t"); // survives reload
});

test("expiry, revoke and delete take effect immediately", () => {
  const ks = new KeyStore(tmp());
  assert.equal(ks.verify("agy-nope").error, "invalid");
  const a = ks.create({ name: "a", expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(ks.verify(a.key).error, "expired");
  const b = ks.create({ name: "b" });
  assert.ok(ks.verify(b.key).record);
  ks.revoke(b.record.id);
  assert.equal(ks.verify(b.key).error, "revoked");
  ks.delete(b.record.id);
  assert.equal(ks.verify(b.key).error, "invalid");
});

test("usage counters", () => {
  const ks = new KeyStore(tmp());
  const { key } = ks.create({ name: "u" });
  const rec = ks.verify(key).record;
  ks.touch(rec); ks.addTokens(rec, 10, 5); ks.flush();
  assert.deepEqual([rec.requests, rec.prompt_tokens, rec.completion_tokens], [1, 10, 5]);
});
