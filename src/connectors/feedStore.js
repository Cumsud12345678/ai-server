// Fayl/link ilə yüklənmiş məhsul/elan sətirlərinin saxlanması (müştəri başına bir sənəd).
//  - AI_MONGODB_URI varsa MongoDB ("feed_data"), yoxdursa fayl (inkişaf/test).
import fs from "node:fs";
import path from "node:path";
import { mongoEnabled, storeDb } from "../store/mongo.js";

const FILE = () => process.env.FEED_FILE || new URL("../../data/feeds.json", import.meta.url).pathname;
let state;
const load = () => { if (!state) { try { state = JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch { state = {}; } } return state; };
const save = () => { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(state)); };
export const resetFeedMemory = () => { state = undefined; };
const col = async () => (await storeDb()).collection("feed_data");

export async function getFeed(tenantId) {
  if (mongoEnabled()) { const d = await (await col()).findOne({ _id: tenantId }); return d ? { items: d.items, fetchedAt: d.fetchedAt } : null; }
  return load()[tenantId] ?? null;
}
export async function putFeed(tenantId, { items, fetchedAt = new Date().toISOString() }) {
  if (mongoEnabled()) { await (await col()).replaceOne({ _id: tenantId }, { _id: tenantId, items, fetchedAt }, { upsert: true }); return; }
  load()[tenantId] = { items, fetchedAt };
  save();
}
export async function deleteFeed(tenantId) {
  if (mongoEnabled()) { await (await col()).deleteOne({ _id: tenantId }); return; }
  if (load()[tenantId]) { delete state[tenantId]; save(); }
}
