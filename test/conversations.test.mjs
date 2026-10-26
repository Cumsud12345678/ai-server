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
