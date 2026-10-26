import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "../testkit/helpers.mjs";
import { createRestRepo } from "../src/connectors/restRepo.js";
import { sanitizeFilters } from "../src/data/filters.js";

const ITEMS = [
  { id: 1, name: "Toyota Camry", cents: 1790000, desc: "<p>Əla <b>vəziyyətdə</b></p>" },
  { id: 2, name: "BMW 520", cents: 1680000, desc: "Təmiz" },
  { id: 3, name: "Kia Optima", cents: 1550000, desc: "Qara" },
];
let server, base, last;
before(async () => {
  server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      last = { method: req.method, url: req.url, body: b };
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/graphql")) {
        const j = JSON.parse(b);
        if (j.variables?.boom) return res.end(JSON.stringify({ errors: [{ message: "bad var" }] }));
        return res.end(JSON.stringify({ data: { ads: { nodes: ITEMS } } }));
      }
      res.end(JSON.stringify({ items: ITEMS })); // text parametrini görməzdən gəlir
    });
  }).listen(0);
  await new Promise((r) => server.on("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const fields = { id: "id", title: { path: "name", stripHtml: true }, price: { path: "cents", divide: 100 }, attributes: { Təsvir: { path: "desc", stripHtml: true } } };
const tenant = (source) => ({ tenantId: "t", source: { type: "rest", baseUrl: base, response: { itemsPath: "items", fields }, ...source } });
const textFilter = { q: { type: "text", description: "Açar sözlər", param: "q" } };

test("localText: API mətn filtrini bilmirsə açar sözlər lokal yoxlanır (hərf fərqi nəzərə alınmır, hamısı uyğun olmalıdır)", async () => {
  const repo = createRestRepo(tenant({ search: { path: "/ads" }, filters: textFilter, localText: true }));
  const S = (f) => sanitizeFilters(f, { maxResults: 10, schema: repo.schema });
  assert.deepEqual((await repo.search(S({ q: "camry" }))).map((l) => l.id), ["1"]);
  assert.deepEqual((await repo.search(S({ q: "eLa vezi" }))).map((l) => l.id), ["1"]); // təsvirdə (attributes)
  assert.deepEqual(await repo.search(S({ q: "camry bmw" })), []);
  assert.equal((await repo.search(S({}))).length, 3);
});
test("localText söndürülüdürsə (default) lokal filtr işləmir", async () => {
  const repo = createRestRepo(tenant({ search: { path: "/ads" }, filters: textFilter }));
  assert.equal((await repo.search(sanitizeFilters({ q: "camry" }, { schema: repo.schema }))).length, 3);
});
test("qiymət cent → AZN, HTML təmizlənir", async () => {
  const repo = createRestRepo(tenant({ search: { path: "/ads" } }));
  const r = await repo.search(sanitizeFilters({}, {}));
  assert.equal(r.find((l) => l.id === "1").price, 17900);
  assert.equal(r.find((l) => l.id === "1").attributes["Təsvir"], "Əla vəziyyətdə");
});
test("GraphQL: POST, filtrlər variables daxilində, cavab data.ads.nodes-dən oxunur", async () => {
  const repo = createRestRepo(tenant({
    search: { path: "/graphql", graphql: "query($q:String){ ads(q:$q){ nodes{ id name } } }" },
    response: { itemsPath: "data.ads.nodes", fields },
    filters: textFilter,
  }));
  const r = await repo.search(sanitizeFilters({ q: "kia" }, { schema: repo.schema }));
  assert.equal(r.length, 3);
  const sent = JSON.parse(last.body);
  assert.equal(last.method, "POST");
  assert.match(sent.query, /ads\(q:\$q\)/);
  assert.deepEqual(sent.variables, { q: "kia" });
});
test("GraphQL xətası aydın mesajla qaytarılır", async () => {
  const repo = createRestRepo(tenant({
    search: { path: "/graphql", graphql: "query($boom:Int){ ads{ nodes{id} } }" },
    response: { itemsPath: "data.ads.nodes", fields },
    filters: { boom: { type: "number", description: "Test", param: "boom" } },
  }));
  await assert.rejects(repo.search(sanitizeFilters({ boom: 1 }, { schema: repo.schema })), /GraphQL xətası: bad var/);
});
