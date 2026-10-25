// REAL DB, SƏNİN SXEMƏ GÖRƏ, YALNIZ OXUMA.
// Yalnız find() və aggregate() ($match/$sort/$limit/$lookup/$project) istifadə olunur.
// $out/$merge, insert, update, delete kodda YOXDUR. Schema/model/index yaradılmır.
// Telefon, satıcı, e-poçt, təsvir və s. sahələr heç vaxt oxunmur ($project yalnız icazəli sahələri götürür).
import mongoose from "mongoose";

const env = process.env;

// Mongoose model adlarından yaranan kolleksiya adları (Listing→listings, City→cities ...).
// Sənin DB-də fərqlidirsə .env-də COL_* ilə dəyiş (adları `node scripts/inspect.mjs` göstərir).
const C = {
  listing: env.COL_LISTINGS || "listings",
  make: env.COL_MAKES || "makes",
  model: env.COL_MODELS || "models",
  category: env.COL_CATEGORIES || "categories",
  city: env.COL_CITIES || "cities",
  fuelType: env.COL_FUELTYPES || "fueltypes",
  transmission: env.COL_TRANSMISSIONS || "transmissions",
};
const NAME = env.NAME_FIELD || "name"; // Make/Model/City... sənədlərində ad sahəsi
const ACTIVE_STATUS = (env.ACTIVE_STATUS || "active").split(",").map((s) => s.trim());
const URL_TEMPLATE = env.LISTING_URL_TEMPLATE || ""; // məs. https://saytin.az/elanlar/{make}-{model}-{id}
const IMAGE_BASE = env.IMAGE_BASE_URL || ""; // şəkil yolu nisbidirsə, əvvələ əlavə olunur

// Link üçün: "Land Rover" → "land-rover", "Şəki" → "seki" (ə→e, ı→i, ö→o, ü→u, ş→s, ç→c, ğ→g)
const AZ = { ə: "e", Ə: "e", ı: "i", İ: "i", I: "i", ö: "o", Ö: "o", ü: "u", Ü: "u", ş: "s", Ş: "s", ç: "c", Ç: "c", ğ: "g", Ğ: "g" };
export const slugify = (v) =>
  String(v ?? "")
    .replace(/[əƏıİIöÖüÜşŞçÇğĞ]/g, (c) => AZ[c])
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Şablon: https://saytin.az/elanlar/{make}-{model}-{id}
export const buildUrl = (template, { id, make, model }) =>
  template
    ? template.replace("{id}", id).replace("{make}", slugify(make)).replace("{model}", slugify(model))
    : null;

const getPath = (o, path) => path.split(".").reduce((x, k) => x?.[k], o); // "name.az" kimi iç-içə yol
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactRe = (s) => new RegExp(`^${escapeRegex(s)}$`, "i");
const containsRe = (s) => new RegExp(escapeRegex(s), "i");

let connecting;
async function getDb(override) {
  if (override) return override;
  connecting ??= mongoose.connect(env.MONGODB_URI, { autoIndex: false, autoCreate: false });
  await connecting;
  return mongoose.connection.db;
}

// "BMW" → Make kolleksiyasında uyğun _id-lər. Əvvəl dəqiq ad, tapılmasa "ehtiva edir".
async function resolveIds(db, colName, value, loose = false) {
  const find = (re) =>
    db.collection(colName).find({ [NAME]: re }, { projection: { _id: 1 } }).limit(50).toArray();
  let docs = loose ? [] : await find(exactRe(value));
  if (!docs.length) docs = await find(containsRe(value));
  return docs.map((d) => d._id);
}

const range = (m, field, min, max) => {
  if (min === undefined && max === undefined) return;
  m[field] = { ...(min !== undefined && { $gte: min }), ...(max !== undefined && { $lte: max }) };
};

// Filtr obyektini $match şərtinə çevirir. Ad tapılmayanda null qaytarır (nəticə yoxdur).
export async function buildMatch(f, db) {
  const m = { status: { $in: ACTIVE_STATUS } };
  const refs = [
    ["make", C.make, f.make, false],
    ["model", C.model, f.model, true],
    ["category", C.category, f.bodyType, false],
    ["region", C.city, f.city, false],
    ["fuelType", C.fuelType, f.fuelType, false],
    ["transmission", C.transmission, f.transmission, false],
  ];
  for (const [field, colName, value, loose] of refs) {
    if (!value) continue;
    const ids = await resolveIds(db, colName, value, loose);
    if (!ids.length) {
      if (env.DEBUG_SEARCH) console.log(`[search] "${value}" "${colName}" kolleksiyasında (${NAME} sahəsində) tapılmadı`);
      return null;
    }
    m[field] = { $in: ids };
  }
  range(m, "price", f.minPrice, f.maxPrice);
  range(m, "year", f.minYear, f.maxYear);
  range(m, "mileage", undefined, f.maxMileage);
  return m;
}

const lookup = (from, field) => [
  { $lookup: { from, localField: field, foreignField: "_id", as: field } },
  { $unwind: { path: `$${field}`, preserveNullAndEmptyArrays: true } },
];

export function buildPipeline(match, f) {
  return [
    { $match: match },
    { $sort: { [f.sortBy]: f.sortDir === "desc" ? -1 : 1, _id: 1 } },
    { $limit: f.limit },
    ...lookup(C.make, "make"),
    ...lookup(C.model, "model"),
    ...lookup(C.category, "category"),
    ...lookup(C.city, "region"),
    ...lookup(C.fuelType, "fuelType"),
    ...lookup(C.transmission, "transmission"),
    {
      // YALNIZ bu sahələr çıxır. phone, seller, description, video... daxil DEYİL.
      $project: {
        price: 1, year: 1, volume: 1, power: 1, mileage: 1, used: 1, credit: 1, barter: 1,
        image: { $arrayElemAt: ["$images", 0] },
        make: `$make.${NAME}`, model: `$model.${NAME}`,
        bodyType: `$category.${NAME}`, city: `$region.${NAME}`,
        fuelType: `$fuelType.${NAME}`, transmission: `$transmission.${NAME}`,
      },
    },
  ];
}

function toListing(d) {
  const id = String(d._id);
  const image = d.image ? (/^https?:\/\//i.test(d.image) || !IMAGE_BASE ? d.image : IMAGE_BASE.replace(/\/$/, "") + "/" + d.image.replace(/^\//, "")) : null;
  const str = (v) => (typeof v === "string" ? v : null);
  return {
    id,
    title: [str(d.make), str(d.model)].filter(Boolean).join(" ") || null,
    make: str(d.make), model: str(d.model),
    price: d.price ?? null, currency: "AZN", year: d.year ?? null,
    volume: d.volume ?? null, power: d.power ?? null, mileage: d.mileage ?? null,
    bodyType: str(d.bodyType), city: str(d.city),
    fuelType: str(d.fuelType), transmission: str(d.transmission),
    used: d.used ?? null, credit: d.credit ?? null, barter: d.barter ?? null,
    url: buildUrl(URL_TEMPLATE, { id, make: d.make, model: d.model }),
    image,
  };
}

export async function search(f, dbOverride) {
  const db = await getDb(dbOverride);
  const match = await buildMatch(f, db);
  if (!match) return [];
  const docs = await db.collection(C.listing).aggregate(buildPipeline(match, f)).toArray();
  return docs.map(toListing);
}

// AI-a bazadakı DƏQİQ adları göstərmək üçün (10 dəqiqə keş)
let vocabCache;
export async function vocabulary(dbOverride) {
  if (vocabCache && Date.now() - vocabCache.at < 10 * 60 * 1000) return vocabCache.data;
  const db = await getDb(dbOverride);
  const names = async (col) =>
    (await db.collection(col).find({}, { projection: { [NAME]: 1 } }).limit(300).toArray())
      .map((d) => getPath(d, NAME)).filter((x) => typeof x === "string").sort();
  const data = {
    makes: await names(C.make), categories: await names(C.category), cities: await names(C.city),
    fuelTypes: await names(C.fuelType), transmissions: await names(C.transmission),
  };
  vocabCache = { at: Date.now(), data };
  return data;
}
