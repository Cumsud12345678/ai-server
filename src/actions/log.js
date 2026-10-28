// Əməliyyat jurnalı: hər icra/ləğv/uğursuzluq qeyd olunur, sahib panelde görür (mübahisə və yoxlama üçün).
import { randomUUID } from "node:crypto";
import { mongoEnabled, storeDb } from "../store/mongo.js";

const RETENTION_DAYS = () => Number(process.env.ACTION_LOG_RETENTION_DAYS) || 90;
const MEM_CAP = 200;
const memory = new Map();
let indexed = false;
const col = async () => {
  const c = (await storeDb()).collection("action_log");
  if (!indexed) {
    indexed = true;
    try { await c.createIndex?.({ at: 1 }, { expireAfterSeconds: RETENTION_DAYS() * 86400 }); await c.createIndex?.({ tenantId: 1, at: -1 }); } catch (e) { console.warn("[actions] indeks yaradıla bilmədi:", e.message); }
  }
  return c;
};

/** entry: { key, title, status: done|failed|unknown|cancelled|expired|denied|test, httpStatus?, subject?, channel?, params?, ms? } */
export async function recordAction(tenantId, entry) {
  try {
    const doc = { _id: randomUUID(), tenantId, at: new Date(), ...entry };
    if (mongoEnabled()) { await (await col()).insertOne(doc); return; }
    const list = memory.get(tenantId) ?? [];
    list.unshift(doc);
    memory.set(tenantId, list.slice(0, MEM_CAP));
  } catch (e) { console.warn("[actions] jurnal yazıla bilmədi:", e.message); }
}

export async function listActionLog(tenantId, limit = 100) {
  const take = Math.min(Math.max(Math.round(limit) || 100, 1), 200);
  const rows = mongoEnabled() ? await (await col()).find({ tenantId }).sort({ at: -1 }).limit(take).toArray() : (memory.get(tenantId) ?? []).slice(0, take);
  return rows.map((d) => ({ id: d._id, at: new Date(d.at).toISOString(), key: d.key, title: d.title, status: d.status, httpStatus: d.httpStatus ?? null, subject: d.subject ?? null, channel: d.channel ?? null, params: d.params ?? {}, ms: d.ms ?? null }));
}

/** Dövr üzrə say: ümumi icra olunanlar və hər əməliyyat üçün status bölgüsü ("test" saylmır). */
export async function actionStats(tenantId, days = 30) {
  const d = Math.min(Math.max(Math.round(Number(days)) || 30, 1), 90);
  const since = new Date(Date.now() - d * 86400000);
  let rows;
  if (mongoEnabled()) {
    rows = await (await col()).aggregate([{ $match: { tenantId, at: { $gte: since }, status: { $ne: "test" } } }, { $group: { _id: { key: "$key", status: "$status" }, n: { $sum: 1 } } }]).toArray();
    rows = rows.map((r) => ({ key: r._id.key, status: r._id.status, n: r.n }));
  } else {
    const tally = new Map();
    for (const e of memory.get(tenantId) ?? []) if (new Date(e.at) >= since && e.status !== "test") { const k = `${e.key}|${e.status}`; tally.set(k, (tally.get(k) ?? 0) + 1); }
    rows = [...tally].map(([k, n]) => { const [key, status] = k.split("|"); return { key, status, n }; });
  }
  const byKey = {};
  let done = 0;
  for (const r of rows) {
    const o = (byKey[r.key] ??= {});
    o[r.status] = (o[r.status] ?? 0) + r.n;
    if (r.status === "done") done += r.n;
  }
  return { days: d, done, byKey };
}

export async function clearActionLog(tenantId) {
  if (mongoEnabled()) { await (await col()).deleteMany({ tenantId }); return; }
  memory.delete(tenantId);
}
