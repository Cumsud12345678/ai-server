// Operator qaralaması: model yalnız mətn qaytarır, ziyarətçiyə heç nə getmir, balans çıxılır, giriş yoxlanır.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpFile } from "../testkit/helpers.mjs";

const TOKEN = "draft-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
let base, server, tenantId, seen;
const fake = {
  models: {
    embedContent: async ({ contents }) => ({ embeddings: contents.map(() => ({ values: new Array(8).fill(0.1) })) }),
    generateContent: async ({ contents, config }) => { seen.push({ system: config.systemInstruction, text: contents[0].parts[0].text }); return { text: "\"Salam, sifarişiniz sabah çatdırılacaq.\"", usageMetadata: { totalTokenCount: 50, promptTokenCount: 40, candidatesTokenCount: 10 } }; },
  },
};
const call = (m, p, b) => fetch(`${base}/v1/service/tenants/${tenantId}${p}`, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) });

before(async () => {
  Object.assign(process.env, { SERVICE_TOKEN: TOKEN, TENANT_SECRET_ENCRYPTION_KEY: "ef".repeat(32) });
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}"); process.env.BILLING_FILE = tmpFile("billing.json", "{}"); process.env.KB_FILE = tmpFile("kb.json", "{}");
  seen = [];
  const { useGeminiClient } = await import("../src/kb/client.js");
  useGeminiClient(fake);
  const { createApp } = await import("../src/app.js");
  server = await new Promise((r) => { const s = createApp().listen(0, () => r(s)); });
  base = `http://localhost:${server.address().port}`;
  ({ tenantId } = await (await fetch(`${base}/v1/service/tenants`, { method: "POST", headers: H, body: JSON.stringify({ businessName: "Mağaza", domain: "magaza.az", profile: { language: "az", mode: "support", tone: "rəsmi" } }) })).json());
});
after(() => server.close());

test("qaralama: söhbət və təlimat modelə gedir, dırnaq təmizlənir, token sayılır", async () => {
  const r = await call("POST", "/draft", { messages: [{ from: "visitor", text: "Sifarişim nə vaxt gələcək?" }, { from: "operator", text: "Yoxlayıram" }], context: [{ role: "user", text: "salam" }] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.draft, "Salam, sifarişiniz sabah çatdırılacaq."); assert.equal(j.usage.tokens, 50);
  assert.match(seen.at(-1).text, /Müştəri: Sifarişim nə vaxt gələcək\?/); assert.match(seen.at(-1).text, /Operator: Yoxlayıram/);
  assert.match(seen.at(-1).system, /uydurma/); assert.match(seen.at(-1).system, /rəsmi/);
});

test("yanlış giriş rədd olunur: boş, çox uzun, yanlış rol, tipi səhv", async () => {
  for (const b of [{}, { messages: [] }, { messages: "x" }, { messages: [{ from: "hacker", text: "x" }] }, { messages: [{ from: "visitor", text: 5 }] }, { messages: Array.from({ length: 21 }, () => ({ from: "visitor", text: "x" })) }, { messages: [{ from: "visitor", text: "x" }], context: [{ role: "system", text: "x" }] }])
    assert.equal((await call("POST", "/draft", b)).status, 400, JSON.stringify(b).slice(0, 60));
});

test("xidmət tokeni olmadan çağırış mümkün deyil", async () => {
  const r = await fetch(`${base}/v1/service/tenants/${tenantId}/draft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ from: "visitor", text: "x" }] }) });
  assert.ok([401, 403].includes(r.status));
});
