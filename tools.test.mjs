import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTools, parseModelOutput, buildPrompt, validateSchema, extractJson, cleanJsonObject, trimConversation, buildToolsSection } from "./tools.mjs";

const weather = { type: "function", function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" }, unit: { type: "string", enum: ["c", "f"] } }, required: ["city"] } } };
const t = normalizeTools({ tools: [weather] });

test("normalizeTools handles tools, legacy functions and choices", () => {
  assert.equal(t.defs[0].name, "get_weather");
  assert.equal(normalizeTools({ tools: [weather], tool_choice: "required" }).choice.mode, "required");
  assert.equal(normalizeTools({ tools: [weather], tool_choice: { type: "function", function: { name: "get_weather" } } }).choice.name, "get_weather");
  const legacy = normalizeTools({ functions: [weather.function], function_call: "none" });
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.choice.mode, "none");
  assert.throws(() => normalizeTools({ tools: [weather], tool_choice: { type: "function", function: { name: "nope" } } }), /unknown function/);
});

test("parses a tagged tool call", () => {
  const r = parseModelOutput('<tool_calls>\n[{"name":"get_weather","arguments":{"city":"Paris"}}]\n</tool_calls>', t);
  assert.equal(r.kind, "calls");
  assert.deepEqual(r.calls[0].arguments, { city: "Paris" });
  assert.match(r.calls[0].id, /^call_/);
});

test("tolerates fences, missing close tag, string arguments, single object", () => {
  assert.equal(parseModelOutput('<tool_calls>```json\n[{"name":"get_weather","arguments":{"city":"A"}}]\n```', t).kind, "calls");
  assert.equal(parseModelOutput('<tool_calls>{"name":"get_weather","arguments":"{\\"city\\":\\"B\\"}"}</tool_calls>', t).calls[0].arguments.city, "B");
  assert.equal(parseModelOutput('```json\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"C"}}]}\n```', t).kind, "calls");
});

test("plain text is content; invalid calls are reported", () => {
  assert.equal(parseModelOutput("It is sunny.", t).kind, "content");
  assert.equal(parseModelOutput('<tool_calls>[{"name":"nope","arguments":{}}]</tool_calls>', t).kind, "invalid");
  assert.equal(parseModelOutput('<tool_calls>[{"name":"get_weather","arguments":{}}]</tool_calls>', t).kind, "invalid");
  assert.equal(parseModelOutput('<tool_calls>[{"name":"get_weather","arguments":{"city":"X","unit":"k"}}]</tool_calls>', t).kind, "invalid");
  assert.equal(parseModelOutput("<tool_calls>not json</tool_calls>", t).kind, "invalid");
  const req = normalizeTools({ tools: [weather], tool_choice: "required" });
  assert.equal(parseModelOutput("just text", req).kind, "invalid");
});

test("parallel_tool_calls=false rejects multiple calls", () => {
  const one = normalizeTools({ tools: [weather], parallel_tool_calls: false });
  const r = parseModelOutput('<tool_calls>[{"name":"get_weather","arguments":{"city":"A"}},{"name":"get_weather","arguments":{"city":"B"}}]</tool_calls>', one);
  assert.equal(r.kind, "invalid");
});

test("prompt includes tools, assistant tool_calls and tool results", () => {
  const p = buildPrompt({ tools: t, messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Weather in Paris?" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_abc123", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
    { role: "tool", tool_call_id: "call_abc123", content: '{"temp":21}' }
  ] });
  assert.match(p, /\[FUNCTION CALLING\]/);
  assert.match(p, /\[TOOL RESULT id=call_abc123 function=get_weather\]/);
  assert.match(p, /<tool_calls>\n\[\{"id":"call_abc123"/);
  assert.ok(p.indexOf("[SYSTEM]") < p.indexOf("[USER]"));
});

test("schema validation and json helpers", () => {
  assert.deepEqual(validateSchema({ a: 1 }, { type: "object", properties: { a: { type: "integer" } }, required: ["a"] }), []);
  assert.equal(validateSchema({ a: 1.5 }, { type: "object", properties: { a: { type: "integer" } } }).length, 1);
  assert.deepEqual(extractJson('noise {"a":"}"} tail').value, { a: "}" });
  assert.equal(cleanJsonObject('```json\n{"x":1}\n```'), '{"x":1}');
  assert.equal(cleanJsonObject("[1]"), null);
});

test("history cap keeps the newest turns, never the orphan tool result, and always the last message", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "m" + i + " " + "x".repeat(70) }));
  assert.equal(trimConversation(msgs, {}).dropped, 0);
  const byCount = trimConversation(msgs, { maxMessages: 4 });
  assert.equal(byCount.convo.length, 4); assert.equal(byCount.convo.at(-1), msgs.at(-1));
  const byTokens = trimConversation(msgs, { maxTokens: 50 });
  assert.ok(byTokens.convo.length >= 1 && byTokens.convo.at(-1) === msgs.at(-1));
  const withTool = [{ role: "user", content: "a" }, { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c1", content: "r" }, { role: "user", content: "b" }];
  assert.deepEqual(trimConversation(withTool, { maxMessages: 2 }).convo.map(m => m.role), ["user"]);
  const p = buildPrompt({ messages: msgs, maxHistoryMessages: 2 });
  assert.match(p, /\[EARLIER MESSAGES OMITTED\]/); assert.ok(!p.includes("m0 "));
});

test("compact prompt keeps the function-calling contract and is shorter", () => {
  const args = { defs: t.defs, choice: t.choice, parallel: t.parallel };
  const full = buildToolsSection(args), small = buildToolsSection(args, { compact: true });
  for (const needle of ["get_weather", "<tool_calls>", "[TOOL RESULT]", "parameters:"]) assert.ok(small.includes(needle), needle);
  assert.ok(small.length < full.length);
  assert.match(buildPrompt({ tools: t, compact: true, messages: [{ role: "user", content: "hi" }] }), /\[ASSISTANT\]$/);
});
