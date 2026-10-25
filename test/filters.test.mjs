import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { compileSchema, sanitizeFilters, MAX_FILTERS } from "../src/data/filters.js";
import { startMock, demoTenant } from "../testkit/helpers.mjs";
import { createRestRepo } from "../src/connectors/restRepo.js";

const ok = (f) => { const s = compileSchema(f); assert.ok(!s.error, s.error); return s; };
const bad = (f, re) => assert.match(compileSchema(f).error ?? "", re);

test("köhnə hazır adlar type olmadan işləyir, mətn təsviri hazırdır", () => {
  const s = ok({ make: { param: "b" }, maxPrice: { param: "p" } });
  assert.deepEqual(s.args.map((a) => [a.name, a.kind]), [["make", "string"], ["maxPrice", "number"]]);
  assert.ok(s.args[0].description);
});
test("yeni ad üçün type və description məcburidir", () => {
  bad({ color: { param: "c" } }, /type tələb/);
  bad({ color: { type: "string", param: "c" } }, /description tələb/);
  bad({ color: { type: "xyz", param: "c", description: "Rəng" } }, /dəstəklənmir/);
});
test("təhlükəli ad və param rədd edilir", () => {
  bad({ "__proto__x": { type: "string", param: "c", description: "Rəng" } }, /filtr adı/);
  bad({ "a b": { type: "string", param: "c", description: "Rəng" } }, /filtr adı/);
  bad({ sortBy: { type: "string", param: "c", description: "Rəng" } }, /ayrılmış/);
  bad({ color: { type: "string", param: "c&admin=1", description: "Rəng" } }, /param/);
  bad({ color: { type: "string", param: "../x", description: "Rəng" } }, /param/);
});
test("range iki arqumentə açılır, tək tərəfli də olar", () => {
  assert.deepEqual(ok({ cc: { type: "range", description: "Həcm", minParam: "a", maxParam: "b" } }).args.map((a) => a.name), ["ccMin", "ccMax"]);
  assert.deepEqual(ok({ cc: { type: "range", description: "Həcm", maxParam: "b" } }).args.map((a) => a.name), ["ccMax"]);
  bad({ cc: { type: "range", description: "Həcm" } }, /minParam/);
});
test("filtr sayı məhduddur", () => {
  const many = Object.fromEntries(Array.from({ length: MAX_FILTERS + 1 }, (_, i) => [`f${i}`, { type: "string", description: "Sahə", param: `p${i}` }]));
  bad(many, /Ən çox/);
});
test("sanitize: tiplər, enum, boolean, multi, naməlum açarlar", () => {
  const s = ok({
    color: { type: "string", description: "Rəng", param: "c", values: ["Qara", "Ağ"] },
    warranty: { type: "boolean", description: "Zəmanət", param: "w" },
    tags: { type: "multi", description: "Etiket", param: "t", values: ["a", "b"] },
    cc: { type: "range", description: "Həcm", minParam: "x", maxParam: "y" },
  });
  const f = sanitizeFilters({ color: "qara", warranty: "true", tags: ["A", "zzz", "b"], ccMin: "1600", ccMax: "abc", hack: 1, make: "BMW" }, { schema: s });
  assert.deepEqual(f, { color: "Qara", warranty: true, tags: ["a", "b"], ccMin: 1600, sortBy: "price", sortDir: "asc", limit: 10 });
  assert.equal(sanitizeFilters({ color: "Yaşıl" }, { schema: s }).color, undefined, "enum-da olmayan dəyər atılır");
  assert.equal(sanitizeFilters({ sortBy: "price" }, { schema: s }).sortBy, "price");
});

let mock;
before(async () => { mock = await startMock(); });
after(() => mock.server.close());

function tenant(filters, extra = {}) {
  const t = demoTenant(mock.url);
  t.source.filters = filters;
  Object.assign(t.source, extra);
  return t;
}
const run = async (t, raw) => { const repo = createRestRepo(t); return repo.search(sanitizeFilters(raw, { maxResults: 20, schema: repo.schema })); };

test("müştəri filtrləri API-yə çatır: string+enum, range, boolean, multi", async () => {
  const t = tenant({
    color: { type: "string", description: "Rəng", param: "color", values: ["Qara", "Ağ", "Boz"] },
    colors: { type: "multi", description: "Rənglər", param: "colors", values: ["Qara", "Ağ", "Boz"] },
    cc: { type: "range", description: "Mühərrik həcmi (sm³)", minParam: "cc_from", maxParam: "cc_to" },
    photo: { type: "boolean", description: "Şəkli var", param: "has_photo", valueMap: { true: "1", false: "0" } },
  }, { vocabulary: undefined });
  t.source.response.fields.attributes = { "Rəng": "color.title" };
  const a = await run(t, { color: "qara" });
  assert.ok(a.length >= 3 && a.every((l) => l.attributes["Rəng"] === "Qara"));
  const b = await run(t, { colors: ["Qara", "Boz"] });
  assert.deepEqual([...new Set(b.map((l) => l.attributes["Rəng"]))].sort(), ["Boz", "Qara"]);
  const c = await run(t, { ccMin: 2000, ccMax: 2500 });
  assert.ok(c.length >= 3 && c.length < 10);
  const d = await run(t, { photo: false });
  assert.deepEqual(d.map((l) => l.id), ["109"].filter(() => true));
});
test("sxemdə olmayan açar sorğuya düşmür (maxPrice elan edilməyib)", async () => {
  const t = tenant({ color: { type: "string", description: "Rəng", param: "color" } }, { vocabulary: undefined });
  const repo = createRestRepo(t);
  const r = await repo.searchWithDebug(sanitizeFilters({ maxPrice: 1, color: "Qara" }, { schema: repo.schema }));
  assert.ok(!/price_to/.test(r.debug.request));
  assert.match(r.debug.request, /color=/);
});
test("vocabulary multi: adlar ID-yə çevrilir, tapılmayan atılır, heç biri yoxdursa nəticə yoxdur", async () => {
  const t = tenant({ make: { type: "multi", description: "Markalar", param: "brand_id", valueFrom: "vocabulary" } });
  const repo = createRestRepo(t);
  const S = (f) => sanitizeFilters(f, { maxResults: 20, schema: repo.schema });
  const one = await repo.search(S({ make: ["BMW", "Tesla"] }));
  assert.ok(one.length >= 3 && one.every((l) => l.make === "BMW"));
  const two = await repo.searchWithDebug(S({ make: ["BMW", "Kia"] }));
  assert.match(two.debug.request, /brand_id=1%2C5/);
  assert.deepEqual(await repo.search(S({ make: ["Tesla"] })), []);
});

test("müştəri API-si qiymət parametrini nəzərə almasa da qiymət yoxlanılır", async () => {
  const t = tenant({ maxPrice: { param: "bele_parametr_yoxdur" }, minPrice: { param: "bele_parametr_yoxdur2" } }, { vocabulary: undefined });
  const repo = createRestRepo(t);
  const S = (f) => sanitizeFilters(f, { maxResults: 20, schema: repo.schema });
  const all = await repo.search(S({}));
  assert.ok(all.some((l) => l.price > 10000), "API filtrləmir, hamısı qayıdır");
  const r = await repo.searchWithDebug(S({ maxPrice: 10000, minPrice: 9000 }));
  assert.ok(r.listings.length >= 1 && r.listings.every((l) => l.price <= 10000 && l.price >= 9000));
  assert.match(r.debug.note, /atıldı/);
});

test("text filtri: sərbəst mətn qəbul edilir (təmizlənir, 100 simvola kəsilir), yalnız biri ola bilər, siyahı/çevirmə qadağandır", async () => {
  const { compileSchema, sanitizeFilters } = await import("../src/data/filters.js");
  const ok = compileSchema({ search: { type: "text", description: "Açar sözlər", param: "q" } });
  assert.equal(ok.error, undefined);
  const f = sanitizeFilters({ search: "  su\nkeçirməyən   " + "x".repeat(200) }, { schema: ok });
  assert.ok(f.search.startsWith("su keçirməyən xxx") && f.search.length === 100);
  assert.equal(sanitizeFilters({ search: 5 }, { schema: ok }).search, undefined);
  assert.match(compileSchema({ a: { type: "text", description: "bir", param: "q" }, b: { type: "text", description: "iki", param: "r" } }).error, /yalnız bir/);
  assert.match(compileSchema({ a: { type: "text", description: "bir", param: "q", values: ["x"] } }).error, /values/);
});

test("strict: hər filtrdə type və description məcburidir; köhnə qısa yazılış yalnız saxlanmış müştərilər üçün işləyir və tam formaya çevrilir", async () => {
  const { compileSchema, expandLegacyFilters } = await import("../src/data/filters.js");
  assert.match(compileSchema({ maxPrice: { param: "p" } }, [], { strict: true }).error, /type yazılmayıb/);
  assert.match(compileSchema({ maxPrice: { type: "number", param: "p" } }, [], { strict: true }).error, /description yazılmayıb/);
  assert.equal(compileSchema({ maxPrice: { type: "number", description: "Maksimum qiymət", param: "p" } }, [], { strict: true }).error, undefined);
  assert.equal(compileSchema({ maxPrice: { param: "p" } }).error, undefined, "köhnə rejim pozulmur");
  const full = expandLegacyFilters({ maxPrice: { param: "p" }, make: { param: "b", valueFrom: "vocabulary" }, limit: { param: "n" }, color: { type: "string", description: "Rəng", param: "c" } });
  assert.deepEqual(full.maxPrice, { type: "number", description: "Maksimum qiymət", param: "p" });
  assert.equal(full.make.type, "string");
  assert.deepEqual(full.limit, { param: "n" });
  delete full.limit;
  assert.equal(compileSchema(full, [], { strict: true }).error, undefined, "tam formaya çevrilmiş filtrlər strict-dən keçir");
});
