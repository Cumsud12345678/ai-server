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

export const queryLoggingOn = (tenant) => tenant.profile?.logQueries !== false;

const col = async () => {
  const c = (await storeDb()).collection("queries");
  if (!indexed) {
    indexed = true; // fake DB-lərdə createIndex olmaya bilər
    try {
      await c.createIndex?.({ at: 1 }, { expireAfterSeconds: RETENTION_DAYS() * 86400 });
      await c.createIndex?.({ tenantId: 1, at: -1 });
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
      ...(Number.isFinite(entry.costAzn) && { costAzn: Math.round(entry.costAzn * 1e6) / 1e6 }), // müştəriyə yazılan məbləğ (manat)
    };
    if (mongoEnabled()) { await (await col()).insertOne(doc); return; }
    const list = memory.get(tenant.tenantId) ?? [];
    list.unshift(doc);
    memory.set(tenant.tenantId, list.slice(0, MEM_CAP));
  } catch (e) { console.warn("[queries] yazıla bilmədi:", e.message); }
}

const view = (d) => ({ id: d._id, at: new Date(d.at).toISOString(), message: d.message, results: d.results, tokens: d.tokens, cached: d.cached, error: d.error, costAzn: d.costAzn ?? null });
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
    const [total, noResults, errors, cached, topAll, topNo] = await Promise.all([
      c.countDocuments(base), c.countDocuments(noRes), c.countDocuments({ ...base, error: true }), c.countDocuments({ ...base, cached: true }), top(base), top(noRes),
    ]);
    const value = { days, total, noResults, errors, cached, top: topAll, topNoResults: topNo, truncated: false };
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
    top: count(rows), topNoResults: count(noResult), truncated: false,
  };
}

export async function clearQueries(tenantId) {
  for (const k of statsCache.keys()) if (k.startsWith(`${tenantId}|`)) statsCache.delete(k);
  if (mongoEnabled()) { await (await col()).deleteMany({ tenantId }); return; }
  memory.delete(tenantId);
}
