// Filtr müqaviləsi.
//  - Standart filtrlər hər müştəridə eynidir: make, model, minPrice, maxPrice (+ sıralama, limit).
//  - Başqa filtri müştəri öz konfiqurasiyasında elan edir (source.filters.<ad> = { type, param, description, ... }).
//  - Köhnə hazır adlar (bodyType, city, fuelType, transmission, minYear, maxYear, maxMileage) geriyə uyğunluq üçün
//    "type" yazılmadan işləyir; yeni müştərilər onları da özü elan etməlidir.
// AI-dan / URL-dən gələn dəyərlər YALNIZ buradakı sxemə görə qəbul edilir: sxemdə olmayan açar heç vaxt
// müştəri API-sinə getmir.
export const SORT_FIELDS = ["price", "year", "mileage"];
export const MAX_FILTERS = 15;
export const KINDS = ["string", "number", "boolean", "multi", "range", "text"];

const RESERVED = new Set(["sort", "limit", "sortBy", "sortDir"]);
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9]{0,29}$/;
const PARAM_RE = /^[A-Za-z0-9_.\-[\]]{1,60}$/;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Hazır (geriyə uyğun) filtrlər
const PRESETS = {
  make: { kind: "string", description: "Marka (dəqiq ad)" },
  model: { kind: "string", description: "Model, məs. X5, Camry" },
  minPrice: { kind: "number", description: "Minimum qiymət" },
  maxPrice: { kind: "number", description: "Maksimum qiymət" },
  bodyType: { kind: "string", description: "Kateqoriya / kuzov tipi (dəqiq ad)" },
  city: { kind: "string", description: "Şəhər / region (dəqiq ad)" },
  fuelType: { kind: "string", description: "Yanacaq növü (dəqiq ad)" },
  transmission: { kind: "string", description: "Sürətlər qutusu (dəqiq ad)" },
  minYear: { kind: "number", description: "Ən aşağı buraxılış ili" },
  maxYear: { kind: "number", description: "Ən yüksək buraxılış ili" },
  maxMileage: { kind: "number", description: "Maksimum yürüş (km)" },
};
export const STANDARD_FILTERS = ["make", "model", "minPrice", "maxPrice"];

const cleanParam = (p) => typeof p === "string" && PARAM_RE.test(p);
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

function readValues(rule, where) {
  if (rule.values === undefined) return { values: undefined };
  if (!Array.isArray(rule.values) || !rule.values.length || rule.values.length > 100 || rule.values.some((v) => !text(v, 60)))
    return { error: `${where}.values 1-100 mətn olmalıdır (hər biri maksimum 60 simvol)` };
  return { values: [...new Set(rule.values.map((v) => v.trim()))] };
}

// Ortaq: param, valueFrom, valueMap
function commonRule(rule, where) {
  if (!cleanParam(rule.param)) return { error: `${where}.param düzgün deyil (hərf, rəqəm, _ . - [ ] ; maksimum 60 simvol)` };
  if (rule.valueFrom !== undefined && rule.valueFrom !== "vocabulary") return { error: `${where}.valueFrom yalnız "vocabulary" ola bilər` };
  if (rule.valueMap !== undefined && (!rule.valueMap || typeof rule.valueMap !== "object" || Array.isArray(rule.valueMap)))
    return { error: `${where}.valueMap obyekt olmalıdır` };
  return {};
}

/**
 * source.filters-i sxemə çevirir. Qaytarır: { args, sortFields } və ya { error }.
 * args[i] = { name, kind: string|number|boolean|multi, description, values?, param, valueFrom?, valueMap?, separator?, format? }
 * "range" tipi iki arqumentə açılır: <ad>Min və <ad>Max.
 */
export function compileSchema(filters = {}, sortFields = [], { strict = false } = {}) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return { error: "source.filters obyekt olmalıdır" };
  const args = [];
  const names = new Set();
  const add = (a, where) => {
    if (names.has(a.name)) return `${where}: "${a.name}" adı təkrarlanır`;
    names.add(a.name);
    args.push(a);
    return null;
  };
  const keys = Object.keys(filters).filter((k) => k !== "sort" && k !== "limit");
  if (keys.length > MAX_FILTERS) return { error: `Ən çox ${MAX_FILTERS} filtr elan edə bilərsən (AI-ın dəqiqliyi üçün)` };

  for (const key of keys) {
    const where = `source.filters.${key}`;
    const rule = filters[key];
    if (!KEY_RE.test(key) || RESERVED.has(key)) return { error: `${where}: filtr adı yalnız latın hərfi və rəqəmdən ibarət olmalıdır (maksimum 30) və ayrılmış söz ola bilməz` };
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return { error: `${where} obyekt olmalıdır` };
    const preset = hasOwn(PRESETS, key) ? PRESETS[key] : null;
    // strict (yeni/yenilənən konfiqurasiya): hər filtr eyni formada yazılır, "hazır" filtr yoxdur.
    // Köhnə saxlanmış müştərilər üçün geriyə uyğunluq: type/description yazılmayıbsa hazır adlardan götürülür.
    if (strict && rule && typeof rule === "object" && rule.type === undefined)
      return { error: `${where}.type yazılmayıb. Hər filtr eyni formada yazılır, məs. { "type": "number", "description": "Maksimum qiymət", "param": "price_to" } (type: ${KINDS.join(", ")})` };
    if (strict && rule && typeof rule === "object" && rule.description === undefined)
      return { error: `${where}.description yazılmayıb. AI filtri bu təsvirə görə başa düşür, məs. "description": "Maksimum qiymət"` };
    const kind = rule.type ?? preset?.kind;
    if (!kind) return { error: `${where}.type tələb olunur (${KINDS.join(", ")})` };
    if (!KINDS.includes(kind)) return { error: `${where}.type dəstəklənmir: ${String(kind).slice(0, 20)} (${KINDS.join(", ")})` };
    const description = rule.description ?? preset?.description;
    if (!text(description, 200) || String(description).trim().length < 3) return { error: `${where}.description tələb olunur (AI filtri bununla başa düşür; 3-200 simvol)` };

    if (kind === "range") {
      if (rule.minParam === undefined && rule.maxParam === undefined) return { error: `${where}: minParam və ya maxParam tələb olunur` };
      for (const [side, p] of [["Min", rule.minParam], ["Max", rule.maxParam]]) {
        if (p === undefined) continue;
        if (!cleanParam(p)) return { error: `${where}.${side.toLowerCase()}Param düzgün deyil` };
        const e = add({ name: `${key}${side}`, kind: "number", description: `${description.trim()} (${side === "Min" ? "ən az" : "ən çox"})`, param: p }, where);
        if (e) return { error: e };
      }
      continue;
    }

    const c = commonRule(rule, where);
    if (c.error) return c;
    if (kind === "text") {
      // Sərbəst mətn axtarışı (təsvir, açar sözlər): siyahı/çevirmə olmur, yalnız bir dənə
      if (rule.values !== undefined || rule.valueFrom !== undefined || rule.valueMap !== undefined) return { error: `${where}: "text" tipində values, valueFrom və valueMap olmur` };
      if (args.some((a) => a.kind === "text")) return { error: `${where}: yalnız bir "text" filtri ola bilər` };
      const e = add({ name: key, kind: "text", description: description.trim(), param: rule.param }, where);
      if (e) return { error: e };
      continue;
    }
    const v = readValues(rule, where);
    if (v.error) return v;
    if (v.values && !["string", "multi"].includes(kind)) return { error: `${where}.values yalnız string və multi tipində olur` };
    if (rule.valueFrom === "vocabulary" && !["string", "multi"].includes(kind)) return { error: `${where}.valueFrom yalnız string və multi tipində olur` };
    const a = { name: key, kind, description: description.trim(), param: rule.param };
    if (v.values) a.values = v.values;
    if (rule.valueFrom) a.valueFrom = rule.valueFrom;
    if (rule.valueMap) a.valueMap = rule.valueMap;
    if (kind === "multi") {
      if (rule.separator !== undefined && !text(rule.separator, 3)) return { error: `${where}.separator düzgün deyil` };
      a.separator = rule.separator ?? ",";
      if (rule.format !== undefined && rule.format !== "array") return { error: `${where}.format yalnız "array" ola bilər` };
      if (rule.format) a.format = "array";
    }
    const e = add(a, where);
    if (e) return { error: e };
  }
  return { args, sortFields };
}

// Dev mənbələri (nümunə JSON / Mongo) üçün sabit sxem: bütün hazır filtrlər
export const LEGACY_SCHEMA = {
  args: Object.entries(PRESETS).map(([name, p]) => ({ name, kind: p.kind, description: p.description })),
  sortFields: SORT_FIELDS,
};
export const FILTER_KEYS = [...LEGACY_SCHEMA.args.map((a) => a.name), "sortBy", "sortDir"];

export const PUBLIC_FIELDS = [
  "id", "title", "make", "model", "price", "currency", "year", "volume", "power", "mileage",
  "bodyType", "city", "fuelType", "transmission", "used", "credit", "barter", "url", "image", "attributes",
];

const num = (v) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const str = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 50) : undefined);
const canon = (a, s) => (a.values ? a.values.find((x) => x.toLowerCase() === s.toLowerCase()) : s);

function cleanValue(a, v) {
  if (v === undefined || v === null) return undefined;
  switch (a.kind) {
    case "number": return num(v);
    case "boolean": return v === true || v === "true" ? true : v === false || v === "false" ? false : undefined;
    case "string": { const s = str(v); return s === undefined ? undefined : canon(a, s); }
    case "text": return typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || undefined : undefined;
    case "multi": {
      const list = (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).slice(0, 10)
        .map(str).filter((x) => x !== undefined).map((x) => canon(a, x)).filter((x) => x !== undefined);
      return list.length ? [...new Set(list)] : undefined;
    }
    default: return undefined;
  }
}

// AI-dan / URL-dən gələn filtrlərə etibar etmir: yalnız sxemdəki adlar, tiplər yoxlanır, sıralama və say məhdudlaşır
export function sanitizeFilters(raw = {}, { maxResults = 10, schema = LEGACY_SCHEMA } = {}) {
  const cap = Math.min(Math.max(num(maxResults) ?? 10, 1), 20);
  const out = {};
  for (const a of schema.args) {
    const v = cleanValue(a, hasOwn(raw ?? {}, a.name) ? raw[a.name] : undefined);
    if (v !== undefined) out[a.name] = v;
  }
  out.sortBy = schema.sortFields.includes(raw?.sortBy) ? raw.sortBy : "price";
  out.sortDir = raw?.sortDir === "desc" ? "desc" : "asc";
  out.limit = Math.min(Math.max(num(raw?.limit) ?? cap, 1), cap);
  return out;
}

export const toPublic = (doc) => Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, doc[k]]));

/** Köhnə (qısa) yazılışı tam formaya çevirir: hazır adlara type və description əlavə edir. Panel üçün də eyni qayda. */
export function expandLegacyFilters(filters = {}) {
  const out = {};
  for (const [k, r] of Object.entries(filters)) {
    if (k === "sort" || k === "limit" || !r || typeof r !== "object" || !hasOwn(PRESETS, k)) { out[k] = r; continue; }
    out[k] = { type: PRESETS[k].kind, description: PRESETS[k].description, ...r };
  }
  return out;
}
