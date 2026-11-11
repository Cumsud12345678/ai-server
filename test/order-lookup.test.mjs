// Girişsiz sifariş statusu: nömrə + telefon uyğun gəlsə status göstərilir; uyğun gəlməsə və ya sifariş yoxdursa eyni cavab;
// təxminə qarşı limitlər; telefon maskalanır; plan imkanı söndürülübsə alət verilmir; panel sınağı.
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { tmpFile } from "../testkit/helpers.mjs";

const H = { "content-type": "application/json", authorization: "Bearer lk-token" };
let base, server, shop, shopUrl, tenantId, mod, shopCalls = 0, seen = [], nextArgs = null;

const ORDERS = {
  "10452": { data: { number: "10452", status: "Kuryerə verilib", eta: "Bu gün 18:00-a qədər", billing: { phone: "+994 50 123 45 67", email: "leyla@mail.az" }, total: 4500, items: [{ name: "Tort Napoleon", qty: 2 }] } },
};
const fakeGemini = {
  models: {
    embedContent: async ({ contents }) => ({ embeddings: contents.map(() => ({ values: new Array(8).fill(0.1) })) }),
    generateContent: async ({ contents, config }) => {
      const names = (config.tools?.[0]?.functionDeclarations ?? []).map((d) => d.name);
      seen.push({ names, system: config.systemInstruction });
      const fr = contents.at(-1).parts.find((p) => p.functionResponse);
      if (fr) return { text: `Nəticə: ${JSON.stringify(fr.functionResponse.response.result)}`, usageMetadata: { totalTokenCount: 30 } };
      const args = nextArgs; nextArgs = null;
      if (args && names.includes("lookup_order")) return { functionCalls: [{ name: "lookup_order", args }], candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "lookup_order", args } }] } }], usageMetadata: { totalTokenCount: 20 } };
      return { text: "Sifariş nömrənizi və telefonunuzu yazın.", usageMetadata: { totalTokenCount: 10 } };
    },
  },
};
const call = (method, path, body) => fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const T = (p = "") => `/v1/service/tenants/${tenantId}${p}`;
let sidN = 0;
const ask = async (args, sid = `sid-lk-${++sidN}-xx`) => { nextArgs = args; return (await call("POST", T("/chat"), { message: "sifarişim haradadır", sid, channel: "whatsapp" })).json(); };
const config = (over = {}) => ({
  baseUrl: shopUrl, auth: { type: "header", name: "X-Shop-Key" }, apiSecret: "SIRR", sources: [],
  lookup: { enabled: true, title: "Sifariş", path: "/orders/{orderId}", itemsPath: "data", phoneField: "billing.phone",
    fields: { "Status": "status", "Çatdırılma": "eta", "Məbləğ": { path: "total", type: "number", divide: 100 }, "Telefon": "billing.phone" }, lines: { path: "items", title: "name", qty: "qty" }, ...over },
});

before(async () => {
  shop = http.createServer((req, res) => {
    shopCalls++;
    if (req.headers["x-shop-key"] !== "SIRR") { res.writeHead(401); return res.end("{}"); }
    const id = decodeURIComponent(req.url.split("/orders/")[1] ?? "");
    const o = ORDERS[id];
    res.writeHead(o ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(o ?? { error: "not found" }));
  });
  await new Promise((r) => shop.listen(0, r));
  shopUrl = `http://localhost:${shop.address().port}`;
  Object.assign(process.env, { SERVICE_TOKEN: "lk-token", TENANT_SECRET_ENCRYPTION_KEY: "ab".repeat(32), ALLOW_LOCAL_CONNECTORS: "1" });
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}"); process.env.BILLING_FILE = tmpFile("billing.json", "{}"); process.env.KB_FILE = tmpFile("kb.json", "{}");
  const { useGeminiClient } = await import("../src/kb/client.js");
  useGeminiClient(fakeGemini);
  mod = await import("../src/private/orderLookup.js");
  const { createApp } = await import("../src/app.js");
  server = await new Promise((r) => { const s = createApp().listen(0, () => r(s)); });
  base = `http://localhost:${server.address().port}`;
  tenantId = (await (await call("POST", "/v1/service/tenants", { businessName: "Tort Evi", domain: "tort.az", profile: { language: "az", mode: "support", generalKnowledge: false } })).json()).tenantId;
});
after(() => { server.close(); shop.close(); delete process.env.ALLOW_LOCAL_CONNECTORS; });
beforeEach(() => mod.resetLookupLimits());

test("konfiqurasiya: telefon sahəsi məcburidir, {orderId} və ya orderParam lazımdır, mənbəsiz də saxlanır", async () => {
  const bad = async (over, re) => { const r = await call("PUT", T("/private-data"), config(over)); assert.equal(r.status, 400); assert.match((await r.json()).error, re); };
  await bad({ phoneField: undefined }, /phoneField/);
  await bad({ path: "/orders" }, /orderId/);
  await bad({ path: "/orders/{orderId}/{other}" }, /yalnız \{orderId\}/);
  const ok = await call("PUT", T("/private-data"), config());
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  const view = await ok.json();
  assert.equal(view.configured, true);
  assert.equal(view.lookup.phoneField, "billing.phone");
  assert.ok(!JSON.stringify(view).includes("SIRR"), "açar panelə qayıtmır");
});

test("samePhone və cleanOrderId", () => {
  assert.equal(mod.samePhone("+994 50 123 45 67", "050-123-45-67"), true);
  assert.equal(mod.samePhone("+994501234567", "0551234567"), false);
  assert.equal(mod.samePhone("", "0501234567"), false);
  assert.equal(mod.cleanOrderId("#10452"), "10452");
  assert.equal(mod.cleanOrderId("№ 10452"), "10452");
  assert.equal(mod.cleanOrderId("10452; DROP"), null);
});

test("düzgün nömrə + telefon: status və tərkib göstərilir, telefon maskalanır, cavab keşə düşmür", async () => {
  const r = await ask({ orderId: "#10452", phone: "050 123 45 67" });
  assert.ok(seen.at(-1).names.includes("lookup_order"), "alət modelə verilir (giriş tələb olunmur)");
  assert.match(seen.at(-1).system, /SİFARİŞ STATUSU/);
  assert.match(r.answer, /"found":true/);
  assert.match(r.answer, /Kuryerə verilib/);
  assert.match(r.answer, /2× Tort Napoleon/);
  assert.match(r.answer, /"Məbləğ":45/);
  assert.ok(!r.answer.includes("123 45 67") && !r.answer.includes("leyla@mail.az"), "telefon və e-poçt göstərilmir");
});

test("səhv telefon və olmayan sifariş: EYNİ cavab (sifarişin mövcudluğu bildirilmir)", async () => {
  const wrong = await ask({ orderId: "10452", phone: "055 999 99 99" });
  const missing = await ask({ orderId: "99999", phone: "050 123 45 67" });
  const note = (a) => JSON.parse(a.answer.replace(/^Nəticə: /, ""));
  assert.deepEqual(note(wrong), note(missing));
  assert.equal(note(wrong).found, false);
  assert.ok(!wrong.answer.includes("Kuryer"));
});

test("təxminə qarşı: eyni sifarişə 5 uğursuz cəhddən sonra düzgün telefon da qəbul olunmur; söhbət başına 10 dəqiqədə 5 axtarış", async () => {
  for (let i = 0; i < 5; i++) await ask({ orderId: "10452", phone: `055 000 00 0${i}` });
  const after = await ask({ orderId: "10452", phone: "050 123 45 67" });
  assert.match(after.answer, /çox uğursuz cəhd/);
  mod.resetLookupLimits();
  const sid = "sid-lk-flood-xx";
  for (let i = 0; i < 5; i++) await ask({ orderId: `X${i}`, phone: "050 111 22 33" }, sid);
  assert.match((await ask({ orderId: "10452", phone: "050 123 45 67" }, sid)).answer, /çox axtarış/);
});

test("söndürüləndə və ya plan imkanı olmayanda alət verilmir", async () => {
  await call("PUT", T("/private-data"), config({ enabled: false }));
  seen = [];
  await ask(null);
  assert.ok(!seen.at(-1)?.names.includes("lookup_order"));
  await call("PUT", T("/private-data"), config());
  // Plan: customerData söndürülüb (Start planı kimi)
  const { store } = await import("../src/billing/storage.js");
  await call("POST", T("/billing/plan/assign"), { plan: "start", days: 30, by: "test" });
  seen = [];
  await ask(null);
  assert.ok(!seen.at(-1)?.names.includes("lookup_order"), "Start planında alət yoxdur");
  await call("POST", T("/billing/plan/assign"), { plan: null, by: "test" });
  void store;
});

test("panel sınağı: söndürülmüş axtarışı da yoxlamaq olur, nəticə maskalanmış", async () => {
  await call("PUT", T("/private-data"), config({ enabled: false }));
  const ok = await (await call("POST", T("/private-data/lookup-test"), { orderId: "10452", phone: "+994501234567" })).json();
  assert.equal(ok.found, true);
  assert.equal(ok.record.Status, "Kuryerə verilib");
  assert.match(ok.record.Telefon, /\*{4}4567$/);
  assert.ok(!ok.record.Telefon.includes("50123"), "telefon tam görünmür");
  const no = await (await call("POST", T("/private-data/lookup-test"), { orderId: "10452", phone: "0559999999" })).json();
  assert.equal(no.found, false);
});
