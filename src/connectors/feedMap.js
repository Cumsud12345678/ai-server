// Fayl/feed sütunlarını standart elan sahələrinə AVTOMATİK uyğunlaşdırır (istifadəçi sonra dəyişə bilər).
import { slugify } from "./mapper.js";
import { columnsOf } from "./feedParse.js";

const norm = (s) => slugify(s).replace(/-/g, "");
// Sahə → tanınan sütun adları (normallaşmış: kiçik hərf, diakritiksiz, tire/boşluqsuz)
const SYN = {
  id: ["id", "productid", "itemid", "sku", "code", "kod", "listingid", "elanid", "guid", "uuid", "mpn", "artikul", "nomre"],
  title: ["title", "name", "productname", "ad", "adi", "basliq", "headline", "mehsul", "mehsuladi", "elanbasligi", "product"],
  price: ["price", "qiymet", "cost", "amount", "salesprice", "sellingprice", "mebleg", "qiymetazn"],
  currency: ["currency", "valyuta", "pricecurrency", "cur"],
  url: ["url", "link", "producturl", "href", "permalink", "elanlinki", "ssilka"],
  image: ["image", "imagelink", "imageurl", "img", "photo", "picture", "thumbnail", "sekil", "foto", "mainimage", "images", "photos", "imagelinkurl"],
  make: ["make", "brand", "marka", "manufacturer", "brend", "firma"],
  model: ["model"],
  year: ["year", "il", "buraxilisili", "modelyear", "ilburaxilis", "manufactureyear"],
  city: ["city", "seher", "region", "location", "yer", "unvan"],
  bodyType: ["bodytype", "category", "kateqoriya", "producttype", "kuzov", "ban", "bantype", "tip", "type", "categoryname", "googleproductcategory"],
  fuelType: ["fuel", "fueltype", "yanacaq", "yanacaqnovu"],
  transmission: ["transmission", "gearbox", "qutu", "suretqutusu", "korobka"],
  mileage: ["mileage", "km", "yurus", "odometer", "probeg"],
  volume: ["volume", "enginevolume", "enginesize", "hecm", "motorhecmi", "motor", "mühərrik"],
  power: ["power", "horsepower", "hp", "gucu", "gucat", "bhp"],
};
const NUMERIC = new Set(["price", "year", "mileage", "volume", "power"]);
const lastSeg = (p) => p.replace(/\[\d+\]/g, "").split(".").pop();

function pickColumn(cols, field, used) {
  const names = SYN[field];
  // 1) tam uyğunluq, ən çox dolu olan; 2) yuvalanmış yolun son hissəsi
  for (const test of [(c) => norm(c.path), (c) => norm(lastSeg(c.path))]) {
    const hits = cols.filter((c) => !used.has(c.path) && names.includes(test(c)));
    if (hits.length) {
      hits.sort((a, b) => names.indexOf(test(a)) - names.indexOf(test(b)) || b.filled - a.filled);
      // ictimai "price" yoxdursa "salePrice" kimi variant qəbul edilir
      return hits[0];
    }
  }
  return null;
}

const CURRENCIES = [[/₼|azn|manat/i, "AZN"], [/\$|usd/i, "USD"], [/€|eur/i, "EUR"], [/₽|rub/i, "RUB"], [/₺|try/i, "TRY"]];

/** Sütun siyahısından `response` (fields, defaults) təklifi qaytarır. */
export function autoMap(items) {
  const cols = columnsOf(items);
  const used = new Set();
  const fields = {};
  const take = (field, spec, col) => { fields[field] = spec; used.add(col.path); };
  for (const f of Object.keys(SYN)) {
    const col = pickColumn(cols, f, used);
    if (!col) continue;
    take(f, NUMERIC.has(f) ? { path: col.path, type: "number", loose: true } : col.path, col);
  }
  // başlıq yoxdursa marka+model, o da yoxdursa ən uzun qısa mətn sütunu
  if (!fields.title) {
    if (fields.make && fields.model) fields.title = "{" + (typeof fields.make === "string" ? fields.make : fields.make.path) + "} {" + (typeof fields.model === "string" ? fields.model : fields.model.path) + "}";
    else {
      const txt = cols.filter((c) => !used.has(c.path) && c.filled > 0.5 && c.avgLen >= 4 && c.avgLen <= 200).sort((a, b) => b.avgLen - a.avgLen)[0];
      if (txt) take("title", txt.path, txt);
    }
  }
  // id yoxdursa url, o da yoxdursa başlıq
  if (!fields.id) {
    const src = fields.url ?? fields.title;
    if (src) fields.id = typeof src === "string" ? (src.includes("{") ? src : `{${src}}`) : `{${src.path}}`;
  }
  // qalan qısa sütunlar xüsusiyyət kimi (AI-a göstərilir); uzun mətnlər yalnız axtarışda iştirak edir
  const attrs = {};
  for (const c of cols.filter((c) => !used.has(c.path) && c.filled >= 0.2 && c.avgLen <= 60).slice(0, 10)) attrs[c.path.replace(/\[\d+\]/g, "")] = c.path;
  if (Object.keys(attrs).length) fields.attributes = attrs;
  const defaults = {};
  if (!fields.currency && fields.price?.path) {
    const col = cols.find((c) => c.path === fields.price.path);
    const cur = CURRENCIES.find(([re]) => col?.samples.some((s) => re.test(s)));
    if (cur) defaults.currency = cur[1];
  }
  const unmapped = cols.filter((c) => !used.has(c.path) && !Object.values(attrs).includes(c.path)).map((c) => c.path);
  return { fields, defaults, unmapped, columns: cols.map((c) => ({ path: c.path, samples: c.samples, filled: Math.round(c.filled * 100) })) };
}
