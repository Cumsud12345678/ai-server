// Köhnə fayllardakı müştəriləri və istifadə sayğacını MongoDB-yə köçürür.
//   node scripts/migrate-to-db.mjs          (köçürür)
//   node scripts/migrate-to-db.mjs --dry    (yalnız nəyin köçüləcəyini göstərir)
// Təhlükəsizdir: təkrar işlətmək olar (eyni ID üzərinə yazır, dublikat yaranmır). Fayllar silinmir.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeDb } from "../src/store/mongo.js";

const dry = process.argv.includes("--dry");
if (!process.env.AI_MONGODB_URI) { console.error("AI_MONGODB_URI .env-də yoxdur."); process.exit(1); }

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return fallback; throw e; } };
const root = fileURLToPath(new URL("..", import.meta.url));
const tenantsFile = path.resolve(process.env.CUSTOMER_TENANTS_FILE || path.join(root, "data/customer-tenants.json"));
const usageFile = path.resolve(process.env.USAGE_FILE || path.join(root, "data/usage.json"));

const tenants = readJson(tenantsFile, []);
const usage = readJson(usageFile, {});
const usageRows = Object.entries(usage).flatMap(([tenantId, months]) =>
  Object.entries(months).map(([month, v]) => ({ _id: `${tenantId}:${month}`, tenantId, month, requests: v.requests ?? 0, tokens: v.tokens ?? 0, ...(v.days && { days: v.days }) })));

console.log(`Müştəri faylı: ${tenantsFile} → ${tenants.length} müştəri`);
console.log(`İstifadə faylı: ${usageFile} → ${usageRows.length} aylıq qeyd`);
if (dry) { console.log("(--dry: heç nə yazılmadı)"); process.exit(0); }

const db = await storeDb();
for (const t of tenants) await db.collection("tenants").replaceOne({ _id: t.tenantId }, { _id: t.tenantId, ...t }, { upsert: true });
for (const r of usageRows) await db.collection("usage").replaceOne({ _id: r._id }, r, { upsert: true });
console.log(`Köçürüldü: ${tenants.length} müştəri, ${usageRows.length} istifadə qeydi.`);
process.exit(0);
