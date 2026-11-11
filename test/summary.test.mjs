// Söhbət xülasəsi: model JSON-u yoxlanır, endpoint balansdan çıxır, səhv giriş 400, model xətası 502.
import "./helpers/legacy-balance.mjs";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock, demoTenant, tmpFile } from "../testkit/helpers.mjs";

let mock, base, server, tenantId, fail = false, parseSummary, summarizeChat;
const H = { "content-type": "application/json", authorization: "Bearer sum-token" };
const call = (method, path, body) => fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const good = { summary: "Müştəri qırmızı ayaqqabı istəyir, ölçü 38.", intent: "Sifariş vermək", mood: "positive", objections: ["Çatdırılma bahadır"], nextStep: "Pulsuz çatdırılma təklif et", temperature: "hot" };

before(async () => {
  mock = await startMock();
  Object.assign(process.env, { SERVICE_TOKEN: "sum-token", TENANT_SECRET_ENCRYPTION_KEY: "cd".repeat(32) });
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}"); process.env.BILLING_FILE = tmpFile("billing.json", "{}");
  const source = structuredClone(demoTenant(mock.url).source); source.auth = { type: "header", name: "X-Api-Key" };
  ({ parseSummary, summarizeChat } = await import("../src/kb/summary.js")); // mühit dəyişənlərindən SONRA yüklənməlidir
  const { createApp } = await import("../src/app.js");
  const summaryFn = async () => { if (fail) throw Object.assign(new Error("boom"), { status: 500 }); return { summary: good, tokens: 300, costUsd: 0.05 }; };
  server = await new Promise((r) => { const s = createApp({ adviseFn: async () => ({ answer: "x", listings: [], tokens: 1, costUsd: 0 }), summaryFn }).listen(0, () => r(s)); });
  base = `http://localhost:${server.address().port}`;
  tenantId = (await (await call("POST", "/v1/service/tenants", { businessName: "T", domain: "t.az", source, apiSecret: "test-secret" })).json()).tenantId;
});
after(() => { server.close(); mock.server.close(); });

test("parseSummary: ```json``` bloku, tanınmayan dəyərlər və uzun mətnlər təmizlənir", () => {
  const s = parseSummary("```json\n" + JSON.stringify({ ...good, mood: "angry", temperature: "boiling", objections: ["a", "b", "c", "d"], summary: "x".repeat(900) }) + "\n```");
  assert.equal(s.mood, "neutral");
  assert.equal(s.temperature, "warm");
  assert.equal(s.objections.length, 3);
  assert.equal(s.summary.length, 400);
  assert.equal(parseSummary("bu json deyil"), null);
  assert.equal(parseSummary(JSON.stringify({ intent: "x" })), null, "summary boşdursa etibarsızdır");
});

test("summarizeChat: model JSON qaytarmasa növbəti modelə keçir, sistem təlimatında dil var", async () => {
  process.env.AI_MODELS = "m1,m2";
  const seen = [];
  const client = { models: { generateContent: async ({ model, config }) => {
    seen.push(model);
    assert.match(config.systemInstruction, /Azərbaycan dili/);
    assert.equal(config.responseMimeType, "application/json");
    return { text: model === "m1" ? "salam" : JSON.stringify(good), usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } };
  } } };
  const r = await summarizeChat({ tenant: { tenantId: "t", profile: { language: "az" } }, messages: [{ from: "visitor", text: "38 ölçü var?" }, { from: "operator", text: "Bəli" }] }, client);
  delete process.env.AI_MODELS;
  assert.deepEqual(seen, ["m1", "m2"]);
  assert.equal(r.summary.intent, "Sifariş vermək");
  assert.equal(r.tokens, 240, "uğursuz cəhdin tokenləri də sayılır");
});

test("endpoint: xülasə qaytarır və xərci balansdan çıxır", async () => {
  const before = (await (await call("GET", `/v1/service/tenants/${tenantId}/billing`)).json()).spend.monthAzn;
  const r = await call("POST", `/v1/service/tenants/${tenantId}/summary`, { messages: [{ from: "visitor", text: "salam" }, { from: "ai", text: "Salam!" }] });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).summary, good);
  const after = (await (await call("GET", `/v1/service/tenants/${tenantId}/billing`)).json()).spend.monthAzn;
  assert.ok(after > before, "xərc yazılır");
});

test("endpoint: səhv giriş 400, model xətası 502", async () => {
  assert.equal((await call("POST", `/v1/service/tenants/${tenantId}/summary`, { messages: [] })).status, 400);
  assert.equal((await call("POST", `/v1/service/tenants/${tenantId}/summary`, { messages: [{ from: "hacker", text: "x" }] })).status, 400);
  fail = true;
  assert.equal((await call("POST", `/v1/service/tenants/${tenantId}/summary`, { messages: [{ from: "visitor", text: "x" }] })).status, 502);
  fail = false;
});
