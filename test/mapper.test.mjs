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

import { stripHtml, validateFieldSpecs } from "../src/connectors/mapper.js";
test("divide/multiply: sentlə gələn qiymət manata çevrilir", () => {
  const m = mapItem({ id: 1, t: "x", p: 1999900, q: "1 500" }, { id: "id", title: "t", price: { path: "p", divide: 100 }, mileage: { path: "q", multiply: 2 } });
  assert.equal(m.price, 19999);
  assert.equal(m.mileage, 3000);
  assert.equal(mapItem({ id: 1, t: "x", p: 1999 }, { id: "id", title: "t", price: { path: "p", divide: 100 } }).price, 19.99);
});
test("stripHtml: etiketlər, entity-lər, script/style təmizlənir", () => {
  assert.equal(stripHtml("<p>Əla&nbsp;vəziyyət</p><script>x()</script><br>Qiymət &amp; &#8364;5 &#x41;"), "Əla vəziyyət Qiymət & €5 A");
  assert.equal(mapItem({ id: 1, d: "<b>Qara</b> rəng" }, { id: "id", title: { path: "d", stripHtml: true } }).title, "Qara rəng");
  assert.equal(renderTemplate("{d|striphtml}", { d: "<i>a</i>" }), "a");
});
test("validateFieldSpecs: səhv divide/stripHtml rədd edilir", () => {
  assert.equal(validateFieldSpecs({ price: { path: "p", divide: 100 }, attributes: { A: { path: "a", stripHtml: true } } }), null);
  assert.match(validateFieldSpecs({ price: { path: "p", divide: 0 } }), /divide/);
  assert.match(validateFieldSpecs({ price: { path: "p", multiply: "2" } }), /multiply/);
  assert.match(validateFieldSpecs({ attributes: { A: { path: "a", stripHtml: "yes" } } }), /stripHtml/);
});
