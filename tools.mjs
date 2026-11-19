// OpenAI tools / function-calling emulation for the AGY bridge.
// AGY's own agent has all of its built-in tools switched off, so "calling a tool" means: the model is
// told (in the prompt) which functions the CLIENT offers and is asked to emit a <tool_calls> JSON block.
// This module builds that prompt, parses the model's reply, and validates it against the JSON Schemas.
import crypto from "node:crypto";

export function badRequest(message, param = null) {
  return Object.assign(new Error(message), { status: 400, param });
}

export function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === "string") return part;
      if (part?.type === "text" || part?.type === "input_text") return part.text || "";
      if (part?.type === "image_url" || part?.type === "input_image") return "[Image input is not supported by this AGY CLI bridge]";
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

/** Normalise `tools`/`tool_choice` and the legacy `functions`/`function_call` into one shape. */
export function normalizeTools(body) {
  let defs = [];
  let legacy = false;
  if (Array.isArray(body.tools) && body.tools.length) {
    for (const t of body.tools) {
      if (!t || t.type !== "function" || !t.function || typeof t.function.name !== "string" || !t.function.name) {
        throw badRequest("Each entry of 'tools' must be {type:'function', function:{name, description?, parameters?}}", "tools");
      }
      defs.push({ name: t.function.name, description: String(t.function.description || ""), parameters: t.function.parameters || { type: "object", properties: {} } });
    }
  } else if (Array.isArray(body.functions) && body.functions.length) {
    legacy = true;
    for (const f of body.functions) {
      if (!f || typeof f.name !== "string" || !f.name) throw badRequest("Each entry of 'functions' must have a name", "functions");
      defs.push({ name: f.name, description: String(f.description || ""), parameters: f.parameters || { type: "object", properties: {} } });
    }
  }
  const seen = new Set();
  for (const d of defs) {
    if (seen.has(d.name)) throw badRequest(`Duplicate function name '${d.name}'`, "tools");
    seen.add(d.name);
  }
  let choice = { mode: "auto", name: null };
  const raw = legacy ? body.function_call : body.tool_choice;
  if (raw !== undefined && raw !== null) {
    if (raw === "none") choice = { mode: "none", name: null };
    else if (raw === "auto") choice = { mode: "auto", name: null };
    else if (raw === "required") choice = { mode: "required", name: null };
    else if (typeof raw === "object") {
      const name = raw.function?.name ?? raw.name;
      if (typeof name !== "string") throw badRequest("Invalid tool_choice", legacy ? "function_call" : "tool_choice");
      choice = { mode: "function", name };
    } else throw badRequest("Invalid tool_choice", legacy ? "function_call" : "tool_choice");
  }
  if (choice.mode === "function" && !defs.some(d => d.name === choice.name)) {
    throw badRequest(`tool_choice names unknown function '${choice.name}'`, "tool_choice");
  }
  if ((choice.mode === "required" || choice.mode === "function") && defs.length === 0) {
    throw badRequest("tool_choice requires at least one tool in 'tools'", "tool_choice");
  }
  return { defs, choice, legacy, parallel: body.parallel_tool_calls !== false };
}

function jsonCompact(v) {
  try { return JSON.stringify(v); } catch { return "{}"; }
}

export function toolCallId() {
  return "call_" + crypto.randomBytes(12).toString("hex");
}

function renderAssistantToolCalls(m) {
  const calls = Array.isArray(m.tool_calls) ? m.tool_calls
    : (m.function_call ? [{ id: "", function: m.function_call }] : []);
  if (!calls.length) return "";
  const items = calls.map(c => {
    let args = c.function?.arguments;
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* keep string */ } }
    return { ...(c.id ? { id: c.id } : {}), name: c.function?.name, arguments: args ?? {} };
  });
  return `<tool_calls>\n${jsonCompact(items)}\n</tool_calls>`;
}

/** Render OpenAI messages into the plain-text transcript sent to AGY. */
export function renderTranscript(messages, priorHistory = []) {
  if (!Array.isArray(messages) || messages.length === 0) throw badRequest("'messages' must be a non-empty array", "messages");
  const isInstr = m => ["system", "developer"].includes(String(m?.role || "").toLowerCase());
  const instructions = messages.filter(isInstr);
  const convo = [...priorHistory, ...messages.filter(m => !isInstr(m))];
  const callNames = new Map();
  for (const m of convo) {
    for (const c of m?.tool_calls || []) if (c?.id) callNames.set(c.id, c.function?.name);
  }
  const parts = [];
  for (const m of instructions) parts.push(`[SYSTEM]\n${contentToText(m.content)}`);
  for (const m of convo) {
    const role = String(m?.role || "user").toLowerCase();
    if (role === "tool" || role === "function") {
      const id = m.tool_call_id || "";
      const name = m.name || callNames.get(id) || "";
      const head = `[TOOL RESULT${id ? ` id=${id}` : ""}${name ? ` function=${name}` : ""}]`;
      parts.push(`${head}\n${contentToText(m.content)}`);
    } else if (role === "assistant") {
      const text = contentToText(m.content);
      const calls = renderAssistantToolCalls(m);
      parts.push(`[ASSISTANT]\n${[text, calls].filter(Boolean).join("\n")}`);
    } else {
      parts.push(`[${role.toUpperCase()}]\n${contentToText(m.content)}`);
    }
  }
  return parts.join("\n\n");
}

export function buildToolsSection({ defs, choice, parallel }) {
  const lines = [];
  lines.push("[FUNCTION CALLING]");
  lines.push("The client application offers the functions below. The CLIENT executes them and sends the output back as [TOOL RESULT] messages. You cannot run anything yourself and you have no other tools, so never claim to have executed something.");
  lines.push("Functions (arguments follow the JSON Schema shown):");
  defs.forEach((d, i) => {
    lines.push(`${i + 1}. ${d.name}${d.description ? " - " + d.description : ""}`);
    lines.push(`   parameters: ${jsonCompact(d.parameters)}`);
  });
  lines.push("Rules:");
  lines.push("- To call functions, reply with ONLY this block and nothing before or after it:");
  lines.push("<tool_calls>");
  lines.push(`[{"name":"<function name>","arguments":{...}}]`);
  lines.push("</tool_calls>");
  lines.push("- \"arguments\" must be a JSON object that satisfies the function's schema (all required fields, correct types). Use only the function names listed above. Do not invent values the user has not given you; if a required value is missing, ask the user in plain text instead of calling.");
  lines.push(parallel ? "- You may put several independent calls in the same array." : "- Call at most ONE function per reply.");
  if (choice.mode === "required") lines.push("- You MUST call at least one function in this reply.");
  else if (choice.mode === "function") lines.push(`- You MUST call the function "${choice.name}" in this reply (and no other function).`);
  else lines.push("- Call a function only when it is needed. If a [TOOL RESULT] already gives you what you need, or no function is needed, answer normally in plain text with NO <tool_calls> block.");
  return lines.join("\n");
}

export function buildPrompt({ messages, tools, responseFormat, priorHistory = [], memoryPolicy = "" }) {
  const transcript = renderTranscript(messages, priorHistory);
  const sections = [];
  if (tools && tools.defs.length && tools.choice.mode !== "none") sections.push(buildToolsSection(tools));
  const rf = responseFormat?.type;
  if (rf === "json_object" || rf === "json_schema") {
    let line = "[OUTPUT FORMAT]\nYour final answer must be ONE valid JSON object and nothing else: no markdown fences, no commentary.";
    const schema = responseFormat.json_schema?.schema;
    if (rf === "json_schema" && schema) line += ` It must conform to this JSON Schema: ${jsonCompact(schema)}`;
    sections.push(line);
  }
  if (memoryPolicy) sections.push(memoryPolicy);
  const tail = "[ASSISTANT]\nRespond to the conversation above. Follow the system instructions and answer the latest message.";
  return [transcript, ...sections, tail].join("\n\n");
}

// ---------------------------------------------------------------- parsing

function stripFences(s) {
  const m = s.trim().match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : s.trim();
}

/** Parse the first complete JSON value (object/array) at or after the first { or [ . */
export function extractJson(text) {
  const s = stripFences(String(text));
  try { return { ok: true, value: JSON.parse(s) }; } catch { /* fall through */ }
  const start = s.search(/[{[]/);
  if (start < 0) return { ok: false };
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try { return { ok: true, value: JSON.parse(s.slice(start, i + 1)) }; } catch { return { ok: false }; }
    }
  }
  return { ok: false };
}

const typeOf = v => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

/** Small JSON Schema validator: type, enum, const, required, properties, items, min/max, anyOf/oneOf. */
export function validateSchema(value, schema, path = "arguments") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const alts = schema.anyOf || schema.oneOf;
    if (!alts.some(a => validateSchema(value, a, path).length === 0)) errors.push(`${path} does not match any allowed shape`);
    return errors;
  }
  if (schema.const !== undefined && jsonCompact(schema.const) !== jsonCompact(value)) errors.push(`${path} must equal ${jsonCompact(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some(e => jsonCompact(e) === jsonCompact(value))) errors.push(`${path} must be one of ${jsonCompact(schema.enum)}`);
  let types = schema.type;
  if (types) {
    types = Array.isArray(types) ? types : [types];
    if (schema.nullable === true && !types.includes("null")) types = [...types, "null"];
    const t = typeOf(value);
    const ok = types.some(x => x === t || (x === "integer" && t === "number" && Number.isInteger(value)) || (x === "number" && t === "number"));
    if (!ok) { errors.push(`${path} must be of type ${types.join("|")} but got ${t}`); return errors; }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path} is too long`);
  }
  if (Array.isArray(value)) {
    if (schema.items && typeof schema.items === "object") value.forEach((v, i) => errors.push(...validateSchema(v, schema.items, `${path}[${i}]`)));
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}.${key} is required`);
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) if (key in value) errors.push(...validateSchema(value[key], sub, `${path}.${key}`));
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in props)) errors.push(`${path}.${key} is not an allowed property`);
    }
  }
  return errors;
}

function coerceCalls(parsed) {
  let arr;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && Array.isArray(parsed.tool_calls)) arr = parsed.tool_calls;
  else if (parsed && parsed.tool_call) arr = [parsed.tool_call];
  else if (parsed && (parsed.name || parsed.function)) arr = [parsed];
  else return null;
  return arr;
}

/**
 * Interpret the model's reply.
 * Returns {kind:'tool_calls', calls:[{id,name,arguments}]} | {kind:'content', text} | {kind:'invalid', errors, raw}
 */
export function parseModelOutput(text, { defs, choice, parallel }) {
  const raw = String(text ?? "").trim();
  const names = new Map(defs.map(d => [d.name, d]));
  const wantCall = choice.mode === "required" || choice.mode === "function";
  let candidate = null; // text that should hold the JSON
  const tag = raw.match(/<tool_calls?>([\s\S]*?)(?:<\/tool_calls?>|$)/i);
  if (tag) candidate = tag[1];
  else {
    // Tolerate a bare JSON reply / fenced JSON that is clearly a tool call.
    const bare = stripFences(raw);
    if (/^[{[]/.test(bare)) {
      const j = extractJson(bare);
      const arr = j.ok ? coerceCalls(j.value) : null;
      if (arr && arr.length && arr.every(c => names.has(c?.name ?? c?.function?.name))) candidate = bare;
    }
  }
  if (candidate === null) {
    if (wantCall) return { kind: "invalid", errors: ["You must call a function but your reply contained no <tool_calls> block."], raw };
    return { kind: "content", text: raw };
  }
  const j = extractJson(candidate);
  if (!j.ok) return { kind: "invalid", errors: ["The <tool_calls> block did not contain valid JSON."], raw };
  const arr = coerceCalls(j.value);
  if (!arr || arr.length === 0) return { kind: "invalid", errors: ["The <tool_calls> block must be a non-empty JSON array of {name, arguments}."], raw };
  const errors = [];
  const calls = [];
  for (const [i, c] of arr.entries()) {
    const name = c?.name ?? c?.function?.name;
    let args = c?.arguments ?? c?.parameters ?? c?.args ?? c?.function?.arguments ?? {};
    if (typeof args === "string") {
      const pa = extractJson(args);
      if (pa.ok && pa.value && typeof pa.value === "object") args = pa.value; else { errors.push(`call ${i + 1}: arguments must be a JSON object`); continue; }
    }
    const def = names.get(name);
    if (!def) { errors.push(`call ${i + 1}: unknown function '${name}'. Valid names: ${[...names.keys()].join(", ")}`); continue; }
    if (!args || typeof args !== "object" || Array.isArray(args)) { errors.push(`call ${i + 1} (${name}): arguments must be a JSON object`); continue; }
    errors.push(...validateSchema(args, def.parameters, `${name}.arguments`));
    calls.push({ id: (typeof c.id === "string" && /^call_[A-Za-z0-9_-]{6,}$/.test(c.id)) ? c.id : toolCallId(), name, arguments: args });
  }
  if (!parallel && calls.length > 1) errors.push("Only one function call is allowed per reply.");
  if (choice.mode === "function" && calls.some(c => c.name !== choice.name)) errors.push(`Only the function '${choice.name}' may be called.`);
  if (errors.length) return { kind: "invalid", errors, raw };
  return { kind: "calls", calls };
}

export function formatRetryPrompt(errors, { choice }) {
  return `[FORMAT ERROR]\nYour previous reply could not be used:\n- ${errors.join("\n- ")}\nReply again now. ${choice.mode === "required" || choice.mode === "function" ? "You MUST call a function." : "Either call a function or answer in plain text."} For a call, output ONLY:\n<tool_calls>\n[{"name":"<function name>","arguments":{...}}]\n</tool_calls>`;
}

/** Validate a json_object response; returns cleaned JSON text or null. */
export function cleanJsonObject(text) {
  const j = extractJson(text);
  if (j.ok && j.value && typeof j.value === "object" && !Array.isArray(j.value)) return JSON.stringify(j.value);
  return null;
}
