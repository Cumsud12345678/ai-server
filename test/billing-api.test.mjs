// Balansın HTTP səviyyəsində işləməsi: xərc balansdan çıxılır, bitəndə 402, yükləmə sorğuları, ödəniş webhook-u.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock, demoTenant, tmpFile } from "../testkit/helpers.mjs";

let mock, base, server, tenantId, apiKey, cost = 0.1;
const TOKEN = "billing-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const call = (method, path, body, headers = H) => fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r) => ({ status: r.status, body: await r.json() });
const bill = async () => (await json(await call("GET", `/v1/service/tenants/${tenantId}/billing`))).body;
const chat = async (message = "salam") => json(await call("POST", `/v1/service/tenants/${tenantId}/chat`, { message }));

before(async () => {
  mock = await startMock();
  process.env.SERVICE_TOKEN = TOKEN;
  process.env.TENANT_SECRET_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}");
  process.env.BILLING_FILE = tmpFile("billing.json", "{}");
  process.env.BILLING_MANUAL_INSTRUCTIONS = "Kartdan karta: 0000";
  const source = structuredClone(demoTenant(mock.url).source);
  source.auth = { type: "header", name: "X-Api-Key" };
  const config = { businessName: "Test", domain: "test.az", profile: { language: "az", maxResults: 5 }, source, apiSecret: "test-secret" };
  const { createApp } = await import("../src/app.js");
  const fake = async () => ({ answer: "Tapdım!", listings: [], tokens: 100, costUsd: cost });
  server = await new Promise((res) => { const s = createApp({ adviseFn: fake }).listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
  const made = await json(await call("POST", "/v1/service/tenants", config));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  ({ tenantId, apiKey } = made.body);
});
after(() => { server.close(); mock.server.close(); });

test("yeni müştərinin aylıq sorğu limiti yoxdur, balans 2 AZN pulsuzdur", async () => {
  const b = await bill();
  assert.equal(b.balance.freeAzn, 2); assert.equal(b.state, "ok");
  const usage = await json(await call("GET", `/v1/service/tenants/${tenantId}/usage`));
  assert.ok(!usage.body.limits?.monthlyRequests, "aylıq sorğu limiti qoyulmur");
});

test("söhbət: xərc balansdan çıxılır; billing yalnız portala göstərilir, açıq API-də yox", async () => {
  const r = await chat();
  assert.equal(r.status, 200);
  assert.equal(r.body.billing.state, "ok");
  assert.equal(r.body.billing.balanceAzn, 1.745); // 2 − 0.1$×1.7×1.5
  const pub = await json(await fetch(`${base}/v1/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ message: "salam" }) }));
  assert.equal(pub.status, 200);
  assert.equal(pub.body.billing, undefined, "müştərinin açıq API cavabında balans yoxdur");
  assert.ok((await bill()).spend.monthAzn >= 0.5, "açıq API sorğusu da balansdan çıxır");
});

test("balans bitəndə 402 BALANCE_EMPTY; AI-sız siyahı işləyir; yükləmə sorğusu → admin təsdiqi → davam", async () => {
  cost = 1; // 2.55 AZN
  const hit = await chat(); // balansı mənfiyə salır
  assert.equal(hit.body.billing.notify, "empty");
  const blocked = await chat();
  assert.equal(blocked.status, 402); assert.equal(blocked.body.code, "BALANCE_EMPTY");
  assert.equal((await json(await call("GET", `/v1/service/tenants/${tenantId}/listings`))).status, 200, "AI-sız siyahı pulsuzdur");

  const bad = await json(await call("POST", `/v1/service/tenants/${tenantId}/billing/topup-request`, { amountAzn: 3 }));
  assert.equal(bad.status, 400);
  const rq = await json(await call("POST", `/v1/service/tenants/${tenantId}/billing/topup-request`, { amountAzn: 10 }));
  assert.equal(rq.status, 201);
  assert.equal(rq.body.provider, "manual"); assert.equal(rq.body.instructions, "Kartdan karta: 0000"); assert.equal(rq.body.request.status, "pending");

  const pending = await json(await call("GET", "/v1/service/billing/requests?status=pending"));
  assert.ok(pending.body.requests.some((x) => x.id === rq.body.request.id && x.tenantId === tenantId));
  const ok = await json(await call("POST", `/v1/service/billing/requests/${rq.body.request.id}/approve`, { by: "admin@x.az" }));
  assert.equal(ok.status, 200);
  cost = 0.01;
  assert.equal((await chat()).status, 200, "yükləmədən sonra söhbət işləyir");
  assert.equal((await call("POST", `/v1/service/billing/requests/${rq.body.request.id}/approve`, {})).status, 200);
  const b = await bill();
  assert.ok(b.balance.paidAzn > 7 && b.balance.paidAzn <= 10, "təkrar təsdiq pul əlavə etmədi");
  assert.equal(b.pendingRequests.length, 0);
});

test("admin: əl ilə yükləmə, vuruq/kredit limiti, bütün balanslar; müştəri xülasəsində vuruq görünmür", async () => {
  const t = await json(await call("POST", `/v1/service/tenants/${tenantId}/billing/topup`, { amountAzn: 5, note: "köçürmə", by: "admin" }));
  assert.equal(t.status, 200);
  const s = await json(await call("PATCH", `/v1/service/tenants/${tenantId}/billing/settings`, { markup: 2, creditLimitAzn: 3 }));
  assert.equal(s.body.admin.markup, 2); assert.equal(s.body.admin.creditLimitAzn, 3);
  assert.equal((await json(await call("PATCH", `/v1/service/tenants/${tenantId}/billing/settings`, { markup: 0.2 }))).status, 400);
  assert.equal((await bill()).admin, undefined);
  assert.equal((await json(await call("GET", `/v1/service/tenants/${tenantId}/billing?admin=1`))).body.admin.markup, 2);
  const all = await json(await call("GET", "/v1/service/billing/accounts"));
  assert.ok(all.body.accounts.some((a) => a.tenantId === tenantId && a.paidAzn > 0));
  assert.equal((await call("GET", "/v1/service/billing/accounts", undefined, { "content-type": "application/json" })).status, 401);
});

test("ödəniş webhook-u: təkrar xəbər pul əlavə etmir, etibarsız imza 400, naməlum provayder 404", async () => {
  const { registerProvider } = await import("../src/billing/providers.js");
  registerProvider({
    name: "fakepay",
    handleWebhook: async (req) => (req.get("x-sign") === "ok" ? { ref: req.body.id, tenantId: req.body.tenantId, amountAzn: req.body.amount } : null),
  });
  const before = (await bill()).balance.paidAzn;
  const hook = (id, sign = "ok") => call("POST", "/v1/billing/webhook/fakepay", { id, tenantId, amount: 10 }, { "content-type": "application/json", "x-sign": sign });
  assert.equal((await hook("p1")).status, 200);
  assert.equal((await json(await hook("p1"))).body.duplicate, true);
  assert.equal(((await bill()).balance.paidAzn - before).toFixed(2), "10.00");
  assert.equal((await hook("p2", "yanlis")).status, 400);
  assert.equal((await call("POST", "/v1/billing/webhook/yoxdur", {}, { "content-type": "application/json" })).status, 404);
});

test("müştəri silinəndə balans və jurnal da silinir", async () => {
  assert.equal((await call("DELETE", `/v1/service/tenants/${tenantId}`)).status, 200);
  assert.equal((await call("GET", `/v1/service/tenants/${tenantId}/billing`)).status, 404);
  const all = await json(await call("GET", "/v1/service/billing/accounts"));
  assert.ok(!all.body.accounts.some((a) => a.tenantId === tenantId));
});
