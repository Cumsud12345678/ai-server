import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startMock, tmpFile } from "../testkit/helpers.mjs";
import { parseFeed, columnsOf } from "../src/connectors/feedParse.js";
import { autoMap } from "../src/connectors/feedMap.js";
import { looseNumber } from "../src/connectors/mapper.js";
import { createFeedRepo } from "../src/connectors/feedRepo.js";

const CSV = "Məhsul adı;Qiymət;Marka;Şəkil;Rəng;Link;Kateqoriya\nQırmızı çanta;45,5 AZN;Zara;http://x/1.jpg;qırmızı;http://x/1;Çanta\nQara ayaqqabı;120 AZN;Nike;http://x/2.jpg;qara;http://x/2;Ayaqqabı\n\"Mavi, uzun köynək\";30 AZN;Zara;http://x/3.jpg;mavi;http://x/3;Geyim\n";
const XML = `<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel><title>Mağaza</title>
<item><g:id>A1</g:id><title>Divan</title><g:price>999.00 AZN</g:price><link>http://s/a1</link><g:image_link>http://s/a1.jpg</g:image_link><g:brand>Ikea</g:brand></item>
<item><g:id>A2</g:id><title><![CDATA[Stol & stul]]></title><g:price>250.00 AZN</g:price><link>http://s/a2</link><g:brand>Ikea</g:brand></item></channel></rss>`;
const JSON_FEED = JSON.stringify({ meta: { v: 1 }, data: { elanlar: [
  { nomre: 11, basliq: "BMW 520", qiymet: 20000, valyuta: "AZN", marka: "BMW", model: "520", il: 2015, seher: "Bakı", yurus: "150 000 km", sekil: "http://c/1.jpg", link: "http://c/1" },
  { nomre: 12, basliq: "Kia Rio", qiymet: 9000, valyuta: "AZN", marka: "Kia", model: "Rio", il: 2018, seher: "Gəncə", yurus: "80 000 km", link: "http://c/2" },
] } });

test("loose number: valyuta işarəsi, boşluq, vergül/nöqtə variantları", () => {
  assert.deepEqual(["1 200,50 AZN", "₼1.200,50", "12.5 USD", "1,250", "abc", "150 000 km"].map(looseNumber), [1200.5, 1200.5, 12.5, 1250, null, 150000]);
});

test("CSV: ; ayırıcı aşkarlanır, dırnaqlı vergül, BOM; JSON: massiv yolu avtomatik; XML: namespace atılır, CDATA", () => {
  const c = parseFeed("﻿" + CSV);
  assert.equal(c.format, "csv"); assert.equal(c.items.length, 3);
  assert.equal(c.items[2]["Məhsul adı"], "Mavi, uzun köynək");
  const j = parseFeed(JSON_FEED);
  assert.equal(j.itemsPath, "data.elanlar"); assert.equal(j.items.length, 2);
  const x = parseFeed(XML);
  assert.equal(x.itemsPath, "item"); assert.equal(x.items[1].title, "Stol & stul"); assert.equal(x.items[0].price, "999.00 AZN");
  assert.throws(() => parseFeed("a;b\n"), /başlıq/);
  assert.throws(() => parseFeed("{bad"), /JSON/);
  assert.throws(() => parseFeed("   "), /boş/);
  assert.ok(columnsOf(x.items).some((col) => col.path === "brand"));
});

test("autoMap: Azərbaycanca, Merchant və JSON sütunları tanınır; id yoxdursa link", () => {
  const a = autoMap(parseFeed(CSV).items);
  assert.equal(a.fields.title, "Məhsul adı"); assert.equal(a.fields.price.path, "Qiymət"); assert.equal(a.fields.make, "Marka");
  assert.equal(a.fields.image, "Şəkil"); assert.equal(a.fields.id, "{Link}"); assert.equal(a.defaults.currency, "AZN");
  assert.equal(a.fields.bodyType, "Kateqoriya"); assert.equal(a.fields.attributes["Rəng"], "Rəng");
  const m = autoMap(parseFeed(XML).items);
  assert.equal(m.fields.id, "id"); assert.equal(m.fields.image, "image_link"); assert.equal(m.fields.make, "brand");
  const j = autoMap(parseFeed(JSON_FEED).items);
  assert.equal(j.fields.id, "nomre"); assert.equal(j.fields.city, "seher"); assert.equal(j.fields.mileage.path, "yurus"); assert.equal(j.fields.year.path, "il");
});

test("feedRepo: filtr, mətn axtarışı (diakritiksiz), sıralama, lüğət, sxem", async () => {
  const items = parseFeed(CSV).items;
  const a = autoMap(items);
  const repo = createFeedRepo({ source: { response: { fields: a.fields, defaults: a.defaults } } }, items);
  assert.deepEqual(repo.supportedFilters.sort(), ["bodyType", "make", "maxPrice", "minPrice", "q", "sortBy", "sortDir"]);
  const q = await repo.search({ q: "qirmizi", limit: 5, sortBy: "price", sortDir: "asc" });
  assert.deepEqual(q.map((l) => l.title), ["Qırmızı çanta"]);
  assert.equal(q[0].price, 45.5); assert.equal(q[0].currency, "AZN");
  const zara = await repo.search({ make: "zara", maxPrice: 40, limit: 5, sortBy: "price", sortDir: "asc" });
  assert.deepEqual(zara.map((l) => l.title), ["Mavi, uzun köynək"]);
  const sorted = await repo.search({ limit: 5, sortBy: "price", sortDir: "desc" });
  assert.deepEqual(sorted.map((l) => l.price), [120, 45.5, 30]);
  assert.deepEqual((await repo.vocabulary()).makes, ["Nike", "Zara"]);
  assert.throws(() => createFeedRepo({ source: {} }, items), /xəritələmə/);
});

const TOKEN = "feed-test-token";
const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
let mock, server, base, feedSrv, feedUrl, feedBody = CSV;
const call = (m, p, b) => fetch(`${base}${p}`, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) });

before(async () => {
  mock = await startMock();
  process.env.SERVICE_TOKEN = TOKEN;
  process.env.ALLOW_LOCAL_CONNECTORS = "1";
  process.env.TENANT_SECRET_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.CUSTOMER_TENANTS_FILE = tmpFile("customer-tenants.json", "[]");
  process.env.USAGE_FILE = tmpFile("usage.json", "{}");
  process.env.BILLING_FILE = tmpFile("billing.json", "{}");
  process.env.FEED_FILE = tmpFile("feeds.json", "{}");
  feedSrv = await new Promise((res) => { const s = http.createServer((req, r) => { r.setHeader("content-type", "text/csv"); r.end(feedBody); }).listen(0, () => res(s)); });
  feedUrl = `http://localhost:${feedSrv.address().port}/feed.csv`;
  const { createApp } = await import("../src/app.js");
  server = await new Promise((res) => { const s = createApp({}).listen(0, () => res(s)); });
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); feedSrv.close(); mock.server.close(); });

test("preview: sütunlar, təklif olunan xəritələmə və nümunə elanlar qayıdır, heç nə saxlanmır", async () => {
  const r = await call("POST", "/v1/service/feed/preview", { feedText: CSV });
  const b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b));
  assert.equal(b.count, 3); assert.equal(b.format, "csv");
  assert.equal(b.suggestion.fields.title, "Məhsul adı");
  assert.equal(b.sample[0].title, "Qırmızı çanta");
  assert.ok(b.columns.some((c) => c.path === "Rəng"));
  const bad = await call("POST", "/v1/service/feed/preview", { feedText: "a;b\n" });
  assert.equal(bad.status, 422);
  const none = await call("POST", "/v1/service/feed/preview", {});
  assert.equal(none.status, 422); assert.equal((await none.json()).code, "NO_FEED");
});

let tenantId;
test("tenant yaradılır (yüklənmiş fayl), repo axtarır; sətirlər bazada, xəritələmə tenant-dadır", async () => {
  const a = autoMap(parseFeed(CSV).items);
  const r = await call("POST", "/v1/service/tenants", { businessName: "Mağaza", domain: "magaza.az", profile: { language: "az" }, source: { type: "feed", feed: { format: "csv" }, response: { fields: a.fields, defaults: a.defaults } }, feedText: CSV });
  const b = await r.json();
  assert.equal(r.status, 201, JSON.stringify(b));
  tenantId = b.tenantId;
  assert.equal(b.sampleCount, 3);
  const { getTenant } = await import("../src/tenants/tenantStore.js");
  const { getRepo } = await import("../src/data/repoFactory.js");
  const t = getTenant(tenantId);
  assert.equal(t.source.type, "feed"); assert.equal(t.source.feed.count, 3); assert.equal(t.source.feed.refreshHours, 0);
  const repo = await getRepo(t);
  assert.equal((await repo.search({ make: "Nike", limit: 5, sortBy: "price", sortDir: "asc" }))[0].title, "Qara ayaqqabı");
});

test("xəritələmə yenilənəndə fayl yenidən göndərilmir (saxlanmış sətirlər istifadə olunur)", async () => {
  const { getTenant } = await import("../src/tenants/tenantStore.js");
  const t = getTenant(tenantId);
  const fields = { ...t.source.response.fields, title: "Kateqoriya" };
  const r = await call("PUT", `/v1/service/tenants/${tenantId}/config`, { businessName: "Mağaza", domain: "magaza.az", profile: { language: "az" }, source: { type: "feed", feed: { format: "csv" }, response: { fields, defaults: t.source.response.defaults } } });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal((await r.json()).sampleListings[0].title, "Geyim");
});

test("refresh: yeni fayl yüklənir; xəritələməni pozan fayl rədd olunur, köhnə data və xəta qalır", async () => {
  const { getTenant } = await import("../src/tenants/tenantStore.js");
  const { getRepo } = await import("../src/data/repoFactory.js");
  // sütun adları dəyişdi (başlıq/ id tapılmır)
  const bad = await call("POST", `/v1/service/tenants/${tenantId}/feed/refresh`, { feedText: "x;y\n1;2\n" });
  assert.equal(bad.status, 422); assert.equal((await bad.json()).code, "MAPPING_FAILED");
  assert.ok(getTenant(tenantId).source.feed.lastError);
  assert.equal((await (await getRepo(getTenant(tenantId))).search({ limit: 9, sortBy: "price", sortDir: "asc" })).length, 3);
  const good = await call("POST", `/v1/service/tenants/${tenantId}/feed/refresh`, { feedText: CSV + "Yaşıl şal;15 AZN;Zara;http://x/4.jpg;yaşıl;http://x/4;Geyim\n" });
  assert.equal(good.status, 200); assert.equal((await good.json()).count, 4);
  const t = getTenant(tenantId);
  assert.equal(t.source.feed.lastError, undefined); assert.equal(t.source.feed.count, 4);
  assert.equal((await (await getRepo(t)).search({ limit: 9, sortBy: "price", sortDir: "asc" })).length, 4);
  const noFile = await call("POST", `/v1/service/tenants/${tenantId}/feed/refresh`, {});
  assert.equal(noFile.status, 400);
});

test("link feed: yaradılır, avto-yenilənmə vaxtı çatanda feed yenilənir; səhv link və böyük fayl rədd olunur", async () => {
  const a = autoMap(parseFeed(CSV).items);
  const src = { type: "feed", feed: { url: feedUrl, refreshHours: 6 }, response: { fields: a.fields, defaults: a.defaults } };
  const r = await call("POST", "/v1/service/tenants", { businessName: "Link", domain: "link.az", profile: { language: "az" }, source: src });
  const b = await r.json();
  assert.equal(r.status, 201, JSON.stringify(b));
  const { getTenant } = await import("../src/tenants/tenantStore.js");
  const { feedDue, feedRefreshTick } = await import("../src/connectors/feedService.js");
  const t = getTenant(b.tenantId);
  assert.equal(t.source.feed.refreshHours, 6); assert.equal(t.source.feed.count, 3);
  assert.equal(feedDue(t), false);
  assert.equal(feedDue(t, Date.now() + 7 * 3600_000), true);
  feedBody = CSV + "Yeni;5 AZN;Zara;;;http://x/9;Geyim\n";
  const n = await feedRefreshTick({ now: Date.now() + 7 * 3600_000, tenants: [t], gapMs: 0 });
  assert.equal(n, 1);
  assert.equal(getTenant(b.tenantId).source.feed.count, 4);
  feedBody = CSV;
  // https olmayan link (lokal icazə söndürülsə) və səhv link
  const bad = await call("POST", "/v1/service/feed/preview", { url: "ftp://x/y.csv" });
  assert.equal(bad.status, 400);
  const big = await call("POST", "/v1/service/feed/preview", { feedText: "a;b\n" + "x;y\n".repeat(1_400_000) });
  assert.equal(big.status, 422);
});

test("tenant silinəndə feed də silinir", async () => {
  const { getFeed } = await import("../src/connectors/feedStore.js");
  assert.ok(await getFeed(tenantId));
  assert.equal((await call("DELETE", `/v1/service/tenants/${tenantId}`)).status, 200);
  assert.equal(await getFeed(tenantId), null);
});

test("feed vəziyyəti endpoint-i", async () => {
  const a = autoMap(parseFeed(CSV).items);
  const r = await call("POST", "/v1/service/tenants", { businessName: "Vəz", domain: "vez.az", profile: { language: "az" }, source: { type: "feed", feed: {}, response: { fields: a.fields, defaults: a.defaults } }, feedText: CSV });
  const id = (await r.json()).tenantId;
  const st = await (await call("GET", `/v1/service/tenants/${id}/feed`)).json();
  assert.equal(st.enabled, true); assert.equal(st.feed.count, 3); assert.ok(st.feed.updatedAt);
});
