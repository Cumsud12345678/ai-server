import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startMock, demoTenant, tmpFile } from "../testkit/helpers.mjs";

let mock, base, server, config, tenantFile;
const TOKEN = "service-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const call = (method, path, body, headers = H) => fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r) => ({ status: r.status, body: await r.json() });

before(async () => {
  mock = await startMock();
  tenantFile = tmpFile("customer-tenants.json", "[]");
  process.env.SERVICE_TOKEN = TOKEN;
  process.env.TENANT_SECRET_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.CUSTOMER_TENANTS_FILE = tenantFile;
  process.env.USAGE_FILE = tmpFile("usage.json", "{}");
  process.env.BILLING_FILE = tmpFile("billing.json", "{}");

  const source = structuredClone(demoTenant(mock.url).source);
  source.auth = { type: "header", name: "X-Api-Key" };
  config = { businessName: "Test Avto", domain: "test.az", profile: { language: "az", maxResults: 5 }, source, apiSecret: "test-secret" };

  const { createApp } = await import("../src/app.js");
  const fake = async () => ({ answer: "Tapdım!", listings: [], tokens: 42 });
  server = await new Promise((res) => { const s = createApp({ adviseFn: fake }).listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); mock.server.close(); });

test("servis tokeni olmadan və ya yanlış tokenlə 401", async () => {
  assert.equal((await call("POST", "/v1/service/tenants", config, { "content-type": "application/json" })).status, 401);
  assert.equal((await call("POST", "/v1/service/tenants", config, { ...H, authorization: "Bearer yanlis" })).status, 401);
  assert.equal((await call("POST", "/v1/onboarding", config)).status, 404, "köhnə public onboarding endpoint-i yoxdur");
});

test("config/test: real sorğu göndərir, nümunə elanları qaytarır", async () => {
  const { status, body } = await json(await call("POST", "/v1/service/config/test", config));
  assert.equal(status, 200);
  assert.ok(body.ok && body.sampleCount > 0 && body.sampleListings[0].title);
});

test("yanlış konfiqurasiya: 400 (valueEnv qadağan) və 422 (xəritələmə səhvdir), müştəri yaranmır", async () => {
  const withEnv = structuredClone(config);
  withEnv.source.auth.valueEnv = "GEMINI_API_KEY";
  assert.equal((await call("POST", "/v1/service/tenants", withEnv)).status, 400);

  const broken = structuredClone(config);
  broken.source.response.fields.title = "olmayan.yol";
  const r = await json(await call("POST", "/v1/service/tenants", broken));
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "MAPPING_FAILED");
  assert.equal(JSON.parse(readFileSync(tenantFile, "utf8")).length, 0);
});

let tenantId, apiKey;
test("aktivləşdirmə: açar qaytarılır, sirr şifrələnir, açar işləyir", async () => {
  const { status, body } = await json(await call("POST", "/v1/service/tenants", config));
  assert.equal(status, 201);
  ({ tenantId, apiKey } = body);
  assert.match(apiKey, /^ca_live_[a-f0-9]{64}$/);
  const raw = readFileSync(tenantFile, "utf8");
  assert.ok(!raw.includes("test-secret") && !raw.includes(apiKey), "açıq sirr və açar fayla yazılmır");
  assert.ok(raw.includes("encryptedValue"));
  const u = await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${apiKey}` } });
  assert.equal(u.status, 200);
});

test("servis vasitəsilə söhbət, siyahı və istifadə (açarsız)", async () => {
  const chat = await json(await call("POST", `/v1/service/tenants/${tenantId}/chat`, { message: "salam" }));
  assert.equal(chat.body.answer, "Tapdım!");
  const list = await json(await call("GET", `/v1/service/tenants/${tenantId}/listings`));
  assert.ok(list.body.count >= 1 && list.body.count <= 5);
  const usage = await json(await call("GET", `/v1/service/tenants/${tenantId}/usage`));
  assert.equal(usage.body.requests, 1);
  assert.equal(usage.body.tokens, 42);
  assert.equal(usage.body.daily.length, 14);
  assert.equal(usage.body.daily.at(-1).requests, 1, "bu günün sorğusu günlük siyahıda görünür");
});

test("dev tenant və ya olmayan müştəri servis endpoint-lərində 404", async () => {
  assert.equal((await call("GET", "/v1/service/tenants/demo-musteri/usage")).status, 404);
  assert.equal((await call("GET", "/v1/service/tenants/yoxdur/usage")).status, 404);
});

test("config yeniləmə: sirr yenidən göndərilmədən saxlanır, cache təmizlənir; səhv config köhnəni pozmur", async () => {
  const next = structuredClone(config);
  delete next.apiSecret;
  next.source.response.fields.title = "{brand.title}";
  next.profile = { maxResults: 2 };
  const ok = await json(await call("PUT", `/v1/service/tenants/${tenantId}/config`, next));
  assert.equal(ok.status, 200);
  const list = await json(await call("GET", `/v1/service/tenants/${tenantId}/listings`));
  assert.ok(list.body.count >= 1 && list.body.count <= 2, "yeni maxResults tətbiq olundu");
  assert.ok(list.body.listings.every((l) => !l.title.includes(" ")), "yeni xəritələmə tətbiq olundu");

  const bad = structuredClone(next);
  bad.source.response.fields.title = "olmayan.yol";
  assert.equal((await call("PUT", `/v1/service/tenants/${tenantId}/config`, bad)).status, 422);
  const still = await json(await call("GET", `/v1/service/tenants/${tenantId}/listings`));
  assert.equal(still.body.count, list.body.count);
});

test("profil yeniləmə: yalnız tanınmış dəyərlər", async () => {
  const ok = await json(await call("PATCH", `/v1/service/tenants/${tenantId}/profile`, { language: "en", tone: "rəsmi" }));
  assert.equal(ok.body.profile.language, "en");
  assert.equal(ok.body.profile.maxResults, 2, "dəyişdirilməyən sahələr qalır");
  assert.equal((await call("PATCH", `/v1/service/tenants/${tenantId}/profile`, { language: "xx" })).status, 400);
});

test("açar yeniləmə: köhnə açar dərhal işləmir, yenisi işləyir", async () => {
  const r = await json(await call("POST", `/v1/service/tenants/${tenantId}/rotate-key`));
  assert.notEqual(r.body.apiKey, apiKey);
  assert.equal((await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${apiKey}` } })).status, 401);
  assert.equal((await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${r.body.apiKey}` } })).status, 200);
});

test("müştəri filtrləri: config/test onları göstərir; səhv elan 400 qaytarır", async () => {
  const c = structuredClone(config);
  c.source.filters.color = { type: "string", description: "Rəng", param: "color", values: ["Qara", "Ağ"] };
  const ok = await json(await call("POST", "/v1/service/config/test", { ...c, testFilters: { color: "Qara" } }));
  assert.equal(ok.status, 200);
  assert.ok(ok.body.filters.some((f) => f.name === "color" && f.kind === "string"));
  assert.match(ok.body.debug.request, /color=Qara/);

  c.source.filters.color.description = "";
  const r = await json(await call("POST", "/v1/service/config/test", c));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /description/);

  const c2 = structuredClone(config);
  c2.source.filters.bodyType = { type: "string", param: "x&y=1", description: "Kuzov" };
  assert.equal((await call("POST", "/v1/service/config/test", c2)).status, 400);
});

test("DELETE müştəri: açar işləmir, ikinci dəfə 404, servis tokeni olmadan 401", async () => {
  const created = await json(await call("POST", "/v1/service/tenants", config));
  const { tenantId, apiKey } = created.body;
  assert.equal((await call("DELETE", `/v1/service/tenants/${tenantId}`, undefined, { "content-type": "application/json" })).status, 401);
  assert.equal((await call("DELETE", `/v1/service/tenants/${tenantId}`)).status, 200);
  assert.equal((await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${apiKey}` } })).status, 401);
  assert.equal((await call("DELETE", `/v1/service/tenants/${tenantId}`)).status, 404);
});
