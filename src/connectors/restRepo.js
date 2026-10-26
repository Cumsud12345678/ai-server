// Konfiqurasiya əsaslı REST konnektoru: hər müştəri üçün kod yox, JSON konfiqurasiya.
import { safeFetchJson, ConnectorError } from "./safeFetch.js";
import { getPath, mapItem, validateListing, slugify } from "./mapper.js";
import { toPublic, compileSchema } from "../data/filters.js";
import { decryptSecret } from "../tenants/secretCrypto.js";

export const LOCAL_SORTABLE_FIELDS = ["price", "year", "mileage", "volume", "power"];
const NAMES = { make: "makes", model: "models", bodyType: "categories", city: "cities", fuelType: "fuelTypes", transmission: "transmissions" };

export function createRestRepo(tenant) {
  const cfg = tenant.source;
  const rules = cfg.filters ?? {};
  const sortRule = rules.sort;
  const localFields = Array.isArray(cfg.localSort) ? cfg.localSort : cfg.localSort ? ["price", "year", "mileage"] : [];
  const sortFields = sortRule
    ? [...new Set(Object.keys(sortRule.valueMap ?? {}).map((k) => k.split(":")[0]))]
    : localFields;
  const compiled = compileSchema(rules, sortFields);
  if (compiled.error) throw new ConnectorError(compiled.error, "BAD_FILTERS");
  const schema = compiled;
  const supportedFilters = schema.args.map((a) => a.name);
  if (sortFields.length) supportedFilters.push("sortBy", "sortDir");

  const cache = new Map();

  function applyAuth(url, headers) {
    const a = cfg.auth;
    if (!a || a.type === "none") return;
    const secret = a.encryptedValue ? decryptSecret(a.encryptedValue) : process.env[a.valueEnv];
    if (!secret) throw new ConnectorError(`Müştəri API açarı konfiqurasiya edilməyib`, "NO_SECRET");
    if (a.type === "header") headers[a.name] = secret;
    else if (a.type === "bearer") headers.Authorization = `Bearer ${secret}`;
    else if (a.type === "query") url.searchParams.set(a.name, secret);
  }

  async function request(path, { method = "GET", params = null, ttlMs = 0, graphql = null } = {}) {
    const url = new URL(path, cfg.baseUrl);
    const headers = {};
    let body;
    if (graphql) {
      // GraphQL: həmişə POST, filtrlər "variables" daxilində gedir
      body = JSON.stringify({ query: graphql, variables: params ?? {} }); headers["content-type"] = "application/json";
    } else if (params) {
      if (method === "GET") for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      else { body = JSON.stringify(params); headers["content-type"] = "application/json"; }
    }
    const shown = `${method} ${url}${body ? " " + body : ""}`; // açar bura düşmür
    applyAuth(url, headers);
    const key = `${method} ${url}|${body ?? ""}`;
    const hit = cache.get(key);
    if (ttlMs && hit && Date.now() - hit.at < ttlMs) return { json: hit.json, shown, cached: true };
    const json = await safeFetchJson(url.toString(), { method, headers, body, timeoutMs: cfg.timeoutMs ?? 5000, maxBytes: cfg.maxBytes ?? 1_000_000 });
    if (cache.size > 200) cache.clear();
    if (ttlMs) cache.set(key, { at: Date.now(), json });
    return { json, shown, cached: false };
  }

  // Müştərinin siyahıları (marka, şəhər...): ad ↔ ID çevirmələri üçün
  // Hər siyahı öz "path"-ından, yoxdursa vocabulary.path-dan götürülür; eyni path bir dəfə çağırılır.
  async function loadVocabulary() {
    if (!cfg.vocabulary) return {};
    const entries = Object.entries(cfg.vocabulary.lists ?? {});
    const paths = [...new Set(entries.map(([, spec]) => spec.path ?? cfg.vocabulary.path).filter(Boolean))];
    const bodies = new Map(await Promise.all(paths.map(async (p) => [p, (await request(p, { ttlMs: 10 * 60 * 1000 })).json])));
    const out = {};
    for (const [key, spec] of entries) {
      const json = bodies.get(spec.path ?? cfg.vocabulary.path);
      const items = (spec.itemsPath ? getPath(json, spec.itemsPath) : json) ?? [];
      out[key] = (Array.isArray(items) ? items : [])
        .map((i) => ({ id: getPath(i, spec.idField), name: String(getPath(i, spec.nameField) ?? "") }))
        .filter((x) => x.name && x.id !== undefined && x.id !== null);
    }
    return out;
  }

  const resolveName = (list, value) => {
    if (!list?.length) return undefined;
    const v = String(value).trim().toLowerCase();
    return (list.find((x) => x.name.toLowerCase() === v) ?? list.find((x) => x.name.toLowerCase().includes(v)))?.id;
  };

  // Sxemdəki filtrləri müştərinin parametrlərinə çevirir. Ad tapılmasa null (nəticə yoxdur).
  function buildParams(f, vocab, vocabError) {
    const params = {};
    for (const a of schema.args) {
      const v = f[a.name];
      if (v === undefined) continue;
      let out = v;
      if (a.valueFrom === "vocabulary") {
        if (vocabError) throw vocabError;
        if (a.kind === "multi") {
          out = v.map((x) => resolveName(vocab[a.name], x)).filter((x) => x !== undefined);
          if (!out.length) return null;
        } else {
          out = resolveName(vocab[a.name], v);
          if (out === undefined) return null;
        }
      } else if (a.valueMap) {
        const one = (x) => a.valueMap[String(x)];
        out = Array.isArray(v) ? v.map(one).filter((x) => x !== undefined) : one(v);
        if (out === undefined || (Array.isArray(out) && !out.length)) continue;
      }
      if (Array.isArray(out) && a.format !== "array") out = out.join(a.separator ?? ",");
      params[a.param] = out;
    }
    if (sortRule) {
      const val = sortRule.valueMap?.[`${f.sortBy}:${f.sortDir}`];
      if (val !== undefined) params[sortRule.param] = val;
    }
    // Səhifə ölçüsü filtr deyil: source.search.limitParam (köhnə yazılış: filters.limit.param də işləyir)
    const limitParam = cfg.search?.limitParam ?? rules.limit?.param;
    if (limitParam) params[limitParam] = f.limit;
    return params;
  }

  async function searchWithDebug(f) {
    const debug = { request: null, cached: false, rawCount: 0, rawFirst: null, dropped: [], note: null };
    let vocab = {}, vocabError = null;
    try { vocab = await loadVocabulary(); } catch (e) { vocabError = e; }

    const params = buildParams(f, vocab, vocabError);
    if (params === null) { debug.note = "Filtrdəki ad müştərinin siyahısında tapılmadı"; return { listings: [], debug }; }

    const { json, shown, cached } = await request(cfg.search.path, {
      method: cfg.search.graphql ? "POST" : cfg.search.method ?? "GET", params, graphql: cfg.search.graphql ?? null, ttlMs: (cfg.cacheSeconds ?? 60) * 1000,
    });
    if (cfg.search.graphql && Array.isArray(json?.errors) && json.errors.length)
      throw new ConnectorError(`GraphQL xətası: ${String(json.errors[0]?.message ?? "naməlum").slice(0, 150)}`, "GRAPHQL_ERROR");
    debug.request = shown; debug.cached = cached;

    const resp = cfg.response;
    let items = getPath(json, resp.itemsPath ?? "");
    if (!Array.isArray(items)) throw new ConnectorError(`Cavabda "${resp.itemsPath ?? ""}" massiv deyil`, "BAD_SHAPE");
    debug.rawCount = items.length;
    debug.rawFirst = items[0] ?? null;

    if (resp.itemFilter) {
      const { path, equals, in: allowed } = resp.itemFilter;
      items = items.filter((it) => { const v = getPath(it, path); return allowed ? allowed.includes(v) : v === equals; });
    }

    const lookup = (listKey, id) => {
      const l = vocab[listKey];
      return l && id !== undefined && id !== null ? l.find((x) => String(x.id) === String(id))?.name ?? null : null;
    };
    let listings = [];
    for (const it of items) {
      const m = mapItem(it, resp.fields, { defaults: resp.defaults, lookup });
      const bad = validateListing(m);
      if (bad) debug.dropped.push(bad); else listings.push(m);
    }

    // Müştəri API-si qiymət parametrini sakitcə nəzərə almaya bilər: qiymət standart sahədir, ona görə özümüz də yoxlayırıq.
    // (Qiyməti olmayan elan saxlanır; sayı azalsa AI "uyğun elan yoxdur" deyəcək, səhv elan göstərməyəcək.)
    if (f.minPrice !== undefined || f.maxPrice !== undefined) {
      const before = listings.length;
      listings = listings.filter((l) => typeof l.price !== "number"
        || ((f.minPrice === undefined || l.price >= f.minPrice) && (f.maxPrice === undefined || l.price <= f.maxPrice)));
      if (listings.length < before) debug.note = `${before - listings.length} elan müştəri API-si qiymət filtrini nəzərə almadığı üçün atıldı`;
    }

    // Müştəri API-si mətn axtarışını bilmirsə (source.localText: true): açar sözləri özümüz yoxlayırıq.
    // Hər söz başlıqda, markada, modeldə, şəhərdə və ya xüsusiyyətlərdə olmalıdır (hərf/diakritik fərqi nəzərə alınmır).
    const textArg = schema.args.find((a) => a.kind === "text");
    if (cfg.localText && textArg && f[textArg.name]) {
      const words = slugify(f[textArg.name]).split("-").filter(Boolean);
      const before = listings.length;
      listings = listings.filter((l) => {
        const hay = slugify([l.title, l.make, l.model, l.city, l.bodyType, l.fuelType, ...Object.values(l.attributes ?? {})].filter(Boolean).join(" "));
        return words.every((w) => hay.includes(w));
      });
      if (listings.length < before) debug.note = [debug.note, `${before - listings.length} elan açar sözə uyğun gəlmədiyi üçün atıldı`].filter(Boolean).join("; ");
    }

    if (localFields.includes(f.sortBy)) {
      const dir = f.sortDir === "desc" ? -1 : 1;
      listings.sort((a, b) => ((a[f.sortBy] ?? Infinity) - (b[f.sortBy] ?? Infinity)) * dir);
    }
    return { listings: listings.slice(0, f.limit).map(toPublic), debug };
  }

  async function vocabulary() {
    const vocab = await loadVocabulary();
    return Object.fromEntries(Object.entries(vocab).map(([k, list]) => [NAMES[k] ?? k, list.map((x) => x.name).sort()]));
  }

  return { schema, supportedFilters, sortFields, search: async (f) => (await searchWithDebug(f)).listings, searchWithDebug, vocabulary };
}
