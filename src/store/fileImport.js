// Fayl rejimindən (AI_MONGODB_URI olmadan) MongoDB-yə köçürmə: müştərilər, istifadə, balanslar, bilik bazası, elan siyahıları.
// Həm scripts/migrate-to-db.mjs, həm də server açılışı (Mongo boşdursa avtomatik) istifadə edir.
// Təkrar işlətmək təhlükəsizdir: eyni _id üzərinə yazılır. Fayllar silinmir.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeDb } from "./mongo.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fileOf = (env, rel) => path.resolve(process.env[env] || path.join(root, rel));
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return fallback; throw new Error(`${file} oxunmadı: ${e.message}`); }
};

export const importFiles = () => ({
  tenants: fileOf("CUSTOMER_TENANTS_FILE", "data/customer-tenants.json"),
  usage: fileOf("USAGE_FILE", "data/usage.json"),
  billing: fileOf("BILLING_FILE", "data/billing.json"),
  kb: fileOf("KB_FILE", "data/kb.json"),
  feeds: fileOf("FEED_FILE", "data/feeds.json"),
});

/** collection -> sənədlər */
export function buildImportPlan() {
  const f = importFiles();
  const tenants = readJson(f.tenants, []);
  const usage = readJson(f.usage, {});
  const billing = readJson(f.billing, {});
  const kb = readJson(f.kb, {});
  const feeds = readJson(f.feeds, {});
  return {
    tenants: tenants.map((t) => ({ _id: t.tenantId, ...t })),
    usage: Object.entries(usage).flatMap(([tenantId, months]) =>
      Object.entries(months).map(([month, v]) => ({ _id: `${tenantId}:${month}`, tenantId, month, requests: v.requests ?? 0, tokens: v.tokens ?? 0, ...(v.days && { days: v.days }) }))),
    billing_accounts: Object.values(billing.acc ?? {}),
    billing_ledger: billing.ledger ?? [],
    billing_days: Object.values(billing.days ?? {}),
    billing_requests: billing.reqs ?? [],
    billing_models: Object.values(billing.models ?? {}),
    billing_settings: Object.entries(billing.settings ?? {}).map(([k, value]) => ({ _id: k, value })),
    kb_sources: kb.sources ?? [],
    kb_chunks: kb.chunks ?? [],
    kb_unanswered: kb.unanswered ?? [],
    kb_leads: kb.leads ?? [],
    feed_data: Object.entries(feeds).map(([tenantId, x]) => ({ _id: tenantId, items: x.items ?? [], fetchedAt: x.fetchedAt })),
  };
}

/** Planı Mongo-ya yazır. Qaytarır: collection -> yazılan sayı */
export async function writeImportPlan(plan, db) {
  db ??= await storeDb();
  const out = {};
  for (const [col, docs] of Object.entries(plan)) {
    const ok = docs.filter((d) => d?._id != null);
    for (let i = 0; i < ok.length; i += 500) {
      await db.collection(col).bulkWrite(ok.slice(i, i + 500).map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: false });
    }
    if (ok.length) out[col] = ok.length;
  }
  return out;
}

/**
 * Server açılışında: Mongo-da hələ heç bir müştəri və balans yoxdursa, amma fayllarda məlumat varsa, avtomatik köçürür.
 * Mongo-da artıq məlumat varsa heç nə etmir (köhnə fayl üzərinə yazılmasın). AI_AUTO_IMPORT=0 ilə söndürülür.
 */
export async function autoImportIfEmpty() {
  if (process.env.AI_AUTO_IMPORT === "0") return null;
  const plan = buildImportPlan();
  const hasFileData = plan.tenants.length > 0 || plan.billing_accounts.length > 0;
  if (!hasFileData) return null;
  const db = await storeDb();
  const [t, a] = await Promise.all([db.collection("tenants").countDocuments({}), db.collection("billing_accounts").countDocuments({})]);
  if (t > 0 || a > 0) return null;
  const done = await writeImportPlan(plan, db);
  console.log("[store] fayllardakı məlumat MongoDB-yə köçürüldü:", Object.entries(done).map(([k, n]) => `${k} ${n}`).join(", "));
  return done;
}