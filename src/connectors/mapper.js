// Müştərinin sahələrini standart elan formatına çevirir (konfiqurasiyaya görə, kodsuz)
const AZ = { ə: "e", Ə: "e", ı: "i", İ: "i", I: "i", ö: "o", Ö: "o", ü: "u", Ü: "u", ş: "s", Ş: "s", ç: "c", Ç: "c", ğ: "g", Ğ: "g" };
export const slugify = (v) =>
  String(v ?? "").replace(/[əƏıİIöÖüÜşŞçÇğĞ]/g, (c) => AZ[c]).toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const transforms = { slug: slugify, lower: (s) => s.toLowerCase(), encode: encodeURIComponent };

// "a.b[0].c" yolu ilə dəyəri oxuyur
export function getPath(obj, path) {
  if (path === "" || path === undefined || path === null) return obj;
  let cur = obj;
  for (const p of String(path).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

// "{brand.title} {model.title?}" : {x} məcburidir (yoxdursa nəticə null), {x?} könüllüdür, {x|slug} çevirmə
export function renderTemplate(tpl, obj) {
  let missing = false;
  const out = tpl.replace(/\{([^}]+)\}/g, (_, expr) => {
    const [rawPath, ...fns] = expr.split("|").map((s) => s.trim());
    const optional = rawPath.endsWith("?");
    let v = getPath(obj, optional ? rawPath.slice(0, -1) : rawPath);
    if (v === undefined || v === null || v === "" || typeof v === "object") { if (!optional) missing = true; return ""; }
    v = String(v);
    for (const fn of fns) if (transforms[fn]) v = transforms[fn](v);
    return v;
  });
  return missing ? null : out.replace(/\s+/g, " ").trim();
}

export function coerce(v, type) {
  if (v === undefined || v === null) return null;
  if (type === "number") {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const n = Number(String(v).replace(/[\s\u00a0]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  if (type === "boolean") {
    if (typeof v === "boolean") return v;
    const s = String(v).toLowerCase();
    return ["true", "1", "yes", "bəli", "var"].includes(s) ? true : ["false", "0", "no", "xeyr", "yox"].includes(s) ? false : null;
  }
  if (typeof v === "object") return null;
  return String(v);
}

const STANDARD_TYPES = { price: "number", year: "number", volume: "number", power: "number", mileage: "number", used: "boolean", credit: "boolean", barter: "boolean" };

function resolveField(item, key, raw, lookup, forcedType) {
  const spec = typeof raw === "string" ? (raw.includes("{") ? { template: raw } : { path: raw }) : raw;
  let v = spec.template ? renderTemplate(spec.template, item) : getPath(item, spec.path);
  if (spec.lookup && lookup) v = lookup(spec.lookup, v); // ID → ad (vocabulary-dən)
  v = coerce(v, spec.type ?? forcedType ?? STANDARD_TYPES[key] ?? "string");
  return v === null && spec.default !== undefined ? spec.default : v;
}

export function mapItem(item, fields, { defaults = {}, lookup } = {}) {
  const out = {};
  for (const [key, raw] of Object.entries(fields)) if (key !== "attributes") out[key] = resolveField(item, key, raw, lookup);
  for (const [k, v] of Object.entries(defaults)) if (out[k] === null || out[k] === undefined) out[k] = v;
  if (fields.attributes) {
    const attrs = {};
    for (const [label, raw] of Object.entries(fields.attributes)) {
      const v = resolveField(item, "attr", raw, lookup, "string");
      if (v !== null) attrs[label] = v;
    }
    out.attributes = Object.keys(attrs).length ? attrs : null;
  }
  return out;
}

export const validateListing = (l) => (!l.id ? "id yoxdur" : !l.title ? "title yoxdur" : null);
