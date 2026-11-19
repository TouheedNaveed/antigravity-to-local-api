// AGY process management: isolated config home, minimal agent, single-use "standby" workers per model,
// bound session workers, concurrency limiter, and clean shutdown. No state is shared between requests:
// a stateless request gets its own fresh AGY conversation (a pre-started worker used exactly once).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const liveChildren = new Set();

function killTree(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

/** Register an extra child process (e.g. a quota probe) so shutdown kills it too. */
export function trackChild(child) {
  liveChildren.add(child);
  child.on("close", () => liveChildren.delete(child));
}

export function killAllChildren() {
  for (const c of liveChildren) killTree(c, "SIGKILL");
}
process.on("exit", killAllChildren);

export function classifyError(err) {
  if (err?.code === "timeout" || err?.code === "aborted" || err?.code === "rate_limit") return err.code;
  const msg = String(err?.message || err || "");
  if (/\b429\b|RESOURCE_EXHAUSTED|rate.?limit|quota exceeded|too many requests|exhausted your capacity/i.test(msg)) return "rate_limit";
  if (err?.transient || /\b(500|502|503|504)\b|unavailable|ECONNRESET|ETIMEDOUT|EPIPE|deadline exceeded|internal error|stream (closed|ended)|exited with code|empty response|overloaded|try again/i.test(msg)) return "transient";
  return "fatal";
}

function mkErr(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, transient: code === "transient", ...extra });
}

const AGENT_PROMPT = `---
name: bridge
description: Text-only assistant used by a local API bridge.
mainAgent: true
subagent: false
tools: []
__EXCL__---
You are a helpful general-purpose assistant answering through an API. You have no tools, no shell, no filesystem and no internet access, so never try to use any. Follow the instructions in each message exactly, including any required output format (for example a <tool_calls> block or a JSON-only reply).
`;

function writeIfChanged(file, content) {
  try { if (fs.readFileSync(file, "utf8") === content) return; } catch { /* missing */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Create the bridge-scoped HOME that hides the user's global skills/MCP servers from AGY. */
export function setupIsolatedHome(cfg) {
  const home = cfg.agyHome;
  const gem = path.join(home, ".gemini");
  fs.mkdirSync(cfg.agyWork, { recursive: true });
  // excludeDefaultComponents drops AGY's built-in system prompt sections and tools (about 1.7k tokens per request).
  // It is skipped when the memory MCP tools are on, because those need the default tool plumbing.
  const minimal = cfg.minimalAgent !== false && !cfg.memoryTools;
  writeIfChanged(path.join(gem, "config", "agents", "bridge", "agent.md"), AGENT_PROMPT.replace("__EXCL__", minimal ? "excludeDefaultComponents: true\n" : ""));
  const mcp = { mcpServers: {} };
  const settings = { permissions: { allow: [], deny: [] } };
  if (cfg.memoryTools) {
    mcp.mcpServers["agy-memory"] = { command: process.execPath, args: [cfg.memoryMcpPath], env: { AGY_MEMORY_DIR: cfg.memoryDir || "" } };
    for (const t of ["memory_search", "memory_grep", "memory_read", "memory_list_dates", "memory_stats"]) settings.permissions.allow.push(`mcp(agy-memory/${t})`);
  }
  writeIfChanged(path.join(gem, "config", "mcp_config.json"), JSON.stringify(mcp, null, 2));
  writeIfChanged(path.join(gem, "antigravity-cli", "settings.json"), JSON.stringify(settings, null, 2));
  return home;
}

/** Delete old per-conversation data AGY wrote inside the isolated home (keeps the disk tidy). */
export function pruneIsolatedHome(cfg) {
  const cutoff = Date.now() - cfg.retainHours * 3600_000;
  const base = path.join(cfg.agyHome, ".gemini", "antigravity-cli");
  let removed = 0;
  for (const sub of ["brain", "conversations", "implicit", "log"]) {
    const dir = path.join(base, sub);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { recursive: true, force: true }); removed++; }
      } catch { /* raced */ }
    }
  }
  return removed;
}

function usageDelta(current = {}, previous = {}) {
  const out = {};
  for (const k of ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"]) {
    out[k] = Math.max(0, Number(current[k] || 0) - Number(previous[k] || 0));
  }
  return out;
}

export class AgyWorker {
  constructor(cfg, model) {
    this.cfg = cfg;
    this.model = model;
    this.createdAt = Date.now();
    this.lastUsed = Date.now();
    this.busy = false;
    this.dead = false;
    this.buffer = "";
    this.stderr = "";
    this.lastUsage = {};
    this.lastDuration = 0;
    this.pending = null;
    this.turns = 0;
    this.lock = Promise.resolve(); // serialises turns on session workers
    const args = [];
    if (cfg.isolate) args.push("--agent", "bridge");
    args.push("--model", model, "--sandbox", "--disable-slash-commands", "--input-format", "stream-json", "--output-format", "stream-json");
    const env = { ...process.env };
    if (cfg.isolate) env.HOME = cfg.agyHome;
    this.child = spawn(cfg.agyBin, args, { env, cwd: cfg.isolate ? cfg.agyWork : process.cwd(), stdio: ["pipe", "pipe", "pipe"], detached: true });
    liveChildren.add(this.child);
    let readyResolve, readyReject;
    this.ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
    this.ready.catch(() => {}); // never an unhandled rejection
    this._readyResolve = readyResolve;
    this._readyReject = readyReject;
    this.startTimer = setTimeout(() => {
      this._die(mkErr(`AGY worker did not become ready within ${cfg.startupMs} ms`, "transient"));
    }, cfg.startupMs);
    this.child.stdout.on("data", chunk => this._onStdout(chunk.toString()));
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-8000); });
    this.child.stdin.on("error", () => { /* handled via close */ });
    this.child.on("error", err => this._die(mkErr(`Could not start AGY CLI at ${cfg.agyBin}: ${err.message}`, "fatal")));
    this.child.on("close", code => {
      liveChildren.delete(this.child);
      this._die(mkErr((this.stderr.trim() || `AGY process exited with code ${code}`).slice(-3000), classifyError({ message: this.stderr + ` exited with code ${code}` }) === "rate_limit" ? "rate_limit" : "transient"));
    });
  }

  _die(err) {
    clearTimeout(this.startTimer);
    const wasDead = this.dead;
    this.dead = true;
    this._readyReject(err);
    if (!wasDead) killTree(this.child, "SIGKILL");
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      this.busy = false;
      p.reject(err);
    }
  }

  _onStdout(text) {
    this.buffer += text;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.event === "init") {
        clearTimeout(this.startTimer);
        this._readyResolve();
      } else if (event.event === "step_update" && event.step_update?.step_type === "agent_response") {
        const delta = event.step_update.text_delta;
        if (delta && this.pending?.onText) { try { this.pending.onText(String(delta)); } catch { /* client gone */ } }
      } else if (event.event === "result" && event.result && this.pending) {
        const p = this.pending;
        clearTimeout(p.timer);
        this.pending = null;
        this.busy = false;
        this.lastUsed = Date.now();
        const result = { ...event.result, usage: usageDelta(event.result.usage || {}, this.lastUsage) };
        this.lastUsage = event.result.usage || this.lastUsage;
        const dur = Number(event.result.duration_seconds || 0);
        result.duration_seconds = Math.max(0, dur - this.lastDuration);
        this.lastDuration = dur;
        if (result.status && result.status !== "SUCCESS") {
          const message = String(result.error || `AGY status: ${result.status}`);
          p.reject(mkErr(message, classifyError({ message }) === "rate_limit" ? "rate_limit" : "transient"));
        } else p.resolve(result);
      }
    }
  }

  /** Run one conversational turn. `signal` aborts (kills the worker). */
  async run(prompt, { onText, signal } = {}) {
    await this.ready;
    if (this.dead) throw mkErr("AGY worker is not available", "transient");
    if (this.busy) throw mkErr("AGY worker already has an active turn", "fatal");
    this.busy = true;
    this.turns++;
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      const onAbort = () => { this._die(mkErr("Request aborted by client", "aborted")); };
      if (signal) {
        if (signal.aborted) { this.busy = false; return reject(mkErr("Request aborted by client", "aborted")); }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const cur = {
        onText,
        timer: setTimeout(() => this._die(mkErr(`AGY turn timed out after ${this.cfg.timeoutMs} ms`, "timeout")), this.cfg.timeoutMs),
        resolve: v => { cleanup(); resolve(v); },
        reject: e => { cleanup(); reject(e); }
      };
      this.pending = cur;
      this.child.stdin.write(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n", err => {
        if (err) this._die(mkErr(`Could not send prompt to AGY: ${err.message}`, "transient"));
      });
    });
  }

  close() {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.startTimer);
    try { this.child.stdin.end(); } catch { /* closed */ }
    const child = this.child;
    setTimeout(() => killTree(child, "SIGKILL"), 1500).unref();
  }

  kill() {
    this.dead = true;
    clearTimeout(this.startTimer);
    killTree(this.child, "SIGKILL");
  }
}

export class AgyPool {
  constructor(cfg) {
    this.cfg = cfg;
    this.standby = new Map();    // model -> [worker]
    this.spawning = new Map();   // model -> count of standby workers being started
    this.sessions = new Map();   // sessionId -> worker
    this.restarts = 0;
    this.closed = false;
    this.timer = setInterval(() => this._sweep(), 30_000);
    this.timer.unref();
  }

  _sweep() {
    const now = Date.now();
    for (const [model, list] of this.standby) {
      const keep = [];
      for (const w of list) {
        if (w.dead) continue;
        if (now - w.lastUsed > this.cfg.standbyIdleMs) { w.close(); continue; }
        keep.push(w);
      }
      this.standby.set(model, keep);
    }
    for (const [id, w] of this.sessions) {
      if (w.dead || (!w.busy && now - w.lastUsed > this.cfg.sessionIdleMs)) { w.close(); this.sessions.delete(id); }
    }
  }

  _topUp(model) {
    if (this.closed) return;
    const have = (this.standby.get(model) || []).filter(w => !w.dead).length + (this.spawning.get(model) || 0);
    let total = 0;
    for (const [m, l] of this.standby) total += l.filter(w => !w.dead).length + (this.spawning.get(m) || 0);
    for (let i = have; i < this.cfg.prewarm && total < this.cfg.prewarmMax; i++, total++) {
      this.spawning.set(model, (this.spawning.get(model) || 0) + 1);
      const w = new AgyWorker(this.cfg, model);
      w.ready.then(() => {
        this.spawning.set(model, Math.max(0, (this.spawning.get(model) || 1) - 1));
        if (this.closed || w.dead) { w.kill(); return; }
        const list = this.standby.get(model) || [];
        list.push(w);
        this.standby.set(model, list);
      }, () => { this.spawning.set(model, Math.max(0, (this.spawning.get(model) || 1) - 1)); });
    }
  }

  /** A fresh single-use worker: takes a ready standby if there is one, otherwise starts a new process. */
  takeFresh(model) {
    const list = this.standby.get(model) || [];
    let w;
    while ((w = list.shift())) { if (!w.dead) break; w = null; }
    if (!w) w = new AgyWorker(this.cfg, model);
    this._topUp(model);
    w.lastUsed = Date.now();
    return w;
  }

  /** Worker bound to a client session id (keeps the AGY conversation). Returns {worker, fresh} or null if the cap is hit. */
  getSession(sessionId, model) {
    let w = this.sessions.get(sessionId);
    if (w && (w.dead || w.model !== model)) {
      if (w.dead) this.restarts++;
      w.close(); this.sessions.delete(sessionId); w = null;
    }
    if (w) { w.lastUsed = Date.now(); return { worker: w, fresh: false }; }
    if (this.sessions.size >= this.cfg.maxSessionWorkers) {
      const victim = [...this.sessions.entries()].filter(([, x]) => !x.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!victim) return null;
      victim[1].close(); this.sessions.delete(victim[0]);
    }
    w = this.takeFresh(model);
    this.sessions.set(sessionId, w);
    return { worker: w, fresh: true };
  }

  hasSession(sessionId, model) {
    const w = this.sessions.get(sessionId);
    return Boolean(w && !w.dead && w.model === model);
  }

  dropSession(sessionId) {
    const w = this.sessions.get(sessionId);
    if (w) { w.kill(); this.sessions.delete(sessionId); }
  }

  stats() {
    const standby = {};
    for (const [m, l] of this.standby) { const n = l.filter(w => !w.dead).length; if (n) standby[m] = n; }
    return { standby, sessions: this.sessions.size, processes: liveChildren.size, restarts: this.restarts };
  }

  shutdown() {
    this.closed = true;
    clearInterval(this.timer);
    for (const l of this.standby.values()) l.forEach(w => w.kill());
    for (const w of this.sessions.values()) w.kill();
    this.standby.clear(); this.sessions.clear();
    killAllChildren();
  }
}

/** Concurrency limiter with a bounded queue and a queue-wait timeout. */
export class Limiter {
  constructor({ max, maxQueue, queueTimeoutMs }) {
    this.max = max; this.maxQueue = maxQueue; this.queueTimeoutMs = queueTimeoutMs;
    this.active = 0; this.queue = [];
  }
  acquire(signal) {
    if (this.active < this.max) { this.active++; return Promise.resolve(this._releaser()); }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(Object.assign(new Error("AGY request queue is full; retry later"), { status: 429, type: "rate_limit_error", code: "local_queue_full", retryAfter: 10 }));
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve: () => { cleanup(); this.active++; resolve(this._releaser()); } };
      const cleanup = () => { clearTimeout(entry.timer); signal?.removeEventListener("abort", onAbort); };
      const onAbort = () => { cleanup(); this.queue = this.queue.filter(e => e !== entry); reject(Object.assign(new Error("Request aborted by client"), { code: "aborted" })); };
      entry.timer = setTimeout(() => {
        this.queue = this.queue.filter(e => e !== entry); cleanup();
        reject(Object.assign(new Error(`Request waited more than ${this.queueTimeoutMs} ms in the queue`), { status: 503, type: "server_error", code: "queue_timeout", retryAfter: 10 }));
      }, this.queueTimeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(entry);
    });
  }
  _releaser() {
    let done = false;
    return () => {
      if (done) return; done = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.queue.shift();
      if (next) next.resolve();
    };
  }
}
