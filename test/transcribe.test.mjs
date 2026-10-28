import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock, demoTenant, tmpFile } from "../testkit/helpers.mjs";
import { sniffAudio, transcribeAudio, validateAudio } from "../src/ai/transcribe.js";

const TOKEN = "tr-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]);
const AUD = { data: OGG.toString("base64") };

test("validateAudio: tip baytlardan təyin olunur, saxta və böyük fayl rədd olunur", () => {
  assert.equal(sniffAudio(OGG), "audio/ogg");
  assert.equal(validateAudio(AUD).mime, "audio/ogg");
  assert.equal(sniffAudio(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A "), Buffer.alloc(10)])), "audio/mp4");
  assert.ok(validateAudio({ data: Buffer.from("<html>salam dünya bu mətn").toString("base64") }).error);
  assert.ok(validateAudio({ data: "!!!" }).error);
  assert.ok(validateAudio({ data: Buffer.concat([Buffer.from("OggS"), Buffer.alloc(2_100_000)]).toString("base64") }).error);
  assert.ok(validateAudio(null).error);
});

test("transcribeAudio: mətn və token qaytarır; ANLAŞILMAZ və boş cavab unclear sayılır", async () => {
  const calls = [];
  const mk = (text) => ({ models: { async generateContent(p) { calls.push(p); return { text, usageMetadata: { totalTokenCount: 120, promptTokenCount: 100, candidatesTokenCount: 20 } }; } } });
  const ok = await transcribeAudio({ audio: { mime: "audio/ogg", data: AUD.data }, client: mk("  Salam,   qara motosiklet axtarıram ") });
  assert.equal(ok.text, "Salam, qara motosiklet axtarıram"); assert.equal(ok.unclear, false); assert.equal(ok.tokens, 120);
  assert.equal(calls[0].contents[0].parts[0].inlineData.mimeType, "audio/ogg");
  assert.equal((await transcribeAudio({ audio: { mime: "audio/ogg", data: AUD.data }, client: mk("ANLAŞILMAZ") })).unclear, true);
  assert.equal((await transcribeAudio({ audio: { mime: "audio/ogg", data: AUD.data }, client: mk(" ") })).unclear, true);
});

let mock, base, server, tenantId;
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
  const { createApp } = await import("../src/app.js");
  const transcribeFn = async () => ({ text: "qara motosiklet", unclear: false, tokens: 150, costUsd: 0.0004 });
  server = await new Promise((res) => { const s = createApp({ transcribeFn }).listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
  const r = await call("POST", "/v1/service/tenants", { businessName: "Test Avto", domain: "test.az", profile: { language: "az", maxResults: 5 }, source, apiSecret: "test-secret" });
  tenantId = (await r.json()).tenantId;
});
after(() => { server.close(); mock.server.close(); });

test("/transcribe: mətn qaytarır, xərc yazılır; pis audio 400; servis tokensiz 401", async () => {
  const before = await (await call("GET", `/v1/service/tenants/${tenantId}/billing`)).json();
  const r = await call("POST", `/v1/service/tenants/${tenantId}/transcribe`, { audio: AUD });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.text, "qara motosiklet"); assert.equal(b.usage.tokens, 150);
  const after = await (await call("GET", `/v1/service/tenants/${tenantId}/billing`)).json();
  assert.ok(after.balance.totalAzn < before.balance.totalAzn, "səs çevirmə balansdan çıxılır");
  const bad = await call("POST", `/v1/service/tenants/${tenantId}/transcribe`, { audio: { data: Buffer.from("not audio at all!!").toString("base64") } });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).code, "BAD_AUDIO");
  const noAuth = await fetch(`${base}/v1/service/tenants/${tenantId}/transcribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ audio: AUD }) });
  assert.equal(noAuth.status, 401);
});
