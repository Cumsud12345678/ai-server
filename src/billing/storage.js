// Balans yaddaşı. MongoDB (AI_MONGODB_URI) və ya fayl/yaddaş (inkişaf).
// Mongo-da yalnız bərabərlik filtrləri və $set/$inc istifadə olunur; balans dəyişikliyi "v" versiya sayı ilə
// optimistik kilid (CAS) ilə edilir: eyni anda gələn sorğular bir-birinin yazısını silmir.
import fs from "node:fs";
import { mongoEnabled, storeDb } from "../store/mongo.js";

const FILE = () => process.env.BILLING_FILE || new URL("../../data/billing.json", import.meta.url);

function fileStore() {
  let st;
  const load = () => {
    if (!st) { try { st = JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch { st = {}; } }
    st.acc ??= {}; st.ledger ??= []; st.days ??= {}; st.reqs ??= [];
    return st;
  };
  const save = () => { try { fs.writeFileSync(FILE(), JSON.stringify(st, null, 2)); } catch (e) { console.warn("[billing] yazıla bilmədi:", e.message); } };
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  return {
    async getAcc(id) { return clone(load().acc[id]) ?? null; },
    async createAcc(doc) { const s = load(); if (s.acc[doc._id]) return false; s.acc[doc._id] = clone(doc); save(); return true; },
    async casAcc(id, v, patch) {
      const s = load(); const a = s.acc[id];
      if (!a || a.v !== v) return false;
      Object.assign(a, clone(patch)); a.v = v + 1; save(); return true;
    },
    async insertLedger(e) { const s = load(); if (s.ledger.some((x) => x._id === e._id)) return false; s.ledger.push(clone(e)); save(); return true; },
    async listLedger(tenantId, limit) { return clone(load().ledger.filter((x) => x.tenantId === tenantId).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit)); },
    async incDay(tenantId, date, inc) {
      const s = load(); const k = `${tenantId}:${date}`;
      const d = (s.days[k] ??= { _id: k, tenantId, date, billed: 0, cost: 0, requests: 0, tokens: 0 });
      for (const [f, n] of Object.entries(inc)) d[f] = (d[f] ?? 0) + n;
      save();
    },
    async listDays(tenantId, sinceDate) { return clone(Object.values(load().days).filter((d) => d.tenantId === tenantId && d.date >= sinceDate).sort((a, b) => (a.date < b.date ? 1 : -1))); },
    async insertReq(r) { const s = load(); s.reqs.push(clone(r)); save(); },
    async getReq(id) { return clone(load().reqs.find((r) => r._id === id)) ?? null; },
    async setReqStatus(id, from, to, extra = {}) {
      const s = load(); const r = s.reqs.find((x) => x._id === id);
      if (!r || r.status !== from) return false;
      Object.assign(r, extra, { status: to }); save(); return true;
    },
    async listReqs({ tenantId, status, limit = 100 }) {
      return clone(load().reqs.filter((r) => (!tenantId || r.tenantId === tenantId) && (!status || r.status === status)).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit));
    },
    async listAccounts() { return clone(Object.values(load().acc)); },
    async deleteTenant(id) {
      const s = load();
      delete s.acc[id]; s.ledger = s.ledger.filter((x) => x.tenantId !== id); s.reqs = s.reqs.filter((x) => x.tenantId !== id);
      for (const k of Object.keys(s.days)) if (s.days[k].tenantId === id) delete s.days[k];
      save();
    },
  };
}

function mongoStore() {
  const c = async (n) => (await storeDb()).collection(n);
  let indexed = false;
  const ensureIndexes = async () => {
    if (indexed) return; indexed = true;
    try {
      await (await c("billing_ledger")).createIndex({ tenantId: 1, at: -1 });
      await (await c("billing_days")).createIndex({ tenantId: 1, date: -1 });
      await (await c("billing_requests")).createIndex({ tenantId: 1, status: 1 });
    } catch (e) { indexed = false; console.warn("[billing] indeks yaradıla bilmədi:", e.message); }
  };
  const dup = (e) => e?.code === 11000;
  return {
    async getAcc(id) { await ensureIndexes(); return (await (await c("billing_accounts")).findOne({ _id: id })) ?? null; },
    async createAcc(doc) { try { await (await c("billing_accounts")).insertOne(doc); return true; } catch (e) { if (dup(e)) return false; throw e; } },
    async casAcc(id, v, patch) { const r = await (await c("billing_accounts")).updateOne({ _id: id, v }, { $set: patch, $inc: { v: 1 } }); return (r.matchedCount ?? r.modifiedCount) === 1; },
    async insertLedger(e) { try { await (await c("billing_ledger")).insertOne(e); return true; } catch (er) { if (dup(er)) return false; throw er; } },
    async listLedger(tenantId, limit) { return (await c("billing_ledger")).find({ tenantId }).sort({ at: -1 }).limit(limit).toArray(); },
    async incDay(tenantId, date, inc) {
      await (await c("billing_days")).updateOne({ _id: `${tenantId}:${date}` }, { $inc: inc, $setOnInsert: { tenantId, date } }, { upsert: true });
    },
    async listDays(tenantId, sinceDate) { return (await c("billing_days")).find({ tenantId, date: { $gte: sinceDate } }).sort({ date: -1 }).toArray(); },
    async insertReq(r) { await (await c("billing_requests")).insertOne(r); },
    async getReq(id) { return (await (await c("billing_requests")).findOne({ _id: id })) ?? null; },
    async setReqStatus(id, from, to, extra = {}) {
      const r = await (await c("billing_requests")).updateOne({ _id: id, status: from }, { $set: { ...extra, status: to } });
      return (r.matchedCount ?? r.modifiedCount) === 1;
    },
    async listReqs({ tenantId, status, limit = 100 }) {
      const f = {}; if (tenantId) f.tenantId = tenantId; if (status) f.status = status;
      return (await c("billing_requests")).find(f).sort({ at: -1 }).limit(limit).toArray();
    },
    async listAccounts() { return (await c("billing_accounts")).find({}).limit(5000).toArray(); },
    async deleteTenant(id) {
      await (await c("billing_accounts")).deleteMany({ _id: id });
      for (const n of ["billing_ledger", "billing_days", "billing_requests"]) await (await c(n)).deleteMany({ tenantId: id });
    },
  };
}

let file, mongo;
export const store = () => (mongoEnabled() ? (mongo ??= mongoStore()) : (file ??= fileStore()));
/** Testlər üçün: fayl rejimini sıfırlayır. */
export const resetStores = () => { file = undefined; mongo = undefined; };
