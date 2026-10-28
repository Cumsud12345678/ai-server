// Feed mənbəyinin ümumi əməliyyatları: yüklə → təhlil et → xəritələməni yoxla → saxla. Marşrutlar və avto-yeniləmə eyni funksiyaları işlədir.
import { FEED_FORMATS, parseFeed } from "./feedParse.js";
import { createFeedRepo } from "./feedRepo.js";
import { getFeed, putFeed } from "./feedStore.js";
import { ConnectorError, safeFetchText } from "./safeFetch.js";
import { validateFieldSpecs } from "./mapper.js";
import { updateCustomerTenant, listCustomerTenants } from "../tenants/customerStore.js";
import { refreshTenants, getTenant } from "../tenants/tenantStore.js";
import { dropRepo } from "../data/repoFactory.js";

export const REFRESH_CHOICES = [0, 6, 24, 168];
const HOUR = 3_600_000;

/** source.feed + source.response yoxlanması. Xəta mətni və ya null. */
export function validateFeedSource(source) {
  const f = source.feed ?? {};
  if (typeof f !== "object" || Array.isArray(f)) return "source.feed obyekt olmalıdır";
  if (f.url !== undefined && (typeof f.url !== "string" || f.url.length > 2000 || !/^https:\/\//i.test(f.url) && !(process.env.ALLOW_LOCAL_CONNECTORS === "1" && /^http:\/\/(localhost|127\.0\.0\.1)/i.test(f.url)))) return "source.feed.url https ilə başlayan link olmalıdır";
  if (f.format !== undefined && !FEED_FORMATS.includes(f.format)) return "source.feed.format json, csv və ya xml olmalıdır";
  if (f.itemsPath !== undefined && (typeof f.itemsPath !== "string" || f.itemsPath.length > 100)) return "source.feed.itemsPath düzgün deyil";
  if (f.delimiter !== undefined && (typeof f.delimiter !== "string" || f.delimiter.length !== 1)) return "source.feed.delimiter bir simvol olmalıdır";
  if (f.refreshHours !== undefined && !REFRESH_CHOICES.includes(f.refreshHours)) return `source.feed.refreshHours bunlardan biri olmalıdır: ${REFRESH_CHOICES.join(", ")}`;
  const r = source.response;
  if (!r || typeof r.fields !== "object" || !r.fields || Array.isArray(r.fields) || Object.keys(r.fields).length > 40) return "source.response.fields tələb olunur";
  if (r.defaults !== undefined && (typeof r.defaults !== "object" || !r.defaults || Array.isArray(r.defaults))) return "source.response.defaults obyekt olmalıdır";
  return validateFieldSpecs(r.fields);
}

/** Mətn (yükləmə) və ya link ilə sətirləri gətirir. text yoxdursa və link yoxdursa saxlanmış nüsxə (stored=true). */
export async function loadItems(feed = {}, text, { tenantId } = {}) {
  if (typeof text === "string" && text) return { ...parseFeed(text, feed), stored: false };
  if (feed.url) return { ...parseFeed(await safeFetchText(feed.url), feed), stored: false };
  if (tenantId) {
    const s = await getFeed(tenantId);
    if (s?.items?.length) return { items: s.items, format: feed.format, itemsPath: feed.itemsPath ?? "", stored: true };
  }
  throw new ConnectorError("Fayl yüklə və ya link göstər", "NO_FEED");
}

/** Xəritələmə ən azı bir elan verirmi? Qaytarır: { repo, count, dropped } */
export function checkMapping(source, items) {
  const repo = createFeedRepo({ source }, items);
  return repo;
}

/** Tenant-a yazılacaq `source.feed` (aşkarlanan dəyərlərlə) */
export const feedMeta = (feed = {}, parsed, count) => ({
  ...(feed.url && { url: feed.url }),
  format: parsed.format ?? feed.format,
  ...(parsed.itemsPath && { itemsPath: parsed.itemsPath }),
  ...(parsed.delimiter && { delimiter: parsed.delimiter }),
  refreshHours: feed.url ? (feed.refreshHours ?? 24) : 0,
  count, updatedAt: new Date().toISOString(),
});

/** Saxlanmış feed-i yeniləyir (link və ya yeni mətn). Xəritələmə pozulubsa köhnə data qalır və xəta tenant-da qeyd olunur. */
export async function refreshFeed(tenant, { text } = {}) {
  const source = tenant.source;
  const feed = source.feed ?? {};
  let parsed;
  try {
    parsed = await loadItems(feed, text, { tenantId: null });
    const repo = createFeedRepo({ source }, parsed.items);
    const probe = await repo.searchWithDebug({ limit: 1, sortBy: "price", sortDir: "asc" });
    if (!probe.listings.length) throw new ConnectorError("Yeni fayldan heç bir elan oxunmadı: sütun adları dəyişib?", "MAPPING_FAILED");
  } catch (e) {
    await updateCustomerTenant(tenant.tenantId, (t) => ({ ...t, source: { ...t.source, feed: { ...t.source.feed, lastError: String(e.message).slice(0, 200), lastErrorAt: new Date().toISOString() } } }));
    refreshTenants();
    throw e;
  }
  await putFeed(tenant.tenantId, { items: parsed.items });
  await updateCustomerTenant(tenant.tenantId, (t) => {
    const { lastError, lastErrorAt, ...rest } = t.source.feed ?? {};
    return { ...t, source: { ...t.source, feed: { ...rest, count: parsed.items.length, updatedAt: new Date().toISOString() } } };
  });
  refreshTenants();
  dropRepo(tenant.tenantId);
  return { count: parsed.items.length, truncated: parsed.truncated };
}

export const feedDue = (tenant, now = Date.now()) => {
  const f = tenant.source?.feed;
  if (tenant.source?.type !== "feed" || !f?.url || !f.refreshHours) return false;
  return now - (Date.parse(f.updatedAt ?? "") || 0) >= f.refreshHours * HOUR;
};

/** Bir dövrə: vaxtı çatmış link feed-lərini ardıcıl yeniləyir. */
export async function feedRefreshTick({ now = Date.now(), tenants = listCustomerTenants().map((t) => getTenant(t.tenantId)).filter(Boolean), refresh = refreshFeed, gapMs = 1000 } = {}) {
  let n = 0;
  for (const t of tenants) {
    if (!feedDue(t, now)) continue;
    try { await refresh(t); n++; } catch (e) { console.warn(`[feed] ${t.tenantId}: ${e.message}`); }
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
  return n;
}

export function startFeedRefresh({ everyMs = 20 * 60_000, firstMs = 3 * 60_000 } = {}) {
  let running = false;
  const tick = async () => { if (running) return; running = true; try { const n = await feedRefreshTick(); if (n) console.log(`[feed] ${n} feed yeniləndi`); } catch (e) { console.error("[feed] yenilənmə xətası:", e); } finally { running = false; } };
  setTimeout(tick, firstMs).unref();
  setInterval(tick, everyMs).unref();
}
