import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock, demoTenant, tmpFile } from "../testkit/helpers.mjs";
import { maskPII } from "../src/queries/queries.js";

let mock, base, server, config, id, key;
const TOKEN = "service-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
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
  config = { businessName: "Q Avto", domain: "q.az", profile: { language: "az", maxResults: 5 }, source, apiSecret: "test-secret" };
  const { createApp } = await import("../src/app.js");
  const fake = async ({ message }) => message.includes("umumisual") ? { answer: "Ümumi cavab", listings: [], searched: false, tokens: 5 } : message.includes("operatorsual") ? { answer: "Formada yazın", listings: [], searched: false, unanswered: true, tokens: 5 } : message.includes("yoxdur") ? { answer: "Tapılmadı", listings: [], tokens: 10 } : message.includes("xeta") ? Promise.reject(new Error("boom")) : { answer: "Var", listings: [{ id: "1" }], tokens: 30 };
  server = await new Promise((res) => { const s = createApp({ adviseFn: fake }).listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
  const r = await (await call("POST", "/v1/service/tenants", config)).json();
  if (!r.tenantId) throw new Error(JSON.stringify(r));
  id = r.tenantId; key = r.apiKey;
});
after(() => { server.close(); mock.server.close(); });

const ask = (message, extra = {}) => call("POST", `/v1/service/tenants/${id}/chat`, { message, ...extra });
const queries = async (qs = "") => (await call("GET", `/v1/service/tenants/${id}/queries${qs}`)).json();

test("maskPII telefon, email və kart nömrəsini gizlədir, qiyməti və ili saxlayır", () => {
  assert.equal(maskPII("zəng edin +994 50 123 45 67 və ya a.b@mail.az"), "zəng edin [nömrə] və ya [email]");
  assert.equal(maskPII("kart 4169 7388 1234 5678"), "kart [nömrə]");
  assert.equal(maskPII("3000 AZN-ə qədər, 2019 il"), "3000 AZN-ə qədər, 2019 il");
});

test("sorğular qeyd olunur: nəticəli, nəticəsiz və xətalı; mətn maskalanır", async () => {
  await ask("Toyota istəyirəm");
  await ask("Toyota istəyirəm");
  await ask("yoxdur belə maşın, nömrəm 050 123 45 67");
  await ask("xeta ver");
  const all = await queries();
  assert.equal(all.total, 4);
  assert.ok(all.queries.some((q) => q.message.includes("[nömrə]") && !q.message.includes("123 45")));
  const none = await queries("?noResults=1");
  assert.equal(none.total, 1, "xəta nəticəsiz sayılmır");
  const stats = await (await call("GET", `/v1/service/tenants/${id}/queries/stats`)).json();
  assert.equal(stats.total, 4);
  assert.equal(stats.errors, 1);
  assert.equal(stats.noResults, 1);
  assert.deepEqual(stats.top[0], { message: "toyota istəyirəm", count: 2 });
  assert.equal((await queries("?q=toyota")).total, 2);
});

test("portalın sınaq söhbəti (test: true) qeydə düşmür", async () => {
  const before = (await queries()).total;
  await ask("sınaq sualı", { test: true });
  assert.equal((await queries()).total, before);
});

test("logQueries=false: qeyd dayanır; true: yenidən başlayır; DELETE hamısını silir", async () => {
  const total = (await queries()).total;
  assert.equal((await call("PATCH", `/v1/service/tenants/${id}/profile`, { logQueries: false })).status, 200);
  await ask("söndürülmüş sual");
  const off = await queries();
  assert.equal(off.enabled, false);
  assert.equal(off.total, total);
  assert.equal((await call("PATCH", `/v1/service/tenants/${id}/profile`, { logQueries: "xeyr" })).status, 400);
  await call("PATCH", `/v1/service/tenants/${id}/profile`, { logQueries: true });
  await ask("açıq sual");
  assert.equal((await queries()).total, total + 1);
  assert.equal((await call("DELETE", `/v1/service/tenants/${id}/queries`)).status, 200);
  assert.equal((await queries()).total, 0);
});

test("müştərini silmək sorğu qeydini də silir", async () => {
  await ask("silinəcək sual");
  const { listQueries } = await import("../src/queries/queries.js");
  assert.equal((await listQueries(id)).total, 1);
  await call("DELETE", `/v1/service/tenants/${id}`);
  assert.equal((await listQueries(id)).total, 0);
});

test("admin xülasəsi: bu gün və bu ay üzrə sorğu/token cəmi, müştərilər token üzrə sıralı", async () => {
  // əvvəlki test müştərini silib, ona görə yenisini yaradırıq
  const r = await (await call("POST", "/v1/service/tenants", { ...config, domain: "s.az", businessName: "S Avto" })).json();
  const q = await fetch(`${base}/v1/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${r.apiKey}` }, body: JSON.stringify({ message: "Honda göstər" }) });
  assert.equal(q.status, 200);
  const s = await (await call("GET", "/v1/service/usage/summary")).json();
  assert.equal(s.daily.length, 30);
  assert.equal(s.monthly.length, 12);
  assert.equal(s.thisMonth.requests, 1);
  assert.equal(s.thisMonth.tokens, 30);
  assert.equal(s.today.tokens, 30);
  assert.equal(s.today.requests, 1);
  assert.equal(s.tenants[0].tenantId, r.tenantId);
  assert.equal((await fetch(`${base}/v1/service/usage/summary`)).status, 401);
});

test("axtarışsız cavab 'tapılmadı' sayılmır: -1 (cavablandı), operator sorğusu -2", async () => {
  const t = await (await call("POST", "/v1/service/tenants", { ...config, domain: "z.az", businessName: "Z Avto" })).json();
  const ask2 = (message) => call("POST", `/v1/service/tenants/${t.tenantId}/chat`, { message });
  await ask2("umumisual bmw necədir");
  await ask2("operatorsual operatora bağla");
  await ask2("yoxdur belə");
  const { listQueries } = await import("../src/queries/queries.js");
  const all = await listQueries(t.tenantId);
  assert.deepEqual(all.queries.map((x) => x.results).sort((a, b) => a - b), [-2, -1, 0]);
  assert.ok(all.queries.every((x) => x.costAzn === null || typeof x.costAzn === "number"), "sorğunun xərci (AZN) qeyd olunur");
  assert.equal((await listQueries(t.tenantId, { noResults: true })).total ?? (await listQueries(t.tenantId, { noResults: true })).queries.length, 1, "yalnız real nəticəsiz axtarış");
});
