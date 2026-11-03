// WooCommerce Store API şablonu (panelin "WooCommerce" düyməsinin yaratdığı konfiqurasiya) saxta mağaza ilə yoxlanır.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "../testkit/helpers.mjs"; // ALLOW_LOCAL_CONNECTORS=1
import { createRestRepo } from "../src/connectors/restRepo.js";
import { compileSchema, sanitizeFilters } from "../src/data/filters.js";

const PRODUCTS = [
  { id: 11, name: "Sony WH-1000XM5", permalink: "https://shop.test/p/sony", short_description: "<p>Səs-küy <b>ləğvi</b></p>", prices: { price: "59900", regular_price: "65000", currency_code: "AZN", currency_minor_unit: 2 }, images: [{ src: "https://shop.test/sony.jpg" }], categories: [{ id: 3, name: "Qulaqlıqlar" }], is_in_stock: true },
  { id: 12, name: "Aero Buds 3", permalink: "https://shop.test/p/aero", short_description: "", prices: { price: "12900", currency_code: "AZN", currency_minor_unit: 2 }, images: [], categories: [{ id: 3, name: "Qulaqlıqlar" }], is_in_stock: false },
];
let server, base, lastQuery;
before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("content-type", "application/json");
    if (u.pathname === "/wp-json/wc/store/v1/products/categories") return res.end(JSON.stringify([{ id: 3, name: "Qulaqlıqlar", slug: "qulaqliqlar" }, { id: 4, name: "Telefonlar", slug: "telefonlar" }]));
    if (u.pathname === "/wp-json/wc/store/v1/products") {
      lastQuery = Object.fromEntries(u.searchParams);
      const max = u.searchParams.get("max_price"), cat = u.searchParams.get("category");
      return res.end(JSON.stringify(PRODUCTS.filter((p) => (!max || Number(p.prices.price) <= Number(max)) && (!cat || p.categories.some((c) => String(c.id) === cat)))));
    }
    res.statusCode = 404; res.end("{}");
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** frontend/lib/presets/woocommerce.ts ilə eyni quruluş */
const wooSource = (baseUrl) => ({
  type: "rest", baseUrl, timeoutMs: 8000, cacheSeconds: 60, localSort: ["price"],
  search: { method: "GET", path: "/wp-json/wc/store/v1/products", limitParam: "per_page" },
  filters: {
    search: { type: "text", description: "Məhsulun adı və ya açar sözlər", param: "search" },
    minPrice: { type: "number", description: "Minimum qiymət", param: "min_price", multiply: 100 },
    maxPrice: { type: "number", description: "Maksimum qiymət", param: "max_price", multiply: 100 },
    category: { type: "string", description: "Kateqoriya", param: "category", valueFrom: "vocabulary" },
    onSale: { type: "boolean", description: "Yalnız endirimdə olan məhsullar", param: "on_sale", valueMap: { true: "true" } },
  },
  vocabulary: { lists: { category: { path: "/wp-json/wc/store/v1/products/categories?per_page=100", idField: "id", nameField: "name" } } },
  response: {
    itemsPath: ".",
    fields: {
      id: "id", title: "name", url: "permalink", image: "images[0].src", currency: "prices.currency_code",
      price: { path: "prices.price", divide: 100 },
      attributes: { "Kateqoriya": "categories[0].name", "Qısa təsvir": { path: "short_description", stripHtml: true }, "Stokda": { path: "is_in_stock", type: "boolean" } },
    },
  },
});

test("WooCommerce şablonu: qiymət filtri qəpiklə gedir, cavab manata çevrilir, kateqoriya adı ID-yə çevrilir", async () => {
  const src = wooSource(base);
  assert.equal(compileSchema(src.filters, [], { strict: true }).error, undefined, "konfiqurasiya yoxlamadan keçir");
  const repo = createRestRepo({ tenantId: "woo", source: src });
  const schema = compileSchema(src.filters, ["price"]);
  const r = await repo.search(sanitizeFilters({ maxPrice: 150, category: "qulaqlıqlar" }, { maxResults: 5, schema }));
  assert.equal(lastQuery.max_price, "15000", "150 AZN -> 15000 qəpik");
  assert.equal(lastQuery.category, "3");
  assert.equal(r.length, 1);
  assert.equal(r[0].title, "Aero Buds 3"); assert.equal(r[0].price, 129); assert.equal(r[0].currency, "AZN");
  const all = await repo.search(sanitizeFilters({}, { maxResults: 5, schema }));
  const sony = all.find((l) => l.title.startsWith("Sony"));
  assert.equal(sony.price, 599); assert.equal(sony.image, "https://shop.test/sony.jpg"); assert.equal(sony.url, "https://shop.test/p/sony");
  assert.equal(sony.attributes["Qısa təsvir"], "Səs-küy ləğvi");
});

test("multiply yalnız number/range üçündür və müsbət olmalıdır", () => {
  assert.match(compileSchema({ x: { type: "string", description: "Rəng", param: "c", multiply: 2 } }).error, /multiply/);
  assert.match(compileSchema({ x: { type: "number", description: "Qiymət", param: "p", multiply: -1 } }).error, /multiply/);
  assert.equal(compileSchema({ x: { type: "range", description: "Qiymət", minParam: "a", maxParam: "b", multiply: 100 } }).error, undefined);
});
