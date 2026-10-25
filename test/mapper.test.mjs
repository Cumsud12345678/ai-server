import test from "node:test";
import assert from "node:assert/strict";
import { getPath, renderTemplate, coerce, mapItem, slugify } from "../src/connectors/mapper.js";

test("getPath: iç-içə yol və massiv indeksi", () => {
  assert.equal(getPath({ a: { b: [{ c: 5 }] } }, "a.b[0].c"), 5);
  assert.equal(getPath({ a: null }, "a.b"), undefined);
});
test("renderTemplate: məcburi {x}, könüllü {x?}, çevirmə |slug", () => {
  const o = { brand: { title: "Land Rover" }, id: 7 };
  assert.equal(renderTemplate("{brand.title} {model.title?}", o), "Land Rover");
  assert.equal(renderTemplate("/elan/{brand.title|slug}-{id}", o), "/elan/land-rover-7");
  assert.equal(renderTemplate("https://x{photos[0].url}", o), null); // məcburi sahə yoxdur
});
test("coerce: mətn qiymət rəqəmə çevrilir", () => {
  assert.equal(coerce("12 500", "number"), 12500);
  assert.equal(coerce("12,5", "number"), 12.5);
  assert.equal(coerce("abc", "number"), null);
  assert.equal(coerce({ x: 1 }, "string"), null);
});
test("mapItem: lookup, default və attributes", () => {
  const item = { ad_id: 5, price: { value: "9 200" }, category: { code: "suv" }, color: { title: "Qara" } };
  const m = mapItem(item, {
    id: "ad_id", title: "{category.code}", price: "price.value",
    bodyType: { path: "category.code", lookup: "bodyType" }, attributes: { Rəng: "color.title", Yox: "nothing" },
  }, { defaults: { currency: "AZN" }, lookup: (k, id) => (k === "bodyType" && id === "suv" ? "SUV" : null) });
  assert.deepEqual([m.id, m.price, m.bodyType, m.currency], ["5", 9200, "SUV", "AZN"]);
  assert.deepEqual(m.attributes, { Rəng: "Qara" });
});
test("slugify: Azərbaycan hərfləri", () => assert.equal(slugify("Şəki Ə-Ö"), "seki-e-o"));
