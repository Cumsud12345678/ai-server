import { Type } from "@google/genai";
import { sanitizeFilters, LEGACY_SCHEMA } from "../data/filters.js";

// Alət MÜŞTƏRİNİN ELAN ETDİYİ filtrlərdən qurulur: AI sxemdə olmayan filtri istifadə edə bilmir
export function buildToolDeclaration(schema = LEGACY_SCHEMA) {
  const properties = {};
  for (const a of schema.args) {
    if (a.kind === "number") properties[a.name] = { type: Type.NUMBER, description: a.description };
    else if (a.kind === "text") properties[a.name] = { type: Type.STRING, description: `${a.description}. Yalnız digər filtrlərlə ifadə olunmayan təsvir/açar sözlər (maksimum 100 simvol)` };
    else if (a.kind === "boolean") properties[a.name] = { type: Type.BOOLEAN, description: a.description };
    else if (a.kind === "multi")
      properties[a.name] = { type: Type.ARRAY, description: a.description, items: { type: Type.STRING, ...(a.values && { enum: a.values }) } };
    else properties[a.name] = { type: Type.STRING, description: a.description, ...(a.values && { enum: a.values }) };
  }
  if (schema.sortFields.length) {
    properties.sortBy = { type: Type.STRING, enum: schema.sortFields, description: "Sıralama sahəsi" };
    properties.sortDir = { type: Type.STRING, enum: ["asc", "desc"], description: "Artan (asc) və ya azalan (desc)" };
  }
  return {
    name: "search_listings",
    description:
      "Elanlar bazasında filtrlərlə axtarır və nəticə qaytarır. Yalnız istifadəçinin dediyi şərtləri doldur, " +
      "demədiklərini boş burax. Mətn filtrləri üçün sistem təlimatındakı və ya enum-dakı dəqiq dəyərlərdən istifadə et.",
    parameters: { type: Type.OBJECT, properties },
  };
}

// Modelə gedən elan qısa olmalıdır: şəkil linki, boş sahələr token yandırır (kartlar ctx.listings-dən tam qaytarılır)
function compactForModel(l) {
  const out = {};
  for (const [k, v] of Object.entries(l)) {
    if (k === "image" || v === null || v === undefined || v === "") continue;
    if (k === "attributes" && v && typeof v === "object") { if (Object.keys(v).length) out[k] = v; continue; }
    out[k] = v;
  }
  return out;
}

// ctx.listings: AI-ın gördüyü bütün elanlar (API cavabında kartlar üçün qaytarılır)
export async function runTool(repo, tenant, name, args, ctx) {
  if (name !== "search_listings") return { error: `Naməlum alət: ${name}` };
  ctx.searched = true; // sorğu qeydi: axtarış həqiqətən aparılıb
  try {
    const filters = sanitizeFilters(args ?? {}, { maxResults: tenant.profile?.maxResults, schema: repo.schema });
    const listings = await repo.search(filters);
    ctx.listings.push(...listings);
    if (process.env.DEBUG_SEARCH) console.log(`[search] ${tenant.tenantId} AI filtri:`, JSON.stringify(args), "→", listings.length, "elan");
    return { count: listings.length, listings: listings.map(compactForModel) };
  } catch (err) {
    ctx.failed = true; // xətalı cavab keşlənmir
    console.error(`[search] ${tenant.tenantId} xəta:`, err.code ?? "", err.message);
    return { error: "Axtarış xidməti hazırda əlçatan deyil. Bunu istifadəçiyə bildir, elan uydurma." };
  }
}
