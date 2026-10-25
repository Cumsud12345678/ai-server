// DB strukturuna BAXMAQ üçün. YALNIZ oxuma əməliyyatları: listCollections, count, find.
// İşlət:  node scripts/inspect.mjs            (kolleksiya adı .env-də MONGODB_COLLECTION)
//    və:  node scripts/inspect.mjs kolleksiyaAdi
import "dotenv/config";
import mongoose from "mongoose";

if (!process.env.MONGODB_URI) {
  console.error(".env faylında MONGODB_URI yoxdur");
  process.exit(1);
}

// Şəxsi məlumatı (e-poçt, telefon kimi uzun rəqəmlər) maskalayır və uzun mətnləri qısaldır
function mask(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") {
    let s = v.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "***@***");
    s = s.replace(/\+?\d[\d\s().-]{6,}\d/g, "***tel***");
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  }
  if (Array.isArray(v)) return depth > 2 ? "[…]" : v.slice(0, 2).map((x) => mask(x, depth + 1)).concat(v.length > 2 ? [`…(+${v.length - 2})`] : []);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if (v._bsontype === "ObjectId" || v._bsontype === "ObjectID") return `ObjectId(${v.toString()})`;
    if (depth > 2) return "{…}";
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x, depth + 1)]));
  }
  return v;
}
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : v instanceof Date ? "date" : v?._bsontype ? v._bsontype : typeof v);

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
const db = mongoose.connection.db;

console.log(`\nBaza: ${db.databaseName}\nKolleksiyalar:`);
for (const c of await db.listCollections().toArray()) {
  console.log(`  - ${c.name}  (${await db.collection(c.name).estimatedDocumentCount()} sənəd)`);
}

const name = process.argv[2] || process.env.MONGODB_COLLECTION;
if (!name) {
  console.log("\nKolleksiya adını yaz:  node scripts/inspect.mjs kolleksiyaAdi");
} else {
  const docs = await db.collection(name).find().limit(2).toArray();
  if (!docs.length) console.log(`\n"${name}" boşdur və ya tapılmadı`);
  else {
    console.log(`\n"${name}" sahələrinin tipləri (1-ci sənəd):`);
    for (const [k, v] of Object.entries(docs[0])) console.log(`  ${k}: ${typeOf(v)}`);
    console.log(`\nNümunə sənəd (maskalanmış):\n${JSON.stringify(mask(docs[0]), null, 2)}`);
  }
}
await mongoose.disconnect();
