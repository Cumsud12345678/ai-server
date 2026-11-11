// Ağıllı operator çağırışı: səbəblər sahibin ayarına görə aktivdir, dəstək rejimində də alət var, cavabda səbəb qayıdır.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpFile } from "../testkit/helpers.mjs";

const H = { "content-type": "application/json", authorization: "Bearer ho-token" };
let base, server, tenantId, h, seen = [], nextCall = null;

const fakeGemini = {
  models: {
    embedContent: async ({ contents }) => ({ embeddings: contents.map(() => ({ values: new Array(8).fill(0.1) })) }),
    generateContent: async ({ contents, config }) => {
      const decls = config.tools?.[0]?.functionDeclarations ?? [];
      seen.push({ decls, system: config.systemInstruction });
      const fr = contents.at(-1).parts.find((p) => p.functionResponse);
      if (fr) return { text: `Cavab: ${JSON.stringify(fr.functionResponse.response.result)}`, usageMetadata: { totalTokenCount: 30 } };
      const c = nextCall; nextCall = null;
      if (c) return { functionCalls: [{ name: "request_operator", args: c }], candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "request_operator", args: c } }] } }], usageMetadata: { totalTokenCount: 20 } };
      return { text: "Salam, necə kömək edim?", usageMetadata: { totalTokenCount: 10 } };
    },
  },
};
const call = (method, path, body, headers = H) => fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const chat = async (args, extra = {}) => { nextCall = args; return (await call("POST", `/v1/service/tenants/${tenantId}/chat`, { message: "pulumu qaytarın, heç kim cavab vermir!", sid: "sid-ho-xxxxx", channel: "whatsapp", ...extra })).json(); };
const tool = () => seen.at(-1).decls.find((d) => d.name === "request_operator");

before(async () => {
  Object.assign(process.env, { SERVICE_TOKEN: "ho-token", TENANT_SECRET_ENCRYPTION_KEY: "ab".repeat(32) });
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}"); process.env.BILLING_FILE = tmpFile("billing.json", "{}"); process.env.KB_FILE = tmpFile("kb.json", "{}");
  const { useGeminiClient } = await import("../src/kb/client.js");
  useGeminiClient(fakeGemini);
  h = await import("../src/ai/handoff.js");
  const { createApp } = await import("../src/app.js");
  server = await new Promise((r) => { const s = createApp().listen(0, () => r(s)); });
  base = `http://localhost:${server.address().port}`;
  ({ tenantId } = await (await call("POST", "/v1/service/tenants", { businessName: "Mağaza", domain: "m.az", profile: { language: "az", mode: "support" } })).json());
});
after(() => server.close());

test("qaydalar: defolt köhnə davranış (istəyəndə + kömək edə bilməyəndə); söndürülmüş səbəb enum-da yoxdur", () => {
  assert.deepEqual(h.cleanHandoffRules(undefined), { cantHelp: true, upset: false, ready: false });
  const d = h.handoffDeclaration({ upset: true, ready: false, cantHelp: false });
  assert.deepEqual(d.parameters.properties.reason.enum, ["asked", "upset"]);
  assert.match(d.description, /narazı/);
  assert.doesNotMatch(d.description, /ready_to_buy/);
  assert.match(h.handoffDeclaration({ ready: true }, { orderForm: true }).description, /sifariş forması/, "forma varsa əvvəl onu doldurur");
});

test("dəstək rejimində alət var; narazı müştəri səbəblə ötürülür, cavabda handoffReason və qeyd qayıdır", async () => {
  const r = await chat({ reason: "upset", note: "Pulunu geri istəyir" }, { handoff: { upset: true, ready: true, cantHelp: true }, live: true });
  assert.ok(tool(), "request_operator aləti dəstək rejimində də verilir");
  assert.deepEqual(tool().parameters.properties.reason.enum, ["asked", "cant_help", "upset", "ready_to_buy"]);
  assert.match(seen.at(-1).system, /narazı və ya əsəbidirsə/);
  assert.equal(r.handoff, true);
  assert.equal(r.handoffReason, "upset");
  assert.equal(r.handoffNote, "Pulunu geri istəyir");
  assert.match(r.answer, /canlı operatora ötürülür/, "canlı operator varsa ona uyğun cavab");
});

test("sahib söndürübsə həmin səbəblə ötürmə olmur (model söhbəti davam etdirir)", async () => {
  const r = await chat({ reason: "ready_to_buy" }, { handoff: { upset: false, ready: false, cantHelp: true } });
  assert.notEqual(r.handoff, true);
  assert.match(r.answer, /aktiv deyil/);
});

test("açıq API-də (portal yox) yalnız istəyəndə və kömək edə bilməyəndə", async () => {
  // Açıq API: handoff qaydaları qəbul olunmur
  const key = (await (await call("POST", `/v1/service/tenants/${tenantId}/rotate-key`)).json()).apiKey;
  nextCall = { reason: "asked" };
  const r = await (await call("POST", "/v1/chat", { message: "operatorla danışmaq istəyirəm", handoff: { upset: true, ready: true } }, { "content-type": "application/json", authorization: `Bearer ${key}` })).json();
  assert.deepEqual(tool().parameters.properties.reason.enum, ["asked", "cant_help"]);
  assert.equal(r.handoff, true);
  assert.equal(r.handoffReason, "asked");
  assert.match(r.answer, /əlaqə formu/, "canlı operator yoxdur: əlaqə formu");
});
