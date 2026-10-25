// MongoDB rejimi, real MongoDB olmadan: sürücünün istifadə etdiyimiz hissəsinin sadə yaddaş nüsxəsi ilə.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock, demoTenant } from "../testkit/helpers.mjs";

// find / findOne / insertOne / replaceOne / updateOne / findOneAndUpdate ($inc, $setOnInsert, upsert)
function fakeDb() {
  const data = new Map();
  const get = (n) => data.get(n) ?? data.set(n, new Map()).get(n);
  const matches = (d, f) => Object.entries(f).every(([k, v]) => d[k] === v);
  const apply = (doc, upd, inserting) => {
    for (const [k, v] of Object.entries(upd.$inc ?? {})) {
      const parts = k.split("."); const last = parts.pop();
      const target = parts.reduce((o, p) => (o[p] ??= {}), doc); // "days.2026-10-16" → doc.days["2026-10-16"]
      target[last] = (target[last] ?? 0) + v;
    }
    if (inserting) Object.assign(doc, upd.$setOnInsert ?? {});
  };
  const collection = (name) => {
    const c = get(name);
    return {
      find: (f = {}) => ({ toArray: async () => [...c.values()].filter((d) => matches(d, f)).map((d) => structuredClone(d)) }),
      findOne: async (f) => { const d = [...c.values()].find((x) => matches(x, f)); return d ? structuredClone(d) : null; },
      insertOne: async (doc) => { if (c.has(doc._id)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 }); c.set(doc._id, structuredClone(doc)); },
      deleteOne: async (f) => { c.delete(f._id); },
      deleteMany: async (f) => { for (const [k, d] of c) if (matches(d, f)) c.delete(k); },
      replaceOne: async (f, doc, o = {}) => { const ex = [...c.values()].find((x) => matches(x, f)); if (ex || o.upsert) c.set(doc._id, structuredClone(doc)); },
      updateOne: async (f, upd, o = {}) => {
        let d = c.get(f._id); const ins = !d;
        if (!d && !o.upsert) return;
        d ??= { _id: f._id }; apply(d, upd, ins); c.set(d._id, d);
      },
      findOneAndUpdate: async (f, upd, o = {}) => {
        let d = c.get(f._id); const ins = !d;
        if (!d && !o.upsert) return null;
        d ??= { _id: f._id }; apply(d, upd, ins); c.set(d._id, d);
        return structuredClone(d);
      },
    };
  };
  return { collection, raw: data };
}

let mock, base, server, db;
const TOKEN = "service-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const call = (method, path, body) => fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });

before(async () => {
  mock = await startMock();
  process.env.SERVICE_TOKEN = TOKEN;
  process.env.TENANT_SECRET_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.CUSTOMER_TENANTS_FILE = "/yoxdur/customer-tenants.json"; // fayla yazılsaydı test düşərdi
  process.env.USAGE_FILE = "/yoxdur/usage.json";
  process.env.BILLING_FILE = "/yoxdur/billing.json";
  db = fakeDb();
  const { useStoreDb } = await import("../src/store/mongo.js");
  useStoreDb(db);
  const { initStores } = await import("../src/store/init.js");
  await initStores();
  const { createApp } = await import("../src/app.js");
  const fake = async () => ({ answer: "Tapdım!", listings: [], tokens: 42 });
  server = await new Promise((res) => { const s = createApp({ adviseFn: fake }).listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); mock.server.close(); });

const config = () => {
  const source = structuredClone(demoTenant(mock.url).source);
  source.auth = { type: "header", name: "X-Api-Key" };
  return { businessName: "DB Avto", domain: "db.az", profile: { language: "az", maxResults: 5 }, source, apiSecret: "test-secret" };
};

test("müştəri DB-yə yazılır, API açarı ilə tapılır, açıq açar DB-də yoxdur", async () => {
  const r = await call("POST", "/v1/service/tenants", config());
  assert.equal(r.status, 201);
  const { tenantId, apiKey } = await r.json();
  const stored = db.raw.get("tenants").get(tenantId);
  assert.equal(stored.tenantId, tenantId);
  assert.ok(stored.apiKeyHash && !JSON.stringify(stored).includes(apiKey), "açıq açar saxlanmır");
  assert.ok(!JSON.stringify(stored).includes("test-secret"), "müştəri sirri açıq saxlanmır");
  const chat = await fetch(`${base}/v1/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ message: "salam" }) });
  assert.equal(chat.status, 200);
  globalThis.__t = { tenantId, apiKey };
});

test("konfiqurasiya, profil və açar yeniləmələri DB-yə yazılır", async () => {
  const { tenantId, apiKey } = globalThis.__t;
  const put = await call("PUT", `/v1/service/tenants/${tenantId}/config`, { ...config(), businessName: "Yeni Ad" });
  assert.equal(put.status, 200);
  assert.equal(db.raw.get("tenants").get(tenantId).profile.businessName, "Yeni Ad");
  await call("PATCH", `/v1/service/tenants/${tenantId}/profile`, { tone: "rəsmi" });
  assert.equal(db.raw.get("tenants").get(tenantId).profile.tone, "rəsmi");
  const rot = await (await call("POST", `/v1/service/tenants/${tenantId}/rotate-key`)).json();
  const old = await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${apiKey}` } });
  assert.equal(old.status, 401, "köhnə açar etibarsızdır");
  const fresh = await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${rot.apiKey}` } });
  assert.equal(fresh.status, 200);
});

test("server yenidən başlayanda müştərilər DB-dən yüklənir", async () => {
  const { tenantId } = globalThis.__t;
  const { reloadCustomerTenants, listCustomerTenants } = await import("../src/tenants/customerStore.js");
  await reloadCustomerTenants();
  assert.ok(listCustomerTenants().some((t) => t.tenantId === tenantId));
});

test("istifadə sayğacı DB-dədir: sorğu və token sayılır", async () => {
  const { tenantId } = globalThis.__t;
  const row = [...db.raw.get("usage").values()].find((d) => d.tenantId === tenantId);
  assert.ok(row && row.requests >= 1 && row.tokens >= 42);
  const u = await (await call("GET", `/v1/service/tenants/${tenantId}/usage`)).json();
  assert.equal(u.requests, row.requests);
});

test("aylıq limit atomikdir: eyni anda 10 sorğu, limit 3 → düz 3-ü keçir, sayğac 3-də qalır", async () => {
  const { checkAndCount, getUsage } = await import("../src/usage/usage.js");
  const t = { tenantId: "limit-test", limits: { monthlyRequests: 3, ratePerMinute: 100 } };
  const results = await Promise.all(Array.from({ length: 10 }, () => checkAndCount(t)));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === "MONTHLY_LIMIT"));
  assert.equal((await getUsage(t)).requests, 3);
});

test("DB-də olmayan müştəri 404, listings sorğusu aylıq sayğaca yazılmır", async () => {
  assert.equal((await call("GET", "/v1/service/tenants/tenant-yoxdur/usage")).status, 404);
  const { tenantId } = globalThis.__t;
  const before = (await (await call("GET", `/v1/service/tenants/${tenantId}/usage`)).json()).requests;
  await call("GET", `/v1/service/tenants/${tenantId}/listings`);
  assert.equal((await (await call("GET", `/v1/service/tenants/${tenantId}/usage`)).json()).requests, before);
});

test("günlük statistika: son 14 gün, bu gün sayılır, limit rədd edilən sorğu günlükdən də çıxılır", async () => {
  const { checkAndCount, getUsage } = await import("../src/usage/usage.js");
  const t = { tenantId: "daily-test", limits: { monthlyRequests: 2, ratePerMinute: 100 } };
  for (let i = 0; i < 5; i++) await checkAndCount(t);
  const u = await getUsage(t);
  assert.equal(u.daily.length, 14);
  assert.equal(u.daily.at(-1).date, new Date().toISOString().slice(0, 10));
  assert.equal(u.daily.at(-1).requests, 2, "yalnız qəbul edilən 2 sorğu");
  assert.ok(u.daily.slice(0, -1).every((d) => d.requests === 0));
  assert.equal(u.requests, 2);
});

test("müştəri silinir: DB-dən, siyahıdan və sayğacdan; açarı işləmir", async () => {
  const r = await call("POST", "/v1/service/tenants", config());
  const { tenantId, apiKey } = await r.json();
  await fetch(`${base}/v1/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ message: "salam" }) });
  assert.ok([...db.raw.get("usage").values()].some((d) => d.tenantId === tenantId));
  assert.equal((await call("DELETE", `/v1/service/tenants/${tenantId}`)).status, 200);
  assert.ok(!db.raw.get("tenants").has(tenantId));
  assert.ok(![...db.raw.get("usage").values()].some((d) => d.tenantId === tenantId));
  const after = await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${apiKey}` } });
  assert.equal(after.status, 401);
  assert.equal((await call("DELETE", `/v1/service/tenants/${tenantId}`)).status, 404, "ikinci dəfə: tapılmadı");
});
