// Sorğular siyahısı səhifələnir (kursor), statistika bütün sorğuları çəkmir.
import test from "node:test";
import assert from "node:assert/strict";
import { recordQuery, listQueries, queryStats, clearQueries } from "../src/queries/queries.js";
import { useStoreDb } from "../src/store/mongo.js";

const tenant = (id) => ({ tenantId: id, profile: {} });
async function seed(t, n) {
  for (let i = 0; i < n; i++) {
    await recordQuery(t, { message: i % 10 === 0 ? `elan yoxdur ${i}` : `sual ${i}`, results: i % 10 === 0 ? 0 : 2, tokens: 5, cached: i % 7 === 0, error: i % 25 === 1 });
    await new Promise((r) => setTimeout(r, 1));
  }
}
async function pageAll(id, opts = {}, size = 20) {
  const seen = []; let cursor; let pages = 0;
  do {
    const r = await listQueries(id, { ...opts, limit: size, before: cursor });
    assert.ok(r.queries.length <= size);
    seen.push(...r.queries); cursor = r.nextCursor; pages++;
    assert.equal(r.hasMore, Boolean(cursor));
  } while (cursor && pages < 50);
  return { seen, pages };
}

test("yaddaş rejimi: kursorla səhifələmə heç nəyi itirmir və təkrarlamır", async () => {
  const t = tenant("mem-1");
  await seed(t, 55);
  const { seen, pages } = await pageAll("mem-1");
  assert.equal(pages, 3);
  assert.equal(seen.length, 55);
  assert.equal(new Set(seen.map((x) => x.id)).size, 55);
  assert.ok(seen.every((x, i) => i === 0 || new Date(seen[i - 1].at) >= new Date(x.at)), "yenidən köhnəyə");
  const first = await listQueries("mem-1", { limit: 20 });
  assert.equal(first.queries.length, 20);
  assert.equal(first.hasMore, true);
});

test("yaddaş rejimi: filtr səhifələmə ilə işləyir (yalnız nəticəsizlər, axtarış)", async () => {
  const none = await pageAll("mem-1", { noResults: true }, 4);
  assert.ok(none.seen.length > 0 && none.seen.every((x) => x.results === 0));
  const q = await pageAll("mem-1", { q: "SUAL 1" }, 3);
  assert.ok(q.seen.length > 0 && q.seen.every((x) => /sual 1/i.test(x.message)));
  const s = await queryStats("mem-1", { days: 30 });
  assert.equal(s.total, 55);
  assert.ok(s.noResults >= 5 && s.top.length > 0);
});

// MongoDB rejimi: sürücünün istifadə etdiyimiz əməliyyatlarının sadə yaddaş nüsxəsi (find/sort/limit, countDocuments, aggregate)
function fakeDb() {
  const data = new Map();
  const get = (n) => data.get(n) ?? data.set(n, new Map()).get(n);
  const cmp = (a, b) => (a instanceof Date ? a.getTime() - b.getTime() : a < b ? -1 : a > b ? 1 : 0);
  const matches = (d, f) => Object.entries(f).every(([k, v]) => {
    if (k === "$and") return v.every((x) => matches(d, x));
    if (k === "$or") return v.some((x) => matches(d, x));
    const val = d[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      return Object.entries(v).every(([op, arg]) => (op === "$gte" ? cmp(val, arg) >= 0 : op === "$lt" ? cmp(val, arg) < 0 : op === "$ne" ? val !== arg
        : op === "$regex" ? new RegExp(arg, v.$options).test(val) : op === "$options" ? true : false));
    }
    return v instanceof Date ? val instanceof Date && val.getTime() === v.getTime() : val === v;
  });
  const collection = (name) => {
    const c = get(name);
    return {
      createIndex: async () => {},
      insertOne: async (doc) => { c.set(doc._id, structuredClone(doc)); },
      deleteMany: async (f) => { for (const [k, d] of c) if (matches(d, f)) c.delete(k); },
      find: (f = {}) => {
        let rows = [...c.values()].filter((d) => matches(d, f)).map((d) => structuredClone(d));
        const cur = {
          sort: (s) => { const [[k1, d1], [k2, d2] = []] = Object.entries(s); rows.sort((a, b) => d1 * cmp(a[k1], b[k1]) || (k2 ? d2 * cmp(a[k2], b[k2]) : 0)); return cur; },
          limit: (n) => { rows = rows.slice(0, n); return cur; },
          toArray: async () => rows,
        };
        return cur;
      },
      countDocuments: async (f = {}) => [...c.values()].filter((d) => matches(d, f)).length,
      aggregate: (pipe) => ({
        toArray: async () => {
          const rows = [...c.values()].filter((d) => matches(d, pipe[0].$match));
          const g = new Map();
          for (const d of rows) { const k = d.message.toLowerCase().replace(/^[ ?!.,;\n\t]+|[ ?!.,;\n\t]+$/g, ""); g.set(k, (g.get(k) ?? 0) + 1); }
          return [...g].filter(([k]) => k !== "").map(([_id, count]) => ({ _id, count })).sort((a, b) => b.count - a.count || (a._id < b._id ? -1 : 1)).slice(0, 10);
        },
      }),
    };
  };
  return { collection };
}

test("MongoDB rejimi: səhifələmə, filtrlər, bazada sayma və qruplama; eyni millisaniyədə yazılanlar itmir", async () => {
  useStoreDb(fakeDb());
  const t = tenant("mongo-1");
  await seed(t, 55);
  for (let i = 0; i < 5; i++) await recordQuery(t, { message: "eyni vaxt", results: 1, tokens: 1 }); // millisaniyə toqquşması ehtimalı
  const { seen, pages } = await pageAll("mongo-1");
  assert.equal(seen.length, 60);
  assert.equal(new Set(seen.map((x) => x.id)).size, 60, "təkrar yoxdur");
  assert.equal(pages, 3);

  const none = await pageAll("mongo-1", { noResults: true }, 4);
  assert.ok(none.seen.length >= 5 && none.seen.every((x) => x.results === 0 && !x.error));
  const q = await pageAll("mongo-1", { q: "yoxdur" }, 3);
  assert.ok(q.seen.length >= 5 && q.seen.every((x) => /yoxdur/.test(x.message)));
  const special = await listQueries("mongo-1", { q: "a.*(" });
  assert.equal(special.queries.length, 0, "regex simvolları mətn kimi axtarılır, xəta vermir");

  const s = await queryStats("mongo-1", { days: 30 });
  assert.equal(s.total, 60);
  assert.ok(s.noResults >= 5 && s.errors >= 1 && s.cached >= 1);
  assert.equal(s.top[0].message, "eyni vaxt");
  assert.equal(s.top[0].count, 5);
  assert.equal(s.truncated, false);

  const again = await queryStats("mongo-1", { days: 30 });
  assert.equal(again, s, "qısa müddət keşdən verilir (hər panel açılışı bazanı yükləməsin)");
  await clearQueries("mongo-1");
  assert.equal((await queryStats("mongo-1", { days: 30 })).total, 0, "silmədən sonra keş təmizlənir");
});
