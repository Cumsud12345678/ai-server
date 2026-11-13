// Müştəri balansı: pulsuz aylıq məbləğ + yüklənmiş balans. Hər sorğunun real Gemini xərci (dollar → manat) vuruq əmsalı ilə
// əvvəl pulsuz hissədən, sonra yüklənmiş balansdan çıxılır. Balans (və kredit limiti) bitəndə sorğu dayanır.
// Bütün məbləğlər mikro-manatla (1 AZN = 1 000 000), tam ədəd kimi saxlanır: kəsr xətası yığılmır.
//
// Yüklənmiş balans "partiyalar"la (lots) saxlanır: hər yükləmənin öz bitmə tarixi var (BILLING_TOPUP_EXPIRY_DAYS, defolt 365).
// Xərc əvvəl pulsuz hissədən, sonra bitməyə ən yaxın partiyadan çıxılır. Müddəti bitən partiyanın qalığı yanır
// (jurnala "expire" yazılır). Qayda: partiyaların qalıqları cəmi = max(0, paid). Kredit limiti ilə paid mənfi ola bilər.
import { randomUUID } from "node:crypto";
import { MICRO, billedMicro, config, fromMicro, toMicro } from "./pricing.js";
import { store } from "./storage.js";
import { adminSub, applyOrder, entitlementsOf, getCatalog, packLeft, quotaLeft, quote, rollWindow, subLive, subView, trialLeft } from "./plans.js";

const month = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const MAX_TRIES = 60;
// Rəqabət olanda (eyni müştəriyə eyni anda çox sorğu) bir neçə uğursuz cəhddən sonra təsadüfi gözləmə: növbə dağılır
const backoff = (i) => (i < 3 ? Promise.resolve() : new Promise((r) => setTimeout(r, Math.random() * Math.min(40, 2 * i))));

// ---- Partiyalar ----
const expiryOf = (fromMs = Date.now()) => { const d = config.topupExpiryDays(); return d > 0 ? new Date(fromMs + d * 86_400_000).toISOString() : null; };
/** Bitməyə ən yaxın partiya birinci (müddətsizlər sonda) */
const byExpiry = (a, b) => (a.exp ?? "9999") < (b.exp ?? "9999") ? -1 : (a.exp ?? "9999") > (b.exp ?? "9999") ? 1 : a.at < b.at ? -1 : 1;
/** Partiyaları paid-ə uyğunlaşdırır: artıq qalıq bitməyə ən yaxın partiyadan çıxılır, sıfırlananlar atılır. */
function fitLots(lots, paid) {
  const out = (lots ?? []).map((l) => ({ ...l })).sort(byExpiry);
  let extra = out.reduce((s, l) => s + l.left, 0) - Math.max(0, paid);
  for (const l of out) { if (extra <= 0) break; const take = Math.min(l.left, extra); l.left -= take; extra -= take; }
  return out.filter((l) => l.left > 0);
}

async function ensure(tenantId, { noTrial = false } = {}) {
  const st = store();
  let acc = await st.getAcc(tenantId);
  if (!acc) {
    // Pulsuz sınaq: N cavab, D gün ərzində (hansı tez bitsə).
    // noTrial: bu e-poçt əvvəl sınaqdan istifadə edib (hesabı silib yenidən açıb): pulsuz sınaq və pulsuz məbləğ verilmir
    const n = noTrial ? 0 : config.trialReplies(), days = config.trialDays();
    const trial = n > 0 ? { left: n, total: n, until: days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null, notified: false } : null;
    await st.createAcc({ _id: tenantId, free: noTrial ? 0 : toMicro(config.freeAzn()), freeMonth: month(), paid: 0, lots: [], creditLimit: 0, markup: null, spent: 0, notified: { low: false, empty: false }, ...(trial && { trial }), ...(noTrial && { noTrial: true }), v: 0, createdAt: new Date().toISOString() });
    acc = await st.getAcc(tenantId);
  }
  // Köhnə hesab (partiyasız): mövcud yüklənmiş balans bir partiya olur, müddət bu andan sayılır (müştəri itirmir)
  if (!Array.isArray(acc.lots)) {
    const lots = acc.paid > 0 ? [{ id: "legacy", amount: acc.paid, left: acc.paid, at: new Date().toISOString(), exp: expiryOf() }] : [];
    if (await st.casAcc(tenantId, acc.v, { lots })) acc = { ...acc, lots, v: acc.v + 1 };
    else acc = await st.getAcc(tenantId);
  }
  // Müddəti bitən partiyalar yanır
  const now = new Date().toISOString();
  for (let i = 0; i < MAX_TRIES && (acc.lots ?? []).some((l) => l.exp && l.exp <= now && l.left > 0); i++) {
    const dead = acc.lots.filter((l) => l.exp && l.exp <= now && l.left > 0);
    const burned = dead.reduce((s, l) => s + l.left, 0);
    const lots = acc.lots.filter((l) => !dead.includes(l));
    const paid = acc.paid - burned;
    if (await st.casAcc(tenantId, acc.v, { paid, lots })) {
      for (const l of dead) {
        await addLedger({ ref: `expire:${tenantId}:${l.id}`, tenantId, type: "expire", amount: -l.left, note: `Müddəti bitdi: ${l.at.slice(0, 10)} tarixli yükləmənin istifadə olunmayan hissəsi`, by: "system" }).catch(() => {});
      }
      acc = { ...acc, paid, lots, v: acc.v + 1 };
      break;
    }
    await backoff(i);
    acc = await st.getAcc(tenantId);
  }
  // Abunə: limit pəncərəsi keçibsə sıfırlanır (illik planda hər 30 gün)
  for (let i = 0; i < MAX_TRIES; i++) {
    const rolled = rollWindow(acc.sub);
    if (!rolled) break;
    if (await st.casAcc(tenantId, acc.v, { sub: rolled })) { acc = { ...acc, sub: rolled, v: acc.v + 1 }; break; }
    acc = await st.getAcc(tenantId);
  }
  // Aylıq yenilənən pulsuz məbləğ: yığılmır, hər ay təzədən başlayır
  if (config.freePeriod() === "monthly" && acc.freeMonth !== month()) {
    const patch = { free: acc.noTrial ? 0 : toMicro(config.freeAzn()), freeMonth: month(), notified: { low: false, empty: false } };
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

// ---- Ümumi AI açarı (admin): bütün müştərilər üçün AI sorğularını dayandırır ----
// Hər sorğuda bazaya getməmək üçün 5 saniyə yaddaşda saxlanır; dəyişəndə dərhal yenilənir.
let controlCache = { at: 0, value: null };
export async function getAiControl() {
  if (Date.now() - controlCache.at < 5000) return controlCache.value ?? { paused: false };
  const v = await store().getSetting("ai_control").catch(() => controlCache.value);
  controlCache = { at: Date.now(), value: v };
  return v ?? { paused: false };
}
export async function setAiControl({ paused, reason = "", by = "" }) {
  if (typeof paused !== "boolean") throw Object.assign(new Error("paused true/false olmalıdır"), { status: 400 });
  const value = paused ? { paused: true, reason: String(reason).slice(0, 300), by: String(by).slice(0, 80), at: new Date().toISOString() } : null;
  await store().setSetting("ai_control", value);
  controlCache = { at: Date.now(), value };
  return value ?? { paused: false };
}
export const resetAiControlCache = () => { controlCache = { at: 0, value: null }; };

const dailyLimitOf = (acc) => (acc.dailyLimit != null ? acc.dailyLimit : toMicro(config.dailyLimitAzn()));

/**
 * Sorğudan əvvəl yoxlama (sıra ilə): ümumi AI açarı, hesabın dayandırılması, balans (və kredit limiti), gündəlik xərc tavanı.
 * Gündəlik tavan balansdan asılı deyil: botun sui-istifadəsi və ya ilişib qalan inteqrasiya bir gündə balansı yandırmasın.
 */
export async function canSpend(tenant, { reply = true } = {}) {
  const control = await getAiControl();
  if (control.paused) return { ok: false, code: "AI_PAUSED", message: "AI müvəqqəti dayandırılıb" };
  if (tenant?.suspended) return { ok: false, code: "TENANT_SUSPENDED", message: "Hesab müvəqqəti dayandırılıb" };
  const acc = await ensure(tenant.tenantId);
  const limit = dailyLimitOf(acc);
  if (limit > 0) {
    const day = await store().getDay(tenant.tenantId, today());
    // Plan müştərisində balansdan pul çıxılmır (billed = 0): limit real AI xərcinə görə işləyir. Balansla işləyəndə billed ≥ cost.
    if (Math.max(day?.billed ?? 0, day?.cost ?? 0) >= limit) return { ok: false, code: "DAILY_LIMIT", message: "Gündəlik xərc limitinə çatılıb" };
  }
  if (!config.enforce()) return { ok: true };
  // Abunə: plan limiti və ya əlavə paket. Köməkçi xərclər (səs, operator qaralaması, analiz) planın içindədir.
  const cat = await getCatalog();
  if (subLive(acc.sub, cat)) {
    if (!reply || quotaLeft(acc.sub) > 0 || packLeft(acc.packs) > 0) return { ok: true };
    if (available(acc) > 0) return { ok: true };
    return { ok: false, code: "PLAN_LIMIT", message: "Planın cavab limiti dolub" };
  }
  if (trialLeft(acc) > 0) return { ok: true };
  if (available(acc) > 0) return { ok: true };
  if (acc.sub?.plan) return { ok: false, code: "PLAN_EXPIRED", message: "Planın müddəti bitib" };
  if (acc.trial) return { ok: false, code: "TRIAL_ENDED", message: "Pulsuz sınaq bitib" };
  return { ok: false, code: "BALANCE_EMPTY", message: "Balans bitib" };
}

/**
 * Sorğudan sonra: real xərci yazır. Qaytarır { billedAzn, balanceAzn, state, notify? }.
 * notify ("low" | "empty") yalnız həmin vəziyyətə İLK keçiddə verilir: portal bundan email göndərir.
 */
export async function charge(tenant, { costUsd = 0, tokens = 0, requests = 1, reply = false } = {}) {
  const st = store();
  const tenantId = tenant.tenantId;
  let acc = await ensure(tenantId);
  const billed = billedMicro(costUsd, acc.markup ?? config.markup());
  const rawCost = billedMicro(costUsd, 1);
  const cat = await getCatalog();
  if (subLive(acc.sub, cat)) {
    const r = await chargePlan(tenantId, acc, { reply, rawCost, requests, tokens });
    if (r) return r;
  } else if (trialLeft(acc) > 0) {
    const r = await chargeTrial(tenantId, acc, { reply, rawCost, requests, tokens });
    if (r) return r;
  }
  await st.incDay(tenantId, today(), { billed, cost: rawCost, requests, tokens });
  if (billed <= 0) return { billedAzn: 0, balanceAzn: fromMicro(acc.free + acc.paid), state: stateOf(acc) };

  for (let i = 0; i < MAX_TRIES; i++) {
    const fromFree = Math.min(acc.free, billed);
    const free = acc.free - fromFree;
    const paid = acc.paid - (billed - fromFree);
    const lots = fitLots(acc.lots, paid);
    const after = { ...acc, free, paid };
    const state = stateOf(after);
    const notified = { ...(acc.notified ?? {}) };
    let notify;
    if (state === "empty" && !notified.empty) { notified.empty = true; notified.low = true; notify = "empty"; }
    else if (state === "low" && !notified.low) { notified.low = true; notify = "low"; }
    if (await st.casAcc(tenantId, acc.v, { free, paid, lots, spent: (acc.spent ?? 0) + billed, notified })) {
      // Pulsuz hissədən çıxılan məbləğ gəlir deyil: maliyyə hesabatında ayrıca göstərilir
      if (fromFree > 0) await st.incDay(tenantId, today(), { free: fromFree }).catch(() => {});
      return { billedAzn: fromMicro(billed), balanceAzn: fromMicro(free + paid), state, ...(notify && { notify }) };
    }
    await backoff(i);
    acc = await st.getAcc(tenantId);
  }
  // Çox yüklü rəqabət: xərci itirmirik, yazıb keçirik (nadir hal)
  console.error(`[billing] ${tenantId}: CAS tükəndi, xərc ehtiyat yolla yazıldı (${billed} µAZN)`);
  const a = await st.getAcc(tenantId);
  const fromFree = Math.min(a.free, billed);
  await st.casAcc(tenantId, a.v, { free: a.free - fromFree, paid: a.paid - (billed - fromFree), lots: fitLots(a.lots, a.paid - (billed - fromFree)), spent: (a.spent ?? 0) + billed });
  if (fromFree > 0) await st.incDay(tenantId, today(), { free: fromFree }).catch(() => {});
  return { billedAzn: fromMicro(billed), balanceAzn: fromMicro(a.free + a.paid - billed), state: "ok" };
}

/**
 * Abunə ilə ödəniş: cavab plan limitindən, o bitəndə əlavə paketdən çıxılır (pul çıxılmır, real xərc hesabata yazılır).
 * Hər ikisi bitibsə null: çağıran tərəf balansa keçir (köhnə balans varsa). 80% və 100%-də bir dəfə xəbər verir.
 */
async function chargePlan(tenantId, acc, { reply, rawCost, requests, tokens }) {
  const st = store();
  for (let i = 0; i < MAX_TRIES; i++) {
    const sub = acc.sub;
    const now = Date.now();
    let patch = null, notify;
    if (!reply) patch = {}; // köməkçi xərc: planın içində
    else if (quotaLeft(sub) > 0) {
      const used = (sub.used ?? 0) + 1;
      const notified = { ...(sub.notified ?? {}) };
      const extra = packLeft(acc.packs, now);
      if (used >= sub.included && extra <= 0 && !notified.u100) { notified.u100 = true; notified.u80 = true; notify = "usage100"; }
      else if (used >= Math.ceil(sub.included * 0.8) && !notified.u80) { notified.u80 = true; notify = "usage80"; }
      patch = { sub: { ...sub, used, notified } };
    } else if (packLeft(acc.packs, now) > 0) {
      // Paket: bitməyə ən yaxın birinci
      const packs = [...acc.packs].filter((p) => p.left > 0 && (!p.exp || Date.parse(p.exp) > now)).sort((a, b) => ((a.exp ?? "9999") < (b.exp ?? "9999") ? -1 : 1));
      packs[0] = { ...packs[0], left: packs[0].left - 1 };
      const left = packs.reduce((s, p) => s + p.left, 0);
      const notified = { ...(sub.notified ?? {}) };
      if (left <= 0 && !notified.u100) { notified.u100 = true; notify = "usage100"; }
      patch = { packs: packs.filter((p) => p.left > 0), sub: { ...sub, notified } };
    } else return null;
    if (!Object.keys(patch).length || (await st.casAcc(tenantId, acc.v, patch))) {
      await st.incDay(tenantId, today(), { billed: 0, cost: rawCost, requests, tokens, ...(reply && { planReplies: 1 }) });
      const after = { ...acc, ...patch };
      return {
        billedAzn: 0, balanceAzn: fromMicro(acc.free + acc.paid), state: "ok",
        plan: { used: after.sub.used ?? 0, included: after.sub.included ?? 0, packLeft: packLeft(after.packs) },
        ...(notify && { notify }),
      };
    }
    await backoff(i);
    acc = await st.getAcc(tenantId);
  }
  return null;
}

/** Pulsuz sınaq: hər cavab sınaq sayından çıxılır; bitəndə bir dəfə "trialEnd" xəbəri */
async function chargeTrial(tenantId, acc, { reply, rawCost, requests, tokens }) {
  const st = store();
  for (let i = 0; i < MAX_TRIES; i++) {
    if (trialLeft(acc) <= 0) return null;
    let patch = {}, notify;
    if (reply) {
      const left = acc.trial.left - 1;
      const notified = left <= 0 ? true : Boolean(acc.trial.notified);
      if (left <= 0 && !acc.trial.notified) notify = "trialEnd";
      patch = { trial: { ...acc.trial, left, notified } };
    }
    if (!reply || (await st.casAcc(tenantId, acc.v, patch))) {
      await st.incDay(tenantId, today(), { billed: 0, cost: rawCost, requests, tokens, ...(reply && { trialReplies: 1 }) });
      const left = reply ? patch.trial.left : acc.trial.left;
      return { billedAzn: 0, balanceAzn: fromMicro(acc.free + acc.paid), state: "ok", trial: { left, total: acc.trial.total ?? 0 }, ...(notify && { notify }) };
    }
    await backoff(i);
    acc = await st.getAcc(tenantId);
  }
  return null;
}

// ---- Abunə sifarişləri ----
const planReq = (r) => ({ kind: r.kind ?? "topup", ...(r.plan && { plan: r.plan }), ...(r.cycle && { cycle: r.cycle }), ...(r.type && { orderType: r.type }), ...(r.pack && { pack: r.pack }), ...(r.replies && { replies: r.replies }) });

/** Müştəri plan və ya paket sifariş edir: məbləğ serverdə hesablanır, ödəniş təsdiqlənəndə tətbiq olunur */
export async function requestOrder(tenantId, input, { provider = "manual" } = {}) {
  const st = store();
  const acc = await ensure(tenantId);
  const cat = await getCatalog();
  const q = quote(acc, cat, input);
  const pending = await st.listReqs({ tenantId, status: "pending", limit: 10 });
  if (pending.length >= 3) throw Object.assign(new Error("Gözləyən 3 sifarişin var. Əvvəlcə onlar həll olunmalıdır"), { status: 429 });
  const req = { _id: randomUUID(), tenantId, amount: toMicro(q.amountAzn), status: "pending", provider, at: new Date().toISOString(), ...q };
  await st.insertReq(req);
  return publicReq(req);
}

/** Sifarişin qiymətini göstərmək üçün (heç nə yaratmır) */
export async function quoteOrder(tenantId, input) {
  const acc = await ensure(tenantId);
  return quote(acc, await getCatalog(), input);
}

/** Təsdiqlənmiş plan/paket sifarişini hesaba tətbiq edir (ledger ref ilə təkrar tətbiq olunmur) */
async function applyPlanOrder(r, by) {
  const st = store();
  const cat = await getCatalog();
  const fresh = await addLedger({ ref: `req:${r._id}`, tenantId: r.tenantId, type: r.kind === "pack" ? "pack" : "plan", amount: r.amount, note: r.kind === "pack" ? `Əlavə paket: +${r.replies} cavab` : `Plan: ${r.plan} (${r.cycle === "year" ? "illik" : "aylıq"}${r.type === "upgrade" ? ", yüksəltmə" : r.type === "renew" ? ", yeniləmə" : ""})`, by: String(by).slice(0, 80) });
  if (!fresh) return false;
  for (let i = 0; i < MAX_TRIES; i++) {
    const acc = await ensure(r.tenantId);
    const patch = applyOrder(acc, cat, { ...r, id: r._id });
    if (await st.casAcc(r.tenantId, acc.v, patch)) return true;
    await backoff(i);
  }
  return true;
}

/** Növbəti dövrdən ucuz plana keçid (ödənişsiz qeyd) və ya ləğvi (null) */
export async function setNextPlan(tenantId, planId) {
  const st = store();
  const cat = await getCatalog();
  for (let i = 0; i < MAX_TRIES; i++) {
    const acc = await ensure(tenantId);
    if (!subLive(acc.sub, cat)) throw Object.assign(new Error("Aktiv plan yoxdur"), { status: 409 });
    if (planId !== null && !cat.plans.some((p) => p.id === planId)) throw Object.assign(new Error("Plan tapılmadı"), { status: 400 });
    const sub = { ...acc.sub, next: planId === acc.sub.plan ? null : planId };
    if (await st.casAcc(tenantId, acc.v, { sub })) return subView({ ...acc, sub }, cat);
    await backoff(i);
  }
  throw Object.assign(new Error("Yenidən cəhd edin"), { status: 503 });
}

/** Admin: müştəriyə plan verir (pulsuz/endirimli) və ya planı götürür (plan: null) */
export async function adminSetPlan(tenantId, { plan, days, note = "", by = "" }) {
  const st = store();
  const cat = await getCatalog();
  for (let i = 0; i < MAX_TRIES; i++) {
    const acc = await ensure(tenantId);
    const sub = plan === null ? null : adminSub(cat, { plan, days });
    if (await st.casAcc(tenantId, acc.v, { sub })) {
      await addLedger({ tenantId, type: "plan", amount: 0, note: plan === null ? `Plan admin tərəfindən götürüldü${note ? `: ${note}` : ""}` : `Admin plan verdi: ${plan}, ${days} gün${note ? ` — ${note}` : ""}`, by: String(by).slice(0, 80) });
      return subView({ ...acc, sub }, cat);
    }
    await backoff(i);
  }
  throw Object.assign(new Error("Yenidən cəhd edin"), { status: 503 });
}

/**
 * Bonus cavablar (məs. partnyor kodu ilə gələn müştəriyə): paket kimi əlavə olunur, plan limiti bitəndən sonra işlənir.
 * ref təkrar-qorumadır: eyni ref ikinci dəfə cavab əlavə etmir. Plan yoxdursa sınağa əlavə olunur.
 */
export async function grantReplies(tenantId, { replies, ref, note = "", by = "" }) {
  const n = Math.round(Number(replies));
  if (!Number.isFinite(n) || n < 1 || n > 100_000) throw Object.assign(new Error("replies 1–100000 olmalıdır"), { status: 400 });
  if (typeof ref !== "string" || !ref) throw Object.assign(new Error("ref lazımdır"), { status: 400 });
  const st = store();
  const cat = await getCatalog();
  const fresh = await addLedger({ ref: `replies:${ref}`.slice(0, 200), tenantId, type: "bonus", amount: 0, note: `+${n} bonus cavab${note ? ` · ${note}` : ""}`, by: String(by).slice(0, 80) });
  if (!fresh) return { duplicate: true };
  for (let i = 0; i < MAX_TRIES; i++) {
    const acc = await ensure(tenantId);
    const patch = subLive(acc.sub, cat)
      ? { packs: [...(acc.packs ?? []).filter((p) => p.left > 0), { id: `bonus:${ref}`.slice(0, 120), left: n, exp: cat.packDays > 0 ? new Date(Date.now() + cat.packDays * 86_400_000).toISOString() : null, at: new Date().toISOString(), bonus: true }] }
      : { trial: { ...(acc.trial ?? { total: 0, left: 0, until: null }), left: trialLeft(acc) + n, total: (acc.trial?.total ?? 0) + n, notified: false } };
    if (await st.casAcc(tenantId, acc.v, patch)) return { duplicate: false, replies: n };
    await backoff(i);
  }
  throw Object.assign(new Error("Yenidən cəhd edin"), { status: 503 });
}

/** Yeni müştərinin balans hesabını dərhal yaradır. noTrial: pulsuz sınaq və pulsuz məbləğ verilmir (təkrar qeydiyyat). */
export async function initAccount(tenantId, { noTrial = false } = {}) {
  await ensure(tenantId, { noTrial });
}

/** Portal üçün: müştərinin imkanları (keşlənir) */
export async function entitlements(tenantId) {
  const acc = await ensure(tenantId);
  return entitlementsOf(acc, await getCatalog());
}

/**
 * Xatırlatmalar: bitməsinə ≤3 gün qalan (expiring) və güzəşti bitmiş (expired) abunələr. Hər biri bir dəfə qaytarılır
 * (bayraq CAS ilə qoyulur): portal saatlıq yoxlamada e-poçt göndərir.
 */
export async function planReminders(now = Date.now()) {
  const st = store();
  const cat = await getCatalog();
  const out = [];
  for (const a of await st.listAccounts()) {
    const sub = a.sub;
    if (!sub?.plan) continue;
    const end = Date.parse(sub.end);
    let kind = null;
    if (now > end + cat.graceDays * 86_400_000 && !sub.notified?.expired) kind = "expired";
    else if (now < end && end - now <= 3 * 86_400_000 && !sub.notified?.expiring) kind = "expiring";
    if (!kind) continue;
    const next = { ...sub, notified: { ...(sub.notified ?? {}), [kind]: true, ...(kind === "expired" && { expiring: true }) } };
    if (await st.casAcc(a._id, a.v, { sub: next })) out.push({ tenantId: a._id, kind, plan: sub.plan, planName: cat.plans.find((p) => p.id === sub.plan)?.name ?? sub.plan, end: sub.end, next: sub.next ?? null });
  }
  return out;
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
  // Müsbət məbləğ yeni partiya açır (öz bitmə tarixi ilə); mənfi düzəliş bitməyə ən yaxın partiyadan çıxılır.
  // Kredit limiti borcu varsa yeni pul əvvəlcə borcu bağlayır (fitLots partiyanı paid-ə uyğunlaşdırır).
  const at = new Date().toISOString();
  for (let i = 0; i < MAX_TRIES; i++) {
    const acc = await st.getAcc(tenantId);
    const paid = acc.paid + micro;
    const lots = fitLots(micro > 0 ? [...(acc.lots ?? []), { id: String(ref ?? randomUUID()).slice(0, 120), amount: micro, left: micro, at, exp: expiryOf(Date.parse(at)) }] : acc.lots, paid);
    const after = { ...acc, paid };
    const notified = stateOf(after) === "ok" ? { low: false, empty: false } : stateOf(after) === "low" ? { low: true, empty: false } : acc.notified;
    if (await st.casAcc(tenantId, acc.v, { paid, lots, notified })) break;
    await backoff(i);
  }
  return { duplicate: false, ...(await summary(tenantId)) };
}

export async function setSettings(tenantId, { markup, creditLimitAzn, dailyLimitAzn }) {
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
  if (dailyLimitAzn !== undefined) {
    // null/"" = ümumi qayda (BILLING_DAILY_LIMIT_AZN), 0 = bu müştəri üçün limit yoxdur
    if (dailyLimitAzn === null || dailyLimitAzn === "") patch.dailyLimit = null;
    else {
      const n = Number(dailyLimitAzn);
      if (!(n >= 0 && n <= 10_000)) throw Object.assign(new Error("Gündəlik limit 0 ilə 10000 arasında olmalıdır"), { status: 400 });
      patch.dailyLimit = toMicro(n);
    }
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

const publicReq = (r) => ({ id: r._id, tenantId: r.tenantId, amountAzn: fromMicro(r.amount), status: r.status, provider: r.provider, at: r.at, ...(r.note && { note: r.note }), ...planReq(r) });

export async function listRequests(opts) { return (await store().listReqs(opts)).map(publicReq); }

// ---- Admin "Ödənişlər": sorğular və balans hərəkətləri (bütün müştərilər üzrə, süzgəc və səhifələmə ilə) ----
const isoOrNull = (v) => { if (typeof v !== "string" || !v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const pageOpts = (q) => ({
  tenantId: typeof q.tenantId === "string" && q.tenantId ? q.tenantId.slice(0, 80) : undefined,
  since: isoOrNull(q.since) ?? undefined, until: isoOrNull(q.until) ?? undefined, before: isoOrNull(q.before) ?? undefined,
  limit: Math.min(500, Math.max(1, Math.round(Number(q.limit) || 100))),
});
const adminReq = (r) => ({ ...publicReq(r), ...(r.resolvedAt && { resolvedAt: r.resolvedAt }), ...(r.resolvedBy && { resolvedBy: r.resolvedBy }) });
export async function adminRequests(q = {}) {
  const status = ["pending", "approved", "rejected"].includes(q.status) ? q.status : undefined;
  const o = pageOpts(q);
  const rows = await store().queryReqs({ ...o, status, limit: o.limit + 1 });
  return { requests: rows.slice(0, o.limit).map(adminReq), nextBefore: rows.length > o.limit ? rows[o.limit - 1].at : null };
}
/** kind: payment = ödəniş şlüzü və ya təsdiqlənmiş sorğu, manual = admin əl ilə əlavə, adjust = mənfi düzəliş */
const ledgerKind = (e) => (e.type === "expire" ? "expire" : e.amount < 0 ? "adjust" : String(e._id).startsWith("req:") || String(e._id).startsWith("pay:") ? "payment" : "manual");
export async function adminLedger(q = {}) {
  const o = pageOpts(q);
  const kind = ["payment", "manual", "adjust", "expire"].includes(q.kind) ? q.kind : undefined;
  // kind süzgəci yaddaşda tətbiq olunur: səhifə dolmaya bilər, ona görə bir az artıq oxunur
  const rows = await store().queryLedger({ ...o, limit: kind ? Math.min(2000, o.limit * 5) : o.limit + 1 });
  const filtered = kind ? rows.filter((e) => ledgerKind(e) === kind) : rows;
  const page = filtered.slice(0, o.limit);
  return {
    entries: page.map((e) => ({ id: e._id, tenantId: e.tenantId, at: e.at, kind: ledgerKind(e), type: e.type, amountAzn: fromMicro(e.amount), note: e.note || "", by: e.by || "" })),
    nextBefore: (kind ? rows.length >= Math.min(2000, o.limit * 5) || filtered.length > o.limit : rows.length > o.limit) && page.length ? page[page.length - 1].at : null,
  };
}

export async function resolveRequest(id, action, by = "") {
  const st = store();
  const r = await st.getReq(id);
  if (!r) throw Object.assign(new Error("Sorğu tapılmadı"), { status: 404 });
  if (action === "approve") {
    if (r.status === "rejected") throw Object.assign(new Error("Sorğu artıq rədd edilib"), { status: 409 });
    if (r.kind === "plan" || r.kind === "pack") {
      const applied = await applyPlanOrder(r, by);
      await st.setReqStatus(id, "pending", "approved", { resolvedAt: new Date().toISOString(), resolvedBy: by });
      return { request: publicReq({ ...r, status: "approved" }), duplicate: !applied, ...(await summary(r.tenantId)) };
    }
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

// Platforma üzrə son 30 günün real orta qiyməti (bütün müştərilər): müştərinin öz tarixçəsi azdırsa təxmin üçün işlənir.
// 10 dəqiqəlik keş: hər balans səhifəsi açılanda bütün günləri oxumasın.
let platformAvg = { at: 0, micro: 0, requests: 0 };
async function platformAvgMicro() {
  if (Date.now() - platformAvg.at < 10 * 60_000) return platformAvg;
  const rows = await store().listAllDays(daysAgo(30));
  const t = rows.reduce((a, d) => ({ billed: a.billed + (d.billed ?? 0), requests: a.requests + (d.requests ?? 0) }), { billed: 0, requests: 0 });
  platformAvg = { at: Date.now(), micro: t.requests > 0 && t.billed > 0 ? t.billed / t.requests : 0, requests: t.requests };
  return platformAvg;
}
export const _resetPlatformAvg = () => { platformAvg = { at: 0, micro: 0, requests: 0 }; };
// Müştərinin öz ortası bu qədər sorğudan sonra etibarlı sayılır
const OWN_AVG_MIN_REQUESTS = 20;

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
    // Yüklənmiş balansın partiyaları: hər birinin qalığı və bitmə tarixi (bitməyə ən yaxın birinci)
    lots: [...(acc.lots ?? [])].sort(byExpiry).map((l) => ({ amountAzn: fromMicro(l.amount), leftAzn: fromMicro(l.left), at: l.at, expiresAt: l.exp })),
    expiryDays: config.topupExpiryDays(),
    state: stateOf(acc),
    allowance: { freeAzn: config.freeAzn(), period: config.freePeriod() },
    minTopupAzn: config.minTopupAzn(), maxTopupAzn: config.maxTopupAzn(), lowAzn: config.lowAzn(),
    enforced: config.enforce(),
    spend: {
      monthAzn: fromMicro(thisMonth.billed), monthRequests: thisMonth.requests,
      last30Azn: fromMicro(last30.billed), last30Requests: last30.requests,
      avgPerRequestAzn: avg ? fromMicro(avg) : null, defaultAvgAzn: config.defaultAvgAzn(),
      // Təxmin üçün mesaj qiyməti: müştərinin öz real ortası (kifayət qədər sorğu varsa), yoxsa bütün platformanın real ortası, o da yoxdursa standart
      ...(await (async () => {
        if (avg && last30.requests >= OWN_AVG_MIN_REQUESTS) return { estimateAzn: fromMicro(avg), estimateSource: "own", estimateRequests: last30.requests };
        const p = await platformAvgMicro().catch(() => ({ micro: 0, requests: 0 }));
        if (p.micro) return { estimateAzn: fromMicro(p.micro), estimateSource: "platform", estimateRequests: p.requests };
        if (avg) return { estimateAzn: fromMicro(avg), estimateSource: "own", estimateRequests: last30.requests };
        return { estimateAzn: config.defaultAvgAzn(), estimateSource: "default", estimateRequests: 0 };
      })()),
      projectedMonthAzn: thisMonth.billed > 0 ? fromMicro((thisMonth.billed / dayOfMonth) * dim) : null,
    },
    pendingRequests: (await st.listReqs({ tenantId, status: "pending", limit: 5 })).map(publicReq),
    ...subView(acc, await getCatalog()),
  };
  if (history) {
    out.days = days.slice(0, 30).map((d) => ({ date: d.date, spentAzn: fromMicro(d.billed), requests: d.requests }));
    out.ledger = (await st.listLedger(tenantId, 30)).map((e) => ({ id: e._id, at: e.at, type: e.type, amountAzn: fromMicro(e.amount), note: e.note || "" }));
  }
  if (admin) {
    const todayRow = days.find((d) => d.date === today());
    out.admin = {
      markup: acc.markup ?? null, defaultMarkup: config.markup(), creditLimitAzn: fromMicro(acc.creditLimit ?? 0), costAzn30: fromMicro(last30.cost), lifetimeSpentAzn: fromMicro(acc.spent ?? 0),
      dailyLimitAzn: acc.dailyLimit != null ? fromMicro(acc.dailyLimit) : null, defaultDailyLimitAzn: config.dailyLimitAzn(), todayAzn: fromMicro(todayRow?.billed ?? 0),
      // Real (vuruqsuz) xərc: provayderə ödənən
      todayCostAzn: fromMicro(todayRow?.cost ?? 0), monthCostAzn: fromMicro(thisMonth.cost ?? 0),
    };
  }
  return out;
}

export const deleteTenantBilling = (tenantId) => store().deleteTenant(tenantId);

/** Model üzrə aylıq xərc (onModelCost hook-u ilə çağırılır). Xərc mikro-manatla, vuruqsuz (real xərc). */
export async function recordModelCost(model, costUsd, tokens = 0) {
  await store().incModel(month(), String(model).slice(0, 80), { cost: billedMicro(costUsd, 1), calls: 1, tokens: Math.round(Number(tokens) || 0) });
}
export { MICRO };
