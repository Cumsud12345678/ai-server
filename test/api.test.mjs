import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock, demoTenant, tmpFile } from "../testkit/helpers.mjs";
import { hashKey } from "../src/tenants/tenantStore.js";

let mock, base, server, calls = [];

before(async () => {
  mock = await startMock();
  const rest = { ...demoTenant(mock.url), tenantId: "rest-t", apiKeyHash: hashKey("rest-key"), limits: { monthlyRequests: 100, ratePerMinute: 100 } };
  const mem = { tenantId: "mem-t", apiKeyHash: hashKey("mem-key"), language: "en", limits: { monthlyRequests: 2, ratePerMinute: 100 },
    profile: { maxResults: 3, domain: "cars" }, source: { type: "memory" } };
  process.env.TENANTS_FILE = tmpFile("tenants.json", JSON.stringify([rest, mem]));
  process.env.USAGE_FILE = tmpFile("usage.json", "{}");
  process.env.BILLING_FILE = tmpFile("billing.json", "{}");

  // saxta Gemini: 1-ci çağırışda alət çağırır, 2-ci çağırışda mətn yazır
  const fake = { models: { generateContent: async (p) => {
    calls.push(p);
    const first = calls.filter((c) => c === p).length && !p.contents.some((c) => c.parts.some((x) => x.functionResponse));
    return first
      ? { functionCalls: [{ name: "search_listings", args: { maxPrice: 10000, make: "Toyota", fuelType: "Benzin" } }],
          candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "search_listings", args: {} } }] } }], usageMetadata: { totalTokenCount: 50 } }
      : { functionCalls: undefined, text: "Tapdım!", candidates: [{ content: { role: "model", parts: [{ text: "Tapdım!" }] } }], usageMetadata: { totalTokenCount: 70 } };
  } } };
  const { createApp } = await import("../src/app.js");
  const { advise } = await import("../src/ai/advisor.js");
  server = await new Promise((res) => { const s = createApp({ adviseFn: (o) => advise(o, fake) }).listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); mock.server.close(); });

const post = (key, body) => fetch(`${base}/v1/chat`, { method: "POST", headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) }, body: JSON.stringify(body) });

test("açarsız / yanlış açar → 401", async () => {
  assert.equal((await post(null, { message: "salam" })).status, 401);
  assert.equal((await post("yanlis", { message: "salam" })).status, 401);
});
test("boş / çox uzun mesaj → 400", async () => {
  assert.equal((await post("rest-key", { message: "" })).status, 400);
  assert.equal((await post("rest-key", { message: "x".repeat(501) })).status, 400);
});
test("/v1/chat: müştərinin API-sindən elanlar, dinamik alət və token sayğacı", async () => {
  const r = await post("rest-key", { message: "10000-ə Toyota" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.answer, "Tapdım!");
  assert.ok(j.listings.length >= 1 && j.listings.every((l) => l.make === "Toyota" && l.price <= 10000));
  assert.equal(j.usage.tokens, 120);
  const decl = calls[0].config.tools[0].functionDeclarations[0];
  assert.ok(decl.parameters.properties.make && !decl.parameters.properties.fuelType, "müştərinin dəstəkləmədiyi filtr aləti yoxdur");
  assert.match(calls[0].config.systemInstruction, /Müştəri Avto/);
  assert.match(calls[0].config.systemInstruction, /Markalar: BMW, Hyundai/);
  const u = await (await fetch(`${base}/v1/usage`, { headers: { authorization: "Bearer rest-key" } })).json();
  assert.equal(u.requests >= 1, true);
});
test("müştəri API-si sönübsə, AI-a xəta verilir və server çökmür", async () => {
  mock.server.close(); mock.server.closeAllConnections?.();
  const t = await fetch(`${base}/v1/listings?maxPrice=1`, { headers: { authorization: "Bearer rest-key" } });
  assert.equal(t.status, 502);
});
test("aylıq limit → 429; dil və maxResults tenant-dan", async () => {
  assert.equal((await post("mem-key", { message: "a" })).status, 200);
  assert.equal((await post("mem-key", { message: "b" })).status, 200);
  const r = await post("mem-key", { message: "c" });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, "MONTHLY_LIMIT");
  const sys = calls.at(-1).config.systemInstruction;
  assert.match(sys, /English only/);
  assert.match(sys, /Ən çox 3 elan/);
});
test("/v1/listings: nümunə tenant, limit tenant-ın maxResults-ı ilə məhdudlaşır", async () => {
  const r = await (await fetch(`${base}/v1/listings?limit=50`, { headers: { authorization: "Bearer mem-key" } })).json();
  assert.equal(r.count, 3);
});
