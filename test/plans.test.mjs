// Abunə planları: sifariş → təsdiq → limit sayğacı, 80/100% bildirişləri, paketlər, yüksəltmə, keçid, xatırlatmalar.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tmpFile } from "../testkit/helpers.mjs";
import { adminSetPlan, grantReplies, canSpend, charge, setSettings, entitlements, planReminders, quoteOrder, requestOrder, resolveRequest, setNextPlan, summary } from "../src/billing/billing.js";
import { DEFAULT_CATALOG, _resetCatalogCache, applyOrder, getCatalog, quote, rollWindow, setCatalog } from "../src/billing/plans.js";
import { resetStores, store } from "../src/billing/storage.js";
import { finance } from "../src/billing/finance.js";
import { useStoreDb } from "../src/store/mongo.js";

const T = (id) => ({ tenantId: id });
let n = 0;
const fresh = () => `p${++n}`;
const DAY = 86_400_000;

beforeEach(() => {
  for (const k of ["BILLING_ENFORCE", "BILLING_FREE_PERIOD", "BILLING_FREE_AZN", "BILLING_TRIAL_DAYS"]) delete process.env[k];
  process.env.BILLING_TRIAL_REPLIES = "0"; // plan testləri sınaqsız; sınaq ayrıca testdədir
  useStoreDb(undefined); resetStores(); _resetCatalogCache();
  process.env.BILLING_FILE = tmpFile(`plans${n}.json`, "{}");
});

async function buy(id, input) {
  const r = await requestOrder(id, input);
  await resolveRequest(r.id, "approve", "admin");
  return r;
}

test("defolt kataloq: Start 15 AZN, WhatsApp/Telegram (kanallar) daxildir", async () => {
  const cat = await getCatalog();
  const start = cat.plans.find((p) => p.id === "start");
  assert.equal(start.priceAzn, 15);
  assert.equal(start.features.channels, true);
  assert.equal(cat.plans.length, DEFAULT_CATALOG.plans.length);
});

test("plan yoxdur, balans yoxdur: AI dayanır; plan alınanda işləyir və cavablar sayılır", async () => {
  const id = fresh();
  assert.equal((await canSpend(T(id))).code, "BALANCE_EMPTY");
  const order = await requestOrder(id, { kind: "plan", plan: "start", cycle: "month" });
  assert.equal(order.amountAzn, 15);
  assert.equal(order.kind, "plan");
  assert.equal(order.status, "pending");
  assert.equal((await canSpend(T(id))).ok, false, "təsdiqdən əvvəl açılmır");
  await resolveRequest(order.id, "approve", "admin");
  await resolveRequest(order.id, "approve", "admin"); // təkrar təsdiq ikinci dəfə tətbiq olunmur
  const s = await summary(id);
  assert.equal(s.subscription.plan, "start");
  assert.equal(s.subscription.status, "active");
  assert.equal(s.subscription.included, 1000);
  assert.ok(Math.abs(Date.parse(s.subscription.end) - Date.now() - 30 * DAY) < 60_000, "bir dövr əlavə olunub");
  assert.equal((await canSpend(T(id))).ok, true);
  const r = await charge(T(id), { costUsd: 0.001, tokens: 10, reply: true });
  assert.equal(r.billedAzn, 0, "plan pulu ödənilib: balansdan çıxılmır");
  assert.equal(r.plan.used, 1);
  await charge(T(id), { costUsd: 0.001, tokens: 10 }); // köməkçi xərc sayılmır
  assert.equal((await summary(id)).subscription.used, 1);
  // ledger: plan ödənişi (req: ref) və maliyyədə abunə gəliri
  const led = await store().listLedger(id, 10);
  assert.equal(led.filter((e) => e.type === "plan").length, 1);
  const fin = await finance({ months: 1 });
  assert.ok(fin.months.at(-1).subsAzn >= 15);
});

test("80% və 100%-də bir dəfə xəbər; limit dolanda AI dayanır, köməkçi xərclər işləyir", async () => {
  const id = fresh();
  await setCatalog({ ...DEFAULT_CATALOG, plans: DEFAULT_CATALOG.plans.map((p) => (p.id === "start" ? { ...p, replies: 10 } : p)) });
  await buy(id, { kind: "plan", plan: "start", cycle: "month" });
  const notes = [];
  for (let i = 0; i < 10; i++) { const r = await charge(T(id), { reply: true }); if (r.notify) notes.push([i + 1, r.notify]); }
  assert.deepEqual(notes, [[8, "usage80"], [10, "usage100"]]);
  const c = await canSpend(T(id));
  assert.equal(c.ok, false);
  assert.equal(c.code, "PLAN_LIMIT");
  assert.equal((await canSpend(T(id), { reply: false })).ok, true);
  // paket: limitdən sonra paketdən çıxılır
  const q = await quoteOrder(id, { kind: "pack", pack: "p500" });
  assert.equal(q.replies, 500);
  await buy(id, { kind: "pack", pack: "p500" });
  assert.equal((await canSpend(T(id))).ok, true);
  const r = await charge(T(id), { reply: true });
  assert.equal(r.plan.packLeft, 499);
  assert.equal((await summary(id)).packLeft, 499);
});

test("paket yalnız aktiv planla; ucuz plana keçid növbəti dövrdən", async () => {
  const id = fresh();
  await assert.rejects(requestOrder(id, { kind: "pack", pack: "p500" }), /aktiv planla/);
  await buy(id, { kind: "plan", plan: "business", cycle: "month" });
  await assert.rejects(requestOrder(id, { kind: "plan", plan: "start", cycle: "month" }), (e) => e.status === 409);
  const v = await setNextPlan(id, "start");
  assert.equal(v.subscription.next, "start");
  // növbəti dövr start ilə yenilənir: "renew" sayılır və köhnə bitmə tarixindən başlayır
  const q = await quoteOrder(id, { kind: "plan", plan: "start", cycle: "month" });
  assert.equal(q.type, "renew");
  const endBefore = (await summary(id)).subscription.end;
  await buy(id, { kind: "plan", plan: "start", cycle: "month" });
  const s = (await summary(id)).subscription;
  assert.equal(s.plan, "business", "cari dövr dəyişmir");
  assert.equal(Date.parse(s.end) - Date.parse(endBefore), 30 * DAY);
});

test("yüksəltmə: qalan günlərin fərqi, limit dərhal yeni planınkı", async () => {
  const id = fresh();
  await buy(id, { kind: "plan", plan: "start", cycle: "month" });
  const q = await quoteOrder(id, { kind: "plan", plan: "business", cycle: "month" });
  assert.equal(q.type, "upgrade");
  assert.ok(q.amountAzn > 19.9 && q.amountAzn <= 20, `tam dövr qalıb: ~20 AZN, gəldi ${q.amountAzn}`);
  await buy(id, { kind: "plan", plan: "business", cycle: "month" });
  const s = await summary(id);
  assert.equal(s.subscription.plan, "business");
  assert.equal(s.subscription.included, 3000);
  assert.equal((await entitlements(id)).features.live, true);
});

test("illik planlar yoxdur: cycle=year göndərilsə də aylıq hesablanır; limit pəncərəsi 30 gündür", () => {
  const cat = DEFAULT_CATALOG;
  const q = quote({}, cat, { kind: "plan", plan: "start", cycle: "year" });
  assert.equal(q.cycle, "month");
  assert.equal(q.amountAzn, 15);
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const { sub } = applyOrder({}, cat, { ...q, id: "x" }, t0);
  assert.equal(Date.parse(sub.end) - t0, 30 * DAY);
  assert.equal(rollWindow({ ...sub, used: 900 }, t0 + 10 * DAY), null);
});

test("plan imkanları: Start-da WhatsApp/Telegram və canlı söhbət var; plansız hesabda imkan yoxdur", async () => {
  const id = fresh();
  assert.equal((await entitlements(id)).source, "none");
  await buy(id, { kind: "plan", plan: "start", cycle: "month" });
  const e = await entitlements(id);
  assert.equal(e.source, "plan");
  assert.equal(e.features.channels, true);
  assert.equal(e.features.live, true);
  assert.equal(e.features.automations, false);
  assert.equal(e.seats, 1);
});

test("pulsuz sınaq: 100 cavab 14 gün ərzində, bitəndə bir dəfə xəbər və TRIAL_ENDED", async () => {
  process.env.BILLING_TRIAL_REPLIES = "3";
  const id = fresh();
  const s0 = await summary(id);
  assert.equal(s0.trial.left, 3);
  assert.ok(Math.abs(Date.parse(s0.trial.until) - Date.now() - 14 * DAY) < 60_000);
  assert.equal(s0.balance.totalAzn, 0, "pulsuz balans (AZN) artıq verilmir");
  assert.equal((await entitlements(id)).source, "trial");
  assert.equal((await canSpend(T(id))).ok, true);
  await charge(T(id), { costUsd: 0.001, reply: false }); // köməkçi xərc sınaqdan çıxılmır
  const notes = [];
  for (let i = 0; i < 3; i++) { const r = await charge(T(id), { costUsd: 0.001, reply: true }); assert.equal(r.billedAzn, 0); if (r.notify) notes.push(r.notify); }
  assert.deepEqual(notes, ["trialLow", "trialEnd"], "80%-də bir dəfə xəbərdarlıq, bitəndə bir dəfə");
  const c = await canSpend(T(id));
  assert.equal(c.ok, false);
  assert.equal(c.code, "TRIAL_ENDED");
  assert.equal((await entitlements(id)).source, "none");
  // plan alınanda sınaqdan asılı olmayaraq işləyir
  await buy(id, { kind: "plan", plan: "start", cycle: "month" });
  assert.equal((await canSpend(T(id))).ok, true);
});

test("pulsuz sınaq müddəti bitəndə qalan cavablar da yanır", async () => {
  process.env.BILLING_TRIAL_REPLIES = "100";
  const id = fresh();
  await summary(id);
  const acc = await store().getAcc(id);
  await store().casAcc(id, acc.v, { trial: { ...acc.trial, until: new Date(Date.now() - 1000).toISOString() } });
  assert.equal((await canSpend(T(id))).code, "TRIAL_ENDED");
  assert.equal((await summary(id)).trial.left, 0);
});

test("xatırlatmalar bir dəfə; admin planı verir və götürür", async () => {
  const id = fresh();
  await adminSetPlan(id, { plan: "pro", days: 2, by: "admin" });
  const a = (await planReminders()).filter((r) => r.tenantId === id);
  assert.deepEqual(a.map((r) => r.kind), ["expiring"]);
  assert.equal((await planReminders()).filter((r) => r.tenantId === id).length, 0);
  assert.equal((await planReminders(Date.now() + 6 * DAY)).find((r) => r.tenantId === id)?.kind, "expired");
  await adminSetPlan(id, { plan: null, by: "admin" });
  assert.equal((await summary(id)).subscription, null);
});

test("aktiv abunəçisi olan planı silmək olmur", async () => {
  const id = fresh();
  await adminSetPlan(id, { plan: "pro", days: 30 });
  await assert.rejects(setCatalog({ ...DEFAULT_CATALOG, plans: DEFAULT_CATALOG.plans.filter((p) => p.id !== "pro") }), (e) => e.status === 409);
});

test("bonus cavablar: planda paket kimi, plansız sınağa; ref ilə bir dəfə", async () => {
  const id = fresh();
  assert.equal((await grantReplies(id, { replies: 200, ref: "p1" })).replies, 200);
  assert.equal((await summary(id)).trial.left, 200, "plan yoxdur: sınağa əlavə olunur");
  await buy(id, { kind: "plan", plan: "start", cycle: "month" });
  await grantReplies(id, { replies: 50, ref: "p2" });
  assert.equal((await grantReplies(id, { replies: 50, ref: "p2" })).duplicate, true);
  assert.equal((await summary(id)).packLeft, 50);
});

test("kataloq yoxlanır", async () => {
  await assert.rejects(setCatalog({ plans: [] }));
  await assert.rejects(setCatalog({ ...DEFAULT_CATALOG, plans: [{ ...DEFAULT_CATALOG.plans[0], id: "Bad Id!" }] }));
});

test("gündəlik limit plan müştərisində real AI xərcinə görə işləyir (balansdan pul çıxılmasa da); admin real xərci görür", async () => {
  const id = fresh();
  await buy(id, { kind: "plan", plan: "start", cycle: "month" });
  await setSettings(id, { dailyLimitAzn: 0.01 });
  assert.equal((await canSpend({ tenantId: id })).ok, true);
  const r = await charge({ tenantId: id }, { costUsd: 0.01, tokens: 100, reply: true });
  assert.equal(r.billedAzn, 0);
  const c = await canSpend({ tenantId: id });
  assert.equal(c.code, "DAILY_LIMIT");
  const s = await summary(id, { admin: true });
  assert.ok(s.admin.todayCostAzn >= 0.01, "bu günün real xərci");
  assert.equal(s.admin.todayAzn, 0, "balansdan çıxılan yoxdur");
  assert.ok(s.admin.monthCostAzn >= s.admin.todayCostAzn);
});

test("pulsuz sınaq müddətlə bitəndə: 3 gün qalmış və bitəndə bir dəfə xatırlatma", async () => {
  process.env.BILLING_TRIAL_REPLIES = "5"; process.env.BILLING_TRIAL_DAYS = "2";
  const id = fresh();
  try { assert.equal((await canSpend({ tenantId: id })).ok, true); }
  finally { process.env.BILLING_TRIAL_REPLIES = "0"; delete process.env.BILLING_TRIAL_DAYS; }
  const mine = async (t) => (await planReminders(t)).filter((r) => r.tenantId === id).map((r) => r.kind);
  assert.deepEqual(await mine(Date.now()), ["trialExpiring"]);
  assert.deepEqual(await mine(Date.now()), []);
  assert.deepEqual(await mine(Date.now() + 3 * 86_400_000), ["trialEnded"]);
  assert.deepEqual(await mine(Date.now() + 4 * 86_400_000), []);
});
