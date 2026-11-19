import "./load-env.mjs";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { archiveTurn, ingestConversation, searchMemory, grepMemory, readMemory, listMemoryDates, memoryStats, conversationHistory } from "./memory-store.mjs";
import { AgyPool, Limiter, classifyError, setupIsolatedHome, pruneIsolatedHome } from "./agy-pool.mjs";
import { normalizeTools, buildPrompt, contentToText, parseModelOutput, formatRetryPrompt, cleanJsonObject, badRequest } from "./tools.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const num = (name, dflt, min = 0) => { const v = Number(process.env[name]); return Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? Math.max(min, v) : dflt; };
const flag = (name, dflt) => { const v = (process.env[name] ?? "").trim().toLowerCase(); if (!v) return dflt; return !["0", "off", "false", "no"].includes(v); };

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8788);
const API_KEY = process.env.AGY_API_KEY || "";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const CFG = {
  agyBin: process.env.AGY_BIN || path.join(os.homedir(), ".local", "bin", "agy"),
  timeoutMs: num("AGY_TIMEOUT_MS", 300000, 1000),
  startupMs: num("AGY_STARTUP_TIMEOUT_MS", 45000, 1000),
  isolate: flag("AGY_ISOLATE", true),
  agyHome: process.env.AGY_HOME_DIR || path.join(HERE, ".agy-home"),
  agyWork: path.join(process.env.AGY_HOME_DIR || path.join(HERE, ".agy-home"), "work"),
  retainHours: num("AGY_HOME_RETAIN_HOURS", 12, 1),
  memoryTools: flag("AGY_MEMORY_TOOLS", false),
  memoryMcpPath: path.join(HERE, "memory-mcp.mjs"),
  memoryDir: process.env.AGY_MEMORY_DIR || "",
  prewarm: num("AGY_PREWARM", 1),
  prewarmMax: num("AGY_PREWARM_MAX", 2),
  standbyIdleMs: num("AGY_STANDBY_IDLE_MS", 120000, 10000),
  sessionIdleMs: Math.max(60_000, num("AGY_SESSION_IDLE_MS", 300000)),
  maxSessionWorkers: Math.max(1, num("AGY_MAX_SESSION_WORKERS", 4, 1))
};
const MAX_CONCURRENT = Math.max(1, num("AGY_MAX_CONCURRENT", 4, 1));
const MAX_QUEUE = num("AGY_MAX_QUEUE", 32);
const QUEUE_TIMEOUT_MS = num("AGY_QUEUE_TIMEOUT_MS", 120000, 1000);
const RETRIES = num("AGY_RETRIES", 1);
const SHUTDOWN_GRACE_MS = num("AGY_SHUTDOWN_GRACE_MS", 10000);

if (CFG.isolate) { setupIsolatedHome(CFG); pruneIsolatedHome(CFG); setInterval(() => pruneIsolatedHome(CFG), 3600_000).unref(); }
const pool = new AgyPool(CFG);
const limiter = new Limiter({ max: MAX_CONCURRENT, maxQueue: MAX_QUEUE, queueTimeoutMs: QUEUE_TIMEOUT_MS });

const MODELS = [
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" }
];

const stats = { started: Date.now(), requests: 0, ok: 0, failed: 0, retries: 0, timeouts: 0, rateLimited: 0, clientAborts: 0, toolCallResponses: 0, consecutiveFailures: 0, lastError: null };
let shuttingDown = false;
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const logErr = (...a) => console.error(`[${new Date().toISOString()}]`, ...a);

function json(res, status, data, extraHeaders = {}) {
  if (res.headersSent) return res.end();
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function openAIError(message, type = "invalid_request_error", code = null, param = null) {
  return { error: { message, type, param, code } };
}

function authorized(req) {
  if (!API_KEY) return true;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body exceeds 2 MB limit"), { status: 413 }));
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(Object.assign(new Error("Request body must be valid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function sendSse(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

function chunkString(s, size = 48) {
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

const addUsage = (total, u = {}) => {
  total.input += Number(u.input_tokens || 0);
  total.output += Number(u.output_tokens || 0);
  total.total += Number(u.total_tokens || 0);
};

const MEMORY_POLICY = "[MEMORY TOOL POLICY]\nWhen the user asks about something they said, decided, ran, shared, or discussed in a past conversation, use the agy-memory MCP tools before answering. Do not pass the original question verbatim as the only search query. Infer the likely facts they want, create several short alternative search terms, synonyms, and identifiers, call memory_search, refine search if needed, and use memory_read to verify the exact source and nearby context. For exact code, commands, or error text, use memory_grep. Only provide recalled facts supported by retrieved messages; if no matching evidence is found, say so rather than guessing. Keep retrieval narrow and do not dump whole conversations into context. For unrelated questions that do not require past-conversation recall, do not search memory.";

function errorToResponse(err) {
  const cls = classifyError(err);
  const message = String(err.message || "AGY request failed");
  if (err.status && err.type) return { status: err.status, body: openAIError(message, err.type, err.code || null), headers: err.retryAfter ? { "retry-after": String(err.retryAfter) } : {} };
  if (err.status) return { status: err.status, body: openAIError(message, "invalid_request_error", err.code || null, err.param || null) };
  if (cls === "rate_limit") return { status: 429, body: openAIError("AGY/provider rate limit detected. Pause requests and check your AGY model/account quota before retrying. Details are in server.log.", "rate_limit_error", "upstream_rate_limit"), headers: { "retry-after": "30" } };
  if (cls === "timeout") return { status: 504, body: openAIError(message, "server_error", "agy_timeout") };
  if (err.code === "invalid_tool_call" || err.code === "invalid_json_output" || err.code === "empty_model_response") return { status: 502, body: openAIError(message, "server_error", err.code) };
  return { status: 502, body: openAIError(message.slice(-1500), "server_error", "agy_cli_error") };
}

async function handleChat(req, res, body) {
  const model = String(body.model || MODELS[0].id);
  if (!MODELS.some(m => m.id === model)) return json(res, 400, openAIError(`Unknown model '${model}'. Check GET /v1/models for supported IDs.`, "invalid_request_error", "model_not_found", "model"));
  if (!Array.isArray(body.messages) || body.messages.length === 0) return json(res, 400, openAIError("'messages' must be a non-empty array", "invalid_request_error", null, "messages"));
  if (Number(body.n || 1) > 1) return json(res, 400, openAIError("Only n=1 is supported", "invalid_request_error", null, "n"));
  let tools;
  try { tools = normalizeTools(body); } catch (e) { return json(res, 400, openAIError(e.message, "invalid_request_error", null, e.param || null)); }
  const toolMode = tools.defs.length > 0 && tools.choice.mode !== "none";
  const rfType = body.response_format?.type;
  const jsonMode = (rfType === "json_object" || rfType === "json_schema") && !toolMode;
  const hasToolHistory = body.messages.some(m => ["tool", "function"].includes(String(m?.role)) || m?.tool_calls || m?.function_call);
  const sessionProvided = Boolean(body.session_id || body.conversation_id);
  const sessionId = String(body.session_id || body.conversation_id || crypto.randomUUID()).slice(0, 200);
  const useSession = sessionProvided && !toolMode && !hasToolHistory && !jsonMode;
  const wantStream = body.stream === true;
  const liveStream = wantStream && !toolMode && !jsonMode;
  const includeUsage = Boolean(body.stream_options?.include_usage);
  const id = "chatcmpl-" + crypto.randomUUID().replaceAll("-", "");
  const created = Math.floor(Date.now() / 1000);

  const ac = new AbortController();
  const onClose = () => { if (!res.writableEnded) { stats.clientAborts++; ac.abort(); } };
  res.on("close", onClose);

  let release;
  try { release = await limiter.acquire(ac.signal); }
  catch (err) {
    if (err.code === "aborted") return;
    stats.failed++; const r = errorToResponse(err); return json(res, r.status, r.body, r.headers);
  }

  const started = Date.now();
  const usageTotal = { input: 0, output: 0, total: 0 };
  let streamStarted = false;
  const startStream = () => {
    if (streamStarted) return;
    streamStarted = true;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    sendSse(res, { id, object: "chat.completion.chunk", created, model, session_id: sessionId, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  };
  const onText = liveStream ? chunk => {
    startStream();
    sendSse(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
  } : undefined;

  // One attempt = one worker. Returns {content, calls}.
  async function attempt() {
    let worker, singleUse = true, fresh = true, unlock = () => {};
    if (useSession) {
      const s = pool.getSession(sessionId, model);
      if (s) { worker = s.worker; fresh = s.fresh; singleUse = false; }
    }
    if (!worker) worker = pool.takeFresh(model);
    let failed = false;
    try {
      if (!singleUse) { const prev = worker.lock; worker.lock = new Promise(r => { unlock = r; }); await prev; }
      let prompt;
      if (!singleUse && !fresh && worker.turns > 0) {
        const lastUser = [...body.messages].reverse().find(m => String(m?.role || "").toLowerCase() === "user");
        if (!lastUser) throw badRequest("messages must include a user message", "messages");
        prompt = `[USER]\n${contentToText(lastUser.content)}`; // the live AGY conversation already holds the history
      } else {
        let priorHistory = [];
        const convo = body.messages.filter(m => !["system", "developer"].includes(String(m?.role || "").toLowerCase()));
        if (useSession && convo.length === 1 && convo[0]?.role === "user") {
          try { priorHistory = conversationHistory(sessionId, 40).messages; } catch (e) { logErr("Session history load failed:", e.message); }
        }
        prompt = buildPrompt({ messages: body.messages, tools: toolMode ? tools : null, responseFormat: jsonMode ? body.response_format : null, priorHistory, memoryPolicy: CFG.memoryTools && !toolMode ? MEMORY_POLICY : "" });
      }
      const turn = async p => {
        const r = await worker.run(p, { onText, signal: ac.signal });
        addUsage(usageTotal, r.usage);
        return r;
      };
      let result = await turn(prompt);
      let text = String(result.response ?? "").trim();
      if (!text) {
        log(`Empty AGY response (${model}); nudging once`);
        result = await turn("[IMPORTANT OUTPUT CHECK]\nYour previous reply was empty. Answer the latest message now with a non-empty reply.");
        text = String(result.response ?? "").trim();
        if (!text) throw Object.assign(new Error("The model returned an empty response twice."), { code: "empty_model_response", transient: true });
      }
      if (toolMode) {
        let parsed = parseModelOutput(text, tools);
        if (parsed.kind === "invalid") {
          log(`Tool-call output invalid (${model}): ${parsed.errors.join("; ").slice(0, 300)}; retrying once`);
          result = await turn(formatRetryPrompt(parsed.errors, tools));
          parsed = parseModelOutput(String(result.response ?? "").trim(), tools);
          if (parsed.kind === "invalid") throw Object.assign(new Error(`The model could not produce a valid function call: ${parsed.errors.join("; ")}`.slice(0, 600)), { code: "invalid_tool_call" });
        }
        return parsed.kind === "calls" ? { calls: parsed.calls, content: null, result } : { calls: null, content: parsed.text, result };
      }
      if (jsonMode) {
        let cleaned = cleanJsonObject(text);
        if (cleaned === null) {
          result = await turn("[FORMAT ERROR]\nYour previous reply was not a single valid JSON object. Reply again with ONLY the JSON object: no markdown, no commentary.");
          cleaned = cleanJsonObject(String(result.response ?? "").trim());
          if (cleaned === null) throw Object.assign(new Error("The model could not produce valid JSON output."), { code: "invalid_json_output" });
        }
        return { calls: null, content: cleaned, result };
      }
      return { calls: null, content: text, result };
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      unlock();
      if (singleUse) worker.kill();
      else if (failed || worker.dead) pool.dropSession(sessionId);
    }
  }

  try {
    let out, tries = 0;
    for (;;) {
      try { out = await attempt(); break; }
      catch (err) {
        const cls = classifyError(err);
        if (tries < RETRIES && cls === "transient" && !streamStarted && !ac.signal.aborted && !shuttingDown) {
          tries++; stats.retries++;
          logErr(`Transient AGY failure (${model}); retrying (${tries}/${RETRIES}): ${String(err.message).slice(0, 300)}`);
          continue;
        }
        throw err;
      }
    }
    stats.ok++; stats.consecutiveFailures = 0;
    const usage = { prompt_tokens: usageTotal.input, completion_tokens: usageTotal.output, total_tokens: usageTotal.total || usageTotal.input + usageTotal.output };
    const finish = out.calls ? (tools.legacy ? "function_call" : "tool_calls") : "stop";
    if (out.calls) stats.toolCallResponses++;
    const apiCalls = out.calls ? out.calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) : null;
    if (!out.calls) {
      try {
        const lastUser = [...body.messages].reverse().find(m => m?.role === "user");
        if (lastUser && !hasToolHistory) archiveTurn({ conversationId: sessionId, userContent: contentToText(lastUser.content), assistantContent: out.content, model });
      } catch (e) { logErr("Memory archive failed:", e.message); }
    }
    const x_agy = { duration_seconds: (Date.now() - started) / 1000, cli_duration_seconds: out.result.duration_seconds || null, retries: tries, warm_session: useSession && out.result.num_turns > 1 };
    if (wantStream) {
      startStream();
      const chunk = (delta, fr = null) => sendSse(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: fr }] });
      if (apiCalls && !tools.legacy) {
        apiCalls.forEach((c, i) => {
          chunk({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.function.name, arguments: "" } }] });
          for (const part of chunkString(c.function.arguments, 40)) chunk({ tool_calls: [{ index: i, function: { arguments: part } }] });
        });
      } else if (apiCalls) {
        chunk({ function_call: { name: apiCalls[0].function.name, arguments: "" } });
        for (const part of chunkString(apiCalls[0].function.arguments, 40)) chunk({ function_call: { arguments: part } });
      } else if (!liveStream) {
        for (const part of chunkString(out.content)) chunk({ content: part });
      }
      chunk({}, finish);
      if (includeUsage) sendSse(res, { id, object: "chat.completion.chunk", created, model, choices: [], usage });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    const message = { role: "assistant", content: out.calls ? null : out.content };
    if (apiCalls) { if (tools.legacy) message.function_call = apiCalls[0].function; else message.tool_calls = apiCalls; }
    return json(res, 200, { session_id: sessionId, id, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason: finish }], usage, x_agy });
  } catch (err) {
    if (err.code === "aborted" || ac.signal.aborted) { log(`Client disconnected; aborted ${model} request`); return; }
    const cls = classifyError(err);
    stats.failed++; stats.consecutiveFailures++;
    if (cls === "timeout") stats.timeouts++;
    if (cls === "rate_limit") stats.rateLimited++;
    stats.lastError = { at: new Date().toISOString(), kind: cls, message: String(err.message).slice(0, 200) };
    logErr(`AGY request failed (${cls}) model=${model}: ${String(err.message).slice(-1500)}`);
    const r = errorToResponse(err);
    if (streamStarted) {
      sendSse(res, { error: r.body.error });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    return json(res, r.status, r.body, r.headers);
  } finally {
    res.off("close", onClose);
    release();
  }
}

function health() {
  const cliExists = fs.existsSync(CFG.agyBin);
  const status = shuttingDown ? "shutting_down" : (!cliExists || stats.consecutiveFailures >= 3) ? "degraded" : "ok";
  return {
    ok: status === "ok", status, service: "agy-local-api", version: "2.0.0", uptime_seconds: Math.round((Date.now() - stats.started) / 1000),
    cli: CFG.agyBin, cli_found: cliExists,
    mode: { isolated_home: CFG.isolate, memory_tools: CFG.memoryTools, tool_calling: "prompt-emulated", prewarm: CFG.prewarm },
    active: limiter.active, queued: limiter.queue.length, max_concurrent: MAX_CONCURRENT, max_queue: MAX_QUEUE,
    warm_sessions: pool.sessions.size, max_session_workers: CFG.maxSessionWorkers,
    pool: pool.stats(),
    stats: { requests: stats.requests, ok: stats.ok, failed: stats.failed, retries: stats.retries, timeouts: stats.timeouts, rate_limited: stats.rateLimited, client_aborts: stats.clientAborts, tool_call_responses: stats.toolCallResponses, consecutive_failures: stats.consecutiveFailures },
    last_error: stats.lastError
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" });
      return res.end();
    }
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") { const h = health(); return json(res, shuttingDown ? 503 : 200, h); }
    if (shuttingDown) return json(res, 503, openAIError("Server is shutting down", "server_error", "shutting_down"), { "retry-after": "5" });
    if (url.pathname.startsWith("/v1/memory/")) {
      if (!authorized(req)) return json(res, 401, openAIError("Invalid or missing API key", "authentication_error"));
      if (req.method === "GET" && url.pathname === "/v1/memory/stats") return json(res, 200, memoryStats());
      if (req.method === "GET" && url.pathname === "/v1/memory/dates") return json(res, 200, listMemoryDates({ limit: Number(url.searchParams.get("limit") || 60) }));
      if (req.method !== "POST") return json(res, 405, openAIError("Use POST for memory search/read/ingest endpoints"));
      let memoryBody;
      try { memoryBody = await readBody(req); } catch (err) { return json(res, err.status || 400, openAIError(err.message)); }
      try {
        if (url.pathname === "/v1/memory/search") return json(res, 200, searchMemory(memoryBody));
        if (url.pathname === "/v1/memory/grep") return json(res, 200, grepMemory(memoryBody));
        if (url.pathname === "/v1/memory/read") return json(res, 200, readMemory(memoryBody));
        if (url.pathname === "/v1/memory/ingest") return json(res, 200, ingestConversation(memoryBody));
        return json(res, 404, openAIError("Unknown memory endpoint", "invalid_request_error", "not_found"));
      } catch (err) { return json(res, 400, openAIError(err.message)); }
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      if (!authorized(req)) return json(res, 401, openAIError("Invalid or missing API key", "authentication_error"));
      return json(res, 200, { object: "list", data: MODELS.map(m => ({ id: m.id, object: "model", created: 0, owned_by: "agy-cli", name: m.name })) });
    }
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return json(res, 404, openAIError("Not found. Use GET /v1/models or POST /v1/chat/completions", "invalid_request_error", "not_found"));
    }
    if (!authorized(req)) return json(res, 401, openAIError("Invalid or missing API key", "authentication_error"));
    let body;
    try { body = await readBody(req); }
    catch (err) { return json(res, err.status || 400, openAIError(err.message)); }
    stats.requests++;
    return await handleChat(req, res, body);
  } catch (err) {
    logErr("Unhandled request error:", err?.stack || err);
    try { if (!res.headersSent) json(res, 500, openAIError("Internal server error", "server_error", "internal_error")); else res.end(); } catch { /* socket gone */ }
  }
});

server.listen(PORT, HOST, () => {
  log(`AGY OpenAI-compatible API listening at http://${HOST}:${PORT}`);
  log(`Using CLI: ${CFG.agyBin}`);
  log(`Auth: ${API_KEY ? "API key required" : "disabled (localhost only)"}`);
  log(`Isolated AGY home: ${CFG.isolate ? CFG.agyHome : "off (using your global AGY config)"}; memory tools: ${CFG.memoryTools ? "on" : "off"}; concurrency ${MAX_CONCURRENT}, queue ${MAX_QUEUE}, session workers ${CFG.maxSessionWorkers}, prewarm ${CFG.prewarm}`);
});
server.on("error", err => { logErr("Server failed:", err.message); process.exit(1); });

async function shutdown(signal) {
  if (shuttingDown) { logErr(`${signal} again: forcing exit`); pool.shutdown(); process.exit(1); }
  shuttingDown = true;
  log(`${signal} received: draining ${limiter.active} active request(s), then killing AGY children`);
  server.close();
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while ((limiter.active > 0 || limiter.queue.length > 0) && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
  pool.shutdown();
  log("Shutdown complete");
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(sig));
process.on("unhandledRejection", err => logErr("Unhandled rejection:", err?.stack || err));
process.on("uncaughtException", err => { logErr("Uncaught exception:", err?.stack || err); });
