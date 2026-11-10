// Hibrid müştəri: Gemini formatındakı sorğunun Claude-a düzgün çevrilməsi, alət dövrü, xərc hesabı və Gemini-yə ehtiyat keçid.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Type } from "@google/genai";
import { toJsonSchema, toClaudeMessages, fromClaudeResponse, buildClaudeRequest, hybridClient, chatModels } from "../src/ai/llm.js";
import { callCostUsd } from "../src/billing/pricing.js";

test("Gemini sxemi JSON Schema-ya çevrilir", () => {
  const s = toJsonSchema({ type: Type.OBJECT, properties: { tags: { type: Type.ARRAY, items: { type: Type.STRING, enum: ["a", "b"] } }, n: { type: Type.NUMBER } }, required: ["n"] });
  assert.deepEqual(s, { type: "object", properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b"] } }, n: { type: "number" } }, required: ["n"] });
});

test("contents → messages: rollar, alət id-ləri, ardıcıl rolların birləşməsi", () => {
  const claudeTurn = fromClaudeResponse({ content: [{ type: "tool_use", id: "tu_1", name: "search_listings", input: { make: "Honda" } }], usage: { input_tokens: 10, output_tokens: 5 } });
  const msgs = toClaudeMessages([
    { role: "model", parts: [{ text: "əvvəlki cavab (atılır: user ilə başlamalıdır)" }] },
    { role: "user", parts: [{ text: "salam" }] },
    { role: "user", parts: [{ text: "Honda var?" }] },
    claudeTurn.candidates[0].content,
    { role: "user", parts: [{ functionResponse: { name: "search_listings", response: { result: { count: 2 } } } }] },
  ]);
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[0].content.length, 2, "iki user mesajı birləşdi");
  assert.equal(msgs[1].content[0].id, "tu_1");
  assert.deepEqual(msgs[2].content[0], { type: "tool_result", tool_use_id: "tu_1", content: '{"count":2}' });
});

test("sorğu gövdəsi: sistem, alətlər, max_tokens, düşünmə söndürülüb", () => {
  delete process.env.CLAUDE_THINKING; delete process.env.CLAUDE_PROMPT_CACHE; delete process.env.MAX_OUTPUT_TOKENS;
  const b = buildClaudeRequest({ model: "claude-haiku-5-5", contents: [{ role: "user", parts: [{ text: "x" }] }], config: { systemInstruction: "SYS", tools: [{ functionDeclarations: [{ name: "t", description: "d", parameters: { type: Type.OBJECT, properties: {} } }] }] } });
  assert.equal(b.system, "SYS"); assert.equal(b.max_tokens, 4096); assert.deepEqual(b.thinking, { type: "disabled" });
  assert.equal(b.tools[0].input_schema.type, "object");
  process.env.CLAUDE_PROMPT_CACHE = "1";
  const c = buildClaudeRequest({ model: "claude-haiku-5-5", contents: [{ role: "user", parts: [{ text: "x" }] }], config: { systemInstruction: "SYS" } });
  assert.deepEqual(c.system[0].cache_control, { type: "ephemeral" });
  delete process.env.CLAUDE_PROMPT_CACHE;
});

test("Haiku 5.5 xərci: 100k həddi, keş oxuma və yazma", () => {
  const small = fromClaudeResponse({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 4000, output_tokens: 300 } }).usageMetadata;
  assert.ok(Math.abs(callCostUsd("claude-haiku-5-5", small) - (4000 * 0.1 + 300 * 0.5) / 1e6) < 1e-12);
  const big = fromClaudeResponse({ content: [], usage: { input_tokens: 100_001, output_tokens: 1000 } }).usageMetadata;
  assert.ok(Math.abs(callCostUsd("claude-haiku-5-5", big) - (100_001 * 0.5 + 1000 * 2.5) / 1e6) < 1e-12, "100k-dan çox: hamısı yüksək qiymətlə");
  const cached = fromClaudeResponse({ content: [], usage: { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 1000, output_tokens: 0 } }).usageMetadata;
  assert.ok(Math.abs(callCostUsd("claude-haiku-5-5", cached) - (100 * 0.1 + 2000 * 0.01 + 1000 * 0.125) / 1e6) < 1e-12);
  assert.ok(Math.abs(callCostUsd("gemini-3.5-flash-lite", { promptTokenCount: 4000, candidatesTokenCount: 300 }) - (4000 * 0.3 + 300 * 2.5) / 1e6) < 1e-12);
});

test("defolt model sırası: Haiku əsas, Gemini Flash-Lite ehtiyat", () => {
  delete process.env.AI_MODELS; delete process.env.GEMINI_MODELS;
  assert.deepEqual(chatModels(), ["claude-haiku-5-5", "gemini-3.5-flash-lite"]);
});

function fakeAnthropic(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => { const j = JSON.parse(body); seen.push({ headers: req.headers, body: j }); const [code, out] = handler(j, seen.length); res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(out)); });
    }).listen(0, () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test("Claude ilə tam alət dövrü (advise) və açar başlığı", async () => {
  const { srv, seen, url } = await fakeAnthropic((body, n) => n === 1
    ? [200, { content: [{ type: "tool_use", id: "tu_9", name: "search_listings", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 20 } }]
    : [200, { content: [{ type: "text", text: "2 elan tapdım." }], stop_reason: "end_turn", usage: { input_tokens: 1200, output_tokens: 30 } }]);
  process.env.ANTHROPIC_BASE_URL = url; process.env.ANTHROPIC_API_KEY = "test-key"; process.env.AI_MODELS = "claude-haiku-5-5";
  try {
    const { advise } = await import("../src/ai/advisor.js");
    const repo = { schema: undefined, search: async () => ({ items: [{ id: "1", title: "Honda" }], total: 1 }), vocabulary: async () => ({}) };
    const client = hybridClient(() => { throw new Error("Gemini çağırılmamalı idi"); });
    const r = await advise({ tenant: { tenantId: "t1", profile: {}, language: "az" }, repo, message: "Honda", history: [] }, client);
    assert.equal(r.answer, "2 elan tapdım.");
    assert.equal(seen[0].headers["x-api-key"], "test-key");
    assert.equal(seen[1].body.messages.at(-1).content[0].tool_use_id, "tu_9");
    assert.ok(Math.abs(r.costUsd - ((2200 * 0.1 + 50 * 0.5) / 1e6)) < 1e-12);
  } finally { srv.close(); delete process.env.ANTHROPIC_BASE_URL; delete process.env.ANTHROPIC_API_KEY; delete process.env.AI_MODELS; }
});

test("Claude yüklüdürsə (529) və ya açar yoxdursa Gemini-yə keçir", async () => {
  const { srv, url } = await fakeAnthropic(() => [529, { error: { message: "Overloaded" } }]);
  process.env.ANTHROPIC_BASE_URL = url; process.env.ANTHROPIC_API_KEY = "k";
  try {
    const gemini = { models: { generateContent: async ({ model }) => ({ text: `gemini:${model}`, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } }) } };
    const client = hybridClient(() => gemini);
    await assert.rejects(client.models.generateContent({ model: "claude-haiku-5-5", contents: [{ role: "user", parts: [{ text: "x" }] }] }), (e) => e.status === 503);
    delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(client.models.generateContent({ model: "claude-haiku-5-5", contents: [{ role: "user", parts: [{ text: "x" }] }] }), (e) => e.status === 404);
    assert.equal((await client.models.generateContent({ model: "gemini-3.5-flash-lite", contents: [] })).text, "gemini:gemini-3.5-flash-lite");
  } finally { srv.close(); delete process.env.ANTHROPIC_BASE_URL; delete process.env.ANTHROPIC_API_KEY; }
});

test("provayder hesabı: Claude balansı bitəndə (400) Gemini-yə keçir və problem qeydə alınır; Gemini billing xətası da ötürülür; uğur təmizləyir", async () => {
  const { providerIssues, _resetProviderIssues, classify } = await import("../src/ai/provider-status.js");
  _resetProviderIssues();
  const { srv, url } = await fakeAnthropic(() => [400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } }]);
  process.env.ANTHROPIC_BASE_URL = url; process.env.ANTHROPIC_API_KEY = "k";
  try {
    let geminiFail = null;
    const gemini = { models: { generateContent: async () => { if (geminiFail) throw geminiFail; return { text: "ok" }; } } };
    const client = hybridClient(() => gemini);
    await assert.rejects(client.models.generateContent({ model: "claude-haiku-5-5", contents: [{ role: "user", parts: [{ text: "x" }] }] }), (e) => e.status === 404, "növbəti modelə keçsin");
    assert.equal(providerIssues().claude.kind, "balance");
    geminiFail = Object.assign(new Error("[403] Billing account for project is disabled"), { status: 403 });
    await assert.rejects(client.models.generateContent({ model: "gemini-3.5-flash-lite", contents: [] }), (e) => e.status === 404);
    assert.equal(providerIssues().gemini.kind, "balance");
    geminiFail = null;
    await client.models.generateContent({ model: "gemini-3.5-flash-lite", contents: [] });
    assert.equal(providerIssues().gemini, undefined, "uğurlu sorğu təmizləyir");
    // tək-tük 429 xəbərdarlıq deyil, 5+ dəfə təkrar olanda görünür
    for (let i = 0; i < 4; i++) { geminiFail = Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 }); await client.models.generateContent({ model: "gemini-3.5-flash-lite", contents: [] }).catch(() => {}); }
    assert.equal(providerIssues().gemini, undefined);
    await client.models.generateContent({ model: "gemini-3.5-flash-lite", contents: [] }).catch(() => {});
    assert.equal(providerIssues().gemini.kind, "quota");
    assert.equal(classify("claude", { status: 400, message: "messages: field required" }), null, "adi 400 hesab problemi deyil");
  } finally { srv.close(); delete process.env.ANTHROPIC_BASE_URL; delete process.env.ANTHROPIC_API_KEY; _resetProviderIssues(); }
});
