import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTools, parseModelOutput, buildPrompt, validateSchema, extractJson, cleanJsonObject } from "./tools.mjs";

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
