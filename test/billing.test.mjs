// Balans: xərc hesabı, pulsuz məbləğ → yüklənmiş balans sırası, dayanma, bildiriş keçidləri, təkrar-qoruma, rəqabət.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tmpFile } from "../testkit/helpers.mjs";
import { callCostUsd, billedMicro, newMeter, toMicro, fromMicro } from "../src/billing/pricing.js";
import { canSpend, charge, topup, summary, setSettings, requestTopup, resolveRequest, listRequests } from "../src/billing/billing.js";
import { resetStores, store } from "../src/billing/storage.js";
import { useStoreDb } from "../src/store/mongo.js";
import { fakeMongo } from "./helpers/fakeMongo.mjs";

const T = (id) => ({ tenantId: id });
let n = 0;
const fresh = () => `t${++n}`;
const modes = {
  fayl: () => { useStoreDb(undefined); resetStores(); process.env.BILLING_FILE = tmpFile(`b${n}.json`, "{}"); },
  mongo: () => { useStoreDb(fakeMongo({ latency: 2 })); resetStores(); },
};

beforeEach(() => {
  for (const k of ["BILLING_MARKUP", "USD_AZN_RATE", "BILLING_FREE_AZN", "BILLING_FREE_PERIOD", "BILLING_LOW_AZN", "BILLING_ENFORCE", "GEMINI_PRICES", "BILLING_MIN_TOPUP_AZN"]) delete process.env[k];
  // testlər Gemini qiymət cədvəli ilə yazılıb (defolt indi Haiku tarifidir)
  process.env.GEMINI_PRICES = JSON.stringify({ "gemini-3.5-flash": { in: 1.5, out: 9, cachedIn: 0.15 }, "gemini-3-flash-preview": { in: 0.5, out: 3, cachedIn: 0.05 }, "*": { in: 1.5, out: 9, cachedIn: 0.15 } });
});

test("xərc: giriş, çıxış, düşünmə və keşlənmiş tokenlər ayrı qiymətlə", () => {
  // 1M giriş (1.5$) + 100k çıxış + 50k düşünmə (150k × 9$/M = 1.35$) = 2.85$
  const usage = { promptTokenCount: 1_000_000, candidatesTokenCount: 100_000, thoughtsTokenCount: 50_000, totalTokenCount: 1_150_000 };
  assert.ok(Math.abs(callCostUsd("gemini-3.5-flash", usage) - 2.85) < 1e-9);
  // keşlənmiş 400k giriş ucuz qiymətlə: 600k×1.5 + 400k×0.15 = 0.96$
  const cached = { promptTokenCount: 1_000_000, cachedContentTokenCount: 400_000, candidatesTokenCount: 0, totalTokenCount: 1_000_000 };
  assert.ok(Math.abs(callCostUsd("gemini-3.5-flash", cached) - 0.96) < 1e-9);
  // ehtiyat model daha ucuzdur; naməlum model ən bahalı qiymətlə hesablanır
  assert.ok(callCostUsd("gemini-3-flash-preview", usage) < callCostUsd("gemini-3.5-flash", usage));
  assert.equal(callCostUsd("naməlum-model", usage), callCostUsd("gemini-3.5-flash", usage));
  // yalnız total verilibsə: 85/15 bölgüsü (100k: 85k×1.5 + 15k×9 = 0.2625$)
  assert.ok(Math.abs(callCostUsd("gemini-3.5-flash", { totalTokenCount: 100_000 }) - 0.2625) < 1e-9);
  assert.equal(callCostUsd("gemini-3.5-flash", undefined), 0);
  process.env.GEMINI_PRICES = JSON.stringify({ "gemini-3.5-flash": { in: 3, out: 18 } });
  assert.ok(Math.abs(callCostUsd("gemini-3.5-flash", usage) - 5.7) < 1e-9, "env ilə qiymət dəyişir");
});

test("sayğac bütün çağırışları toplayır; manata çevirmə 1.7 × vuruq 1.5", () => {
  const m = newMeter();
  m.add("gemini-3.5-flash", { promptTokenCount: 2000, candidatesTokenCount: 100, totalTokenCount: 2100 });
  m.add("gemini-3.5-flash", { promptTokenCount: 3000, candidatesTokenCount: 400, totalTokenCount: 3400 });
  assert.equal(m.tokens, 5500); assert.equal(m.calls, 2);
  assert.ok(Math.abs(m.costUsd - ((5000 * 1.5 + 500 * 9) / 1e6)) < 1e-12);
  assert.equal(billedMicro(1), 2_550_000, "1$ → 1×1.7×1.5 = 2.55 AZN");
  assert.equal(billedMicro(1, 1), 1_700_000);
  assert.equal(fromMicro(toMicro(0.0225)), 0.0225);
  process.env.BILLING_MARKUP = "2"; process.env.USD_AZN_RATE = "1.8";
  assert.equal(billedMicro(1), 3_600_000);
});

for (const [mode, setup] of Object.entries(modes)) {
  test(`[${mode}] yeni hesab 2 AZN pulsuz alır; xərc əvvəl pulsuzdan, sonra yüklənmişdən çıxılır`, async () => {
    setup();
    const t = T(fresh());
    let s = await summary(t.tenantId);
    assert.equal(s.balance.freeAzn, 2); assert.equal(s.balance.paidAzn, 0); assert.equal(s.state, "ok");
    await topup(t.tenantId, 10, { note: "test", by: "admin" });
    // 1$ xərc = 2.55 AZN: 2 pulsuz + 0.55 yüklənmişdən
    const r = await charge(t, { costUsd: 1, tokens: 1000 });
    assert.equal(r.billedAzn, 2.55);
    s = await summary(t.tenantId);
    assert.equal(s.balance.freeAzn, 0); assert.equal(s.balance.paidAzn, 9.45); assert.equal(s.balance.totalAzn, 9.45);
    assert.equal(s.spend.monthAzn, 2.55); assert.equal(s.spend.monthRequests, 1);
    assert.equal(s.ledger[0].type, "topup"); assert.equal(s.ledger[0].amountAzn, 10);
  });

  test(`[${mode}] balans bitəndə sorğu dayanır, yükləmədən sonra davam edir; kredit limiti və enforce=false`, async () => {
    setup();
    const t = T(fresh());
    assert.equal((await canSpend(t)).ok, true);
    await charge(t, { costUsd: 1 }); // 2.55 > 2 pulsuz → mənfi 0.55
    assert.equal((await canSpend(t)).ok, false);
    assert.equal((await canSpend(t)).code, "BALANCE_EMPTY");
    await setSettings(t.tenantId, { creditLimitAzn: 5 });
    assert.equal((await canSpend(t)).ok, true, "kredit limiti kiçik borca icazə verir");
    await charge(t, { costUsd: 2 }); // −5.65 → limit aşıldı
    assert.equal((await canSpend(t)).ok, false);
    await topup(t.tenantId, 10);
    assert.equal((await canSpend(t)).ok, true, "yükləmədən sonra işləyir");
    await setSettings(t.tenantId, { creditLimitAzn: 0 });
    process.env.BILLING_ENFORCE = "false";
    await charge(t, { costUsd: 100 });
    assert.equal((await canSpend(t)).ok, true, "enforce=false: heç vaxt dayandırmır");
  });

  test(`[${mode}] bildiriş yalnız vəziyyətə ilk keçiddə gəlir, yükləmədən sonra yenilənir`, async () => {
    setup();
    const t = T(fresh());
    const a = await charge(t, { costUsd: 0.7 });   // 1.785 AZN → qalıq 0.215 ≤ 1 AZN: low
    assert.equal(a.notify, "low"); assert.equal(a.state, "low");
    const b = await charge(t, { costUsd: 0.01 });
    assert.equal(b.notify, undefined, "təkrar low göndərilmir");
    const c = await charge(t, { costUsd: 0.2 });   // 0 altına düşdü: empty
    assert.equal(c.notify, "empty"); assert.equal(c.state, "empty");
    assert.equal((await charge(t, { costUsd: 0.2 })).notify, undefined, "təkrar empty göndərilmir");
    await topup(t.tenantId, 10);
    const d = await charge(t, { costUsd: 4 });     // 10.2 → qalıq çox deyil? 10 − (−0.x) − 10.2 ⇒ yenidən low/empty
    assert.ok(["low", "empty"].includes(d.notify), "yükləmədən sonra bayraqlar sıfırlanıb: yenidən xəbər verilir");
  });

  test(`[${mode}] ref ilə təkrar yükləmə pul əlavə etmir (şlüz eyni xəbəri təkrar göndərə bilər)`, async () => {
    setup();
    const t = T(fresh());
    const first = await topup(t.tenantId, 10, { ref: "pay:x:1" });
    const second = await topup(t.tenantId, 10, { ref: "pay:x:1" });
    assert.equal(first.duplicate, false); assert.equal(second.duplicate, true);
    assert.equal((await summary(t.tenantId)).balance.paidAzn, 10);
    await assert.rejects(topup(t.tenantId, 0), /Məbləğ/);
    await topup(t.tenantId, -3, { note: "qaytarma" });
    assert.equal((await summary(t.tenantId)).balance.paidAzn, 7);
  });

  test(`[${mode}] aylıq pulsuz məbləğ yenilənir (yığılmır); "once" rejimində yenilənmir`, async () => {
    setup();
    const t = T(fresh());
    await charge(t, { costUsd: 0.5 });
    const st = store(); let acc = await st.getAcc(t.tenantId);
    assert.ok(acc.free < toMicro(2));
    await st.casAcc(t.tenantId, acc.v, { freeMonth: "2020-01" }); // keçən ay kimi
    let s = await summary(t.tenantId);
    assert.equal(s.balance.freeAzn, 2, "yeni ay: təzədən 2 AZN, əvvəlki qalıq üstünə gəlmir");
    acc = await st.getAcc(t.tenantId);
    await st.casAcc(t.tenantId, acc.v, { free: toMicro(0.1), freeMonth: "2020-01" });
    process.env.BILLING_FREE_PERIOD = "once";
    s = await summary(t.tenantId);
    assert.equal(s.balance.freeAzn, 0.1, "once: yenilənmir");
  });

  test(`[${mode}] 60 paralel sorğu: heç bir xərc itmir`, async () => {
    setup();
    const t = T(fresh());
    await topup(t.tenantId, 100);
    await Promise.all(Array.from({ length: 60 }, () => charge(t, { costUsd: 0.01, tokens: 10 })));
    const s = await summary(t.tenantId);
    const each = fromMicro(billedMicro(0.01));
    assert.ok(Math.abs(s.spend.monthAzn - each * 60) < 0.001, `xərc ${s.spend.monthAzn} ≠ ${each * 60}`);
    assert.ok(Math.abs(s.balance.totalAzn - (102 - each * 60)) < 0.001);
    assert.equal(s.spend.monthRequests, 60);
  });

  test(`[${mode}] yükləmə sorğusu: minimum, gözləyən limiti, təsdiq pulu bir dəfə əlavə edir, rədd`, async () => {
    setup();
    const t = T(fresh());
    await assert.rejects(requestTopup(t.tenantId, 5), /arasında/);
    const r = await requestTopup(t.tenantId, 20);
    assert.equal(r.amountAzn, 20); assert.equal(r.status, "pending");
    assert.equal((await summary(t.tenantId)).pendingRequests.length, 1);
    const ok = await resolveRequest(r.id, "approve", "admin");
    assert.equal(ok.request.status, "approved"); assert.equal(ok.balance.paidAzn, 20);
    const again = await resolveRequest(r.id, "approve", "admin");
    assert.equal(again.balance.paidAzn, 20, "təkrar təsdiq pul əlavə etmir");
    const r2 = await requestTopup(t.tenantId, 10);
    await resolveRequest(r2.id, "reject", "admin");
    assert.equal((await summary(t.tenantId)).balance.paidAzn, 20);
    await assert.rejects(resolveRequest(r2.id, "approve", "admin"), /rədd/);
    await requestTopup(t.tenantId, 10); await requestTopup(t.tenantId, 10); await requestTopup(t.tenantId, 10);
    await assert.rejects(requestTopup(t.tenantId, 10), /Gözləyən/);
    assert.equal((await listRequests({ status: "pending" })).filter((x) => x.tenantId === t.tenantId).length, 3);
  });

  test(`[${mode}] panel xülasəsi: orta sorğu, proqnoz, admin görünüşü (vuruq)`, async () => {
    setup();
    const t = T(fresh());
    for (let i = 0; i < 4; i++) await charge(t, { costUsd: 0.01 });
    await setSettings(t.tenantId, { markup: 2 });
    await charge(t, { costUsd: 0.01 });
    const s = await summary(t.tenantId, { admin: true });
    assert.equal(s.spend.last30Requests, 5);
    assert.ok(s.spend.avgPerRequestAzn > 0.02 && s.spend.avgPerRequestAzn < 0.04);
    assert.ok(s.spend.projectedMonthAzn >= s.spend.monthAzn);
    assert.equal(s.admin.markup, 2); assert.equal(s.admin.defaultMarkup, 1.5);
    assert.ok(s.admin.costAzn30 > 0 && s.admin.costAzn30 < s.spend.last30Azn, "həqiqi xərc satış qiymətindən azdır");
    const pub = await summary(t.tenantId);
    assert.equal(pub.admin, undefined, "müştəriyə vuruq göstərilmir");
    await assert.rejects(setSettings(t.tenantId, { markup: 0.5 }), /Vuruq/);
  });
}
