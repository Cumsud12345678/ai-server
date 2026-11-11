// Admin: müştərinin dayandırılması (bütün sorğular 402 TENANT_SUSPENDED) və maliyyə hesabatı (pul girişi, xərc, mənfəət, model üzrə).
import "./helpers/legacy-balance.mjs";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock, demoTenant, tmpFile } from "../testkit/helpers.mjs";

let mock, base, server, tenantId, apiKey;
const TOKEN = "finance-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const call = (method, path, body, headers = H) => fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r) => ({ status: r.status, body: await r.json() });
const chat = async () => json(await call("POST", `/v1/service/tenants/${tenantId}/chat`, { message: "salam" }));
const finance = async () => (await json(await call("GET", "/v1/service/billing/finance?months=3"))).body;

before(async () => {
  mock = await startMock();
  process.env.SERVICE_TOKEN = TOKEN;
  process.env.TENANT_SECRET_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants-fin.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage-fin.json", "{}");
  process.env.BILLING_FILE = tmpFile("billing-fin.json", "{}");
  for (const k of ["BILLING_MARKUP", "USD_AZN_RATE", "BILLING_ENFORCE"]) delete process.env[k];
  process.env.BILLING_FREE_AZN = "0.1";
  const source = structuredClone(demoTenant(mock.url).source);
  source.auth = { type: "header", name: "X-Api-Key" };
  const config = { businessName: "Fin", domain: "fin.az", profile: { language: "az", maxResults: 5 }, source, apiSecret: "test-secret" };
  const { createApp } = await import("../src/app.js");
  const { onModelCost, newMeter } = await import("../src/billing/pricing.js");
  const { recordModelCost } = await import("../src/billing/billing.js");
  onModelCost((m, c, t) => recordModelCost(m, c, t));
  // Saxta model: real sayğacdan keçir ki, model üzrə xərc də yazılsın (100k giriş tokeni Haiku 5.5-də 0.01$)
  const fake = async () => {
    const meter = newMeter();
    meter.add("claude-haiku-5-5", { promptTokenCount: 100_000, candidatesTokenCount: 0, totalTokenCount: 100_000 });
    return { answer: "Tapdım!", listings: [], tokens: meter.tokens, costUsd: meter.costUsd };
  };
  server = await new Promise((res) => { const s = createApp({ adviseFn: fake }).listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
  const made = await json(await call("POST", "/v1/service/tenants", config));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  ({ tenantId, apiKey } = made.body);
});
after(async () => { (await import("../src/billing/pricing.js")).onModelCost(null); server.close(); mock.server.close(); });

test("dayandırılmış müştəri: portal söhbəti, açıq API və siyahı 402 TENANT_SUSPENDED; aktiv edəndə davam edir", async () => {
  assert.equal((await chat()).status, 200);
  const s = await json(await call("PATCH", `/v1/service/tenants/${tenantId}/suspend`, { suspended: true }));
  assert.equal(s.status, 200);
  const blocked = await chat();
  assert.equal(blocked.status, 402); assert.equal(blocked.body.code, "TENANT_SUSPENDED");
  const pub = await json(await fetch(`${base}/v1/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ message: "salam" }) }));
  assert.equal(pub.body.code, "TENANT_SUSPENDED");
  assert.equal((await json(await call("GET", `/v1/service/tenants/${tenantId}/listings`))).body.code, "TENANT_SUSPENDED");
  assert.equal((await json(await call("PATCH", `/v1/service/tenants/${tenantId}/suspend`, { suspended: "bəli" }))).status, 400);
  await call("PATCH", `/v1/service/tenants/${tenantId}/suspend`, { suspended: false });
  assert.equal((await chat()).status, 200);
});

test("maliyyə: pulsuz hissə gəlirə düşmür, ödəniş və əl ilə əlavə ayrılır, model üzrə xərc yazılır", async () => {
  // indiyədək 2 söhbət: hər biri 0.01$ × 1.7 = 0.017 AZN real xərc, ×1.5 = 0.0255 AZN müştəriyə — hamısı pulsuz hissədən (0.1 AZN)
  let f = await finance();
  const cur = f.months.at(-1);
  assert.equal(f.months.length, 3);
  assert.equal(cur.costAzn, 0.034);
  assert.equal(cur.billedAzn, 0.051);
  assert.equal(cur.freeAzn, 0.051, "pulsuz balansdan çıxılıb");
  assert.equal(cur.revenueAzn, 0);
  assert.equal(cur.profitAzn, -0.034, "pulsuz istifadə xərcdir");
  const m = f.models.find((x) => x.model === "claude-haiku-5-5");
  assert.ok(m && m.calls >= 2 && m.provider === "anthropic");

  // təsdiqlənmiş yükləmə sorğusu = ödəniş; admin əl ilə əlavəsi ayrıca; mənfi düzəliş
  const req = await json(await call("POST", `/v1/service/tenants/${tenantId}/billing/topup-request`, { amountAzn: 10 }));
  await call("POST", `/v1/service/billing/requests/${req.body.request.id}/approve`, { by: "admin@x.az" });
  await call("POST", `/v1/service/tenants/${tenantId}/billing/topup`, { amountAzn: 5, note: "hədiyyə" });
  await call("POST", `/v1/service/tenants/${tenantId}/billing/topup`, { amountAzn: -1, note: "düzəliş" });
  f = await finance();
  assert.deepEqual(f.months.at(-1).cashIn, { paidAzn: 10, manualAzn: 5, adjustAzn: -1, totalAzn: 14 });
  assert.equal(f.totals.cashInAzn, 14);
  assert.equal(f.totals.outstandingPaidAzn, 14, "hələ xərclənməyib");

  // pulsuz hissə bitəndən sonra xərc ödənişli balansdan: gəlir yaranır
  for (let i = 0; i < 8; i++) await chat();
  f = await finance();
  const after = f.months.at(-1);
  assert.equal(after.freeAzn, 0.1, "pulsuz hissə ayrılan məbləğdən çox ola bilməz");
  assert.ok(after.revenueAzn > 0 && after.profitAzn > -after.costAzn);
  assert.equal(f.tenants[0].tenantId, tenantId);
  assert.ok(f.totals.outstandingPaidAzn < 14);
});
