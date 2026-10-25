// Niyə axtarış boş qayıdır? YALNIZ oxuma (count, aggregate $group/$match/$project, find).
// İşlət:  node scripts/diagnose.mjs 300      (300 = yoxlanılan maksimum qiymət)
import "dotenv/config";
import mongoose from "mongoose";

const maxPrice = Number(process.argv[2] || 300);
const L = process.env.COL_LISTINGS || "listings";
const NAME = process.env.NAME_FIELD || "name";
if (!process.env.MONGODB_URI) { console.error(".env-də MONGODB_URI yoxdur"); process.exit(1); }

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
const db = mongoose.connection.db;
const col = db.collection(L);

const group = async (expr) =>
  (await col.aggregate([{ $group: { _id: expr, n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray())
    .map((x) => `${JSON.stringify(x._id)}: ${x.n}`).join("  |  ");

console.log(`\nKolleksiya: ${L}   cəmi sənəd: ${await col.estimatedDocumentCount()}`);
console.log("\nstatus dəyərləri:        ", await group("$status"));
console.log("price tipi:              ", await group({ $type: "$price" }));
console.log("make tipi (objectId olmalı):", await group({ $type: "$make" }));
console.log("category tipi:           ", await group({ $type: "$category" }));

console.log(`\nSayğaclar (qiymət ≤ ${maxPrice}):`);
console.log("  status:active + price rəqəm ≤ limit :", await col.countDocuments({ status: "active", price: { $lte: maxPrice } }));
console.log("  status fərq etmədən, price rəqəm ≤ limit :", await col.countDocuments({ price: { $lte: maxPrice } }));

// Qiymət mətn kimi saxlanılıbsa da tapır
const cheap = await col.aggregate([
  { $addFields: { _p: { $convert: { input: "$price", to: "double", onError: null, onNull: null } } } },
  { $match: { _p: { $lte: maxPrice } } },
  { $project: { price: 1, status: 1, category: 1, make: 1, _p: 1 } },
  { $limit: 10 },
]).toArray();

console.log(`\nQiyməti ≤ ${maxPrice} olan elanlar (status və tip fərq etmədən), ilk ${cheap.length}:`);
const getPath = (o, path) => path.split(".").reduce((x, k) => x?.[k], o);
const nameOf = async (colName, id) => {
  if (!id) return "(boş)";
  try {
    const d = await db.collection(colName).findOne({ _id: id });
    if (!d) return `(bu _id "${colName}" kolleksiyasında YOXDUR, kolleksiya adı səhv ola bilər)`;
    const v = getPath(d, NAME);
    if (typeof v === "string") return v;
    return `("${NAME}" sahəsi yoxdur və ya mətn deyil; sənədin sahələri: ${Object.keys(d).join(", ")})`;
  } catch { return "(istinad pozulub)"; }
};
for (const d of cheap) {
  const cat = await nameOf(process.env.COL_CATEGORIES || "categories", d.category);
  const make = await nameOf(process.env.COL_MAKES || "makes", d.make);
  console.log(`  ${String(d._id)} | price=${JSON.stringify(d.price)} (${typeof d.price}) | status=${JSON.stringify(d.status)} | kateqoriya=${cat} | marka=${make}`);
}
if (!cheap.length) console.log("  heç biri tapılmadı: qiymət sahəsi başqa adda ola bilər, node scripts/inspect.mjs ilə baxın");
await mongoose.disconnect();
