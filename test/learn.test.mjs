// Operator cavablarından öyrənmə: şəxsi məlumatlı cütlər atılır, bilik bazasının bildiyi təklif olunmur,
// təklif təsdiqlənəndə sual-cavab yaranır, rədd ediləndə silinir; balans yoxdursa 402.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpFile } from "../testkit/helpers.mjs";

const H = { "content-type": "application/json", authorization: "Bearer ln-token" };
let base, server, tenantId, L, nextPairs = [];
const fakeGemini = {
  models: {
    embedContent: async ({ contents }) => ({ embeddings: contents.map((c) => ({ values: /çatdırılma|delivery/i.test(JSON.stringify(c)) ? [1, 0, 0, 0, 0, 0, 0, 0] : [0, 1, 0, 0, 0, 0, 0, 0] })) }),
    generateContent: async ({ config }) => {
      if (/bilik bazasını genişləndirirsən/.test(config.systemInstruction ?? "")) return { text: JSON.stringify({ pairs: nextPairs }), usageMetadata: { totalTokenCount: 50 } };
      return { text: "ok", usageMetadata: { totalTokenCount: 5 } };
    },
  },
};
const call = (method, path, body) => fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const T = (p = "") => `/v1/service/tenants/${tenantId}${p}`;
const msgs = [{ from: "visitor", text: "Gəncəyə göndərirsiniz?" }, { from: "operator", text: "Bəli, Gəncəyə 2 günə çatdırırıq, 5 AZN" }];

before(async () => {
  Object.assign(process.env, { SERVICE_TOKEN: "ln-token", TENANT_SECRET_ENCRYPTION_KEY: "ab".repeat(32) });
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}"); process.env.BILLING_FILE = tmpFile("billing.json", "{}"); process.env.KB_FILE = tmpFile("kb.json", "{}");
  const { useGeminiClient } = await import("../src/kb/client.js");
  useGeminiClient(fakeGemini);
  L = await import("../src/kb/learn.js");
  const { createApp } = await import("../src/app.js");
  server = await new Promise((r) => { const s = createApp().listen(0, () => r(s)); });
  base = `http://localhost:${server.address().port}`;
  ({ tenantId } = await (await call("POST", "/v1/service/tenants", { businessName: "Mağaza", domain: "m.az", profile: { language: "az", mode: "support" } })).json());
});
after(() => server.close());

test("parsePairs: şəxsi məlumat, təkrar və boş cütlər atılır; ən çox 3", () => {
  const out = L.parsePairs(JSON.stringify({ pairs: [
    { question: "Gəncəyə çatdırılma var?", answer: "Bəli, 2 günə, 5 AZN" },
    { question: "gəncəyə çatdırılma var?", answer: "təkrar" },
    { question: "Sifarişim haradadır?", answer: "Sifariş №10452 yoldadır" },
    { question: "Nömrəniz?", answer: "+994 50 123 45 67" },
    { question: "Qısa", answer: "" },
    { question: "İş saatınız?", answer: "10:00-19:00" }, { question: "Ünvanınız?", answer: "Nizami küç. 5" }, { question: "Kartla ödəniş?", answer: "Bəli" },
  ] }));
  assert.deepEqual(out.map((p) => p.question), ["Gəncəyə çatdırılma var?", "İş saatınız?", "Ünvanınız?"]);
  assert.deepEqual(L.parsePairs("pozuq json"), []);
  assert.equal(L.validLearnInput({ messages: [{ from: "visitor", text: "salam" }, { from: "operator", text: "ok" }] }), false, "qısa operator cavabı yetmir");
});

test("söhbətdən təklif yaranır, təsdiqlənəndə sual-cavab olur; bilik bazası artıq bilirsə təklif olunmur", async () => {
  nextPairs = [{ question: "Gəncəyə çatdırılma var?", answer: "Bəli, 2 günə, 5 AZN" }];
  const r = await (await call("POST", T("/kb/learn"), { messages: msgs, chatId: "chat-1" })).json();
  assert.equal(r.added, 1);
  const list = await (await call("GET", T("/kb/suggestions"))).json();
  assert.equal(list.items[0].question, "Gəncəyə çatdırılma var?");
  assert.equal(list.items[0].chatId, "chat-1");
  const acc = await call("POST", T(`/kb/suggestions/${list.items[0].id}/accept`), { questions: ["Gəncəyə çatdırılma var?", "Gəncəyə çatdırılma olur?"], answer: "Bəli, Gəncəyə 2 günə çatdırırıq, 5 AZN." });
  assert.equal(acc.status, 201);
  assert.equal((await acc.json()).source.type, "qa");
  assert.equal((await (await call("GET", T("/kb/suggestions"))).json()).items.length, 0);
  // Eyni mövzu ikinci dəfə: köməkçi artıq bilir
  const again = await (await call("POST", T("/kb/learn"), { messages: msgs })).json();
  assert.equal(again.added, 0);
});

test("rədd: təklif silinir; düzgün olmayan giriş 400", async () => {
  nextPairs = [{ question: "İş saatınız neçədir?", answer: "Hər gün 10:00-19:00" }];
  assert.equal((await (await call("POST", T("/kb/learn"), { messages: msgs })).json()).added, 1);
  const id = (await (await call("GET", T("/kb/suggestions"))).json()).items[0].id;
  assert.equal((await call("DELETE", T(`/kb/suggestions/${id}`))).status, 200);
  assert.equal((await call("DELETE", T(`/kb/suggestions/${id}`))).status, 404);
  assert.equal((await call("POST", T("/kb/learn"), { messages: [{ from: "visitor", text: "salam" }] })).status, 400);
});
