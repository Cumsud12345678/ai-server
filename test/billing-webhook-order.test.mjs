// Ödəniş webhook-u sorğuya (requestId) bağlı olanda pul yalnız BİR dəfə yazılmalıdır.
// Əvvəlki xəta: topup ("pay:" ref) + resolveRequest (yenidən topup, "req:" ref) → 10 AZN ödəniş 20 AZN yazırdı.
// Həmçinin: portal noTrial göndərəndə (təkrar qeydiyyat) pulsuz sınaq və pulsuz məbləğ verilmir.
import "./helpers/legacy-balance.mjs";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock, demoTenant, tmpFile } from "../testkit/helpers.mjs";

let mock, base, server, tenantId, config;
const TOKEN = "webhook-order-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const call = (method, path, body) => fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const bill = async (id = tenantId) => (await (await call("GET", `/v1/service/tenants/${id}/billing`)).json());
const hook = (body) => fetch(`${base}/v1/billing/webhook/fakepay2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

before(async () => {
  mock = await startMock();
  process.env.SERVICE_TOKEN = TOKEN;
  process.env.TENANT_SECRET_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}");
  process.env.BILLING_FILE = tmpFile("billing.json", "{}");
  const source = structuredClone(demoTenant(mock.url).source);
  source.auth = { type: "header", name: "X-Api-Key" };
  config = { businessName: "Test", domain: "test.az", profile: { language: "az" }, source, apiSecret: "test-secret" };
  const { createApp } = await import("../src/app.js");
  const { registerProvider } = await import("../src/billing/providers.js");
  registerProvider({ name: "fakepay2", handleWebhook: async (req) => ({ ref: req.body.id, tenantId: req.body.tenantId, amountAzn: req.body.amount, requestId: req.body.requestId }) });
  server = await new Promise((res) => { const s = createApp({ adviseFn: async () => ({ answer: "x", listings: [], tokens: 1, costUsd: 0 }) }).listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
  const made = await (await call("POST", "/v1/service/tenants", config)).json();
  tenantId = made.tenantId;
  assert.equal(made.trial, true);
});
after(() => { server.close(); mock.server.close(); });

test("sorğuya bağlı yükləmə: 10 AZN ödəniş balansa düz 10 AZN yazır, təkrar xəbər əlavə etmir", async () => {
  const before = (await bill()).balance.paidAzn;
  const { request } = await (await call("POST", `/v1/service/tenants/${tenantId}/billing/topup-request`, { amountAzn: 10 })).json();
  const first = await (await hook({ id: "w1", tenantId, amount: 10, requestId: request.id })).json();
  assert.equal(first.duplicate, false);
  const again = await (await hook({ id: "w1", tenantId, amount: 10, requestId: request.id })).json();
  assert.equal(again.duplicate, true);
  assert.equal(((await bill()).balance.paidAzn - before).toFixed(2), "10.00");
  const reqs = await (await call("GET", "/v1/service/billing/requests?status=approved")).json();
  assert.ok(reqs.requests.some((r) => r.id === request.id), "sorğu təsdiqlənmiş kimi qeyd olunur");
});

test("məbləğ və ya müştəri sorğuya uyğun gəlmirsə 400, pul yazılmır", async () => {
  const before = (await bill()).balance.paidAzn;
  const { request } = await (await call("POST", `/v1/service/tenants/${tenantId}/billing/topup-request`, { amountAzn: 10 })).json();
  assert.equal((await hook({ id: "w2", tenantId, amount: 5, requestId: request.id })).status, 400);
  assert.equal((await hook({ id: "w3", tenantId: "tenant-basqa", amount: 10, requestId: request.id })).status, 400);
  assert.equal((await bill()).balance.paidAzn, before);
});

test("rədd edilmiş sorğuya ödəniş gəlsə pul itmir, bir dəfə balansa yazılır", async () => {
  const before = (await bill()).balance.paidAzn;
  const { request } = await (await call("POST", `/v1/service/tenants/${tenantId}/billing/topup-request`, { amountAzn: 10 })).json();
  assert.equal((await call("POST", `/v1/service/billing/requests/${request.id}/reject`, { by: "admin" })).status, 200);
  await hook({ id: "w4", tenantId, amount: 10, requestId: request.id });
  await hook({ id: "w4", tenantId, amount: 10, requestId: request.id });
  assert.equal(((await bill()).balance.paidAzn - before).toFixed(2), "10.00");
});

test("noTrial: təkrar qeydiyyatda pulsuz sınaq və pulsuz məbləğ verilmir", async () => {
  const fresh = await bill();
  assert.ok(fresh.balance.freeAzn > 0, "adi yeni müştəri pulsuz məbləğ alır");
  const made = await (await call("POST", "/v1/service/tenants", { ...config, noTrial: true })).json();
  assert.equal(made.trial, false);
  const b = await bill(made.tenantId);
  assert.equal(b.balance.freeAzn, 0);
  assert.equal(b.balance.totalAzn, 0);
});
