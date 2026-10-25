// Bilik bazasının saxlanması: mənbələr, hissələr (vektorlarla), cavabsız suallar, müraciətlər.
//  - AI_MONGODB_URI varsa MongoDB (kb_sources, kb_chunks, kb_unanswered, kb_leads), yoxdursa fayl (inkişaf/test).
//  - Filtrlər yalnız bərabərlik üzərindədir; sıralama və limit proses daxilində edilir (bir müştərinin bazası kiçikdir).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mongoEnabled, storeDb } from "../store/mongo.js";

const FILE = () => process.env.KB_FILE || new URL("../../data/kb.json", import.meta.url).pathname;
let state;
const load = () => {
  if (!state) { try { state = JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch { state = {}; } }
  for (const k of ["sources", "chunks", "unanswered", "leads"]) state[k] ??= [];
  return state;
};
const save = () => {
  try { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(state)); }
  catch (e) { console.warn("[kb] yazıla bilmədi:", e.message); }
};
/** Testlər üçün */
export const resetKbMemory = () => { state = undefined; chunkCache.clear(); };

const col = async (n) => (await storeDb()).collection(n);
const COLS = { sources: "kb_sources", chunks: "kb_chunks", unanswered: "kb_unanswered", leads: "kb_leads" };
const byTenant = async (kind, tenantId) => {
  if (mongoEnabled()) return (await (await col(COLS[kind])).find({ tenantId }).toArray());
  return load()[kind].filter((d) => d.tenantId === tenantId);
};

// ---------- mənbələr ----------
export async function listSources(tenantId) {
  return (await byTenant("sources", tenantId)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
export async function getSource(tenantId, id) {
  return (await byTenant("sources", tenantId)).find((s) => s._id === id) ?? null;
}
export async function putSource(src) {
  src.updatedAt = new Date().toISOString();
  if (mongoEnabled()) { await (await col(COLS.sources)).replaceOne({ _id: src._id }, src, { upsert: true }); return src; }
  const s = load(); const i = s.sources.findIndex((x) => x._id === src._id);
  if (i >= 0) s.sources[i] = src; else s.sources.push(src);
  save(); return src;
}
export const newSource = (tenantId, fields) => ({
  _id: randomUUID(), tenantId, status: "processing", chunks: 0, chars: 0, pages: 0, error: null,
  createdAt: new Date().toISOString(), ...fields,
});

// ---------- hissələr ----------
const chunkCache = new Map(); // tenantId -> { at, chunks }
const CACHE_MS = 30_000;
export async function listChunks(tenantId) {
  const hit = chunkCache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.chunks;
  const chunks = await byTenant("chunks", tenantId);
  chunkCache.set(tenantId, { at: Date.now(), chunks });
  return chunks;
}
export async function countChunks(tenantId) { return (await byTenant("chunks", tenantId)).length; }
export async function replaceSourceChunks(tenantId, sourceId, chunks) {
  chunkCache.delete(tenantId);
  const docs = chunks.map((c, i) => ({ _id: randomUUID(), tenantId, sourceId, idx: i, ...c }));
  if (mongoEnabled()) {
    const c = await col(COLS.chunks);
    await c.deleteMany({ tenantId, sourceId });
    for (let i = 0; i < docs.length; i += 200) await c.insertMany(docs.slice(i, i + 200));
    return docs.length;
  }
  const s = load();
  s.chunks = s.chunks.filter((d) => !(d.tenantId === tenantId && d.sourceId === sourceId)).concat(docs);
  save(); return docs.length;
}
export async function deleteSource(tenantId, sourceId) {
  chunkCache.delete(tenantId);
  if (mongoEnabled()) {
    await (await col(COLS.chunks)).deleteMany({ tenantId, sourceId });
    await (await col(COLS.sources)).deleteOne({ _id: sourceId });
    return;
  }
  const s = load();
  s.chunks = s.chunks.filter((d) => !(d.tenantId === tenantId && d.sourceId === sourceId));
  s.sources = s.sources.filter((d) => d._id !== sourceId);
  save();
}

// ---------- cavabsız suallar və müraciətlər ----------
const INBOX_CAP = 1000;
export async function addInbox(kind, tenantId, doc) {
  const d = { _id: randomUUID(), tenantId, at: new Date().toISOString(), ...doc };
  if (mongoEnabled()) { await (await col(COLS[kind])).insertOne(d); return d; }
  const s = load(); s[kind].push(d);
  const mine = s[kind].filter((x) => x.tenantId === tenantId);
  if (mine.length > INBOX_CAP) { const drop = new Set(mine.slice(0, mine.length - INBOX_CAP).map((x) => x._id)); s[kind] = s[kind].filter((x) => !drop.has(x._id)); }
  save(); return d;
}
export async function listInbox(kind, tenantId, { limit = 100 } = {}) {
  const rows = (await byTenant(kind, tenantId)).sort((a, b) => new Date(b.at) - new Date(a.at));
  return { total: rows.length, items: rows.slice(0, Math.min(Math.max(limit, 1), 500)) };
}
export async function updateInbox(kind, tenantId, id, patch) {
  const row = (await byTenant(kind, tenantId)).find((d) => d._id === id);
  if (!row) return null;
  const next = { ...row, ...patch };
  if (mongoEnabled()) await (await col(COLS[kind])).replaceOne({ _id: id }, next);
  else { const s = load(); s[kind][s[kind].findIndex((d) => d._id === id)] = next; save(); }
  return next;
}
export async function deleteInbox(kind, tenantId, id) {
  const row = (await byTenant(kind, tenantId)).find((d) => d._id === id);
  if (!row) return false;
  if (mongoEnabled()) await (await col(COLS[kind])).deleteOne({ _id: id });
  else { const s = load(); s[kind] = s[kind].filter((d) => d._id !== id); save(); }
  return true;
}

/** Müştəri silinəndə bütün bilik bazası məlumatı silinir. */
export async function deleteTenantKb(tenantId) {
  chunkCache.delete(tenantId);
  if (mongoEnabled()) { for (const n of Object.values(COLS)) await (await col(n)).deleteMany({ tenantId }); return; }
  const s = load();
  for (const k of Object.keys(COLS)) s[k] = s[k].filter((d) => d.tenantId !== tenantId);
  save();
}
