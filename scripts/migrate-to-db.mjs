// Fayl rejimindəki (AI_MONGODB_URI olmadan) bütün məlumatı MongoDB-yə köçürür:
//   müştərilər, istifadə sayğacı, BALANSLAR (hesablar, ödəniş jurnalı, gündəlik xərc, yükləmə sorğuları, model xərci, ayarlar),
//   bilik bazası (mənbələr, hissələr, cavabsız suallar, müraciətlər) və fayl/link ilə yüklənmiş elan siyahıları.
//
//   node scripts/migrate-to-db.mjs --dry    (yalnız nəyin köçüləcəyini göstərir, heç nə yazmır)
//   node scripts/migrate-to-db.mjs          (köçürür)
//
// Server özü də AI_MONGODB_URI ilə ilk açılanda Mongo boşdursa bunu avtomatik edir (src/store/fileImport.js).
// Təhlükəsizdir: təkrar işlətmək olar (eyni _id üzərinə yazır, dublikat yaranmır). Fayllar silinmir.
// Sorğu jurnalı fayl rejimində yalnız yaddaşda olduğu üçün köçürülə bilməz.
// DİQQƏT: köçürmə zamanı server fayla yazmamalıdır, yoxsa son dəqiqələrin balans dəyişiklikləri itə bilər.
import "dotenv/config";
import fs from "node:fs";
import { buildImportPlan, importFiles, writeImportPlan } from "../src/store/fileImport.js";

const dry = process.argv.includes("--dry");
if (!process.env.AI_MONGODB_URI) { console.error("AI_MONGODB_URI .env-də yoxdur."); process.exit(1); }

for (const [name, f] of Object.entries(importFiles())) console.log(`${name.padEnd(8)} ${fs.existsSync(f) ? f : `${f} (yoxdur, keçilir)`}`);
const plan = buildImportPlan();
console.log("");
for (const [col, docs] of Object.entries(plan)) {
  const bad = docs.filter((d) => d?._id == null).length;
  console.log(`${col.padEnd(18)} ${String(docs.length).padStart(6)} sənəd${bad ? `  (${bad} sənəddə _id yoxdur, keçiləcək)` : ""}`);
}
const accounts = plan.billing_accounts;
if (accounts.length) {
  const sum = (k) => accounts.reduce((s, a) => s + (Number(a[k]) || 0), 0) / 1e6;
  console.log(`\nBalanslar: ${accounts.length} hesab · pulsuz ${sum("free").toFixed(2)} AZN · ödənişli ${sum("paid").toFixed(2)} AZN`);
}
if (dry) { console.log("\n(--dry: heç nə yazılmadı)"); process.exit(0); }

const done = await writeImportPlan(plan);
for (const [col, n] of Object.entries(done)) console.log(`✓ ${col}: ${n}`);
console.log("\nKöçürmə bitdi. İndi serverə AI_MONGODB_URI əlavə edib yenidən başlat; açılışda “[store] müştərilər və istifadə MongoDB-dədir” yazılmalıdır.");
process.exit(0);
