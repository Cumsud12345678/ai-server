import test from "node:test";
import assert from "node:assert/strict";
import { compileSchema } from "../src/data/filters.js";
import { runTool, buildToolDeclaration } from "../src/ai/searchTool.js";

test("runTool: konnektor xətası AI-a aydın mesaj kimi qayıdır, çökmür", async () => {
  const repo = { search: async () => { throw Object.assign(new Error("boom"), { code: "TIMEOUT" }); } };
  const ctx = { listings: [] };
  const r = await runTool(repo, { tenantId: "t" }, "search_listings", { maxPrice: 1 }, ctx);
  assert.match(r.error, /əlçatan deyil/);
  assert.deepEqual(ctx.listings, []);
});
test("runTool: nəticələr ctx.listings-ə yığılır, naməlum alət rədd edilir", async () => {
  const repo = { search: async () => [{ id: "1" }, { id: "2" }] };
  const ctx = { listings: [] };
  const r = await runTool(repo, { tenantId: "t", profile: { maxResults: 5 } }, "search_listings", {}, ctx);
  assert.equal(r.count, 2);
  assert.equal(ctx.listings.length, 2);
  assert.ok((await runTool(repo, { tenantId: "t" }, "drop_table", {}, ctx)).error);
});
test("buildToolDeclaration: sıralama yalnız dəstəklənəndə", () => {
  const a = buildToolDeclaration({ args: [{ name: "make", kind: "string", description: "Marka" }, { name: "maxPrice", kind: "number", description: "Max" }], sortFields: [] });
  assert.deepEqual(Object.keys(a.parameters.properties), ["make", "maxPrice"]);
  const b = buildToolDeclaration({ args: [], sortFields: ["price"] });
  assert.deepEqual(b.parameters.properties.sortBy.enum, ["price"]);
});
test("buildToolDeclaration: müştəri tipləri (enum, boolean, multi, range)", () => {
  const { schema } = (() => {
    const s = compileSchema({
      color: { type: "string", description: "Rəng", param: "color", values: ["Qara", "Ağ"] },
      warranty: { type: "boolean", description: "Zəmanəti var", param: "w" },
      tags: { type: "multi", description: "Etiketlər", param: "t", values: ["a", "b"] },
      cc: { type: "range", description: "Mühərrik həcmi", minParam: "cc_from", maxParam: "cc_to" },
    });
    return { schema: s };
  })();
  const p = buildToolDeclaration(schema).parameters.properties;
  assert.deepEqual(Object.keys(p), ["color", "warranty", "tags", "ccMin", "ccMax"]);
  assert.deepEqual(p.color.enum, ["Qara", "Ağ"]);
  assert.equal(p.warranty.type, "BOOLEAN");
  assert.equal(p.tags.type, "ARRAY");
  assert.deepEqual(p.tags.items.enum, ["a", "b"]);
  assert.equal(p.ccMin.type, "NUMBER");
});
test("runTool: sxemdə olmayan açar müştəri API-sinə çatmır", async () => {
  const schema = compileSchema({ color: { type: "string", description: "Rəng", param: "color" } });
  let seen;
  const repo = { schema, search: async (f) => { seen = f; return []; } };
  await runTool(repo, { tenantId: "t" }, "search_listings", { color: "Qara", maxPrice: 5, admin: "1", __proto__: { x: 1 } }, { listings: [] });
  assert.equal(seen.color, "Qara");
  assert.ok(!("maxPrice" in seen) && !("admin" in seen));
});
