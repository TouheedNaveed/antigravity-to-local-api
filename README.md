<p align="center">
  <img src="assets/banner.jpg" alt="Antigravity Local API" width="100%" />
</p>

# AGY Local API + Memory Search

OpenAI-compatible local HTTP bridge for the AGY CLI, with a local searchable archive of conversations and an MCP server that lets AGY search that archive as a tool.

## Requirements

- Node.js 22.5+ (tested with Node 24.21.0; uses built-in `node:sqlite` and `process.loadEnvFile`).
- The AGY CLI installed and signed in. By default, the API expects it at `~/.local/bin/agy`.
- No third-party npm dependencies are required.
- SQLite FTS5 must be available in the Node SQLite build.

## Quick setup

1. Clone or download this repository and open a terminal in the `agy-local-api` folder.
2. Create your local configuration file from the public template:

   macOS / Linux:

   ```bash
   cp .env.example .env
   ```

   Windows PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Open `.env` and change only the settings you need. The defaults work for a local API when AGY is installed at `~/.local/bin/agy`. Keep `HOST=127.0.0.1` for local-only access.
4. Start the API:

   ```bash
   npm start
   ```

No `npm install` is needed: the project uses Node.js built-in modules. Check the server at `http://127.0.0.1:8788/health`.

The `.env` file is private and ignored by Git. Commit `.env.example`, never `.env`. The application loads `.env` from its own project directory; existing shell environment variables take precedence over values in `.env`.

## Environment settings

| Variable | Default | Purpose |
|---|---:|---|
| `HOST` | `127.0.0.1` | Local bind address. Keep local unless you have secured remote access. |
| `PORT` | `8788` | HTTP API port. |
| `AGY_BIN` | `~/.local/bin/agy` | Optional absolute path to the AGY CLI; blank uses the default. |
| `AGY_API_KEY` | blank | Optional Bearer token. Blank disables API-key authentication; use only on localhost in that case. |
| `AGY_TIMEOUT_MS` | `300000` | Maximum request duration in milliseconds. |
| `AGY_MAX_CONCURRENT` | `1` | Maximum requests processed at once. |
| `AGY_MAX_QUEUE` | `10` | Maximum waiting requests. |
| `AGY_MAX_SESSION_WORKERS` | `1` | Maximum warm CLI sessions. |
| `AGY_SESSION_IDLE_MS` | `300000` | Idle time before a warm session is retired, in milliseconds. |
| `AGY_MEMORY_DIR` | project `memory/` folder | Optional absolute path for memory storage; blank uses the project's `memory/` folder. |

Default API address: `http://127.0.0.1:8788`.

## Memory archive layout

By default the archive lives under agy-local-api/memory/:

```text
memory/
  index.sqlite
  raw/
    YYYY/
      MM/
        DD/
          <conversation-id>.jsonl
```

The SQLite index stores messages and a full-text FTS5 index. Raw JSONL is retained as a dated source archive. Set AGY_MEMORY_DIR to move the archive elsewhere.

Requests to POST /v1/chat/completions automatically archive the latest user message and the assistant answer. Send a stable session_id in each request to group turns from the same chat; without it, each API request may be stored as a separate conversation depending on the AGY response ID.

## Memory HTTP endpoints

- GET /v1/memory/stats: index and archive counts.
- GET /v1/memory/dates: dates containing archived messages.
- POST /v1/memory/search: global full-text search; body supports query, queries, after, before, role, search_type, and limit.
- POST /v1/memory/grep: literal substring search.
- POST /v1/memory/read: read a matching message plus nearby messages using message_id.
- POST /v1/memory/ingest: import a conversation using conversation_id and messages.

If AGY_API_KEY is set, include Authorization: Bearer YOUR_KEY on these endpoints. The default listener is loopback-only.

Example search:

```bash
curl -s http://127.0.0.1:8788/v1/memory/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"local server command","queries":["nohup node","port 8788"],"limit":8}'
```

## Register memory tools for AGY

The MCP server exposes these local tools:

- memory_search: keyword/FTS search; the tool description instructs AGY to infer search terms instead of searching the user's question verbatim.
- memory_grep: exact substring search.
- memory_read: retrieve a matching message and nearby context.
- memory_list_dates: list indexed dates.
- memory_stats: inspect index counts and paths.
- memory_ingest: explicitly import supplied conversation records.

Register it once with the AGY CLI:

```bash
agy mcp add --type stdio agy-memory "$(command -v node)" "$PWD/memory-mcp.mjs"
agy mcp list
```

Run the command from inside the cloned `agy-local-api` folder so `$PWD` resolves to the right location. If Node is not on the expected PATH for AGY, replace `$(command -v node)` with the absolute output of `which node`. The MCP process uses the same AGY_MEMORY_DIR environment variable as the HTTP API only if it is set in the environment inherited by AGY.

Restart any active AGY CLI session after registering the server so it reloads the MCP tool list. The headless CLI also needs narrow per-tool permission grants. The setup uses mcp(memory_search), mcp(memory_grep), mcp(memory_read), mcp(memory_list_dates), mcp(memory_stats), and mcp(memory_ingest) in ~/.gemini/antigravity-cli/settings.json; it does not enable the broad --dangerously-skip-permissions flag.

## Import existing conversations

New API calls are archived automatically, but historical ChatGPT/AGY conversations are not magically available to this service. Export or provide them, then import through POST /v1/memory/ingest or MCP tool memory_ingest. The index is only as complete as the data ingested into it.

## OpenAI SDK example

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8788/v1",
  apiKey: "local",
});

const result = await client.chat.completions.create({
  model: "gemini-3.8-flash-medium",
  messages: [{ role: "user", content: "Hello from my local project" }],
});

console.log(result.choices[0].message.content);
```

## Notes and limitations

- Search, grep, indexing and message retrieval run locally and do not make LLM calls. AGY's reasoning/tool selection and final answer still consume model tokens.
- Search is full-text (FTS5) plus literal fallback. Semantic/vector search and a local embedding model are not included in this first implementation.
- AGY must call the registered MCP tools for tool-driven search. OpenAI tools/function calling for *your* functions is now supported (emulated, see UPGRADE notes below).
- The API listens on 127.0.0.1 by default and is not exposed to other devices.

## UPGRADE notes (v2.0)

What changed compared with the original bridge:

- **Function calling.** `tools` / `tool_choice` (`auto`, `none`, `required`, or one named function), `parallel_tool_calls`, and the legacy `functions` / `function_call` are accepted. Replies carry `message.tool_calls` with `finish_reason: "tool_calls"` (legacy: `function_call`). Follow-up `role: "tool"` messages and assistant messages that contain `tool_calls` are understood. This is **emulated through the prompt**: the functions and their JSON Schemas are described to the model, which must reply with a `<tool_calls>[...]</tool_calls>` block; the bridge parses it, validates names and arguments against your schemas, and asks the model once to fix an invalid reply. AGY itself never executes anything: the bridge runs it with `--sandbox` and a custom agent with `tools: []`, so only a harmless internal task-list tool remains.
- **Streaming** (`stream: true`, `stream_options.include_usage`). Plain chat streams live from AGY. Tool-call and JSON-mode replies are produced in full first and then sent as SSE chunks.
- **`response_format`** `json_object` (and a best-effort `json_schema`): the reply is checked for valid JSON and retried once.
- **About 83% fewer prompt tokens.** The old ~12.5k tokens per request came from AGY's full coding-agent system prompt, ~20 built-in tools, your global skills and your MCP servers (blender, browse). The bridge now runs AGY in its own `HOME` (`./.agy-home`) with a minimal tool-less agent: the same "Say OK" request costs ~2.1k tokens. Your real `~/.gemini` is not touched. Login still works because AGY keeps credentials in the desktop keyring (via the user D-Bus session), not in `~/.gemini`; the bridge must run inside your logged-in user session.
- **Reliability.** Bounded queue with a queue-wait timeout, per-turn and startup timeouts, one automatic retry on transient AGY failures (dead process, startup failure, empty reply; never on quota/429 or timeouts), dead workers are discarded and replaced, OpenAI-style error bodies everywhere, client disconnects cancel the AGY run, `/health` reports status/pool/counters (503 while shutting down), and SIGINT/SIGTERM drain in-flight requests then kill every AGY child process.
- **Concurrency.** Defaults are now 4 concurrent requests and 4 session workers. Each stateless request gets its own fresh single-use AGY process (a ready-to-go one is kept on standby per model, so latency stays low); nothing is shared between concurrent requests. Requests that send `session_id` / `conversation_id` keep a warm AGY conversation as before.
- **Memory tools are off by default** (`AGY_MEMORY_TOOLS=off`), so the MEMORY TOOL POLICY text and the agy-memory MCP are not sent. Switching them on costs several extra thousand tokens when AGY decides to search.

New / changed environment variables (all in `.env`; see `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGY_MAX_CONCURRENT` | 4 | Parallel AGY runs (was 1) |
| `AGY_MAX_QUEUE` | 32 | Requests allowed to wait (was 10); more get HTTP 429 |
| `AGY_QUEUE_TIMEOUT_MS` | 120000 | Max wait in the queue before HTTP 503 |
| `AGY_TIMEOUT_MS` | 300000 | Per-turn timeout |
| `AGY_STARTUP_TIMEOUT_MS` | 45000 | Time allowed for an AGY process to become ready |
| `AGY_RETRIES` | 1 | Retries on transient failures |
| `AGY_SHUTDOWN_GRACE_MS` | 10000 | How long shutdown waits for in-flight requests |
| `AGY_MAX_SESSION_WORKERS` | 4 | Warm session conversations kept (was 1) |
| `AGY_SESSION_IDLE_MS` | 300000 | Idle time before a session worker is closed |
| `AGY_PREWARM` | 1 | Ready-to-use standby AGY processes per model (0 disables) |
| `AGY_PREWARM_MAX` | 2 | Total standby processes (each idle one uses ~240 MB RAM) |
| `AGY_STANDBY_IDLE_MS` | 120000 | Idle standby processes are closed after this |
| `AGY_MINIMAL_AGENT` | 1 | bridge agent uses `excludeDefaultComponents`: no built-in AGY prompt or tools (about 450 prompt tokens instead of 2,050 for "Say OK"); ignored when `AGY_MEMORY_TOOLS=on` |
| `AGY_COMPACT_PROMPT` | 1 | shorter wrapper, function-calling and JSON-mode text |
| `AGY_MAX_HISTORY_TOKENS` / `AGY_MAX_HISTORY_MESSAGES` | 0 | optional cap: oldest turns are dropped first (estimate, about 3.5 characters per token); system messages and the last message are always kept |
| `AGY_ISOLATE` | 1 | `1` = bridge-only HOME + minimal agent; `0` = legacy (global config, ~12k tokens) |
| `AGY_HOME_DIR` | `./.agy-home` | Where the isolated AGY home lives |
| `AGY_HOME_RETAIN_HOURS` | 12 | AGY conversation logs older than this are pruned from the isolated home |
| `AGY_MEMORY_TOOLS` | off | `on` registers the agy-memory MCP for AGY and adds the memory policy text |

Limitations: tool calling relies on the model following the prompt protocol (it worked on all six models in testing, but it is not a native API feature); images are not supported; `n > 1` is rejected; arguments are validated with a small built-in JSON Schema checker (type, enum, required, nested properties/items, min/max); standby processes use RAM while idle; token counts come from AGY and include the bridge's small prompt scaffolding (~100-350 tokens).

Run `npm run check` (syntax checks + unit tests for the tool-call parser). The original files are in `.orig/`, and the untouched code is on the `main` branch.

## API keys and dashboard (v2.1)

**First run**

1. Start the server (`npm start`) and open `http://127.0.0.1:8790/` (or `/dashboard`).
2. The first visit shows a setup screen: choose an admin password (min 8 characters). Do this right away: whoever opens the page first sets it.
3. Open the **API keys** tab, name a key, choose when it expires (after N days, on a date/time, or never) and create it. The full key (`agy-` + 43 characters) is shown **once**; copy it.
4. Send it with every request: `Authorization: Bearer agy-...` (or the `x-api-key` header).

```bash
curl http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer agy-YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.8-flash-medium","messages":[{"role":"user","content":"Hello"}]}'
```

**Behaviour**

- **A key is required by default** for every `/v1/*` call (chat, models, memory). Until you create the first key every call returns 401 `no_api_keys`. Existing clients that used a dummy key such as `local` must be given a real key. `AGY_REQUIRE_KEY=0` leaves the API open only while no keys exist and `AGY_API_KEY` is empty; as soon as a key exists, keys are enforced.
- `AGY_API_KEY` in `.env` still works as a static key (it cannot be revoked from the dashboard; remove it from `.env` to disable it).
- 401 errors are OpenAI-style with distinct codes: `missing_api_key`, `invalid_api_key`, `api_key_expired`, `api_key_revoked`, `no_api_keys`.
- Revoking or deleting a key takes effect on the very next request. Revoked keys can be deleted.
- Per key the dashboard shows status, last used, request count and prompt/completion tokens (tokens consumed by the retry turns are included).
- `GET /health` stays public (it contains no secrets); everything else under `/v1` needs a key.

**Dashboard tabs**: *API keys* (create, revoke, delete), *Playground* (model picker, streaming chat, optional token usage; authenticate with the dashboard session, which is not counted, or paste a key), *Status* (health, queue, pool, counters, last error, models), *Connect & docs* (base URL, curl, JS/Python SDK snippets, Continue / Open WebUI / Cursor notes). The page is one self-contained file (`dashboard.html`), no CDN or build step.

**Security model**

- Keys: only a SHA-256 hash, a display prefix and metadata are stored, in `data/keys.json` (directory mode 700, file mode 600, gitignored).
- Admin password: scrypt hash in `data/admin.json` (mode 600). Login gives an HttpOnly, SameSite=Strict session cookie (12 h); 5 wrong passwords per minute are throttled.
- Admin API (`/admin/api/*`) never accepts API keys. State-changing calls require the session, a per-session CSRF token header, the `X-Requested-With: agy-dashboard` header and a same-origin `Origin`. The `Host` header must be `127.0.0.1`, `localhost` or `[::1]` (blocks DNS rebinding); add names via `AGY_ADMIN_ALLOWED_HOSTS`.
- The page is served with a nonce-based Content-Security-Policy and `X-Frame-Options: DENY`.
- To reset a forgotten admin password: stop the server, delete `data/admin.json`, start it, and set a new one. Keys are kept.

New variables: `AGY_REQUIRE_KEY` (default 1), `AGY_DATA_DIR` (default `./data`), `AGY_ADMIN_ALLOWED_HOSTS`.

Limitations: the dashboard speaks plain HTTP on loopback (no TLS); there is a single admin account; sessions live in memory (a restart signs you out); usage counters are written to disk every ~2 s and on shutdown, so a hard kill can lose the last couple of seconds; Cursor's custom base URL setting calls the API from Cursor's servers, so a localhost URL generally does not work there.

## Usage, metrics and quota (v2.2)

The dashboard has a **Usage & quota** tab (and a live uptime clock on **Status**).

- **Live panel**: server uptime, active and queued requests, last-5-minute traffic. Pushed over SSE (`GET /admin/api/live`, every 2 s); the browser ticks the clocks every second.
- **Charts** (plain canvas, no external libraries): tokens, requests and errors, latency, concurrency and queue, for 1 h / 24 h / 7 d / 30 d, plus breakdowns by model and by API key. `GET /admin/api/metrics?range=1h|24h|7d|30d`.
- **Storage**: `data/metrics.sqlite` (built-in `node:sqlite`). Per-minute buckets are kept 48 h, then rolled up hourly and kept about 400 days.
- **Plan quota**: read from the CLI's own `agy -p "/usage"` command (run with the bridge's isolated home, 0 tokens). It reports, per model group (Gemini; Claude and GPT), the remaining fraction and reset time of the 5-hour and weekly limits. The dashboard shows them with a live countdown. Refreshed every `AGY_QUOTA_POLL_MS` (default 120000) or via "Refresh now". Quota is account-wide, so Antigravity use outside this bridge also counts; the "used through this bridge" figure only covers this server's traffic.
- **Last quota error**: if upstream rejects a request for quota, the message and any reset time parsed from it are shown.
- **Self-set token budget** (optional): a token budget per day / 5 h / week with a reset time of day, counted from this bridge's own traffic and clearly labelled as self-set. Saved in `data/settings.json`.

Limitations: `/usage` takes a few seconds and needs the desktop keyring session (same as `agy` itself); if it fails, the last error is shown instead of made-up numbers. Metrics only cover requests that went through this bridge.

## Dashboard redesign and OpenCode (v2.3)

- Every screen uses one liquid glass theme (blurred amber background, frosted panels, themed dropdowns, date picker, toggles, modals and toasts). No external fonts, scripts or libraries. Responsive down to 390 px with a bottom nav on phones; the Playground Options panel sits inline below the chat (the Options button scrolls to it).
- Everything is live: SSE status pill, a 1 s ticker for clocks and countdowns, relative times, animated numbers.
- Playground: Stop aborts a running reply, Send returns when idle.
- Key creation is idempotent: the dashboard sends a `request_id` (replayed for 30 s) and the server rejects the same key name twice within 5 s, so a double click cannot create two keys.
- The favicon is served at `/favicon.svg` and `/favicon.png`.
- The **Docs** tab shows OpenCode setup steps and a ready `opencode.json` listing this bridge's models. Set `AGY_API_KEY` to a key created in the dashboard, then run `opencode` and pick `AGY Local`.

## Token usage (v2.3)

Measured on `gemini-3.8-flash-low`, prompt tokens as reported by AGY:

| Request | Before | After |
| --- | --- | --- |
| "Say OK" | 2,040 | 441 |
| get_weather call, then the tool result | 2,313 and 2,417 | 601 and 712 |
| JSON mode | 2,085 | 472 |
| 6 turn chat (client resends history), total | 12,722 | 3,112 |
| Claude Sonnet 4.6, "Say OK" | 2,705 | 992 |

The saving comes from the agent flag `excludeDefaultComponents: true`, which removes AGY's own system prompt and built-in tools. What is left is the bridge's one sentence agent prompt, your messages, and a short fixed overhead (about 370 tokens on Gemini, about 920 on Claude, set by AGY). AGY reports `cache_read_tokens` as 0, so warm sessions do not reduce usage: every turn is billed for the whole conversation, which is why `AGY_MAX_HISTORY_*` exists. Completion tokens include thinking tokens, which the model sometimes adds (0 to about 120) and the bridge cannot control.
