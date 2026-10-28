// Fayl/feed mənbəyi: sətirlər bizdə saxlanır, xəritələmə response.fields ilə (REST ilə eyni format), axtarış və filtr yerli aparılır.
// Eyni interfeys: { schema, supportedFilters, sortFields, search, searchWithDebug, vocabulary }
import { mapItem, validateListing, slugify } from "./mapper.js";
import { compileSchema, toPublic } from "../data/filters.js";
import { ConnectorError } from "./safeFetch.js";

const NAMES = { make: "makes", model: "models", bodyType: "categories", city: "cities", fuelType: "fuelTypes", transmission: "transmissions" };
const STRING_FILTERS = {
  make: "Marka / brend (dəqiq ad)", model: "Model", bodyType: "Kateqoriya / növ", city: "Şəhər / region",
  fuelType: "Yanacaq növü", transmission: "Sürətlər qutusu",
};
const hasValue = (listings, k) => listings.some((l) => l[k] !== null && l[k] !== undefined && l[k] !== "");
const scalars = (v, out = [], depth = 0) => {
  if (out.length >= 40 || v === null || v === undefined) return out;
  if (Array.isArray(v)) { if (depth < 3) v.slice(0, 5).forEach((x) => scalars(x, out, depth + 1)); }
  else if (typeof v === "object") { if (depth < 3) Object.values(v).forEach((x) => scalars(x, out, depth + 1)); }
  else { const s = String(v); if (s) out.push(s.slice(0, 200)); }
  return out;
};

/** items: xam sətirlər; tenant.source.response: { fields, defaults } */
export function createFeedRepo(tenant, items) {
  const resp = tenant.source?.response;
  if (!resp?.fields || typeof resp.fields !== "object") throw new ConnectorError("Sahə xəritələməsi yoxdur", "BAD_MAPPING");
  const dropped = [];
  const rows = [];
  for (const it of items) {
    const m = mapItem(it, resp.fields, { defaults: resp.defaults });
    const bad = validateListing(m);
    if (bad) { dropped.push(bad); continue; }
    rows.push({ listing: m, hay: slugify([m.title, m.make, m.model, m.city, m.bodyType, m.fuelType, ...Object.values(m.attributes ?? {}), ...scalars(it)].filter(Boolean).join(" ")), norm: Object.fromEntries(Object.keys(STRING_FILTERS).map((k) => [k, m[k] ? slugify(m[k]) : ""])) });
  }
  const listings = rows.map((r) => r.listing);

  const rules = {};
  for (const [k, d] of Object.entries(STRING_FILTERS)) if (hasValue(listings, k)) rules[k] = { type: "string", description: d, param: k };
  if (hasValue(listings, "price")) { rules.minPrice = { type: "number", description: "Minimum qiymət", param: "minPrice" }; rules.maxPrice = { type: "number", description: "Maksimum qiymət", param: "maxPrice" }; }
  if (hasValue(listings, "year")) { rules.minYear = { type: "number", description: "Ən aşağı il", param: "minYear" }; rules.maxYear = { type: "number", description: "Ən yüksək il", param: "maxYear" }; }
  if (hasValue(listings, "mileage")) rules.maxMileage = { type: "number", description: "Maksimum yürüş (km)", param: "maxMileage" };
  rules.q = { type: "text", description: "Sərbəst axtarış sözləri (ad, rəng, xüsusiyyət və s.)", param: "q" };
  const sortFields = ["price", "year", "mileage"].filter((k) => hasValue(listings, k));
  const compiled = compileSchema(rules, sortFields);
  if (compiled.error) throw new ConnectorError(compiled.error, "BAD_FILTERS");
  const schema = compiled;
  const supportedFilters = schema.args.map((a) => a.name);
  if (sortFields.length) supportedFilters.push("sortBy", "sortDir");

  const matchStr = (norm, want) => { const w = slugify(want); return !w || norm === w || norm.includes(w); };

  function searchWithDebug(f) {
    const debug = { request: "feed", cached: true, rawCount: items.length, rawFirst: items[0] ?? null, dropped: dropped.slice(0, 5), note: null };
    const words = f.q ? slugify(f.q).split("-").filter(Boolean) : [];
    let out = rows.filter(({ listing: l, hay, norm }) => {
      for (const k of Object.keys(STRING_FILTERS)) if (f[k] !== undefined && !matchStr(norm[k], f[k])) return false;
      if (f.minPrice !== undefined && !(typeof l.price === "number" && l.price >= f.minPrice)) return false;
      if (f.maxPrice !== undefined && !(typeof l.price === "number" && l.price <= f.maxPrice)) return false;
      if (f.minYear !== undefined && !(typeof l.year === "number" && l.year >= f.minYear)) return false;
      if (f.maxYear !== undefined && !(typeof l.year === "number" && l.year <= f.maxYear)) return false;
      if (f.maxMileage !== undefined && !(typeof l.mileage === "number" && l.mileage <= f.maxMileage)) return false;
      return words.every((w) => hay.includes(w));
    }).map((r) => r.listing);
    if (sortFields.includes(f.sortBy)) {
      const dir = f.sortDir === "desc" ? -1 : 1;
      out = [...out].sort((a, b) => ((a[f.sortBy] ?? Infinity) - (b[f.sortBy] ?? Infinity)) * dir);
    }
    return { listings: out.slice(0, f.limit).map(toPublic), debug };
  }

  async function vocabulary() {
    const out = {};
    for (const k of Object.keys(STRING_FILTERS)) {
      const vals = [...new Set(listings.map((l) => l[k]).filter((v) => typeof v === "string" && v))].sort();
      if (vals.length) out[NAMES[k]] = vals.slice(0, 300);
    }
    return out;
  }

  return { schema, supportedFilters, sortFields, search: async (f) => searchWithDebug(f).listings, searchWithDebug: async (f) => searchWithDebug(f), vocabulary };
}
