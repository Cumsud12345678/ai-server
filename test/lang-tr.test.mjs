// Türk dili: profil dili tr qəbul olunur, cavabsızlıq mətni və draft dili türkcədir, yanlış dil rədd olunur.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpFile } from "../testkit/helpers.mjs";

const TOKEN = "tr-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
let base, server, tenantId, seen;
const fake = {
  models: {
    embedContent: async ({ contents }) => ({ embeddings: contents.map(() => ({ values: new Array(8).fill(0.1) })) }),
    generateContent: async ({ contents, config }) => { seen.push({ system: config.systemInstruction }); return { text: "Merhaba", usageMetadata: { totalTokenCount: 10, promptTokenCount: 8, candidatesTokenCount: 2 } }; },
  },
};
const create = (language) => fetch(`${base}/v1/service/tenants`, { method: "POST", headers: H, body: JSON.stringify({ businessName: "Mağaza", domain: "magaza.az", profile: { language, mode: "support" } }) });

before(async () => {
  Object.assign(process.env, { SERVICE_TOKEN: TOKEN, TENANT_SECRET_ENCRYPTION_KEY: "ab".repeat(32) });
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}"); process.env.BILLING_FILE = tmpFile("billing.json", "{}"); process.env.KB_FILE = tmpFile("kb.json", "{}");
  seen = [];
  const { useGeminiClient } = await import("../src/kb/client.js");
  useGeminiClient(fake);
  const { createApp } = await import("../src/app.js");
  server = await new Promise((r) => { const s = createApp().listen(0, () => r(s)); });
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test("profile.language=tr qəbul olunur, başqa dil rədd olunur", async () => {
  const ok = await create("tr");
  assert.equal(ok.status, 201);
  tenantId = (await ok.json()).tenantId;
  const bad = await create("de");
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /az, en, ru və ya tr/);
});

test("tr tenant: cavabsızlıq mətni türkcədir və qaralama türk dilində istənir", async () => {
  const { fallbackText } = await import("../src/kb/answer.js");
  assert.match(fallbackText({ language: "tr", profile: {} }), /yanıtını bilgilerimizde bulamadım/);
  const r = await fetch(`${base}/v1/service/tenants/${tenantId}/draft`, { method: "POST", headers: H, body: JSON.stringify({ messages: [{ from: "visitor", text: "Merhaba" }] }) });
  assert.equal(r.status, 200);
  assert.match(seen.at(-1).system, /Türkçe/);
});
