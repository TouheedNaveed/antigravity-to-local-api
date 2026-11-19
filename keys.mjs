// API key store: only SHA-256 hashes are kept on disk (data/keys.json, mode 600).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
}

export function writeSecretFile(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export class KeyStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "keys.json");
    this.byHash = new Map();
    this.keys = [];
    this.dirty = false;
    this.timer = null;
    ensureDir(dataDir);
    this._load();
    if (!fs.existsSync(this.file)) this._saveNow();
    else { try { fs.chmodSync(this.file, 0o600); } catch { /* ignore */ } }
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.keys = Array.isArray(data.keys) ? data.keys : [];
    } catch (e) {
      if (e.code !== "ENOENT") throw new Error(`Cannot read ${this.file}: ${e.message}. Fix or remove the file.`);
      this.keys = [];
    }
    this.byHash = new Map(this.keys.map(k => [k.hash, k]));
  }

  _saveNow() {
    clearTimeout(this.timer); this.timer = null; this.dirty = false;
    writeSecretFile(this.file, JSON.stringify({ version: 1, keys: this.keys }, null, 2));
  }

  _saveSoon() {
    this.dirty = true;
    if (!this.timer) { this.timer = setTimeout(() => { try { this._saveNow(); } catch (e) { console.error("keys.json save failed:", e.message); } }, 2000); this.timer.unref(); }
  }

  flush() { if (this.dirty) this._saveNow(); }

  count() { return this.keys.length; }

  static status(k, now = Date.now()) {
    if (k.revoked_at) return "revoked";
    if (k.expires_at && Date.parse(k.expires_at) <= now) return "expired";
    return "active";
  }

  /** @returns {{key: string, record: object}} the full key is returned exactly once */
  create({ name, expiresAt = null }) {
    const cleanName = String(name || "").trim().slice(0, 80);
    if (!cleanName) throw Object.assign(new Error("A key name is required"), { status: 400 });
    const secret = crypto.randomBytes(32).toString("base64url");
    const key = `agy-${secret}`;
    const record = {
      id: "key_" + crypto.randomBytes(6).toString("hex"),
      name: cleanName,
      prefix: `agy-${secret.slice(0, 4)}…`,
      hash: sha256(key),
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      revoked_at: null,
      last_used_at: null,
      requests: 0, prompt_tokens: 0, completion_tokens: 0
    };
    this.keys.push(record);
    this.byHash.set(record.hash, record);
    this._saveNow();
    return { key, record: this.publicView(record) };
  }

  publicView(k) {
    const { hash, ...rest } = k;
    return { ...rest, status: KeyStore.status(k) };
  }

  list() { return this.keys.map(k => this.publicView(k)).reverse(); }

  find(id) { return this.keys.find(k => k.id === id); }

  revoke(id) {
    const k = this.find(id);
    if (!k) throw Object.assign(new Error("Key not found"), { status: 404 });
    if (!k.revoked_at) { k.revoked_at = new Date().toISOString(); this._saveNow(); }
    return this.publicView(k);
  }

  delete(id) {
    const i = this.keys.findIndex(k => k.id === id);
    if (i < 0) throw Object.assign(new Error("Key not found"), { status: 404 });
    const [k] = this.keys.splice(i, 1);
    this.byHash.delete(k.hash);
    this._saveNow();
  }

  /** Look a presented token up. Returns {record} or {error: 'invalid'|'expired'|'revoked'} */
  verify(token) {
    if (!token || !token.startsWith("agy-")) return { error: "invalid" };
    const k = this.byHash.get(sha256(token));
    if (!k) return { error: "invalid" };
    const st = KeyStore.status(k);
    if (st !== "active") return { error: st, record: k };
    return { record: k };
  }

  touch(k) { k.last_used_at = new Date().toISOString(); k.requests++; this._saveSoon(); }

  addTokens(k, prompt = 0, completion = 0) {
    k.prompt_tokens += Number(prompt) || 0;
    k.completion_tokens += Number(completion) || 0;
    this._saveSoon();
  }
}
