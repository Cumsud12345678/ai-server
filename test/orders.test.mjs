// API-siz sifariş forması: forma yoxlanır, AI yalnız düzgün məlumatla sifariş yaza bilir, sifariş müraciətlər qutusuna düşür,
// cavabda portala qayıdır, limitlər işləyir, forma söndürüləndə alət modelə verilmir.
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tmpFile } from "../testkit/helpers.mjs";

const TOKEN = "order-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
let base, server, tenantId, apiKey, nextCall, lastTools, orders;

const fakeGemini = {
  models: {
    embedContent: async ({ contents }) => ({ embeddings: contents.map(() => ({ values: new Array(8).fill(0.1) })) }),
    generateContent: async ({ contents, config }) => {
      lastTools = (config.tools?.[0]?.functionDeclarations ?? []);
      const names = lastTools.map((d) => d.name);
      const fr = contents.at(-1).parts.find((p) => p.functionResponse);
      if (fr) return { text: `Cavab: ${JSON.stringify(fr.functionResponse.response.result)}`, usageMetadata: { totalTokenCount: 40 } };
      const call = nextCall; nextCall = null;
      if (call && names.includes(call.name)) return { functionCalls: [{ name: call.name, args: call.args }], candidates: [{ content: { role: "model", parts: [{ functionCall: call }] } }], usageMetadata: { totalTokenCount: 20 } };
      return { text: "Salam, nə sifariş etmək istəyirsiniz?", usageMetadata: { totalTokenCount: 10 } };
    },
  },
};

const call = (method, path, body, headers = H) => fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const T = (p = "") => `/v1/service/tenants/${tenantId}${p}`;
let n = 0;
const chat = async (message, args, sid = `sid-order-${++n}-xxxx`) => { nextCall = args ? { name: "submit_order", args } : null; return (await call("POST", T("/chat"), { message, sid, channel: "telegram", history: [{ role: "user", text: "tort istəyirəm" }, { role: "model", text: "Adınız?" }] })).json(); };
const form = (over = {}) => ({
  enabled: true, title: "Tort sifarişi", instructions: "Bakı daxili çatdırılma 5 AZN.", successMessage: "Sifarişiniz qəbul olundu, 1 saat ərzində zəng edəcəyik.",
  fields: [
    { key: "name", label: "Ad", type: "text", required: true },
    { key: "phone", label: "Telefon", type: "phone", required: true },
    { key: "cake", label: "Tort", type: "select", required: true, options: ["Napoleon", "Medovik"] },
    { key: "qty", label: "Say", type: "number" },
    { key: "address", label: "Ünvan", type: "address", required: true, description: "Rayon, küçə, ev" },
  ], ...over,
});
const good = { name: "Leyla", phone: "+994 50 123 45 67", cake: "napoleon", qty: "2", address: "Nəsimi r., Bülbül 5" };

before(async () => {
  Object.assign(process.env, { SERVICE_TOKEN: TOKEN, TENANT_SECRET_ENCRYPTION_KEY: "ef".repeat(32) });
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}"); process.env.BILLING_FILE = tmpFile("billing.json", "{}"); process.env.KB_FILE = tmpFile("kb.json", "{}");
  const { useGeminiClient } = await import("../src/kb/client.js");
  useGeminiClient(fakeGemini);
  orders = await import("../src/orders/orders.js");
  const { createApp } = await import("../src/app.js");
  server = await new Promise((res) => { const s = createApp().listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
  ({ tenantId, apiKey } = await (await call("POST", "/v1/service/tenants", { businessName: "Şirniyyat", domain: "tort.az", profile: { language: "az", mode: "support", generalKnowledge: false } })).json());
});
after(() => server.close());
beforeEach(() => orders._resetOrderLimits());

test("forma yoxlanır: əlaqə sahəsi məcburidir, açar və növ düzgün olmalıdır", async () => {
  const bad = async (mut, re) => { const f = form(); mut(f); const r = await call("PUT", T("/order-form"), f); assert.equal(r.status, 400); assert.match((await r.json()).error, re); };
  await bad((f) => { f.fields = f.fields.filter((x) => x.type !== "phone"); }, /Telefon və ya e-poçt/);
  await bad((f) => { f.fields[1].required = false; }, /Telefon və ya e-poçt/);
  await bad((f) => { f.fields[0].key = "Ad Soyad"; }, /açarı/);
  await bad((f) => { f.fields[3].key = "name"; }, /təkrarlanır/);
  await bad((f) => { f.fields[2].options = ["tək"]; }, /variant/);
  await bad((f) => { f.fields[0].type = "date"; }, /növ/);
  await bad((f) => { f.fields = Array.from({ length: 13 }, (_, i) => ({ key: `f${i}`, label: "x", type: "phone", required: true })); }, /12/);
  const ok = await call("PUT", T("/order-form"), form());
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).form.fields.length, 5);
});

test("forma aktivdirsə submit_order aləti modelə verilir, sistem təlimatında sahələr var", async () => {
  await chat("salam");
  const d = lastTools.find((x) => x.name === "submit_order");
  assert.ok(d, "alət verilir");
  assert.deepEqual(d.parameters.required, ["name", "phone", "cake", "address"]);
  assert.deepEqual(d.parameters.properties.cake.enum, ["Napoleon", "Medovik"]);
  const { orderPrompt } = orders;
  const p = orderPrompt({ orderForm: form() });
  assert.match(p, /Təsdiq edirsiniz/);
  assert.match(p, /Bakı daxili çatdırılma/);
});

test("düzgün sifariş müraciətlər qutusuna düşür və cavabda portala qayıdır", async () => {
  const r = await chat("bəli, təsdiq edirəm", good);
  assert.ok(r.order, JSON.stringify(r));
  assert.equal(r.order.contact, "+994 50 123 45 67");
  assert.equal(r.order.name, "Leyla");
  assert.deepEqual(r.order.fields.map((f) => f.value), ["Leyla", "+994 50 123 45 67", "Napoleon", "2", "Nəsimi r., Bülbül 5"]);
  const leads = await (await call("GET", T("/kb/leads"))).json();
  const lead = leads.items.find((l) => l.id === r.order.id);
  assert.ok(lead, "müraciət yaranıb");
  assert.equal(lead.status, "new");
  assert.equal(lead.order.channel, "telegram");
  assert.match(lead.question, /^Tort sifarişi: Tort: Napoleon; Say: 2; Ünvan: Nəsimi/);
  assert.ok(lead.conversation.length >= 2, "söhbət saxlanır");
  // şəxsi məlumat sorğu jurnalına düşmür
  const q = await (await call("GET", T("/queries"))).json();
  assert.ok(!JSON.stringify(q).includes("Bülbül"), "ünvan sorğu jurnalında yoxdur");
});

test("çatışmayan və ya səhv məlumatla sifariş yazılmır, model səbəbi alır", async () => {
  const before = (await (await call("GET", T("/kb/leads"))).json()).total;
  const miss = await chat("təsdiq", { ...good, address: "" });
  assert.equal(miss.order, undefined);
  assert.match(miss.answer, /çatışmır: Ünvan/);
  const wrong = await chat("təsdiq", { ...good, phone: "12", cake: "Şokolad" });
  assert.equal(wrong.order, undefined);
  assert.match(wrong.answer, /düzgün deyil: Telefon, Tort/);
  assert.equal((await (await call("GET", T("/kb/leads"))).json()).total, before);
});

test("eyni söhbətdən saatda 3 sifarişdən çox qəbul olunmur", async () => {
  const sid = "sid-limit-xxxxxxxx";
  for (let i = 0; i < 3; i++) assert.ok((await chat("təsdiq", good, sid)).order);
  const fourth = await chat("təsdiq", good, sid);
  assert.equal(fourth.order, undefined);
  assert.match(fourth.answer, /çox sifariş/);
});

test("açıq API ilə gələn sifariş 'api' kanalı kimi qeyd olunur", async () => {
  nextCall = { name: "submit_order", args: good };
  const r = await (await call("POST", "/v1/chat", { message: "təsdiq", history: [{ role: "user", text: "x" }] }, { "content-type": "application/json", authorization: `Bearer ${apiKey}` })).json();
  assert.ok(r.order);
  const lead = (await (await call("GET", T("/kb/leads"))).json()).items.find((l) => l.id === r.order.id);
  assert.equal(lead.order.channel, "api");
});

test("forma söndürüləndə və ya silinəndə alət verilmir", async () => {
  await call("PUT", T("/order-form"), form({ enabled: false }));
  lastTools = []; // model çağırılmasa da (qısa yol) əvvəlki testin alətləri qalmasın
  await chat("salam");
  assert.ok(!lastTools.some((x) => x.name === "submit_order"));
  await call("PUT", T("/order-form"), form());
  assert.equal((await call("DELETE", T("/order-form"))).status, 200);
  assert.equal((await (await call("GET", T("/order-form"))).json()).form, null);
  lastTools = [];
  await chat("salam");
  assert.ok(!lastTools.some((x) => x.name === "submit_order"));
});

test("elan rejimində (advisor) də alət işləyir və nəticə qayıdır", async () => {
  const { advise } = await import("../src/ai/advisor.js");
  const tenant = { tenantId: "t-adv", language: "az", profile: { mode: "listings", maxResults: 5 }, orderForm: { ...form(), fields: form().fields } };
  const repo = { schema: { args: [], sortFields: [] }, supportedFilters: [], search: async () => [], vocabulary: async () => ({}) };
  let step = 0, tools = [];
  const client = { models: { generateContent: async ({ config, contents }) => {
    tools = config.tools[0].functionDeclarations.map((d) => d.name);
    assert.match(config.systemInstruction, /SİFARİŞ QƏBULU/);
    if (step++ === 0) return { functionCalls: [{ name: "submit_order", args: good }], candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "submit_order", args: good } }] } }], usageMetadata: { totalTokenCount: 5 } };
    const fr = contents.at(-1).parts[0].functionResponse.response.result;
    return { text: `Qəbul olundu ${fr.orderNumber}`, usageMetadata: { totalTokenCount: 5 } };
  } } };
  const r = await advise({ tenant, repo, message: "təsdiq", history: [{ role: "user", text: "medovik istəyirəm" }], sid: "sid-adv-xxxxxx", channel: "widget" }, client);
  assert.ok(tools.includes("submit_order"));
  assert.ok(r.order);
  assert.match(r.answer, /^Qəbul olundu [0-9A-F]{8}$/);
  assert.equal(r.private, true, "şəxsi cavab keşə düşmür");
});
