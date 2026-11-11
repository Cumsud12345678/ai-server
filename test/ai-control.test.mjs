// Admin: ümumi AI açarı, müştəri başına gündəlik xərc limiti, Ödənişlər səhifəsi üçün sorğu və balans hərəkətləri siyahısı.
import { legacyBalanceEnv } from "./helpers/legacy-balance.mjs";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock, demoTenant, tmpFile } from "../testkit/helpers.mjs";

let mock, base, server, tenantId, apiKey;
const TOKEN = "aictl-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const call = (method, path, body) => fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r) => ({ status: r.status, body: await r.json() });
const chat = async () => json(await call("POST", `/v1/service/tenants/${tenantId}/chat`, { message: "salam" }));

before(async () => {
  mock = await startMock();
  process.env.SERVICE_TOKEN = TOKEN;
  process.env.TENANT_SECRET_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants-ctl.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage-ctl.json", "{}");
  process.env.BILLING_FILE = tmpFile("billing-ctl.json", "{}");
  for (const k of ["BILLING_MARKUP", "USD_AZN_RATE", "BILLING_ENFORCE", "BILLING_FREE_AZN", "BILLING_DAILY_LIMIT_AZN"]) delete process.env[k];
  legacyBalanceEnv();
  const source = structuredClone(demoTenant(mock.url).source);
  source.auth = { type: "header", name: "X-Api-Key" };
  const config = { businessName: "Ctl", domain: "ctl.az", profile: { language: "az", maxResults: 5 }, source, apiSecret: "test-secret" };
  const { createApp } = await import("../src/app.js");
  const fake = async () => ({ answer: "Tapdım!", listings: [], tokens: 10, costUsd: 0.1 }); // 0.1$ × 1.7 × 1.5 = 0.255 AZN
  server = await new Promise((res) => { const s = createApp({ adviseFn: fake }).listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
  const made = await json(await call("POST", "/v1/service/tenants", config));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  ({ tenantId, apiKey } = made.body);
});
after(() => { server.close(); mock.server.close(); });

test("ümumi AI açarı: dayandırılanda bütün söhbətlər 402 AI_PAUSED, səbəb saxlanır; açılanda davam edir", async () => {
  assert.deepEqual((await json(await call("GET", "/v1/service/ai-control"))).body, { paused: false });
  assert.equal((await json(await call("PUT", "/v1/service/ai-control", { paused: "hə" }))).status, 400);
  const on = await json(await call("PUT", "/v1/service/ai-control", { paused: true, reason: "Anthropic xərci qəfil artıb", by: "boss@x.az" }));
  assert.equal(on.body.paused, true); assert.equal(on.body.by, "boss@x.az");
  const r = await chat();
  assert.equal(r.status, 402); assert.equal(r.body.code, "AI_PAUSED");
  const pub = await json(await fetch(`${base}/v1/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ message: "salam" }) }));
  assert.equal(pub.body.code, "AI_PAUSED", "açıq API də dayanır");
  assert.equal((await json(await call("GET", "/v1/service/ai-control"))).body.reason, "Anthropic xərci qəfil artıb");
  await call("PUT", "/v1/service/ai-control", { paused: false });
  assert.equal((await chat()).status, 200);
});

test("gündəlik limit: müştəriyə ayrıca təyin olunur; aşanda 402 DAILY_LIMIT; 0 = limitsiz; null = ümumi qayda", async () => {
  const s = await json(await call("PATCH", `/v1/service/tenants/${tenantId}/billing/settings`, { dailyLimitAzn: 0.5 }));
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.admin.dailyLimitAzn, 0.5);
  // əvvəlki testdə 1 söhbət oldu (0.255): bir dənə də keçir (0.51), sonra dayanır
  assert.equal((await chat()).status, 200);
  const blocked = await chat();
  assert.equal(blocked.status, 402); assert.equal(blocked.body.code, "DAILY_LIMIT");
  const b = (await json(await call("GET", `/v1/service/tenants/${tenantId}/billing?admin=1`))).body;
  assert.ok(b.admin.todayAzn >= 0.5);
  assert.equal((await json(await call("PATCH", `/v1/service/tenants/${tenantId}/billing/settings`, { dailyLimitAzn: -1 }))).status, 400);
  await call("PATCH", `/v1/service/tenants/${tenantId}/billing/settings`, { dailyLimitAzn: 0 });
  assert.equal((await chat()).status, 200, "0 = limit yoxdur");
  process.env.BILLING_DAILY_LIMIT_AZN = "0.1";
  const def = await json(await call("PATCH", `/v1/service/tenants/${tenantId}/billing/settings`, { dailyLimitAzn: null }));
  assert.equal(def.body.admin.dailyLimitAzn, null); assert.equal(def.body.admin.defaultDailyLimitAzn, 0.1);
  assert.equal((await chat()).body.code, "DAILY_LIMIT", "ümumi qayda tətbiq olunur");
  delete process.env.BILLING_DAILY_LIMIT_AZN;
});

test("ödənişlər: sorğular status və tarixə görə süzülür, balans hərəkətləri növünə görə, səhifələmə işləyir", async () => {
  const ids = [];
  for (const amt of [10, 20, 30]) ids.push((await json(await call("POST", `/v1/service/tenants/${tenantId}/billing/topup-request`, { amountAzn: amt }))).body.request.id);
  // gözləyən sorğu limiti 3-dür: birini təsdiq, birini rədd edirik
  await call("POST", `/v1/service/billing/requests/${ids[0]}/approve`, { by: "boss@x.az" });
  await call("POST", `/v1/service/billing/requests/${ids[1]}/reject`, { by: "boss@x.az" });
  await call("POST", `/v1/service/tenants/${tenantId}/billing/topup`, { amountAzn: 5, note: "hədiyyə", by: "boss@x.az" });
  await call("POST", `/v1/service/tenants/${tenantId}/billing/topup`, { amountAzn: -2, note: "qaytarma", by: "boss@x.az" });

  const all = (await json(await call("GET", "/v1/service/billing/requests?status=all&limit=10"))).body;
  assert.equal(all.requests.length, 3);
  const approved = all.requests.find((r) => r.id === ids[0]);
  assert.equal(approved.status, "approved"); assert.equal(approved.resolvedBy, "boss@x.az");
  assert.equal((await json(await call("GET", "/v1/service/billing/requests?status=rejected&limit=10"))).body.requests.length, 1);
  assert.equal((await json(await call("GET", "/v1/service/billing/requests?status=pending"))).body.requests.length, 1, "köhnə çağırış dəyişməyib");
  const future = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal((await json(await call("GET", `/v1/service/billing/requests?status=all&since=${future}`))).body.requests.length, 0);

  const page1 = (await json(await call("GET", "/v1/service/billing/ledger?limit=2"))).body;
  assert.equal(page1.entries.length, 2);
  assert.ok(page1.nextBefore);
  const page2 = (await json(await call("GET", `/v1/service/billing/ledger?limit=2&before=${encodeURIComponent(page1.nextBefore)}`))).body;
  assert.ok(page2.entries.length >= 1);
  const kinds = new Set([...page1.entries, ...page2.entries].map((e) => e.kind));
  assert.deepEqual([...kinds].sort(), ["adjust", "manual", "payment"]);
  const manual = (await json(await call("GET", "/v1/service/billing/ledger?kind=manual"))).body.entries;
  assert.equal(manual.length, 1); assert.equal(manual[0].note, "hədiyyə"); assert.equal(manual[0].by, "boss@x.az");
  assert.equal((await json(await call("GET", `/v1/service/billing/ledger?tenantId=yoxdur`))).body.entries.length, 0);
});
