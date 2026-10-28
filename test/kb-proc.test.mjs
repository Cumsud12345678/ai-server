import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpFile } from "../testkit/helpers.mjs";

const TOKEN = "proc-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
let base, server, tenantId, systems, texts;

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
    generateContent: async ({ contents, config }) => { systems.push(String(config?.systemInstruction ?? "")); texts.push(contents.at(-1).parts[0].text); return { text: "Model cavabı.\n[[S:1]]", usageMetadata: { totalTokenCount: 50 } }; },
  },
};
const call = (method, path, body) => fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const kb = (p = "") => `/v1/service/tenants/${tenantId}/kb${p}`;
const ask = async (message) => (await (await fetch(`${base}/v1/service/tenants/${tenantId}/chat`, { method: "POST", headers: H, body: JSON.stringify({ message }) })).json());
const STEPS = "1. Sifariş nömrəsini soruş.\n2. Məhsulun açılıb-açılmadığını soruş.\n3. 14 gün keçməyibsə qaytarma formasını göndər.";

before(async () => {
  process.env.SERVICE_TOKEN = TOKEN;
  process.env.TENANT_SECRET_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}");
  process.env.BILLING_FILE = tmpFile("billing.json", "{}");
  process.env.KB_FILE = tmpFile("kb.json", "{}");
  process.env.KB_MIN_COSINE = "0.3"; process.env.KB_MIN_COSINE_KW = "0.25";
  process.env.KB_PROC_COSINE = "0.5"; process.env.KB_MAX_PROC = "2";
  systems = []; texts = [];
  (await import("../src/kb/client.js")).useGeminiClient(fakeGemini);
  const { createApp } = await import("../src/app.js");
  server = await new Promise((res) => { const s = createApp().listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
  const r = await call("POST", "/v1/service/tenants", { businessName: "Test Mağaza", domain: "magaza.az", profile: { language: "az", mode: "support" } });
  ({ tenantId } = await r.json());
});
after(() => server.close());

test("yoxlama: ad, ifadə və addımlar düzgün olmalıdır", async () => {
  for (const body of [{ name: "", triggers: ["qaytarma"], steps: STEPS }, { name: "Qaytarma", triggers: [], steps: STEPS }, { name: "Qaytarma", triggers: ["qaytarmaq istəyirəm"], steps: "qısa" }, { name: "Qaytarma", triggers: Array.from({ length: 7 }, (_, i) => `ifadə nömrə ${i}`), steps: STEPS }, { name: "Qaytarma", triggers: ["qaytarmaq istəyirəm"], steps: "x".repeat(2600) }]) {
    const r = await call("POST", kb("/proc"), body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal((await r.json()).code, "BAD_PROC");
  }
});

test("ssenari işə düşəndə addımlar sistem təlimatına düşür; əlaqəsiz sualda düşmür; ssenari kontekstdə görünmür", async () => {
  const r = await call("POST", kb("/proc"), { name: "Məhsulun qaytarılması", triggers: ["məhsulu qaytarmaq istəyirəm", "pulumu geri qaytarın"], steps: STEPS });
  assert.equal(r.status, 201);
  const { source } = await r.json();
  assert.equal(source.type, "proc"); assert.equal(source.status, "ready"); assert.equal(source.triggers.length, 2); assert.equal(source.steps, STEPS);
  const out = await ask("məhsulu qaytarmaq istəyirəm");
  assert.ok(out.answer);
  assert.ok(systems.at(-1).includes("SSENARİ \"Məhsulun qaytarılması\"") && systems.at(-1).includes("Sifariş nömrəsini soruş"), "addımlar təlimatdadır");
  assert.ok(!texts.at(-1).includes("Nə vaxt:"), "ssenari mətni KONTEKSTə düşmür");
  await ask("iş saatlarınız necədir");
  assert.ok(!systems.at(-1).includes("SSENARİ"), "əlaqəsiz sualda ssenari yoxdur");
});

test("yeniləmə, siyahı, say və limit; silmə işləyir; sual-cavab/mənbə limitinə qarışmır", async () => {
  const list0 = await (await call("GET", kb())).json();
  const id = list0.sources.find((s) => s.type === "proc").id;
  const up = await call("PUT", kb(`/proc/${id}`), { name: "Qaytarma", triggers: ["qaytarmaq istəyirəm"], steps: STEPS + "\n4. Təşəkkür et." });
  assert.equal(up.status, 200);
  assert.equal((await up.json()).source.name, "Qaytarma");
  assert.equal((await call("PUT", kb("/proc/yoxdur"), { name: "Qaytarma", triggers: ["qaytarmaq istəyirəm"], steps: STEPS })).status, 404);
  const list = await (await call("GET", kb())).json();
  assert.equal(list.totals.proc, 1); assert.equal(list.totals.sources, 0); assert.equal(list.limits.proc, 2);
  assert.equal((await call("POST", kb("/proc"), { name: "İkinci", triggers: ["sifariş ləğvi"], steps: STEPS })).status, 201);
  const over = await call("POST", kb("/proc"), { name: "Üçüncü", triggers: ["görüş rezervi"], steps: STEPS });
  assert.equal(over.status, 400); assert.equal((await over.json()).code, "SOURCE_LIMIT");
  assert.equal((await call("DELETE", kb(`/sources/${id}`))).status, 200);
  assert.equal((await (await call("GET", kb())).json()).totals.proc, 1);
});

test("'both' rejimində search_knowledge aləti ssenarini təlimat kimi qaytarır", async () => {
  const { runKbTool } = await import("../src/kb/answer.js");
  const ctx = {};
  const r = await runKbTool({ tenantId }, { query: "sifariş ləğvi" }, ctx, fakeGemini);
  assert.equal(r.found, true);
  assert.equal(r.procedure.name, "İkinci");
  assert.ok(r.procedure.steps.includes("Sifariş nömrəsini soruş"));
  assert.ok(!(r.snippets ?? []).some((s) => String(s.text).includes("Nə vaxt:")), "ssenari parçası snippet kimi çıxmır");
});
