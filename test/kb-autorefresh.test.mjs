import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { tmpFile } from "../testkit/helpers.mjs";

let ingest, store, auto, site, siteUrl, embedCalls = 0, body = "Çatdırılma Bakı daxilində 3 iş günü çəkir və 100 AZN-dən yuxarı pulsuzdur. Ödəniş kartla və ya nağd mümkündür.", down = false;
const tenant = { tenantId: "auto-t", language: "az", profile: { mode: "support", businessName: "A" }, limits: {} };
const fakeGemini = { models: { embedContent: async ({ contents }) => { embedCalls++; return { embeddings: contents.map(() => ({ values: [1, 0, 0] })) }; } } };

before(async () => {
  process.env.KB_FILE = tmpFile("kb.json", "{}");
  process.env.ALLOW_LOCAL_CONNECTORS = "1";
  const { useGeminiClient } = await import("../src/kb/client.js");
  useGeminiClient(fakeGemini);
  ingest = await import("../src/kb/ingest.js");
  store = await import("../src/kb/store.js");
  auto = await import("../src/kb/autorefresh.js");
  site = http.createServer((req, res) => {
    if (req.url === "/robots.txt") { res.statusCode = 404; return res.end(); }
    if (down) { res.statusCode = 500; return res.end("x"); }
    res.setHeader("content-type", "text/html");
    res.end(`<html><head><title>FAQ</title></head><body><main><h1>FAQ</h1><p>${body}</p></main></body></html>`);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  siteUrl = `http://127.0.0.1:${site.address().port}/faq`;
});
after(() => site.close());

const only = async () => (await store.listSources(tenant.tenantId))[0];

test("dueSources: yalnız hazır sayt mənbələri və intervalı keçənlər; off = heç biri", () => {
  const old = new Date(Date.now() - 8 * 86400_000).toISOString(), fresh = new Date().toISOString();
  const src = [
    { _id: "1", type: "site", status: "ready", lastIndexedAt: old, createdAt: old },
    { _id: "2", type: "url", status: "ready", lastIndexedAt: fresh, createdAt: old },
    { _id: "3", type: "file", status: "ready", lastIndexedAt: old, createdAt: old },
    { _id: "4", type: "url", status: "processing", lastIndexedAt: old, createdAt: old },
    { _id: "5", type: "url", status: "ready", lastIndexedAt: old, lastRefreshAt: fresh, createdAt: old },
  ];
  assert.deepEqual(auto.dueSources(src, auto.INTERVALS.weekly).map((s) => s._id), ["1"]);
  assert.deepEqual(auto.dueSources(src, 0), []);
  assert.equal(auto.intervalOf({ profile: {} }), auto.INTERVALS.weekly);
  assert.equal(auto.intervalOf({ profile: { kbAutoRefresh: "daily" } }), auto.INTERVALS.daily);
  assert.equal(auto.intervalOf({ profile: { kbAutoRefresh: "off" } }), 0);
});

test("avto-yenilənmə: dəyişməyibsə vektorlaşdırma yoxdur; dəyişibsə yenidən oxunur; sayt düşübsə köhnə hissələr qalır", async () => {
  await ingest.ingestUrl(tenant, { url: siteUrl });
  await ingest.idle();
  let s = await only();
  assert.equal(s.status, "ready"); assert.ok(s.chunks > 0);
  const firstIndexed = s.lastIndexedAt;

  embedCalls = 0;
  await (await ingest.refreshSource(tenant, s._id, { auto: true }), ingest.idle());
  s = await only();
  assert.equal(embedCalls, 0, "məzmun eyni: embedding çağırılmamalıdır");
  assert.equal(s.unchanged, true); assert.equal(s.lastIndexedAt, firstIndexed); assert.ok(s.lastRefreshAt);

  body = "Çatdırılma indi Bakı daxilində 1 iş günü çəkir. Yeni qayda 2027-ci ildən qüvvədədir və bütün sifarişlərə aiddir.";
  await ingest.refreshSource(tenant, s._id, { auto: true }); await ingest.idle();
  s = await only();
  assert.ok(embedCalls > 0); assert.equal(s.unchanged, false); assert.equal(s.status, "ready");
  assert.ok((await store.listChunks(tenant.tenantId)).some((c) => /1 iş günü/.test(c.text)));

  down = true; store.resetKbMemory?.();
  const chunksBefore = s.chunks;
  await ingest.refreshSource(tenant, s._id, { auto: true }); await ingest.idle();
  s = await only();
  assert.equal(s.status, "ready", "sayt düşsə də bot sınmamalıdır"); assert.ok(s.refreshError); assert.equal(s.chunks, chunksBefore);
  down = false;
});

test("planlaşdırıcı: vaxtı çatmış mənbə yenilənir; təzə, söndürülmüş və elan rejimli müştərilərə toxunulmur", async () => {
  const s = await only();
  const day = 86400_000, ago = (n) => new Date(Date.now() - n * day).toISOString();
  await store.putSource({ ...s, lastIndexedAt: ago(3), lastRefreshAt: ago(3), createdAt: ago(9) });
  const calls = [];
  const refresh = async (t, id, o) => { calls.push([t.tenantId, id, o.auto]); };
  const t = (id, profile) => ({ ...tenant, tenantId: id, profile });
  // eyni mənbələr bu tenant üçündür: yalnız tenant.tenantId = "auto-t" üçün mənbə var
  const n = await auto.autoRefreshTick({ gapMs: 0, refresh, tenants: [t("auto-t", { mode: "support", kbAutoRefresh: "weekly" })] });
  assert.equal(n, 0, "3 gün həftəlik üçün tezdir"); assert.equal(calls.length, 0);
  assert.equal(await auto.autoRefreshTick({ gapMs: 0, refresh, tenants: [t("auto-t", { mode: "support", kbAutoRefresh: "daily" })] }), 1);
  assert.deepEqual(calls, [["auto-t", s._id, true]]);
  assert.equal(await auto.autoRefreshTick({ gapMs: 0, refresh, tenants: [t("auto-t", { mode: "support", kbAutoRefresh: "off" })] }), 0);
  assert.equal(await auto.autoRefreshTick({ gapMs: 0, refresh, tenants: [t("auto-t", { mode: "listings", kbAutoRefresh: "daily" })] }), 0);
  assert.equal(calls.length, 1);
});
