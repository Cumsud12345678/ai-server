import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock, demoTenant, tmpFile } from "../testkit/helpers.mjs";
import { analyzeTopics } from "../src/queries/insights.js";
import { questionSample, queryTrend, recordQuery } from "../src/queries/queries.js";

test("analyzeTopics: sayları kod hesablayır; təkrar və yanlış id-lər atılır, 'Digər' sonda", async () => {
  const items = [
    { text: "çatdırılma neçə günə", count: 5, unanswered: 0 },
    { text: "çatdırılma pulsuzdur?", count: 3, unanswered: 3 },
    { text: "qaytarma necə olur", count: 4, unanswered: 4 },
    { text: "salam", count: 2, unanswered: 0 },
  ];
  const json = JSON.stringify({ topics: [{ name: "Çatdırılma", ids: [0, 1, 99] }, { name: "Qaytarma", ids: [2, 1] }], gaps: [{ title: "Qaytarma qaydası", why: "Cavabsızdır", ids: [2] }, { title: "Boş", why: "", ids: [3] }] });
  const client = { models: { async generateContent() { return { text: "```json\n" + json + "\n```", usageMetadata: { totalTokenCount: 400, promptTokenCount: 350, candidatesTokenCount: 50 } }; } } };
  const r = await analyzeTopics({ items, client });
  assert.deepEqual(r.topics.map((t) => [t.name, t.count, t.unanswered]), [["Çatdırılma", 8, 3], ["Qaytarma", 4, 4], ["Digər", 2, 0]]);
  assert.deepEqual(r.gaps.map((g) => [g.title, g.count]), [["Qaytarma qaydası", 4]], "cavabsız olmayan boşluq çıxarılır");
  assert.equal(r.tokens, 400);
  await assert.rejects(analyzeTopics({ items, client: { models: { async generateContent() { return { text: "bu json deyil" }; } } } }));
});

test("queryTrend və questionSample: gündəlik say, təkrar suallar birləşir, cavabsız sayılır", async () => {
  const tenant = { tenantId: "tr-insights", profile: {} };
  for (const [m, results] of [["Çatdırılma var?", 3], ["çatdırılma var", 0], ["qaytarma", -2], ["qaytarma", 2]]) await recordQuery(tenant, { message: m, results });
  await recordQuery(tenant, { message: "xəta", error: true });
  const s = await questionSample("tr-insights", 30);
  assert.deepEqual(s.map((x) => [x.text, x.count, x.unanswered]).sort(), [["qaytarma", 2, 1], ["çatdırılma var", 2, 1]].sort());
  const t = await queryTrend("tr-insights", 7);
  assert.equal(t.length, 7);
  const last = t.at(-1);
  assert.equal(last.total, 5); assert.equal(last.unanswered, 2, "results=0 və -2 cavabsızdır, xəta yox");
  assert.equal(t[0].total, 0);
});

const TOKEN = "ins-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
let mock, base, server, tenantId, calls = 0;
const call = (method, path, body) => fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });

before(async () => {
  mock = await startMock();
  process.env.SERVICE_TOKEN = TOKEN;
  process.env.TENANT_SECRET_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}");
  process.env.BILLING_FILE = tmpFile("billing.json", "{}");
  const source = structuredClone(demoTenant(mock.url).source);
  source.auth = { type: "header", name: "X-Api-Key" };
  const { createApp } = await import("../src/app.js");
  const insightsFn = async ({ items }) => { calls++; return { topics: [{ name: "Hamısı", count: items.length, unanswered: 0, examples: [] }], gaps: [], tokens: 300, costUsd: 0.0005 }; };
  server = await new Promise((res) => { const s = createApp({ insightsFn }).listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
  const r = await call("POST", "/v1/service/tenants", { businessName: "Test Avto", domain: "test.az", profile: { language: "az", maxResults: 5 }, source, apiSecret: "test-secret" });
  tenantId = (await r.json()).tenantId;
});
after(() => { server.close(); mock.server.close(); });

test("/insights: az sual varsa AI çağırılmır; kifayət qədər varsa təhlil edilir, balansdan çıxılır, 6 saat keşlənir (ikinci dəfə pulsuz)", async () => {
  const few = await (await call("POST", `/v1/service/tenants/${tenantId}/insights`, { days: 30 })).json();
  assert.equal(few.tooFew, true); assert.equal(calls, 0);
  const tenant = { tenantId, profile: {} };
  for (let i = 0; i < 6; i++) await recordQuery(tenant, { message: `sual ${i}`, results: 1 });
  const b0 = (await (await call("GET", `/v1/service/tenants/${tenantId}/billing`)).json()).balance.totalAzn;
  const r1 = await (await call("POST", `/v1/service/tenants/${tenantId}/insights`, { days: 30 })).json();
  assert.equal(r1.cached, false); assert.equal(r1.asked, 6); assert.equal(calls, 1);
  const b1 = (await (await call("GET", `/v1/service/tenants/${tenantId}/billing`)).json()).balance.totalAzn;
  assert.ok(b1 < b0, "xərc yazılır");
  const r2 = await (await call("POST", `/v1/service/tenants/${tenantId}/insights`, { days: 30 })).json();
  assert.equal(r2.cached, true); assert.equal(calls, 1, "keşdən gəldi");
  const t = await (await call("GET", `/v1/service/tenants/${tenantId}/queries/trend?days=7`)).json();
  assert.equal(t.daily.length, 7);
  assert.equal((await fetch(`${base}/v1/service/tenants/${tenantId}/insights`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
});
