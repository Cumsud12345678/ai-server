import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpFile } from "../testkit/helpers.mjs";

const TOKEN = "qa-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
let base, server, tenantId, apiKey, generated;

const DIM = 128;
const vec = (text) => {
  const v = new Array(DIM).fill(0);
  for (const w of text.toLowerCase().split(/[^a-zəıöüçşğ0-9]+/).filter((x) => x.length > 2)) {
    let h = 0; for (const ch of w.slice(0, 6)) h = (h * 31 + ch.charCodeAt(0)) % DIM;
    v[h] += 1;
  }
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / n);
};
const fakeGemini = {
  models: {
    embedContent: async ({ contents }) => ({ embeddings: contents.map((t) => ({ values: vec(t) })) }),
    generateContent: async ({ contents }) => { generated.push(contents.at(-1).parts[0].text); return { text: "Model cavabı.\n[[S:1]]", usageMetadata: { totalTokenCount: 50 } }; },
  },
};
const call = (method, path, body) => fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const kb = (p = "") => `/v1/service/tenants/${tenantId}/kb${p}`;
const ask = async (message) => (await (await fetch(`${base}/v1/service/tenants/${tenantId}/chat`, { method: "POST", headers: H, body: JSON.stringify({ message }) })).json());

before(async () => {
  process.env.SERVICE_TOKEN = TOKEN;
  process.env.TENANT_SECRET_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}");
  process.env.BILLING_FILE = tmpFile("billing.json", "{}");
  process.env.KB_FILE = tmpFile("kb.json", "{}");
  process.env.KB_MIN_COSINE = "0.3"; process.env.KB_MIN_COSINE_KW = "0.25";
  process.env.KB_QA_COSINE = "0.8";
  generated = [];
  (await import("../src/kb/client.js")).useGeminiClient(fakeGemini);
  const { createApp } = await import("../src/app.js");
  server = await new Promise((res) => { const s = createApp().listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
  const r = await call("POST", "/v1/service/tenants", { businessName: "Test Mağaza", domain: "magaza.az", profile: { language: "az", mode: "support" } });
  ({ tenantId, apiKey } = await r.json());
});
after(() => server.close());

test("yoxlama: boş sual/cavab, çox sual, uzun cavab rədd olunur", async () => {
  for (const body of [{ questions: [], answer: "x yes" }, { questions: ["Çatdırılma nə vaxt?"], answer: "" }, { questions: Array.from({ length: 9 }, (_, i) => `Sual nömrə ${i}`), answer: "cavab" }, { questions: ["Çatdırılma?"], answer: "a".repeat(2001) }, { questions: ["ab"], answer: "cavab" }]) {
    const r = await call("POST", kb("/qa"), body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal((await r.json()).code, "BAD_QA");
  }
});

test("cütlük yaradılır; eyni sual modelsiz sözbəsöz cavab alır, token 0", async () => {
  const r = await call("POST", kb("/qa"), { questions: ["Çatdırılma neçə günə olur", "Sifariş nə vaxt çatır"], answer: "Bakı daxilində 2 iş günü, bölgələrə 4 iş günü." });
  assert.equal(r.status, 201);
  const { source } = await r.json();
  assert.equal(source.type, "qa"); assert.equal(source.status, "ready"); assert.deepEqual(source.questions.length, 2);
  const before = generated.length;
  const out = await ask("Çatdırılma neçə günə olur");
  assert.equal(out.answer, "Bakı daxilində 2 iş günü, bölgələrə 4 iş günü.");
  assert.equal(out.usage.tokens, 0);
  assert.equal(generated.length, before, "model çağırılmayıb");
  const variant = await ask("Sifariş nə vaxt çatır?");
  assert.equal(variant.answer, "Bakı daxilində 2 iş günü, bölgələrə 4 iş günü.");
});

test("əlaqəsiz sual dəqiq cavabı tetiklemir: model cavab verir", async () => {
  const before = generated.length;
  const out = await ask("Qaytarma şərtləriniz nədir ətraflı izah edin");
  assert.equal(out.answer, "Model cavabı.");
  assert.equal(generated.length, before + 1);
});

test("redaktə: cavab dəyişir və yenisi işləyir; siyahıda questions/answer görünür; limitlər sayılır", async () => {
  const list = await (await call("GET", kb())).json();
  const qa = list.sources.find((s) => s.type === "qa");
  assert.equal(qa.answer.startsWith("Bakı"), true);
  assert.equal(list.totals.qa, 1); assert.equal(list.totals.sources, 0, "sual-cavab adi mənbə limitinə daxil deyil");
  const put = await call("PUT", kb(`/qa/${qa.id}`), { questions: ["Çatdırılma neçə günə olur"], answer: "Yeni cavab: 1 gün." });
  assert.equal(put.status, 200);
  assert.equal((await ask("Çatdırılma neçə günə olur")).answer, "Yeni cavab: 1 gün.");
  assert.equal((await call("PUT", kb("/qa/yoxdur"), { questions: ["abc de"], answer: "xx" })).status, 404);
  const after = await (await call("GET", kb())).json();
  assert.equal(after.sources.find((s) => s.type === "qa").questions.length, 1);
});

test("silmək: cütlük silinir, sual yenidən modelə gedir", async () => {
  const list = await (await call("GET", kb())).json();
  const qa = list.sources.find((s) => s.type === "qa");
  assert.equal((await call("DELETE", kb(`/sources/${qa.id}`))).status, 200);
  const before = generated.length;
  const out = await ask("Çatdırılma neçə günə olur");
  assert.equal(out.answer, "Model cavabı.");
  assert.equal(generated.length, before + 1);
});
