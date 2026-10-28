// Əməliyyatlar: heç nə təsdiqsiz icra olunmur, parametrlər yoxlanır, kimlik bağlıdır, sorğu təhlükəsizdir.
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { tmpFile } from "../testkit/helpers.mjs";

const TOKEN = "act-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
let apiKey, base, server, shop, shopUrl, tenantId, mod, act, secret, signing, shopCalls, nextCall;

const fakeGemini = {
  models: {
    embedContent: async ({ contents }) => ({ embeddings: contents.map(() => ({ values: new Array(8).fill(0.1) })) }),
    generateContent: async ({ contents, config }) => {
      const names = (config.tools?.[0]?.functionDeclarations ?? []).map((d) => d.name);
      const last = contents.at(-1);
      const fr = last.parts.find((p) => p.functionResponse);
      if (fr) return { text: `Cavab: ${JSON.stringify(fr.functionResponse.response.result)}`, usageMetadata: { totalTokenCount: 40 } };
      const call = nextCall;
      nextCall = null;
      if (call && names.includes(call.name)) return { functionCalls: [{ name: call.name, args: call.args }], candidates: [{ content: { role: "model", parts: [{ functionCall: call }] } }], usageMetadata: { totalTokenCount: 20 } };
      return { text: names.length ? "Salam" : "Əməliyyat mümkün deyil.", usageMetadata: { totalTokenCount: 10 } };
    },
  },
};

const call = (method, path, body) => fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const T = (p = "") => `/v1/service/tenants/${tenantId}${p}`;
let n = 0;
const chat = async (message, { identity, sid = `sid-act-${++n}-xxxxxx`, ask } = {}) => { nextCall = ask ? { name: ask.name, args: ask.args } : null; return { sid, r: await (await call("POST", T("/chat"), { message, identity, sid, channel: "widget" })).json() }; };
const decide = async (id, decision, sid, identity) => (await call("POST", T("/actions/confirm"), { id, decision, sid, identity })).json();
const actions = (over = {}) => ({
  baseUrl: shopUrl, auth: { type: "bearer" }, apiSecret: "API-SIRR",
  items: [
    { key: "cancel_order", title: "Sifarişi ləğv et", description: "İstifadəçi öz sifarişini ləğv etmək istəyəndə", method: "POST", path: "/orders/{orderNo}/cancel", requireIdentity: true,
      params: [{ name: "orderNo", type: "string", description: "Sifariş nömrəsi", required: true, maxLength: 20 }, { name: "reason", type: "enum", description: "Səbəb", enum: ["gec", "səhv", "başqa"] }],
      confirmText: "Sifariş {orderNo} ləğv olunacaq", successMessage: "Sifariş {orderNo} ləğv edildi." },
    { key: "create_ticket", title: "Bilet yarat", description: "İstifadəçi problem barədə bilet açmaq istəyəndə", method: "POST", path: "/tickets",
      params: [{ name: "subject", type: "string", description: "Mövzu", required: true, maxLength: 50 }, { name: "priority", type: "integer", description: "Prioritet", min: 1, max: 3 }, { name: "urgent", type: "boolean", description: "Təcili" }] },
    { key: "slow_thing", title: "Yavaş", description: "Cavab verməyən test əməliyyatı", method: "POST", path: "/slow" },
    { key: "bad_thing", title: "Xətalı", description: "Həmişə xəta qaytaran test əməliyyatı", method: "POST", path: "/fail" },
  ], ...over,
});

before(async () => {
  Object.assign(process.env, { SERVICE_TOKEN: TOKEN, TENANT_SECRET_ENCRYPTION_KEY: "cd".repeat(32), ALLOW_LOCAL_CONNECTORS: "1", ACTION_TIMEOUT_MS: "400" });
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}"); process.env.BILLING_FILE = tmpFile("billing.json", "{}"); process.env.KB_FILE = tmpFile("kb.json", "{}");
  shopCalls = [];
  const { useGeminiClient } = await import("../src/kb/client.js");
  useGeminiClient(fakeGemini);
  mod = await import("../src/private/privateData.js");
  act = await import("../src/actions/actions.js");
  shop = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      shopCalls.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/slow") return; // cavab verilmir
      if (req.headers.authorization !== "Bearer API-SIRR") { res.statusCode = 401; return res.end("{}"); }
      if (req.url === "/fail") { res.statusCode = 409; return res.end(JSON.stringify({ message: "<b>Artıq göndərilib</b>" })); }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => shop.listen(0, r));
  shopUrl = `http://localhost:${shop.address().port}`;
  const { createApp } = await import("../src/app.js");
  server = await new Promise((res) => { const s = createApp().listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
  ({ tenantId, apiKey } = await (await call("POST", "/v1/service/tenants", { businessName: "Mağaza", domain: "magaza.az", profile: { language: "az", mode: "support" } })).json());
  // identity üçün şəxsi məlumat mənbəyi
  await call("PUT", T("/private-data"), { baseUrl: shopUrl, auth: { type: "bearer" }, apiSecret: "API-SIRR", sources: [{ key: "orders", title: "Sifarişlər", description: "istifadəçinin sifarişləri", path: "/users/{userId}/orders", itemsPath: "data", fields: { "Nömrə": "id" } }] });
  secret = (await (await call("POST", T("/private-data/identity-secret"))).json()).identitySecret;
});
after(() => { server.close(); shop.close(); });
beforeEach(() => act?.resetActionLimits());

test("konfiqurasiya yoxlanır: HTTPS, metod, yol, parametr, yer tutucu, sirr cavabda yoxdur", async () => {
  const bad = async (mut, re) => { const c = actions(); mut(c); const r = await call("PUT", T("/actions"), c); assert.equal(r.status, 400); assert.match((await r.json()).error, re); };
  await bad((c) => { c.baseUrl = "http://evil.az"; }, /HTTPS/);
  await bad((c) => { c.items[0].method = "GET"; }, /method/);
  await bad((c) => { c.items[0].path = "/orders/../x"; }, /path/);
  await bad((c) => { c.items[0].path = "/orders/{nope}/cancel"; }, /yer tutucusu/);
  await bad((c) => { c.items[1].path = "/u/{userId}"; }, /requireIdentity/);
  await bad((c) => { c.items[0].params[0].name = "userId"; }, /userId/);
  await bad((c) => { c.items[0].confirmText = "Salam {userId}"; }, /userId/);
  await bad((c) => { c.items[1].key = "cancel_order"; }, /təkrarlanır/);
  await bad((c) => { c.items[0].description = "qısa"; }, /description/);
  await bad((c) => { c.items[0].params[1].enum = ["tək"]; }, /enum/);
  await bad((c) => { c.items = []; }, /Ən azı/);
  await bad((c) => { delete c.apiSecret; }, /apiSecret/);
  await bad((c) => { c.auth = { type: "bearer", value: "x" }; }, /auth daxilində/);
  const ok = await call("PUT", T("/actions"), actions());
  assert.equal(ok.status, 200);
  const view = await ok.json();
  signing = view.signingSecret;
  assert.match(signing, /^casig_[a-f0-9]{64}$/, "imza açarı ilk saxlamada bir dəfə göstərilir");
  assert.equal(view.auth.hasSecret, true); assert.equal(view.items.length, 4);
  assert.doesNotMatch(JSON.stringify(view), /API-SIRR|encrypted|signingSecretEnc/);
  const again = await (await call("GET", T("/actions"))).json();
  assert.doesNotMatch(JSON.stringify(again), /API-SIRR|encrypted|casig_/);
  const resave = await (await call("PUT", T("/actions"), { ...actions(), apiSecret: undefined })).json();
  assert.equal(resave.signingSecret, undefined, "təkrar saxlamada imza açarı dəyişmir");
});

test("MODEL TƏKLİF EDƏNDƏ HEÇ NƏ İCRA OLUNMUR: yalnız təsdiq kartı qayıdır", async () => {
  shopCalls.length = 0;
  const { r } = await chat("Sifarişimi ləğv et", { identity: mod.signIdentity(secret, "ali"), ask: { name: "act_cancel_order", args: { orderNo: "A-1", reason: "gec" } } });
  assert.equal(shopCalls.length, 0, "sayta heç bir sorğu getməyib");
  assert.ok(r.confirm?.id && /^[0-9a-f]{32}$/.test(r.confirm.id));
  assert.equal(r.confirm.title, "Sifarişi ləğv et");
  assert.match(r.confirm.summary, /A-1/);
  assert.deepEqual(r.confirm.details, [{ k: "orderNo", v: "A-1" }, { k: "reason", v: "gec" }], "parametrlər həmişə göstərilir");
  assert.match(r.answer, /awaiting_user_confirmation/, "model yalnız gözləmə statusunu görüb");
});

test("təsdiqdən sonra icra olunur: imza, idempotency, autentifikasiya və gövdə düzgündür; userId tokendən", async () => {
  shopCalls.length = 0;
  const ident = mod.signIdentity(secret, "ali");
  const { sid, r } = await chat("Sifarişimi ləğv et", { identity: ident, ask: { name: "act_cancel_order", args: { orderNo: "A-1", reason: "gec", userId: "vuqar" } } });
  assert.equal(shopCalls.length, 0);
  const out = await decide(r.confirm.id, "confirm", sid, ident);
  assert.equal(out.status, "done"); assert.equal(out.message, "Sifariş A-1 ləğv edildi.");
  assert.equal(shopCalls.length, 1);
  const c = shopCalls[0];
  assert.equal(c.method, "POST"); assert.equal(c.url, "/orders/A-1/cancel");
  assert.equal(c.headers.authorization, "Bearer API-SIRR");
  assert.equal(c.headers["x-chatbot-action"], "cancel_order");
  assert.equal(c.headers["x-chatbot-idempotency-key"], r.confirm.id);
  assert.deepEqual(JSON.parse(c.body), { orderNo: "A-1", reason: "gec", userId: "ali" }, "modelin göndərdiyi userId nəzərə alınmır");
  const ts = c.headers["x-chatbot-timestamp"];
  const expect = crypto.createHmac("sha256", signing).update(`${ts}.POST./orders/A-1/cancel.${c.body}`).digest("hex");
  assert.equal(c.headers["x-chatbot-signature"], `sha256=${expect}`);
  assert.ok(Math.abs(Date.now() / 1000 - Number(ts)) < 30);
});

test("təsdiq BİRDƏFƏLİKDİR: təkrar basmaq ikinci icra yaratmır", async () => {
  shopCalls.length = 0;
  const ident = mod.signIdentity(secret, "ali");
  const { sid, r } = await chat("ləğv et", { identity: ident, ask: { name: "act_cancel_order", args: { orderNo: "A-2" } } });
  const [a, b] = await Promise.all([decide(r.confirm.id, "confirm", sid, ident), decide(r.confirm.id, "confirm", sid, ident)]);
  assert.deepEqual([a.status, b.status].sort(), ["done", "expired"]);
  assert.equal(shopCalls.length, 1);
  assert.equal((await decide(r.confirm.id, "confirm", sid, ident)).status, "expired");
});

test("başqa istifadəçi və ya başqa söhbət kartı təsdiq edə bilməz; kart məhv olmur", async () => {
  shopCalls.length = 0;
  const ali = mod.signIdentity(secret, "ali");
  const { sid, r } = await chat("ləğv et", { identity: ali, ask: { name: "act_cancel_order", args: { orderNo: "A-3" } } });
  assert.equal((await decide(r.confirm.id, "confirm", "başqa-söhbət-sid", ali)).status, "expired", "başqa sid");
  assert.equal((await decide(r.confirm.id, "confirm", sid, mod.signIdentity(secret, "vuqar"))).status, "denied", "başqa istifadəçi");
  assert.equal((await decide(r.confirm.id, "confirm", sid, undefined)).status, "denied", "anonim");
  assert.equal((await decide(r.confirm.id, "confirm", sid, mod.signIdentity("saxta", "ali"))).status, "denied", "saxta token");
  assert.equal(shopCalls.length, 0);
  assert.equal((await decide(r.confirm.id, "confirm", sid, ali)).status, "done", "sahibi hələ təsdiq edə bilir");
});

test("ləğv düyməsi icra etmir; yeni təklif köhnəni əvəz edir; müddət bitəndə etibarsızdır", async () => {
  shopCalls.length = 0;
  const ident = mod.signIdentity(secret, "ali");
  const one = await chat("ləğv et", { identity: ident, ask: { name: "act_cancel_order", args: { orderNo: "A-4" } } });
  assert.equal((await decide(one.r.confirm.id, "cancel", one.sid, ident)).status, "cancelled");
  assert.equal((await decide(one.r.confirm.id, "confirm", one.sid, ident)).status, "expired");
  const sid = "sid-replace-xxxxxx";
  const a = await chat("ləğv et", { identity: ident, sid, ask: { name: "act_cancel_order", args: { orderNo: "A-5" } } });
  const b = await chat("ləğv et", { identity: ident, sid, ask: { name: "act_cancel_order", args: { orderNo: "A-6" } } });
  assert.equal((await decide(a.r.confirm.id, "confirm", sid, ident)).status, "expired", "köhnə kart əvəz olunub");
  const { getPending } = await import("../src/actions/pending.js");
  const p = getPending(b.r.confirm.id); p.expiresAt = Date.now() - 1;
  assert.equal((await decide(b.r.confirm.id, "confirm", sid, ident)).status, "expired");
  assert.equal(shopCalls.length, 0);
});

test("parametr doğrulama: bəyan olunmayan atılır, tip/enum/uzunluq/aralıq/tələb yoxlanır", () => {
  const spec = { params: actions().items[1].params.concat(actions().items[0].params.slice(1)) };
  assert.deepEqual(act.coerceParams(spec, { subject: " Salam\n\tdünya ", priority: "2", urgent: "true", hack: "x", reason: "SƏHV" }), { values: { subject: "Salam dünya", priority: 2, urgent: true, reason: "səhv" } });
  assert.match(act.coerceParams(spec, {}).error, /subject/);
  assert.match(act.coerceParams(spec, { subject: "x".repeat(51) }).error, /uzundur/);
  assert.match(act.coerceParams(spec, { subject: "a", priority: 4 }).error, /aralığında/);
  assert.match(act.coerceParams(spec, { subject: "a", priority: 1.5 }).error, /tam ədəd/);
  assert.match(act.coerceParams(spec, { subject: "a", reason: "yox" }).error, /yalnız bunlardan/);
  assert.match(act.coerceParams(spec, { subject: "a", urgent: "bəlkə" }).error, /bəli\/xeyr/);
  assert.match(act.coerceParams(spec, { subject: { a: 1 } }).error, /mətn/);
});

test("model səhv parametr göndərəndə heç bir kart yaranmır", async () => {
  const { r } = await chat("bilet aç", { ask: { name: "act_create_ticket", args: { priority: 9 } } });
  assert.equal(r.confirm, undefined);
  assert.match(r.answer, /subject/);
});

test("kimlik tələb edən əməliyyat anonim üçün alət kimi verilmir; sid olmadan heç biri verilmir", () => {
  const t = { tenantId: "x", actions: { baseUrl: "https://a.az", items: actions().items.map((i) => ({ ...i, enabled: true })) }, privateData: { identity: { secretEnc: "x" } } };
  assert.deepEqual(act.actionDeclarations(t, { identity: null, sid: "s".repeat(8) }).map((d) => d.name), ["act_create_ticket", "act_slow_thing", "act_bad_thing"]);
  assert.equal(act.actionDeclarations(t, { identity: { sub: "ali" }, sid: "s".repeat(8) }).length, 4);
  assert.equal(act.actionDeclarations(t, { identity: { sub: "ali" }, sid: null }).length, 0);
  const off = { ...t, actions: { ...t.actions, items: t.actions.items.map((i) => ({ ...i, enabled: false })) } };
  assert.equal(act.actionDeclarations(off, { sid: "s".repeat(8) }).length, 0);
  const decl = act.actionDeclarations(t, { identity: { sub: "ali" }, sid: "s".repeat(8) })[0];
  assert.ok(!("userId" in decl.parameters.properties));
});

test("açıq API (müştəri açarı, portalsız) əməliyyat təklif etmir", async () => {
  shopCalls.length = 0;
  nextCall = { name: "act_create_ticket", args: { subject: "x" } };
  const r = await (await fetch(`${base}/v1/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ message: "bilet aç", sid: "sid-direct-xxxxx" }) })).json();
  assert.equal(r.confirm, undefined);
  assert.equal(shopCalls.length, 0);
  nextCall = null;
});

test("sayt xəta qaytarsa: təmizlənmiş səbəb göstərilir; AVTOMATİK TƏKRAR YOXDUR", async () => {
  shopCalls.length = 0;
  const { sid, r } = await chat("xətalı", { ask: { name: "act_bad_thing", args: {} } });
  const out = await decide(r.confirm.id, "confirm", sid);
  assert.equal(out.status, "failed");
  assert.match(out.message, /Artıq göndərilib/); assert.doesNotMatch(out.message, /<b>/);
  assert.equal(shopCalls.length, 1, "təkrar sorğu yoxdur");
});

test("cavab gəlməsə nəticə 'bəlli deyil' olur, uğur uydurulmur və təkrar göndərilmir", async () => {
  shopCalls.length = 0;
  const { sid, r } = await chat("yavaş", { ask: { name: "act_slow_thing", args: {} } });
  const out = await decide(r.confirm.id, "confirm", sid);
  assert.equal(out.status, "unknown"); assert.match(out.message, /bəlli deyil/);
  assert.equal(shopCalls.length, 1);
});

test("SSRF: daxili/metadata ünvanına əməliyyat getmir", async () => {
  const { safeRequest } = await import("../src/actions/http.js");
  const prev = process.env.ALLOW_LOCAL_CONNECTORS; process.env.ALLOW_LOCAL_CONNECTORS = "0";
  try {
    for (const u of ["https://127.0.0.1/x", "https://169.254.169.254/latest", "https://10.0.0.5/a", "https://user:pw@example.com/", "http://example.com/", "https://[::1]/x", "https://localhost/x"])
      await assert.rejects(() => safeRequest(u, { method: "POST", body: "{}" }), (e) => ["UNSAFE_URL", "BAD_URL"].includes(e.code), u);
  } finally { process.env.ALLOW_LOCAL_CONNECTORS = prev; }
});

test("limitlər: təklif və icra sayı məhdudlaşır", async () => {
  act.resetActionLimits();
  const ident = mod.signIdentity(secret, "limit-user");
  let last;
  for (let i = 0; i < 7; i++) last = (await chat("bilet", { identity: ident, ask: { name: "act_create_ticket", args: { subject: `s${i}` } } })).r;
  assert.match(last.answer, /tez-tez/, "7-ci təklif rədd olunur");
  act.resetActionLimits();
  shopCalls.length = 0;
  const outs = [];
  for (let i = 0; i < 6; i++) { const { sid, r } = await chat("bilet", { identity: ident, ask: { name: "act_create_ticket", args: { subject: `t${i}` } } }); outs.push((await decide(r.confirm.id, "confirm", sid, ident)).status); }
  assert.deepEqual(outs, ["done", "done", "done", "done", "done", "denied"]);
  assert.equal(shopCalls.length, 5);
});

test("sınaq: preview heç nə göndərmir, sirri göstərmir; real sınaq X-Chatbot-Test ilə gedir", async () => {
  act.resetActionLimits();
  shopCalls.length = 0;
  const pv = await (await call("POST", T("/actions/test"), { key: "cancel_order", params: { orderNo: "T-1" } })).json();
  assert.equal(shopCalls.length, 0);
  assert.equal(pv.preview.method, "POST"); assert.match(pv.preview.url, /\/orders\/T-1\/cancel$/);
  assert.doesNotMatch(JSON.stringify(pv), /API-SIRR|casig_/); assert.equal(pv.preview.headers.authorization, "***");
  const real = await (await call("POST", T("/actions/test"), { key: "create_ticket", params: { subject: "sınaq" }, send: true })).json();
  assert.equal(real.status, "done"); assert.equal(shopCalls.length, 1); assert.equal(shopCalls[0].headers["x-chatbot-test"], "1");
  assert.equal((await call("POST", T("/actions/test"), { key: "yoxdur" })).status, 400);
  assert.equal((await call("POST", T("/actions/test"), { key: "create_ticket", params: {} })).status, 400, "tələb olunan parametr");
});

test("jurnal: təsdiq/ləğv/xəta yazılır, e-poçt maskalanır, sirr yoxdur", async () => {
  act.resetActionLimits();
  const ident = mod.signIdentity(secret, "log-user");
  const { sid, r } = await chat("bilet", { identity: ident, ask: { name: "act_create_ticket", args: { subject: "yaz ali@mail.az" } } });
  await decide(r.confirm.id, "confirm", sid, ident);
  const { entries } = await (await call("GET", T("/actions/log"))).json();
  assert.ok(entries.length >= 5);
  const e = entries.find((x) => x.key === "create_ticket" && x.subject === "log-user");
  assert.equal(e.status, "done"); assert.equal(e.params.subject, "yaz [email]"); assert.ok(e.ms >= 0);
  assert.ok(entries.some((x) => x.status === "cancelled") && entries.some((x) => x.status === "unknown") && entries.some((x) => x.status === "test") && entries.some((x) => x.status === "denied"));
  assert.doesNotMatch(JSON.stringify(entries), /API-SIRR|casig_/);
  assert.equal((await call("DELETE", T("/actions/log"))).status, 200);
  assert.deepEqual((await (await call("GET", T("/actions/log"))).json()).entries, []);
});

test("əməliyyatı olan hesabda cavab keşi söndürülür; imza açarı fırladılır", async () => {
  assert.equal(act.hasActions({ actions: { items: [{ enabled: true }] } }), true);
  assert.equal(act.hasActions({}), false);
  const r = await call("POST", T("/actions/signing-secret"));
  assert.equal(r.status, 201);
  const next = (await r.json()).signingSecret;
  assert.notEqual(next, signing); assert.match(next, /^casig_/);
});

test("əməliyyatlar silinəndə alətlər yox olur", async () => {
  assert.equal((await call("DELETE", T("/actions"))).status, 200);
  assert.deepEqual((await (await call("GET", T("/actions"))).json()).items, []);
  const { sid, r } = await chat("bilet", { ask: { name: "act_create_ticket", args: { subject: "x" } } });
  void sid; assert.equal(r.confirm, undefined);
});
