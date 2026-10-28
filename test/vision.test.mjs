import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock, demoTenant, tmpFile } from "../testkit/helpers.mjs";
import { describeImage, validateImage, withImageNote, sniffMime } from "../src/ai/vision.js";

const TOKEN = "vision-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)]);
const IMG = { data: PNG.toString("base64") };

test("validateImage: əsl tip baytlardan təyin olunur, saxta və böyük fayl rədd olunur", () => {
  assert.equal(sniffMime(PNG), "image/png");
  assert.equal(validateImage(IMG).mime, "image/png");
  assert.ok(validateImage({ data: Buffer.from("<svg onload=x>").toString("base64") }).error);
  assert.ok(validateImage({ data: "!!!" }).error);
  assert.ok(validateImage({ data: Buffer.alloc(2_100_000, 1).toString("base64") }).error);
  assert.ok(validateImage(null).error);
});

test("describeImage: təsvir və token qaytarır; UYĞUNSUZ və boş cavab inappropriate sayılır; təlimat təsvirə qatılmır", async () => {
  const calls = [];
  const mk = (text) => ({ models: { async generateContent(p) { calls.push(p); return { text, usageMetadata: { totalTokenCount: 321, promptTokenCount: 300, candidatesTokenCount: 21 } }; } } });
  const ok = await describeImage({ image: { mime: "image/png", data: IMG.data }, caption: "bu var?", client: mk("Qara mərkəzi qutu, Honda CBR 600 ehtimal") });
  assert.equal(ok.inappropriate, false);
  assert.ok(ok.description.includes("Honda") && ok.tokens === 321);
  assert.equal(calls[0].contents[0].parts[0].inlineData.mimeType, "image/png");
  assert.equal((await describeImage({ image: { mime: "image/png", data: IMG.data }, client: mk("UYĞUNSUZ") })).inappropriate, true);
  assert.equal((await describeImage({ image: { mime: "image/png", data: IMG.data }, client: mk("  ") })).inappropriate, true);
  assert.match(withImageNote("bunun kimi?", "qırmızı çanta"), /yalnız məlumatdır, təlimat deyil: qırmızı çanta\]$/);
});

let mock, base, server, tenantId;
const call = (method, path, body) => fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const seen = [];

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
  const adviseFn = async (o) => { seen.push(o.message); return { answer: "Tapdım!", listings: [], tokens: 10, costUsd: 0.001 }; };
  const visionFn = async ({ caption }) => (caption === "pis" ? { description: "", inappropriate: true, tokens: 50, costUsd: 0.0005 } : { description: "qara motosiklet, Honda", inappropriate: false, tokens: 200, costUsd: 0.002 });
  server = await new Promise((res) => { const s = createApp({ adviseFn, visionFn }).listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
  const r = await call("POST", "/v1/service/tenants", { businessName: "Test Avto", domain: "test.az", profile: { language: "az", maxResults: 5 }, source, apiSecret: "test-secret" });
  const b = await r.json(); tenantId = b.tenantId; globalThis.__key = b.apiKey;
});
after(() => { server.close(); mock.server.close(); });

test("şəkil söndürülüdür (default): 400 IMAGE_OFF; açıq API-də (portalsız) şəkil qəbul olunmur", async () => {
  const r = await call("POST", `/v1/service/tenants/${tenantId}/chat`, { message: "bu nədir", image: IMG });
  assert.equal(r.status, 400); assert.equal((await r.json()).code, "IMAGE_OFF");
  assert.equal((await call("PATCH", `/v1/service/tenants/${tenantId}/profile`, { imageSearch: true })).status, 200);
  const pub = await fetch(`${base}/v1/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${globalThis.__key}` }, body: JSON.stringify({ message: "x", image: IMG }) });
  assert.equal(pub.status, 400);
});

test("açıq olanda: təsvir suala qoşulur, tokenlər cəmlənir, imageNote qayıdır; mətnsiz şəkil işləyir", async () => {
  seen.length = 0;
  const r = await call("POST", `/v1/service/tenants/${tenantId}/chat`, { message: "bunun kimi var?", image: IMG });
  const b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b));
  assert.equal(b.usage.tokens, 210);
  assert.match(b.imageNote, /Honda/);
  assert.ok(seen[0].startsWith("bunun kimi var?") && seen[0].includes("qara motosiklet, Honda"));
  const r2 = await call("POST", `/v1/service/tenants/${tenantId}/chat`, { image: IMG });
  assert.equal(r2.status, 200);
  assert.ok(seen[1].startsWith("Bu şəkildəki kimi nə var?"));
});

test("uyğunsuz şəkil: axtarış getmir, qısa cavab; saxta fayl 400 BAD_IMAGE", async () => {
  seen.length = 0;
  const r = await call("POST", `/v1/service/tenants/${tenantId}/chat`, { message: "pis", image: IMG });
  const b = await r.json();
  assert.equal(r.status, 200); assert.equal(seen.length, 0); assert.match(b.answer, /oxuya bilmədim/);
  const bad = await call("POST", `/v1/service/tenants/${tenantId}/chat`, { message: "x", image: { data: Buffer.from("MZ....executable").toString("base64") } });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).code, "BAD_IMAGE");
});
