// Müştəri başına aylıq sorğu/token sayğacı və dəqiqəlik limit.
//  - AI_MONGODB_URI verilibsə: MongoDB ("usage" kolleksiyası, atomik $inc: eyni anda gələn sorğular bir-birinin sayını silmir).
//  - Verilməyibsə: fayl (inkişaf/test üçün, bir proses).
// Dəqiqəlik limit yaddaşdadır (hər server üçün ayrıca); bu qəsdəndir, DB-yə hər sorğuda əlavə yazı salmır.
import fs from "node:fs";
import { mongoEnabled, storeDb } from "../store/mongo.js";

const FILE = () => process.env.USAGE_FILE || new URL("../../data/usage.json", import.meta.url);
let state;
const windows = new Map();
const month = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10); // günlər UTC ilə sayılır
const DAYS = 14;
// Son 14 günün tarixləri (köhnədən yeniyə)
const lastDays = () => Array.from({ length: DAYS }, (_, i) => new Date(Date.now() - (DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10));

// ---------- fayl rejimi ----------
const load = () => {
  if (!state) { try { state = JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch { state = {}; } }
  return state;
};
const save = () => { try { fs.writeFileSync(FILE(), JSON.stringify(state, null, 2)); } catch (e) { console.warn("[usage] yazıla bilmədi:", e.message); } };
const bucket = (id) => ((load()[id] ??= {})[month()] ??= { requests: 0, tokens: 0 });
const fileDay = (id, m, d) => load()[id]?.[m]?.days?.[d] ?? 0;

// ---------- MongoDB rejimi ----------
const col = async () => (await storeDb()).collection("usage");
const docId = (tenantId) => `${tenantId}:${month()}`;
const meta = (tenantId) => ({ tenantId, month: month() });

async function hitMonthly(tenantId, limit) {
  const c = await col();
  const after = await c.findOneAndUpdate(
    { _id: docId(tenantId) }, { $inc: { requests: 1, [`days.${today()}`]: 1 }, $setOnInsert: meta(tenantId) }, { upsert: true, returnDocument: "after" });
  if (limit && after.requests > limit) {
    await c.updateOne({ _id: docId(tenantId) }, { $inc: { requests: -1, [`days.${today()}`]: -1 } }); // limit dolub: bu sorğu sayılmır
    return false;
  }
  return true;
}

export async function checkAndCount(tenant, { countMonthly = true, skipRate = false } = {}) {
  const limits = tenant.limits ?? {};
  const monthlyFull = { ok: false, code: "MONTHLY_LIMIT", message: "Aylıq sorğu limiti dolub" };

  if (!mongoEnabled() && countMonthly && limits.monthlyRequests && bucket(tenant.tenantId).requests >= limits.monthlyRequests) return monthlyFull;

  const now = Date.now();
  const recent = (windows.get(tenant.tenantId) ?? []).filter((t) => now - t < 60_000);
  if (!skipRate && limits.ratePerMinute && recent.length >= limits.ratePerMinute)
    return { ok: false, code: "RATE_LIMIT", message: "Çox tez-tez sorğu göndərilir", retryAfter: Math.max(1, Math.ceil((60_000 - (now - recent[0])) / 1000)) };

  if (countMonthly) {
    if (mongoEnabled()) { if (!(await hitMonthly(tenant.tenantId, limits.monthlyRequests))) return monthlyFull; }
    else { const b = bucket(tenant.tenantId); b.requests++; (b.days ??= {})[today()] = (b.days[today()] ?? 0) + 1; save(); }
  }
  recent.push(now);
  windows.set(tenant.tenantId, recent);
  return { ok: true };
}

export async function addTokens(tenant, tokens) {
  if (!tokens) return;
  if (mongoEnabled()) {
    await (await col()).updateOne({ _id: docId(tenant.tenantId) }, { $inc: { tokens, [`tokenDays.${today()}`]: tokens }, $setOnInsert: meta(tenant.tenantId) }, { upsert: true });
    return;
  }
  const b = bucket(tenant.tenantId);
  b.tokens += tokens;
  (b.tokenDays ??= {})[today()] = (b.tokenDays[today()] ?? 0) + tokens;
  save();
}

// Qaytarır: bu ayın cəmi + "daily": son 14 gün üzrə günlük sorğu sayı [{ date, requests }]
export async function getUsage(tenant) {
  const days = lastDays();
  if (mongoEnabled()) {
    const c = await col();
    const docs = {};
    for (const m of new Set(days.map((d) => d.slice(0, 7)))) docs[m] = await c.findOne({ _id: `${tenant.tenantId}:${m}` });
    const cur = docs[month()] ?? (await c.findOne({ _id: docId(tenant.tenantId) }));
    return {
      month: month(), requests: cur?.requests ?? 0, tokens: cur?.tokens ?? 0, limits: tenant.limits ?? {},
      daily: days.map((date) => ({ date, requests: docs[date.slice(0, 7)]?.days?.[date] ?? 0 })),
    };
  }
  const { days: _ignored, ...cur } = bucket(tenant.tenantId);
  return {
    month: month(), ...cur, limits: tenant.limits ?? {},
    daily: days.map((date) => ({ date, requests: fileDay(tenant.tenantId, date.slice(0, 7), date) })),
  };
}

// Bütün müştərilər üzrə ümumi xülasə (admin üçün).
// daily: son 30 gün, monthly: son 12 ay, tenants: bu ayın müştəriləri (token üzrə azalan).
// Gündəlik token sayğacı bu funksiya əlavə olunandan başlayır; köhnə günlərdə token 0 görünə bilər, aylıq cəm isə dəqiqdir.
export async function getUsageSummary() {
  const days = Array.from({ length: 30 }, (_, i) => new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10));
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (11 - i), 1)).toISOString().slice(0, 7));
  // [{ tenantId, month, requests, tokens, days, tokenDays }]
  let rows;
  if (mongoEnabled()) rows = await (await col()).find({ month: { $in: months } }).toArray();
  else rows = Object.entries(load()).flatMap(([tenantId, ms]) => Object.entries(ms).filter(([m]) => months.includes(m)).map(([m, b]) => ({ tenantId, month: m, ...b })));

  const daily = new Map(days.map((d) => [d, { date: d, requests: 0, tokens: 0 }]));
  const monthly = new Map(months.map((m) => [m, { month: m, requests: 0, tokens: 0 }]));
  const cur = month();
  const tenants = [];
  for (const r of rows) {
    const mo = monthly.get(r.month);
    if (mo) { mo.requests += r.requests ?? 0; mo.tokens += r.tokens ?? 0; }
    for (const [d, n] of Object.entries(r.days ?? {})) if (daily.has(d)) daily.get(d).requests += n;
    for (const [d, n] of Object.entries(r.tokenDays ?? {})) if (daily.has(d)) daily.get(d).tokens += n;
    if (r.month === cur) tenants.push({ tenantId: r.tenantId, requests: r.requests ?? 0, tokens: r.tokens ?? 0 });
  }
  tenants.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests);
  const dailyList = [...daily.values()], monthlyList = [...monthly.values()];
  const prevM = monthlyList.at(-2) ?? { requests: 0, tokens: 0 };
  return {
    today: dailyList.at(-1), thisMonth: monthlyList.at(-1), lastMonth: prevM,
    daily: dailyList, monthly: monthlyList, tenants,
  };
}

/** Müştəri silinəndə onun sayğac qeydlərini də silir. */
export async function deleteTenantUsage(tenantId) {
  windows.delete(tenantId);
  if (mongoEnabled()) { await (await col()).deleteMany({ tenantId }); return; }
  if (load()[tenantId]) { delete state[tenantId]; save(); }
}
