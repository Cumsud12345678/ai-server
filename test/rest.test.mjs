import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock, demoTenant } from "../testkit/helpers.mjs";
import { createRestRepo } from "../src/connectors/restRepo.js";
import { sanitizeFilters } from "../src/data/filters.js";

let mock, repo;
const S = (f) => sanitizeFilters(f, { maxResults: 5 });
before(async () => { mock = await startMock(); repo = createRestRepo(demoTenant(mock.url)); });
after(() => mock.server.close());

test("dəstəklənən filtrlər konfiqurasiyadan gəlir (fuelType yoxdur)", () => {
  assert.ok(repo.supportedFilters.includes("make"));
  assert.ok(repo.supportedFilters.includes("sortBy"));
  assert.ok(!repo.supportedFilters.includes("fuelType"));
});
test("qiymət filtri, qaralama atılır, telefon çıxmır", async () => {
  const r = await repo.search(S({ maxPrice: 10000 }));
  assert.ok(r.length >= 3);
  assert.ok(r.every((l) => l.price <= 10000));
  assert.ok(!r.some((l) => l.id === "111"), "draft elan çıxmamalıdır");
  assert.ok(!JSON.stringify(r).includes("994"), "telefon çıxmamalıdır");
});
test("marka adı → ID (vocabulary), kateqoriya kodu → ad (lookup)", async () => {
  const r = await repo.search(S({ make: "bmw" }));
  assert.deepEqual([...new Set(r.map((l) => l.make))], ["BMW"]);
  assert.equal(r.find((l) => l.id === "101").bodyType, "SUV");
  assert.equal(r.find((l) => l.id === "101").attributes["Rəng"], "Qara");
});
test("olmayan marka → boş nəticə", async () => assert.deepEqual(await repo.search(S({ make: "Tesla" })), []));
test("qiymət mətn kimi gəlsə də rəqəmə çevrilir", async () => {
  const r = await repo.search(S({ make: "Hyundai" }));
  assert.equal(r.find((l) => l.id === "107").price, 12500);
});
test("şəkil yoxdursa image null, model yoxdursa title yenə var", async () => {
  const all = await repo.search(sanitizeFilters({ limit: 20 }, { maxResults: 20 }));
  assert.equal(all.find((l) => l.id === "109").image, null);
  assert.equal(all.find((l) => l.id === "110").title, "Hyundai");
  assert.equal(all.find((l) => l.id === "101").url, "https://musteri.example/elan/bmw-x5-101");
});
test("sıralama və limit", async () => {
  const r = await repo.search(S({ sortBy: "price", sortDir: "desc" }));
  assert.equal(r.length, 5);
  assert.deepEqual(r.map((l) => l.price), [...r.map((l) => l.price)].sort((a, b) => b - a));
});
test("səhv müştəri açarı → aydın xəta", async () => {
  const t = demoTenant(mock.url);
  t.source.auth.valueEnv = "YOX_BELE_DEYISEN";
  await assert.rejects(createRestRepo(t).search(S({})), /konfiqurasiya edilməyib/);
});
test("müştəri 401 qaytarsa ConnectorError", async () => {
  process.env.DEMO_CUSTOMER_KEY = "yanlis";
  await assert.rejects(createRestRepo(demoTenant(mock.url)).search(S({})), /401/);
  process.env.DEMO_CUSTOMER_KEY = "test-secret";
});
test("timeout", async () => {
  const slow = await new Promise((res) => { const s = (async () => (await import("node:http")).createServer(() => {}).listen(0, function () { res(this); }))(); });
  const t = demoTenant(`http://localhost:${slow.address().port}`);
  t.source.timeoutMs = 200; t.source.vocabulary = undefined;
  t.source.filters = { maxPrice: { param: "price_to" } };
  await assert.rejects(createRestRepo(t).search(S({ maxPrice: 1 })), /vaxtında/);
  slow.close(); slow.closeAllConnections?.();
});
