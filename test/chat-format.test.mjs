// Söhbət formatı: kartlı kanalda qısa cavab, "bir dənə" istəyində yalnız seçilən kart, tarixçənin qısaldılma işarəsi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { advise, pickShown, hasCards } from "../src/ai/advisor.js";
import { clipTurn, historyContents } from "../src/ai/history.js";

test("[[SHOW:..]] yalnız seçilən elanları saxlayır, işarə mətndən silinir", () => {
  const ls = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(pickShown("Ən idealı B-dir.\n[[SHOW:b]]", ls), { text: "Ən idealı B-dir.", listings: [{ id: "b" }] });
  assert.equal(pickShown("x [[SHOW:yox]]", ls).listings.length, 3, "səhv id: hamısı göstərilir");
  assert.equal(pickShown("işarəsiz", ls).listings.length, 3);
});

test("tarixçə: kəsilən mesaj işarələnir, qısa mesaj dəyişmir", () => {
  assert.equal(clipTurn("salam", 700), "salam");
  assert.equal(clipTurn("a".repeat(800), 700), "a".repeat(700) + " […qısaldılıb]");
  const h = historyContents([{ role: "user", text: "1" }, { role: "model", text: "2" }, { role: "user", text: "3" }], 2, 700);
  assert.deepEqual(h.map((x) => x.role), ["model", "user"]);
});

test("kanal: vidjetdə kart, Telegram/WhatsApp-da mətn siyahısı təlimatı", async () => {
  assert.equal(hasCards("widget"), true); assert.equal(hasCards(null), true);
  assert.equal(hasCards("telegram"), false); assert.equal(hasCards("whatsapp"), false);
  const systems = [];
  const client = { models: { generateContent: async ({ config }) => { systems.push(config.systemInstruction); return { text: "ok", usageMetadata: { totalTokenCount: 1 } }; } } };
  const repo = { search: async () => [], vocabulary: async () => ({}) };
  const tenant = { tenantId: "fmt", profile: {}, language: "az" };
  await advise({ tenant, repo, message: "Tufan 1", channel: "widget" }, client);
  await advise({ tenant, repo, message: "Tufan 2", channel: "telegram" }, client);
  assert.match(systems[0], /KART şəklində/); assert.doesNotMatch(systems[0], /qısa bir sətirlə yaz/);
  assert.match(systems[1], /qısa bir sətirlə yaz/);
  assert.match(systems[0], /ƏVVƏLCƏ AXTAR/); assert.match(systems[0], /özbaşına "düzəliş" etmə/);
});
