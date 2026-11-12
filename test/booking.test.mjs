// API-siz randevu təqvimi: ayarın yoxlanması, boş vaxtların hesablanması (qurşaq, tutum, qabaqcadan, bağlı gün),
// AI ilə randevu (kanal ünvanı saxlanır), tutulmuş vaxtın təkrar verilməməsi, panel statusları, sifariş mərhələsi.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpFile } from "../testkit/helpers.mjs";

const H = { "content-type": "application/json", authorization: "Bearer bk-token" };
let base, server, tenantId, B, store, seen = [], nextCall = null;

const fakeGemini = {
  models: {
    embedContent: async ({ contents }) => ({ embeddings: contents.map(() => ({ values: new Array(8).fill(0.1) })) }),
    generateContent: async ({ contents, config }) => {
      seen.push({ names: (config.tools?.[0]?.functionDeclarations ?? []).map((d) => d.name), system: config.systemInstruction });
      const fr = contents.at(-1).parts.find((p) => p.functionResponse);
      if (fr) return { text: `Nəticə: ${JSON.stringify(fr.functionResponse.response.result)}`, usageMetadata: { totalTokenCount: 30 } };
      const c = nextCall; nextCall = null;
      if (c) return { functionCalls: [c], candidates: [{ content: { role: "model", parts: [{ functionCall: c }] } }], usageMetadata: { totalTokenCount: 20 } };
      return { text: "Salam!", usageMetadata: { totalTokenCount: 10 } };
    },
  },
};
const call = (method, path, body) => fetch(`${base}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const T = (p = "") => `/v1/service/tenants/${tenantId}${p}`;
const chat = async (c, extra = {}) => { nextCall = c; return (await call("POST", T("/chat"), { message: "sabaha yazılmaq istəyirəm", sid: "sid-bk-aaaaa", channel: "telegram", ...extra })).json(); };
const result = (r) => JSON.parse(r.answer.replace(/^Nəticə: /, ""));
const allDays = { from: "10:00", to: "18:00" };
const cfg = (over = {}) => ({ enabled: true, title: "Salon", services: [{ name: "Saç kəsimi", duration: 60, price: "15 AZN" }, { name: "Manikür", duration: 30 }], days: Array(7).fill(allDays), step: 30, capacity: 1, noticeMin: 0, horizonDays: 14, ...over });
const tomorrow = () => new Date(Date.now() + 86_400_000 + 4 * 3_600_000).toISOString().slice(0, 10); // Bakı vaxtı ilə sabah

before(async () => {
  Object.assign(process.env, { SERVICE_TOKEN: "bk-token", TENANT_SECRET_ENCRYPTION_KEY: "ab".repeat(32) });
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}"); process.env.BILLING_FILE = tmpFile("billing.json", "{}"); process.env.KB_FILE = tmpFile("kb.json", "{}");
  const { useGeminiClient } = await import("../src/kb/client.js");
  useGeminiClient(fakeGemini);
  B = await import("../src/booking/booking.js");
  store = await import("../src/kb/store.js");
  const { createApp } = await import("../src/app.js");
  server = await new Promise((r) => { const s = createApp().listen(0, () => r(s)); });
  base = `http://localhost:${server.address().port}`;
  ({ tenantId } = await (await call("POST", "/v1/service/tenants", { businessName: "Gözəllik Salonu", domain: "salon.az", profile: { language: "az", mode: "support" } })).json());
});
after(() => server.close());

test("ayar: yoxlama xətaları və təmizlənmiş nüsxə", async () => {
  const bad = async (over, re) => { const r = await call("PUT", T("/booking"), cfg(over)); assert.equal(r.status, 400); assert.match((await r.json()).error, re); };
  await bad({ services: [] }, /xidmət/);
  await bad({ services: [{ name: "A", duration: 2 }] }, /5-480/);
  await bad({ services: [{ name: "A", duration: 30 }, { name: "a", duration: 30 }] }, /təkrarlanır/);
  await bad({ days: [allDays] }, /7 günü/);
  await bad({ days: Array(7).fill(null) }, /iş günü/);
  await bad({ days: Array(7).fill({ from: "18:00", to: "10:00" }) }, /gec/);
  await bad({ step: 7 }, /Addım/);
  await bad({ tz: "Mars/Olympus" }, /qurşağı/);
  const ok = await (await call("PUT", T("/booking"), cfg({ closedDates: ["2030-01-01", "2030-01-01"] }))).json();
  assert.equal(ok.booking.tz, "Asia/Baku");
  assert.deepEqual(ok.booking.closedDates, ["2030-01-01"]);
  assert.equal(ok.booking.reminders, true);
  assert.equal((await (await call("GET", T("/booking"))).json()).booking.services.length, 2);
});

test("boş vaxtlar: Bakı vaxtı, tutum, qabaqcadan yazılma, bağlı gün, üfüq", () => {
  const c = B.cleanBooking(cfg({ noticeMin: 120, capacity: 2 }));
  const now = Date.parse("2030-03-04T06:00:00Z"); // Bakı: 10:00
  const svc = c.services[0];
  const today = B.daySlots(c, svc, "2030-03-04", [], now);
  assert.equal(today[0], "12:00", "2 saat qabaqcadan: 10:00 + 2 saat");
  assert.equal(today.at(-1), "17:00", "60 dəqiqəlik xidmət 18:00-da bitməlidir");
  const s = B.zonedMs("2030-03-05", 10 * 60, "Asia/Baku");
  assert.equal(new Date(s).toISOString(), "2030-03-05T06:00:00.000Z");
  const busy1 = [{ start: s, end: s + 3_600_000 }];
  assert.ok(B.daySlots(c, svc, "2030-03-05", busy1, now).includes("10:00"), "tutum 2: bir randevu ilə hələ boşdur");
  assert.ok(!B.daySlots(c, svc, "2030-03-05", [...busy1, ...busy1], now).includes("10:00"), "iki randevu: dolu");
  assert.ok(!B.daySlots(c, svc, "2030-03-05", [...busy1, ...busy1], now).includes("09:30"));
  assert.ok(!B.daySlots(c, svc, "2030-03-05", [...busy1, ...busy1], now).includes("10:30"), "üst-üstə düşən vaxt da dolu");
  assert.deepEqual(B.daySlots({ ...c, closedDates: ["2030-03-06"] }, svc, "2030-03-06", [], now), []);
  assert.deepEqual(B.daySlots(c, svc, "2030-03-03", [], now), [], "keçmiş gün");
  assert.deepEqual(B.daySlots(c, svc, "2030-04-30", [], now), [], "üfüqdən kənar");
  const sundayOff = { ...c, days: c.days.map((d, i) => (i === 0 ? null : d)) };
  assert.deepEqual(B.daySlots(sundayOff, svc, "2030-03-10", [], now), [], "2030-03-10 bazar günüdür");
});

test("AI ilə randevu: əvvəl boş vaxt, sonra təsdiqli yazılış; kanal ünvanı saxlanır; eyni vaxt ikinci dəfə verilmir", async () => {
  await call("PUT", T("/booking"), cfg());
  const d = tomorrow();
  const slots = result(await chat({ name: "find_slots", args: { service: "Saç kəsimi", date: d } }));
  assert.ok(seen.at(-1).names.includes("find_slots") && seen.at(-1).names.includes("book_appointment"));
  assert.match(seen.at(-1).system, /RANDEVU QƏBULU \(Salon\)/);
  assert.equal(slots.days[0].date, d);
  assert.equal(slots.days[0].times[0], "10:00");
  assert.equal(slots.price, "15 AZN");

  const reach = { type: "telegram", chatId: "555", lang: "az" };
  const r = await chat({ name: "book_appointment", args: { service: "Saç kəsimi", date: d, time: "10:00", name: "Aysel", phone: "+994 50 123 45 67" } }, { reach });
  assert.equal(r.booking.service, "Saç kəsimi");
  assert.equal(r.booking.date, d);
  assert.equal(r.booking.time, "10:00");
  assert.equal(r.booking.reminders, true);
  const lead = await store.getInbox("leads", tenantId, r.booking.id);
  assert.deepEqual(lead.booking.reach, reach);
  assert.equal(lead.booking.status, "booked");
  assert.equal(lead.contact, "+994 50 123 45 67");

  const again = result(await chat({ name: "book_appointment", args: { service: "Saç kəsimi", date: d, time: "10:00", name: "Leyla", phone: "0551112233" } }, { sid: "sid-bk-bbbbb" }));
  assert.match(again.error, /boş deyil/);
  const slots2 = result(await chat({ name: "find_slots", args: { service: "Manikür", date: d } }, { sid: "sid-bk-ccccc" }));
  assert.ok(!slots2.days[0].times.includes("10:00") && !slots2.days[0].times.includes("10:30"), "tutulmuş saat (və üst-üstə düşən) yoxdur");
  assert.ok(slots2.days[0].times.includes("11:00"));

  const bad = result(await chat({ name: "book_appointment", args: { service: "Saç kəsimi", date: d, time: "11:00", name: "X", phone: "12" } }, { sid: "sid-bk-ddddd" }));
  assert.match(bad.error, /Telefon/);
});

test("panel: kind=booking siyahısı, randevu statusu və sifariş mərhələsi", async () => {
  const list = await (await call("GET", T("/kb/leads?kind=booking"))).json();
  assert.equal(list.items.length, 1);
  const id = list.items[0].id;
  assert.equal(list.items[0].booking.time, "10:00");
  const p = await (await call("PATCH", T(`/kb/leads/${id}`), { bookingStatus: "cancelled", by: "Sahib" })).json();
  assert.equal(p.lead.booking.status, "cancelled");
  assert.equal(p.lead.status, "solved");
  // Ləğv olunmuş vaxt yenidən boşdur
  const slots = result(await chat({ name: "find_slots", args: { service: "Saç kəsimi", date: tomorrow() } }, { sid: "sid-bk-eeeee" }));
  assert.equal(slots.days[0].times[0], "10:00");

  const order = await store.addInbox("leads", tenantId, { name: "A", contact: "0501234567", question: "Sifariş", conversation: [], handled: false, status: "new", order: { title: "Sifariş", fields: [{ label: "Məhsul", value: "Tort" }], channel: "telegram" } });
  assert.equal((await (await call("GET", T("/kb/leads?kind=order"))).json()).items[0].order.stage, "new", "köhnə sifarişin mərhələsi defolt: yeni");
  const shipped = await (await call("PATCH", T(`/kb/leads/${order._id}`), { orderStage: "shipped", by: "Sahib" })).json();
  assert.equal(shipped.lead.order.stage, "shipped");
  assert.equal(shipped.lead.status, "open");
  assert.equal((await (await call("PATCH", T(`/kb/leads/${order._id}`), { orderStage: "delivered", by: "Sahib" })).json()).lead.status, "solved");
  assert.equal((await call("PATCH", T(`/kb/leads/${order._id}`), { orderStage: "lost" })).status, 400);
  assert.equal((await call("PATCH", T(`/kb/leads/${id}`), { orderStage: "shipped" })).status, 400, "randevu sifariş deyil");
});
