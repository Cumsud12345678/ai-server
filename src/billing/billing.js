// Müştəri balansı: pulsuz aylıq məbləğ + yüklənmiş balans. Hər sorğunun real Gemini xərci (dollar → manat) vuruq əmsalı ilə
// əvvəl pulsuz hissədən, sonra yüklənmiş balansdan çıxılır. Balans (və kredit limiti) bitəndə sorğu dayanır.
// Bütün məbləğlər mikro-manatla (1 AZN = 1 000 000), tam ədəd kimi saxlanır: kəsr xətası yığılmır.
import { randomUUID } from "node:crypto";
import { MICRO, billedMicro, config, fromMicro, toMicro } from "./pricing.js";
import { store } from "./storage.js";

const month = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const MAX_TRIES = 60;
// Rəqabət olanda (eyni müştəriyə eyni anda çox sorğu) bir neçə uğursuz cəhddən sonra təsadüfi gözləmə: növbə dağılır
const backoff = (i) => (i < 3 ? Promise.resolve() : new Promise((r) => setTimeout(r, Math.random() * Math.min(40, 2 * i))));

async function ensure(tenantId) {
  const st = store();
  let acc = await st.getAcc(tenantId);
  if (!acc) {
    await st.createAcc({ _id: tenantId, free: toMicro(config.freeAzn()), freeMonth: month(), paid: 0, creditLimit: 0, markup: null, spent: 0, notified: { low: false, empty: false }, v: 0, createdAt: new Date().toISOString() });
    acc = await st.getAcc(tenantId);
  }
  // Aylıq yenilənən pulsuz məbləğ: yığılmır, hər ay təzədən başlayır
  if (config.freePeriod() === "monthly" && acc.freeMonth !== month()) {
    const patch = { free: toMicro(config.freeAzn()), freeMonth: month(), notified: { low: false, empty: false } };
    if (await st.casAcc(tenantId, acc.v, patch)) acc = { ...acc, ...patch, v: acc.v + 1 };
    else acc = await st.getAcc(tenantId);
  }
  return acc;
}

const available = (a) => a.free + a.paid + (a.creditLimit ?? 0);
const stateOf = (a) => {
  const total = a.free + a.paid;
  return total <= 0 ? "empty" : total <= toMicro(config.lowAzn()) ? "low" : "ok";
};

/** Sorğudan əvvəl: balans (və kredit limiti) bitibsə dayandırır. */
export async function canSpend(tenant) {
  if (!config.enforce()) return { ok: true };
  const acc = await ensure(tenant.tenantId);
  if (available(acc) > 0) return { ok: true };
  return { ok: false, code: "BALANCE_EMPTY", message: "Balans bitib" };
}

/**
 * Sorğudan sonra: real xərci yazır. Qaytarır { billedAzn, balanceAzn, state, notify? }.
 * notify ("low" | "empty") yalnız həmin vəziyyətə İLK keçiddə verilir: portal bundan email göndərir.
 */
export async function charge(tenant, { costUsd = 0, tokens = 0 } = {}) {
  const st = store();
  const tenantId = tenant.tenantId;
  let acc = await ensure(tenantId);
  const billed = billedMicro(costUsd, acc.markup ?? config.markup());
  const rawCost = billedMicro(costUsd, 1);
  await st.incDay(tenantId, today(), { billed, cost: rawCost, requests: 1, tokens });
  if (billed <= 0) return { billedAzn: 0, balanceAzn: fromMicro(acc.free + acc.paid), state: stateOf(acc) };

  for (let i = 0; i < MAX_TRIES; i++) {
    const fromFree = Math.min(acc.free, billed);
    const free = acc.free - fromFree;
    const paid = acc.paid - (billed - fromFree);
    const after = { ...acc, free, paid };
    const state = stateOf(after);
    const notified = { ...(acc.notified ?? {}) };
    let notify;
    if (state === "empty" && !notified.empty) { notified.empty = true; notified.low = true; notify = "empty"; }
    else if (state === "low" && !notified.low) { notified.low = true; notify = "low"; }
    if (await st.casAcc(tenantId, acc.v, { free, paid, spent: (acc.spent ?? 0) + billed, notified })) {
      return { billedAzn: fromMicro(billed), balanceAzn: fromMicro(free + paid), state, ...(notify && { notify }) };
    }
    await backoff(i);
    acc = await st.getAcc(tenantId);
  }
  // Çox yüklü rəqabət: xərci itirmirik, yazıb keçirik (nadir hal)
  console.error(`[billing] ${tenantId}: CAS tükəndi, xərc ehtiyat yolla yazıldı (${billed} µAZN)`);
  const a = await st.getAcc(tenantId);
  const fromFree = Math.min(a.free, billed);
  await st.casAcc(tenantId, a.v, { free: a.free - fromFree, paid: a.paid - (billed - fromFree), spent: (a.spent ?? 0) + billed });
  return { billedAzn: fromMicro(billed), balanceAzn: fromMicro(a.free + a.paid - billed), state: "ok" };
}

async function addLedger({ ref, ...entry }) {
  return store().insertLedger({ _id: ref ?? randomUUID(), at: new Date().toISOString(), ...entry });
}

/**
 * Balansı artırır (mənfi məbləğ = düzəliş/qaytarma). `ref` verilibsə əməliyyat təkrar olunmur (ödəniş şlüzü eyni xəbəri
 * bir neçə dəfə göndərə bilər): eyni ref ikinci dəfə pul əlavə etmir.
 */
export async function topup(tenantId, amountAzn, { note = "", by = "", ref, type } = {}) {
  const micro = toMicro(amountAzn);
  if (!Number.isFinite(micro) || micro === 0) throw Object.assign(new Error("Məbləğ düzgün deyil"), { status: 400 });
  if (Math.abs(micro) > toMicro(100_000)) throw Object.assign(new Error("Məbləğ çox böyükdür"), { status: 400 });
  const st = store();
  await ensure(tenantId);
  const fresh = await addLedger({ tenantId, type: type ?? (micro > 0 ? "topup" : "adjust"), amount: micro, note: String(note).slice(0, 200), by: String(by).slice(0, 80), ...(ref && { ref: String(ref).slice(0, 120) }) });
  if (!fresh) return { duplicate: true, ...(await summary(tenantId)) };
  for (let i = 0; i < MAX_TRIES; i++) {
    const acc = await st.getAcc(tenantId);
    const paid = acc.paid + micro;
    const after = { ...acc, paid };
    const notified = stateOf(after) === "ok" ? { low: false, empty: false } : stateOf(after) === "low" ? { low: true, empty: false } : acc.notified;
    if (await st.casAcc(tenantId, acc.v, { paid, notified })) break;
    await backoff(i);
  }
  return { duplicate: false, ...(await summary(tenantId)) };
}

export async function setSettings(tenantId, { markup, creditLimitAzn }) {
  const st = store();
  const patch = {};
  if (markup !== undefined) {
    if (markup !== null && !(Number(markup) >= 1 && Number(markup) <= 10)) throw Object.assign(new Error("Vuruq 1 ilə 10 arasında olmalıdır"), { status: 400 });
    patch.markup = markup === null ? null : Number(markup);
  }
  if (creditLimitAzn !== undefined) {
    const n = Number(creditLimitAzn);
    if (!(n >= 0 && n <= 10_000)) throw Object.assign(new Error("Kredit limiti 0 ilə 10000 arasında olmalıdır"), { status: 400 });
    patch.creditLimit = toMicro(n);
  }
  await ensure(tenantId);
  for (let i = 0; i < MAX_TRIES; i++) {
    const acc = await st.getAcc(tenantId);
    if (await st.casAcc(tenantId, acc.v, patch)) break;
    await backoff(i);
  }
  return summary(tenantId, { admin: true });
}

/** Müştəri "balans yüklə" istəyir (ödəniş provayderi olmayanda admin təsdiq edir). */
export async function requestTopup(tenantId, amountAzn, { provider = "manual" } = {}) {
  const amount = Number(amountAzn);
  if (!(amount >= config.minTopupAzn()) || amount > config.maxTopupAzn())
    throw Object.assign(new Error(`Məbləğ ${config.minTopupAzn()} ilə ${config.maxTopupAzn()} AZN arasında olmalıdır`), { status: 400 });
  const st = store();
  const pending = await st.listReqs({ tenantId, status: "pending", limit: 10 });
  if (pending.length >= 3) throw Object.assign(new Error("Gözləyən 3 yükləmə sorğun var. Əvvəlcə onlar həll olunmalıdır"), { status: 429 });
  const req = { _id: randomUUID(), tenantId, amount: toMicro(amount), status: "pending", provider, at: new Date().toISOString() };
  await st.insertReq(req);
  return publicReq(req);
}

const publicReq = (r) => ({ id: r._id, tenantId: r.tenantId, amountAzn: fromMicro(r.amount), status: r.status, provider: r.provider, at: r.at, ...(r.note && { note: r.note }) });

export async function listRequests(opts) { return (await store().listReqs(opts)).map(publicReq); }

export async function resolveRequest(id, action, by = "") {
  const st = store();
  const r = await st.getReq(id);
  if (!r) throw Object.assign(new Error("Sorğu tapılmadı"), { status: 404 });
  if (action === "approve") {
    if (r.status === "rejected") throw Object.assign(new Error("Sorğu artıq rədd edilib"), { status: 409 });
    const res = await topup(r.tenantId, fromMicro(r.amount), { note: "Yükləmə təsdiqləndi", by, ref: `req:${id}` }); // təkrar təsdiq pul əlavə etmir
    await st.setReqStatus(id, "pending", "approved", { resolvedAt: new Date().toISOString(), resolvedBy: by });
    return { request: publicReq({ ...r, status: "approved" }), ...res };
  }
  if (action === "reject") {
    if (!(await st.setReqStatus(id, "pending", "rejected", { resolvedAt: new Date().toISOString(), resolvedBy: by }))) throw Object.assign(new Error("Sorğu artıq həll olunub"), { status: 409 });
    return { request: publicReq({ ...r, status: "rejected" }) };
  }
  throw Object.assign(new Error("action approve və ya reject olmalıdır"), { status: 400 });
}

/** Panel üçün tam görüntü: qalıq, xərc, orta sorğu, proqnoz, son əməliyyatlar. */
export async function summary(tenantId, { admin = false, history = true } = {}) {
  const st = store();
  const acc = await ensure(tenantId);
  const days = await st.listDays(tenantId, daysAgo(30));
  const m = month();
  const sum = (rows) => rows.reduce((a, d) => ({ billed: a.billed + (d.billed ?? 0), cost: a.cost + (d.cost ?? 0), requests: a.requests + (d.requests ?? 0), tokens: a.tokens + (d.tokens ?? 0) }), { billed: 0, cost: 0, requests: 0, tokens: 0 });
  const last30 = sum(days);
  const thisMonth = sum(days.filter((d) => d.date.startsWith(m)));
  const dayOfMonth = new Date().getUTCDate();
  const dim = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0)).getUTCDate();
  const avg = last30.requests > 0 && last30.billed > 0 ? last30.billed / last30.requests : 0;
  const out = {
    balance: { freeAzn: fromMicro(acc.free), paidAzn: fromMicro(acc.paid), totalAzn: fromMicro(acc.free + acc.paid) },
    state: stateOf(acc),
    allowance: { freeAzn: config.freeAzn(), period: config.freePeriod() },
    minTopupAzn: config.minTopupAzn(), maxTopupAzn: config.maxTopupAzn(), lowAzn: config.lowAzn(),
    enforced: config.enforce(),
    spend: {
      monthAzn: fromMicro(thisMonth.billed), monthRequests: thisMonth.requests,
      last30Azn: fromMicro(last30.billed), last30Requests: last30.requests,
      avgPerRequestAzn: avg ? fromMicro(avg) : null, defaultAvgAzn: config.defaultAvgAzn(),
      projectedMonthAzn: thisMonth.billed > 0 ? fromMicro((thisMonth.billed / dayOfMonth) * dim) : null,
    },
    pendingRequests: (await st.listReqs({ tenantId, status: "pending", limit: 5 })).map(publicReq),
  };
  if (history) {
    out.days = days.slice(0, 30).map((d) => ({ date: d.date, spentAzn: fromMicro(d.billed), requests: d.requests }));
    out.ledger = (await st.listLedger(tenantId, 30)).map((e) => ({ id: e._id, at: e.at, type: e.type, amountAzn: fromMicro(e.amount), note: e.note || "" }));
  }
  if (admin) {
    out.admin = { markup: acc.markup ?? null, defaultMarkup: config.markup(), creditLimitAzn: fromMicro(acc.creditLimit ?? 0), costAzn30: fromMicro(last30.cost), lifetimeSpentAzn: fromMicro(acc.spent ?? 0) };
  }
  return out;
}

export const deleteTenantBilling = (tenantId) => store().deleteTenant(tenantId);
export { MICRO };
