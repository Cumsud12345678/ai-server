// "Yalnız dəstək" rejimində elan mənbəyi qoşulanda rejim avtomatik "both" olur; identity secret məlumat mənbəyi olmadan da yaradılır.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock, demoTenant, tmpFile } from "../testkit/helpers.mjs";

let mock, base, server, source;
const TOKEN = "mode-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const call = async (method, path, body) => { const r = await fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

before(async () => {
  mock = await startMock();
  process.env.SERVICE_TOKEN = TOKEN;
  process.env.TENANT_SECRET_ENCRYPTION_KEY = "cd".repeat(32);
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}");
  process.env.BILLING_FILE = tmpFile("billing.json", "{}");
  source = structuredClone(demoTenant(mock.url).source);
  source.auth = { type: "header", name: "X-Api-Key" };
  const { createApp } = await import("../src/app.js");
  server = await new Promise((res) => { const s = createApp({ adviseFn: async () => ({ answer: "ok", listings: [], tokens: 1 }) }).listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); mock.server.close(); });

test("dəstək rejimində mənbə qoşulur → rejim both; açıq yazılan rejim dəyişmir", async () => {
  const created = await call("POST", "/v1/service/tenants", { businessName: "Dəstək", domain: "d.az", profile: { mode: "support" } });
  assert.equal(created.status, 201);
  const id = created.body.tenantId;
  const up = await call("PUT", `/v1/service/tenants/${id}/config`, { businessName: "Dəstək", domain: "d.az", profile: { tone: "rəsmi" }, source, apiSecret: "test-secret" });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.profile.mode, "both");
  assert.equal(up.body.modeChanged, true);
  assert.equal(up.body.profile.tone, "rəsmi");
  const again = await call("PUT", `/v1/service/tenants/${id}/config`, { businessName: "Dəstək", domain: "d.az", profile: { mode: "listings" }, source });
  assert.equal(again.body.profile.mode, "listings");
  assert.equal(again.body.modeChanged, true);
});

test("identity secret məlumat mənbəsiz yaradılır və müştəri məlumatı silinəndə qalır", async () => {
  const created = await call("POST", "/v1/service/tenants", { businessName: "Mağaza", domain: "m.az", profile: { mode: "support" } });
  const id = created.body.tenantId;
  const s = await call("POST", `/v1/service/tenants/${id}/private-data/identity-secret`);
  assert.equal(s.status, 201);
  let view = (await call("GET", `/v1/service/tenants/${id}/private-data`)).body;
  assert.equal(view.configured, false); assert.equal(view.identity.configured, true); assert.equal(view.ready, false); assert.deepEqual(view.sources, []);
  assert.equal((await call("GET", `/v1/service/tenants/${id}/actions`)).body.identityReady, true);
  // girişli əməliyyat varsa açar qalır
  const act = await call("PUT", `/v1/service/tenants/${id}/actions`, { baseUrl: "https://shop.example", items: [{ key: "cancel_order", title: "Ləğv et", description: "Sifarişi ləğv etmək istəyəndə", method: "POST", path: "/cancel", requireIdentity: true, params: [] }] });
  assert.equal(act.status, 200, JSON.stringify(act.body));
  await call("DELETE", `/v1/service/tenants/${id}/private-data`);
  view = (await call("GET", `/v1/service/tenants/${id}/private-data`)).body;
  assert.equal(view.identity.configured, true, "girişli əməliyyatlar üçün açar qalmalıdır");
});

test("profil: cavab uzunluğu və köməkçinin adı saxlanır, prompt-a düşür; səhv dəyər rədd olunur", async () => {
  const { styleLines } = await import("../src/ai/style.js");
  const created = await call("POST", "/v1/service/tenants", { businessName: "Üslub", domain: "u.az", profile: { mode: "support", answerLength: "short", agentName: "Aysel" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const bad = await call("POST", "/v1/service/tenants", { businessName: "X", domain: "x.az", profile: { mode: "support", answerLength: "huge" } });
  assert.equal(bad.status, 400);
  const s = styleLines({ tone: "rəsmi", agentName: "Aysel", answerLength: "short" });
  assert.match(s, /Ton: rəsmi/); assert.match(s, /Aysel/); assert.match(s, /qısa/);
  assert.equal(styleLines({}), "Ton: dostcasına.");
});
