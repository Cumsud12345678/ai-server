// Müştərilərin (sayt istifadəçilərinin) suallarının qeydi: sayt sahibi nə soruşulduğunu və nəyin tapılmadığını görsün.
//  - Telefon, email və uzun rəqəm ardıcıllığı (kart nömrəsi və s.) saxlamazdan ƏVVƏL maskalanır.
//  - Sorğular QUERY_RETENTION_DAYS (defolt 90) gündən sonra avtomatik silinir (MongoDB TTL indeksi).
//  - Müştəri profile.logQueries=false ilə qeydi söndürə bilər.
//  - MongoDB yoxdursa yaddaşda (hər müştəri üçün son 500) saxlanır: yalnız inkişaf üçün.
import { randomUUID } from "node:crypto";
import { mongoEnabled, storeDb } from "../store/mongo.js";

const RETENTION_DAYS = () => Number(process.env.QUERY_RETENTION_DAYS) || 90;
const MEM_CAP = 500;
const memory = new Map(); // tenantId -> [{...}] (yenidən köhnəyə)
let indexed = false;

export function maskPII(text) {
  return String(text)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 ? "[nömrə]" : m)) // telefon, kart və s.
    .slice(0, 500);
}
const maskAnswer = (text) => maskPII(text).slice(0, 1200);
// Söhbət identifikatoru vidjetdən gəlir (ziyarətçinin brauzer söhbəti); yalnız təhlükəsiz format qəbul edilir
export const cleanSid = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : undefined);

export const queryLoggingOn = (tenant) => tenant.profile?.logQueries !== false;

const col = async () => {
  const c = (await storeDb()).collection("queries");
  if (!indexed) {
    indexed = true; // fake DB-lərdə createIndex olmaya bilər
    try {
      await c.createIndex?.({ at: 1 }, { expireAfterSeconds: RETENTION_DAYS() * 86400 });
      await c.createIndex?.({ tenantId: 1, at: -1 });
      await c.createIndex?.({ tenantId: 1, sid: 1, at: 1 }, { sparse: true });
    } catch (e) { console.warn("[queries] indeks yaradıla bilmədi:", e.message); }
  }
  return c;
};

/** entry: { message, results, tokens, cached, error }. Uğursuz olsa söhbəti pozmur. */
export async function recordQuery(tenant, entry) {
  if (!queryLoggingOn(tenant)) return;
  try {
    const doc = {
      _id: randomUUID(), tenantId: tenant.tenantId, at: new Date(),
      message: maskPII(entry.message), results: entry.results ?? 0, tokens: entry.tokens ?? 0,
      cached: Boolean(entry.cached), error: Boolean(entry.error),
      ...(cleanSid(entry.sid) && { sid: entry.sid }),
      // Şəxsi məlumat (sifariş/ödəniş) olan cavab mətni heç vaxt saxlanmır
      ...(entry.private ? { private: true } : typeof entry.answer === "string" && entry.answer ? { answer: maskAnswer(entry.answer) } : {}),
      ...(Number.isFinite(entry.costAzn) && { costAzn: Math.round(entry.costAzn * 1e6) / 1e6 }), // müştəriyə yazılan məbləğ (manat)
    };
    if (mongoEnabled()) { await (await col()).insertOne(doc); return; }
    const list = memory.get(tenant.tenantId) ?? [];
    list.unshift(doc);
    memory.set(tenant.tenantId, list.slice(0, MEM_CAP));
  } catch (e) { console.warn("[queries] yazıla bilmədi:", e.message); }
}

const view = (d) => ({ id: d._id, at: new Date(d.at).toISOString(), ...(d.sid && { sid: d.sid }), message: d.message, results: d.results, tokens: d.tokens, cached: d.cached, error: d.error, costAzn: d.costAzn ?? null });
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sinceOf = (days) => new Date(Date.now() - days * 86_400_000);
const memoryRows = (tenantId) => memory.get(tenantId) ?? [];

// Səhifələmə kursoru: "<ISO vaxt>|<id>" (eyni millisaniyədə olan qeydlər itməsin deyə id də var)
const parseCursor = (c) => {
  const [at, id] = String(c ?? "").split("|");
  return at && id && !Number.isNaN(new Date(at).getTime()) ? { at: new Date(at), id } : null;
};
const makeCursor = (d) => `${new Date(d.at).toISOString()}|${d._id}`;

/**
 * Siyahı: yenidən köhnəyə, səhifə-səhifə (kursorla). Bütün sorğular bir dəfəyə çəkilmir.
 * opts: { limit, noResults, q, days, before } -> { queries, hasMore, nextCursor, total? }
 * MongoDB-də filtr, sıralama və limit bazada işləyir (indeks: tenantId + at); yaddaş rejimində (inkişaf) massivdə.
 */
export async function listQueries(tenantId, { limit = 30, noResults = false, q = "", days = 30, before } = {}) {
  const take = Math.min(Math.max(Math.round(limit) || 30, 1), 200);
  const needle = String(q).trim();
  const cur = parseCursor(before);
  let rows;
  let total;
  if (mongoEnabled()) {
    const at = { $gte: sinceOf(days) };
    const f = { tenantId, at };
    if (noResults) { f.results = 0; f.error = false; }
    if (needle) f.message = { $regex: escapeRegex(needle), $options: "i" };
    if (cur) { delete f.at; f.$and = [{ at: { $gte: sinceOf(days) } }, { $or: [{ at: { $lt: cur.at } }, { at: cur.at, _id: { $lt: cur.id } }] }]; }
    rows = await (await col()).find(f).sort({ at: -1, _id: -1 }).limit(take + 1).toArray();
  } else {
    const since = sinceOf(days).getTime(), low = needle.toLowerCase();
    const all = memoryRows(tenantId).filter((d) => new Date(d.at).getTime() >= since)
      .filter((d) => (!noResults || (d.results === 0 && !d.error)) && (!low || d.message.toLowerCase().includes(low)))
      .sort((a, b) => new Date(b.at) - new Date(a.at) || (a._id < b._id ? 1 : -1));
    total = all.length;
    rows = all.filter((d) => !cur || new Date(d.at) < cur.at || (new Date(d.at).getTime() === cur.at.getTime() && d._id < cur.id)).slice(0, take + 1);
  }
  const hasMore = rows.length > take;
  const page = rows.slice(0, take);
  return { ...(total !== undefined && { total }), hasMore, nextCursor: hasMore ? makeCursor(page.at(-1)) : null, queries: page.map(view) };
}

/**
 * Söhbətlər: eyni sid ilə yazılmış suallar bir söhbətdir. Yenidən köhnəyə, kursor = son mesajın vaxtı.
 * -> { conversations: [{ sid, startedAt, lastAt, messages, unanswered, costAzn, first }], hasMore, nextCursor }
 */
export async function listConversations(tenantId, { limit = 30, days = 30, before } = {}) {
  const take = Math.min(Math.max(Math.round(limit) || 30, 1), 100);
  const since = sinceOf(days);
  const cur = before && !Number.isNaN(new Date(before).getTime()) ? new Date(before) : null;
  let groups;
  if (mongoEnabled()) {
    const pipe = [
      { $match: { tenantId, sid: { $exists: true }, at: { $gte: since } } },
      { $sort: { at: 1 } },
      { $group: { _id: "$sid", startedAt: { $first: "$at" }, lastAt: { $last: "$at" }, messages: { $sum: 1 }, first: { $first: "$message" },
          unanswered: { $sum: { $cond: [{ $or: [{ $eq: ["$results", 0] }, { $eq: ["$results", -2] }, { $eq: ["$error", true] }] }, 1, 0] } },
          costAzn: { $sum: { $ifNull: ["$costAzn", 0] } } } },
      ...(cur ? [{ $match: { lastAt: { $lt: cur } } }] : []),
      { $sort: { lastAt: -1 } }, { $limit: take + 1 },
    ];
    groups = (await (await col()).aggregate(pipe).toArray()).map((g) => ({ sid: g._id, startedAt: g.startedAt, lastAt: g.lastAt, messages: g.messages, first: g.first, unanswered: g.unanswered, costAzn: g.costAzn }));
  } else {
    const m = new Map();
    for (const d of [...memoryRows(tenantId)].reverse()) {
      if (!d.sid || new Date(d.at) < since) continue;
      const g = m.get(d.sid) ?? { sid: d.sid, startedAt: d.at, lastAt: d.at, messages: 0, first: d.message, unanswered: 0, costAzn: 0 };
      g.lastAt = d.at; g.messages++; g.costAzn += d.costAzn ?? 0;
      if (d.results === 0 || d.results === -2 || d.error) g.unanswered++;
      m.set(d.sid, g);
    }
    groups = [...m.values()].filter((g) => !cur || new Date(g.lastAt) < cur).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt)).slice(0, take + 1);
  }
  const hasMore = groups.length > take;
  const page = groups.slice(0, take);
  return {
    hasMore, nextCursor: hasMore ? new Date(page.at(-1).lastAt).toISOString() : null,
    conversations: page.map((g) => ({ sid: g.sid, startedAt: new Date(g.startedAt).toISOString(), lastAt: new Date(g.lastAt).toISOString(), messages: g.messages, first: g.first, unanswered: g.unanswered, costAzn: Math.round(g.costAzn * 1e6) / 1e6 })),
  };
}

/** Bir söhbətin bütün mesajları (köhnədən yeniyə): sual + AI cavabı. */
export async function getConversation(tenantId, sid) {
  if (!cleanSid(sid)) return null;
  const rows = mongoEnabled()
    ? await (await col()).find({ tenantId, sid }).sort({ at: 1, _id: 1 }).limit(200).toArray()
    : memoryRows(tenantId).filter((d) => d.sid === sid).sort((a, b) => new Date(a.at) - new Date(b.at)).slice(0, 200);
  if (!rows.length) return null;
  return { sid, messages: rows.map((d) => ({ ...view(d), answer: d.answer ?? null })) };
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").replace(/[?!.,;]+$/g, "").trim();
const statsCache = new Map(); // MongoDB rejimində hər panel açılışı bazanı yükləməsin
const STATS_TTL_MS = 30_000;

/** Xülasə: say, nəticəsiz sorğular, xətalar, ən çox verilən suallar. MongoDB-də hesablama bazadadır (sayma + $group), bütün sorğuları çəkmir. */
export async function queryStats(tenantId, { days = 30 } = {}) {
  if (mongoEnabled()) {
    const key = `${tenantId}|${days}`;
    const hit = statsCache.get(key);
    if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.value;
    const c = await col();
    const base = { tenantId, at: { $gte: sinceOf(days) } };
    const noRes = { ...base, results: 0, error: false };
    const top = async (f) => (await c.aggregate([
      { $match: f },
      { $group: { _id: { $trim: { input: { $toLower: "$message" }, chars: " ?!.,;\n\t" } }, count: { $sum: 1 } } },
      { $match: { _id: { $ne: "" } } },
      { $sort: { count: -1, _id: 1 } }, { $limit: 10 },
    ]).toArray()).map((r) => ({ message: r._id, count: r.count }));
    const convs = async () => (await c.aggregate([{ $match: { ...base, sid: { $exists: true } } }, { $group: { _id: "$sid" } }, { $count: "n" }]).toArray())[0]?.n ?? 0;
    const [total, noResults, errors, cached, topAll, topNo, conversations] = await Promise.all([
      c.countDocuments(base), c.countDocuments(noRes), c.countDocuments({ ...base, error: true }), c.countDocuments({ ...base, cached: true }), top(base), top(noRes), convs(),
    ]);
    const value = { days, total, noResults, errors, cached, conversations, top: topAll, topNoResults: topNo, truncated: false };
    statsCache.set(key, { at: Date.now(), value });
    return value;
  }
  const since = sinceOf(days).getTime();
  const rows = memoryRows(tenantId).filter((d) => new Date(d.at).getTime() >= since);
  const count = (arr) => {
    const m = new Map();
    for (const d of arr) { const k = norm(d.message); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([message, count]) => ({ message, count }));
  };
  const noResult = rows.filter((d) => d.results === 0 && !d.error);
  return {
    days, total: rows.length,
    noResults: noResult.length, errors: rows.filter((d) => d.error).length, cached: rows.filter((d) => d.cached).length,
    conversations: new Set(rows.filter((d) => d.sid).map((d) => d.sid)).size,
    top: count(rows), topNoResults: count(noResult), truncated: false,
  };
}

export async function clearQueries(tenantId) {
  for (const k of statsCache.keys()) if (k.startsWith(`${tenantId}|`)) statsCache.delete(k);
  if (mongoEnabled()) { await (await col()).deleteMany({ tenantId }); return; }
  memory.delete(tenantId);
}

// ---------- Analitika: gündəlik trend və AI təhlili üçün nümunə ----------
const TZ_H = Number(process.env.TREND_TZ_OFFSET_H ?? 4); // Azərbaycan (UTC+4): günün sərhədi yerli vaxtla
const dayKey = (d) => new Date(new Date(d).getTime() + TZ_H * 3_600_000).toISOString().slice(0, 10);
const isUnanswered = (d) => (d.results === 0 && !d.error) || d.results === -2;

/** Gündəlik say: [{ day: "2026-10-28", total, unanswered }] (boş günlər də 0 ilə). */
export async function queryTrend(tenantId, days = 30) {
  const since = sinceOf(days);
  const by = new Map();
  if (mongoEnabled()) {
    const rows = await (await col()).aggregate([
      { $match: { tenantId, at: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$at", timezone: `${TZ_H >= 0 ? "+" : "-"}${String(Math.abs(TZ_H)).padStart(2, "0")}:00` } }, total: { $sum: 1 },
          unanswered: { $sum: { $cond: [{ $or: [{ $and: [{ $eq: ["$results", 0] }, { $eq: ["$error", false] }] }, { $eq: ["$results", -2] }] }, 1, 0] } } } },
    ]).toArray();
    for (const r of rows) by.set(r._id, { total: r.total, unanswered: r.unanswered });
  } else {
    for (const d of memoryRows(tenantId)) {
      if (new Date(d.at) < since) continue;
      const k = dayKey(d.at); const g = by.get(k) ?? { total: 0, unanswered: 0 };
      g.total++; if (isUnanswered(d)) g.unanswered++; by.set(k, g);
    }
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(Date.now() - i * 86_400_000);
    out.push({ day: k, total: by.get(k)?.total ?? 0, unanswered: by.get(k)?.unanswered ?? 0 });
  }
  return out;
}

/** Eyni sual birləşir: [{ text, count, unanswered }] — ən çox soruşulanlar əvvəl, ən çox `cap` sətir. */
export async function questionSample(tenantId, days = 30, cap = 300) {
  const since = sinceOf(days);
  if (mongoEnabled()) {
    const rows = await (await col()).aggregate([
      { $match: { tenantId, at: { $gte: since }, error: false } },
      { $group: { _id: { $trim: { input: { $toLower: "$message" }, chars: " ?!.,;\n\t" } }, count: { $sum: 1 },
          unanswered: { $sum: { $cond: [{ $or: [{ $eq: ["$results", 0] }, { $eq: ["$results", -2] }] }, 1, 0] } } } },
      { $match: { _id: { $ne: "" } } }, { $sort: { count: -1, _id: 1 } }, { $limit: cap },
    ]).toArray();
    return rows.map((r) => ({ text: r._id, count: r.count, unanswered: r.unanswered }));
  }
  const m = new Map();
  for (const d of memoryRows(tenantId)) {
    if (new Date(d.at) < since || d.error) continue;
    const k = norm(d.message); if (!k) continue;
    const g = m.get(k) ?? { text: k, count: 0, unanswered: 0 };
    g.count++; if (isUnanswered(d)) g.unanswered++; m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : 1)).slice(0, cap);
}
