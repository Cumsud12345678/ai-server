// Abunə planları: müştəri birbaşa plan alır (aylıq və ya illik), planın aylıq cavab limiti var.
// Limit dolanda əlavə paket (məs. +500 cavab) alına bilər. Pulsuz sınaq köhnə balans mexanizmi ilə işləyir (free).
//
// Hesab sənədində (billing_accounts) abunə vəziyyəti:
//   sub = { plan, cycle: "month"|"year", start, end,           — ödənilmiş dövr
//           qStart, qEnd, used, included,                       — cari limit pəncərəsi (illik planda da hər 30 gündən bir sıfırlanır)
//           next,                                               — növbəti dövrdən keçiləcək plan (endirmə)
//           notified: { u80, u100, expiring, expired } }
//   packs = [{ id, left, exp, at }]                              — əlavə paketlər (12 ay qüvvədədir, əvvəl bitməyə yaxın olan işlənir)
//
// Plan kataloqu admin tərəfindən dəyişdirilir (billing_settings: "plan_catalog"); defolt dəyərlər aşağıdadır.
import { randomUUID } from "node:crypto";
import { store } from "./storage.js";
import { toMicro, fromMicro } from "./pricing.js";

const DAY = 86_400_000;
const WINDOW_DAYS = 30;

/** Funksiya açarları: portal bunlara görə imkanları açır/bağlayır */
export const FEATURE_KEYS = ["channels", "live", "automations", "campaigns", "actions", "customerData", "noBranding"];

export const DEFAULT_CATALOG = {
  graceDays: 3,
  packDays: 365,
  plans: [
    { id: "start", name: "Start", priceAzn: 15, replies: 1000, seats: 1,
      features: { channels: true, live: true, automations: false, campaigns: false, actions: false, customerData: false, noBranding: false } },
    { id: "business", name: "Biznes", priceAzn: 35, replies: 3000, seats: 3,
      features: { channels: true, live: true, automations: true, campaigns: true, actions: false, customerData: false, noBranding: true } },
    { id: "pro", name: "Pro", priceAzn: 79, replies: 10000, seats: 10,
      features: { channels: true, live: true, automations: true, campaigns: true, actions: true, customerData: true, noBranding: true } },
  ],
  packs: [{ id: "p500", replies: 500, priceAzn: 10 }],
};
/** Sınaq (plan yoxdur, pulsuz balans var): hər şey açıqdır ki, müştəri bütün imkanları yoxlasın */
export const TRIAL_FEATURES = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
export const TRIAL_SEATS = 3;

const err = (status, message) => Object.assign(new Error(message), { status });
const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };

let catCache = { at: 0, value: null };
export async function getCatalog() {
  if (catCache.value && Date.now() - catCache.at < 5000) return catCache.value;
  const v = await store().getSetting("plan_catalog").catch(() => null);
  catCache = { at: Date.now(), value: v ? normalize(v) : DEFAULT_CATALOG };
  return catCache.value;
}
export const _resetCatalogCache = () => { catCache = { at: 0, value: null }; };

/** Admin kataloqu dəyişir: hər sahə yoxlanılır, səhv dəyər 400 qaytarır */
function normalize(c) {
  const plans = Array.isArray(c?.plans) ? c.plans : null;
  if (!plans || !plans.length || plans.length > 8) throw err(400, "plans 1–8 plandan ibarət olmalıdır");
  const ids = new Set();
  const outPlans = plans.map((p) => {
    const id = String(p?.id ?? "").trim();
    if (!/^[a-z0-9_-]{2,20}$/.test(id) || ids.has(id)) throw err(400, `Plan id düzgün deyil: ${id || "(boş)"}`);
    ids.add(id);
    const priceAzn = num(p.priceAzn, 0, 10000), replies = num(p.replies, 1, 10_000_000), seats = num(p.seats ?? 1, 1, 100);
    if (priceAzn == null || replies == null || seats == null) throw err(400, `${id}: qiymət, cavab sayı və ya komanda sayı düzgün deyil`);
    const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, Boolean(p.features?.[k])]));
    return { id, name: String(p.name ?? id).slice(0, 40), priceAzn, replies: Math.round(replies), seats: Math.round(seats), features };
  });
  const packs = (Array.isArray(c.packs) ? c.packs : []).slice(0, 6).map((k) => {
    const id = String(k?.id ?? "").trim(), replies = num(k?.replies, 1, 1_000_000), priceAzn = num(k?.priceAzn, 0, 10000);
    if (!/^[a-z0-9_-]{2,20}$/.test(id) || replies == null || priceAzn == null) throw err(400, `Paket düzgün deyil: ${id || "(boş)"}`);
    return { id, replies: Math.round(replies), priceAzn };
  });
  return {
    graceDays: num(c.graceDays ?? 3, 0, 30) ?? 3,
    yearlyMonths: num(c.yearlyMonths ?? 10, 1, 12) ?? 10,
    packDays: num(c.packDays ?? 365, 0, 3650) ?? 365,
    plans: outPlans, packs,
  };
}
export async function setCatalog(input) {
  const value = normalize(input);
  // Aktiv abunəçisi olan planı silmək/kodunu dəyişmək olmaz: abunə tanınmaz olar
  const ids = new Set(value.plans.map((p) => p.id));
  const orphan = (await store().listAccounts()).filter((a) => a.sub?.plan && !ids.has(a.sub.plan) && subLive(a.sub, value));
  if (orphan.length) {
    const used = [...new Set(orphan.map((a) => a.sub.plan))].join(", ");
    throw err(409, `Bu planlarda aktiv abunəçi var: ${used} (${orphan.length} müştəri). Əvvəlcə onları başqa plana keçirin`);
  }
  await store().setSetting("plan_catalog", value);
  catCache = { at: Date.now(), value };
  return value;
}

const planOf = (cat, id) => cat.plans.find((p) => p.id === id) ?? null;
const iso = (ms) => new Date(ms).toISOString();
const cycleDays = (cycle) => (cycle === "year" ? 365 : WINDOW_DAYS);
const priceFor = (cat, plan, cycle) => (cycle === "year" ? plan.priceAzn * cat.yearlyMonths : plan.priceAzn);

/** Abunə hazırda xidmət verirmi (ödənilmiş dövr + güzəşt günləri) */
export function subLive(sub, cat, now = Date.now()) {
  return Boolean(sub?.plan) && now < Date.parse(sub.end) + cat.graceDays * DAY;
}
/** Plan limiti + əlavə paketlərdə qalan cavab */
export const packLeft = (packs, now = Date.now()) => (packs ?? []).filter((p) => !p.exp || Date.parse(p.exp) > now).reduce((s, p) => s + p.left, 0);
export const quotaLeft = (sub) => Math.max(0, (sub?.included ?? 0) - (sub?.used ?? 0));
/** Pulsuz sınaqda qalan cavab (müddəti bitibsə 0) */
export const trialLeft = (acc, now = Date.now()) => (!acc?.trial || (acc.trial.until && now >= Date.parse(acc.trial.until)) ? 0 : Math.max(0, acc.trial.left ?? 0));

/** Limit pəncərəsini irəli çəkir (illik planda hər 30 gün, aylıqda dövr yenilənəndə). Dəyişiklik yoxdursa null. */
export function rollWindow(sub, now = Date.now()) {
  if (!sub?.plan || !sub.qEnd) return null;
  let qStart = Date.parse(sub.qStart), qEnd = Date.parse(sub.qEnd);
  const end = Date.parse(sub.end);
  if (now < qEnd || qEnd >= end) return null;
  while (qEnd <= now && qEnd < end) { qStart = qEnd; qEnd = Math.min(qEnd + WINDOW_DAYS * DAY, end); }
  const out = { ...sub, qStart: iso(qStart), qEnd: iso(qEnd), used: 0, notified: { ...(sub.notified ?? {}), u80: false, u100: false } };
  // Planlaşdırılmış keçid (yeniləmə başqa planla ödənilib): köhnə dövr bitəndə yeni plan və limiti başlayır
  if (sub.switchAt && qStart >= Date.parse(sub.switchAt) && sub.next) {
    Object.assign(out, { plan: sub.next, included: sub.nextIncluded ?? sub.included, next: null, switchAt: null, nextIncluded: null });
  }
  return out;
}

/** Müştərinin hazırkı imkanları (portal funksiyaları buna görə açır) */
export function entitlementsOf(acc, cat, now = Date.now()) {
  const sub = acc?.sub;
  if (subLive(sub, cat, now)) {
    const p = planOf(cat, sub.plan);
    if (p) return { source: "plan", plan: p.id, features: p.features, seats: p.seats };
  }
  // Plan yoxdur: sınaq/köhnə balans varsa hər şey açıqdır, yoxdursa AI onsuz da işləmir
  return { source: trialLeft(acc, now) > 0 || (acc?.free ?? 0) + (acc?.paid ?? 0) > 0 ? "trial" : "none", plan: null, features: TRIAL_FEATURES, seats: TRIAL_SEATS };
}

/** Panel üçün abunə görüntüsü */
export function subView(acc, cat, now = Date.now()) {
  const sub = acc?.sub;
  const packs = (acc?.packs ?? []).filter((p) => p.left > 0 && (!p.exp || Date.parse(p.exp) > now));
  const view = {
    catalog: { plans: cat.plans, packs: cat.packs, yearlyMonths: cat.yearlyMonths, graceDays: cat.graceDays },
    packs: packs.map((p) => ({ left: p.left, expiresAt: p.exp, at: p.at })),
    packLeft: packLeft(packs, now),
    entitlements: entitlementsOf(acc, cat, now),
    trial: acc?.trial ? { left: trialLeft(acc, now), total: acc.trial.total ?? acc.trial.left ?? 0, until: acc.trial.until ?? null, used: Math.max(0, (acc.trial.total ?? 0) - (acc.trial.left ?? 0)) } : null,
  };
  if (!sub?.plan) return { ...view, subscription: null };
  const end = Date.parse(sub.end);
  const status = now < end ? "active" : now < end + cat.graceDays * DAY ? "grace" : "expired";
  return {
    ...view,
    subscription: {
      plan: sub.plan, planName: planOf(cat, sub.plan)?.name ?? sub.plan, cycle: sub.cycle, status,
      start: sub.start, end: sub.end, graceUntil: iso(end + cat.graceDays * DAY),
      used: sub.used ?? 0, included: sub.included ?? 0, windowStart: sub.qStart, windowEnd: sub.qEnd,
      next: sub.next ?? null, nextName: sub.next ? planOf(cat, sub.next)?.name ?? sub.next : null,
    },
  };
}

/**
 * Sifarişin məbləği və növü. Növlər:
 *   new     — plan yoxdur/vaxtı bitib: indidən yeni dövr
 *   renew   — eyni (və ya planlaşdırılmış növbəti) planın növbəti dövrü: köhnə bitmə tarixindən davam edir
 *   upgrade — dövrün ortasında bahalı plana keçid: qalan günlərin fərqi ödənilir, bitmə tarixi dəyişmir
 *   pack    — əlavə cavab paketi (aktiv plan tələb olunur)
 */
export function quote(acc, cat, input, now = Date.now()) {
  const kind = input?.kind;
  const sub = acc?.sub;
  const live = subLive(sub, cat, now);
  if (kind === "pack") {
    const pack = cat.packs.find((p) => p.id === input.pack);
    if (!pack) throw err(400, "Paket tapılmadı");
    if (!live) throw err(409, "Əlavə paket yalnız aktiv planla alınır");
    return { kind: "pack", pack: pack.id, replies: pack.replies, amountAzn: pack.priceAzn };
  }
  if (kind !== "plan") throw err(400, "kind plan və ya pack olmalıdır");
  const plan = planOf(cat, input.plan);
  if (!plan) throw err(400, "Plan tapılmadı");
  const cycle = "month"; // illik planlar ləğv olunub: hər dövr 30 gündür
  const cur = live ? planOf(cat, sub.plan) : null;
  if (cur && cur.id !== plan.id && plan.priceAzn > cur.priceAzn && now < Date.parse(sub.end)) {
    // Yüksəltmə: qalan günlər üçün fərq (dövrün növünə görə)
    const total = Date.parse(sub.end) - Date.parse(sub.start);
    const left = Math.max(0, Date.parse(sub.end) - now);
    const diff = priceFor(cat, plan, sub.cycle) - priceFor(cat, cur, sub.cycle);
    const amountAzn = Math.max(0, Math.round((diff * left) / total * 100) / 100);
    return { kind: "plan", type: "upgrade", plan: plan.id, cycle: sub.cycle, amountAzn };
  }
  // Ucuz plan: yalnız əvvəlcədən "növbəti dövrdən keç" seçilibsə (onda bu, növbəti dövrün ödənişidir)
  if (cur && cur.id !== plan.id && plan.priceAzn <= cur.priceAzn && sub.next !== plan.id) throw err(409, "Ucuz plana keçid növbəti dövrdən olur: \"Növbəti dövrdən keç\" seçin");
  const renew = Boolean(cur) && (cur.id === plan.id || sub.next === plan.id);
  return { kind: "plan", type: renew ? "renew" : "new", plan: plan.id, cycle, amountAzn: priceFor(cat, plan, cycle) };
}

/** Ödəniş təsdiqlənəndə sifarişi tətbiq edir. Hesabın yeni sub/packs sahələrini qaytarır (CAS çağıran tərəfdədir). */
export function applyOrder(acc, cat, order, now = Date.now()) {
  if (order.kind === "pack") {
    const exp = cat.packDays > 0 ? iso(now + cat.packDays * DAY) : null;
    return { packs: [...(acc.packs ?? []).filter((p) => p.left > 0), { id: order.id, left: order.replies, exp, at: iso(now) }] };
  }
  const plan = planOf(cat, order.plan);
  if (!plan) throw err(409, "Plan artıq mövcud deyil");
  const sub = acc.sub;
  if (order.type === "upgrade" && subLive(sub, cat, now)) {
    // Limit yeni planınkı olur, işlənmiş cavablar sayılır; bitmə tarixi eyni qalır
    return { sub: { ...sub, plan: plan.id, included: plan.replies, next: null, notified: { ...(sub.notified ?? {}), u80: false, u100: false } } };
  }
  const days = cycleDays(order.cycle);
  if (order.type === "renew" && sub?.plan && now < Date.parse(sub.end)) {
    // Vaxtından əvvəl yeniləmə: cari dövr və limit olduğu kimi qalır, bitmə tarixi uzanır.
    // Növbəti dövr üçün başqa (ucuz) plan seçilibsə, keçid köhnə bitmə tarixində olur.
    const out = { ...sub, end: iso(Date.parse(sub.end) + days * DAY), cycle: order.cycle, notified: { ...(sub.notified ?? {}), expiring: false, expired: false } };
    if (plan.id !== sub.plan) Object.assign(out, { next: plan.id, switchAt: sub.end, nextIncluded: plan.replies });
    else Object.assign(out, { next: null, switchAt: null, nextIncluded: null });
    return { sub: out };
  }
  // Yeniləmə köhnə bitmə tarixindən davam edir (vaxtında ödəyən gün itirmir); vaxtı çoxdan keçibsə indidən
  // (güzəşt müddətində ödəyəndə də köhnə bitmə tarixindən: güzəşt günləri pulsuz deyil)
  const start = order.type === "renew" && sub?.end && Date.parse(sub.end) > now - cat.graceDays * DAY ? Date.parse(sub.end) : now;
  const end = start + days * DAY;
  return {
    sub: {
      plan: plan.id, cycle: order.cycle, start: iso(start), end: iso(end),
      qStart: iso(start), qEnd: iso(Math.min(start + WINDOW_DAYS * DAY, end)),
      used: 0, included: plan.replies, next: null,
      notified: { u80: false, u100: false, expiring: false, expired: false },
    },
  };
}

/** Admin müştəriyə plan verir (pulsuz və ya endirimli): dərhal aktivləşir */
export function adminSub(cat, { plan, days = 30 }, now = Date.now()) {
  const p = planOf(cat, plan);
  if (!p) throw err(400, "Plan tapılmadı");
  const d = num(days, 1, 3650);
  if (d == null) throw err(400, "days 1–3650 olmalıdır");
  const end = now + Math.round(d) * DAY;
  return { plan: p.id, cycle: "month", start: iso(now), end: iso(end), qStart: iso(now), qEnd: iso(Math.min(now + WINDOW_DAYS * DAY, end)), used: 0, included: p.replies, next: null, notified: { u80: false, u100: false, expiring: false, expired: false } };
}

export const newOrderId = () => randomUUID();
export { fromMicro, toMicro };
