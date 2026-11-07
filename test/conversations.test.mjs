// Söhbət tarixçəsi: eyni sid-li suallar qruplanır, cavab mətni (maskalanmış) oxunur, qeyd söndürülübsə heç nə yazılmır.
import test from "node:test";
import assert from "node:assert/strict";
import { recordQuery, listConversations, getConversation, queryStats, cleanSid } from "../src/queries/queries.js";

const T = (id, profile = {}) => ({ tenantId: id, profile });
const wait = () => new Promise((r) => setTimeout(r, 3));

test("sid-lər söhbətə qruplanır, ən yenisi birincidir, cavab oxunur", async () => {
  const t = T("conv-1");
  await recordQuery(t, { message: "salam", results: 1, sid: "aaaaaaaa11", answer: "Salam! Necə kömək edim?" }); await wait();
  await recordQuery(t, { message: "çatdırılma neçəyədir", results: 0, sid: "aaaaaaaa11", answer: "Bilmirəm, 055 123 45 67 ilə zəng edin" }); await wait();
  await recordQuery(t, { message: "başqa", results: 1, sid: "bbbbbbbb22", answer: "ok" }); await wait();
  await recordQuery(t, { message: "sidsiz", results: 1 });
  const l = await listConversations("conv-1");
  assert.equal(l.conversations.length, 2);
  assert.equal(l.conversations[0].sid, "bbbbbbbb22");
  const a = l.conversations.find((c) => c.sid === "aaaaaaaa11");
  assert.equal(a.messages, 2); assert.equal(a.unanswered, 1); assert.equal(a.first, "salam");
  const c = await getConversation("conv-1", "aaaaaaaa11");
  assert.deepEqual(c.messages.map((m) => m.message), ["salam", "çatdırılma neçəyədir"]);
  assert.match(c.messages[1].answer, /\[nömrə\]/); assert.doesNotMatch(c.messages[1].answer, /123 45/);
  assert.equal((await queryStats("conv-1")).conversations, 2);
  assert.equal(await getConversation("conv-2", "aaaaaaaa11"), null, "başqa müştərinin söhbəti görünmür");
});

test("yanlış sid qəbul edilmir, logQueries=false heç nə yazmır, səhifələmə", async () => {
  assert.equal(cleanSid("../x"), undefined); assert.equal(cleanSid("short"), undefined); assert.equal(cleanSid("abcdef123456"), "abcdef123456");
  await recordQuery(T("conv-off", { logQueries: false }), { message: "x", sid: "cccccccc33", answer: "y" });
  assert.equal((await listConversations("conv-off")).conversations.length, 0);
  const t = T("conv-page");
  for (let i = 0; i < 5; i++) { await recordQuery(t, { message: `m${i}`, results: 1, sid: `sid-page-${i}x` }); await wait(); }
  const p1 = await listConversations("conv-page", { limit: 2 });
  assert.equal(p1.conversations.length, 2); assert.ok(p1.hasMore);
  const p2 = await listConversations("conv-page", { limit: 10, before: p1.nextCursor });
  assert.equal(p2.conversations.length, 3);
});

test("söhbətdə göstərilən elanlar və təklif olunan əməliyyat saxlanır (şəxsi cavabda yox)", async () => {
  const t = { tenantId: "t-listings" };
  await recordQuery(t, { message: "honda", results: 1, sid: "bbbbbbbb22", answer: "Tapdım", listings: [{ id: 7, title: "Honda CBR", price: 9000, currency: "AZN", url: "https://moto.az/7", image: "javascript:alert(1)", extra: "x" }], confirm: { title: "Sifarişi ləğv et", summary: "A-1001 ləğv edilsin? Tel: +994501234567" } }); await wait();
  await recordQuery(t, { message: "sifarişim", results: -1, sid: "bbbbbbbb22", answer: "gizli", private: true, listings: [{ title: "x" }] });
  const c = await getConversation("t-listings", "bbbbbbbb22");
  assert.deepEqual(c.messages[0].listings, [{ id: "7", title: "Honda CBR", price: 9000, currency: "AZN", url: "https://moto.az/7" }]);
  assert.equal(c.messages[0].confirm.title, "Sifarişi ləğv et");
  assert.ok(!c.messages[0].confirm.summary.includes("501234567"), "telefon maskalanır");
  assert.equal(c.messages[1].listings, undefined);
});

test("elan kliki həmin elanı göstərən cavaba yazılır", async () => {
  const { recordClick } = await import("../src/queries/queries.js");
  const t = { tenantId: "t-clicks" };
  await recordQuery(t, { message: "honda", results: 1, sid: "dddddddd44", answer: "a", listings: [{ id: 5, title: "Honda" }] }); await wait();
  await recordQuery(t, { message: "başqa", results: 1, sid: "dddddddd44", answer: "b", listings: [{ id: 9, title: "Yamaha" }] });
  assert.equal(await recordClick("t-clicks", "dddddddd44", { id: "5", title: "Honda" }), true);
  const c = await getConversation("t-clicks", "dddddddd44");
  assert.equal(c.messages[0].clicks[0].id, "5");
  assert.equal(c.messages[1].clicks, undefined);
  assert.equal(await recordClick("t-clicks", "yoxyoxyoxyox", { id: "5" }), false);
});
