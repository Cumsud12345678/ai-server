import test from "node:test";
import assert from "node:assert/strict";
import { actionStats, recordAction } from "../src/actions/log.js";

test("actionStats: test statusu sayılmır, icra olunanlar açar üzrə bölünür", async () => {
  const t = "t-stats-" + Date.now();
  await recordAction(t, { key: "cancel_order", title: "x", status: "done" });
  await recordAction(t, { key: "cancel_order", title: "x", status: "done" });
  await recordAction(t, { key: "cancel_order", title: "x", status: "cancelled" });
  await recordAction(t, { key: "book", title: "y", status: "failed" });
  await recordAction(t, { key: "book", title: "y", status: "test" });
  const s = await actionStats(t, 30);
  assert.equal(s.done, 2);
  assert.deepEqual(s.byKey.cancel_order, { done: 2, cancelled: 1 });
  assert.deepEqual(s.byKey.book, { failed: 1 });
  assert.equal((await actionStats("boş", 30)).done, 0);
});
