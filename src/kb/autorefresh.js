// Saytdan oxunmuş bilik mənbələrinin avtomatik yenilənməsi. Müştəri profilində: profile.kbAutoRefresh = "off" | "daily" | "weekly" (defolt "weekly").
import { listTenants } from "../tenants/tenantStore.js";
import { listSources } from "./store.js";
import { refreshSource } from "./ingest.js";

const HOUR = 3_600_000;
export const INTERVALS = { daily: 24 * HOUR, weekly: 7 * 24 * HOUR };
export const DEFAULT_AUTO = "weekly";
export const intervalOf = (tenant) => INTERVALS[tenant.profile?.kbAutoRefresh ?? DEFAULT_AUTO] ?? 0; // "off" → 0

const lastTouch = (s) => Math.max(Date.parse(s.lastIndexedAt ?? "") || 0, Date.parse(s.lastRefreshAt ?? "") || 0, Date.parse(s.createdAt ?? "") || 0);

/** Vaxtı çatmış sayt mənbələri: hazır, hazırda emal olunmayan, son oxunmadan intervalı keçmiş. */
export function dueSources(sources, everyMs, now = Date.now()) {
  if (!everyMs) return [];
  return sources.filter((s) => ["url", "site"].includes(s.type) && s.status === "ready" && now - lastTouch(s) >= everyMs);
}

/** Bir dövrə: bütün müştərilər üzrə vaxtı çatmış mənbələri ardıcıl yeniləyir (saytlara yük düşməsin). */
export async function autoRefreshTick({ now = Date.now(), refresh = refreshSource, gapMs = 2000, tenants = listTenants() } = {}) {
  let n = 0;
  for (const tenant of tenants) {
    const every = intervalOf(tenant);
    if (!every || tenant.profile?.mode === "listings") continue; // elan rejimində bilik bazası istifadə olunmur
    let sources;
    try { sources = await listSources(tenant.tenantId); } catch (e) { console.error("[kb] avto-yenilənmə siyahısı alınmadı:", e.message); continue; }
    for (const s of dueSources(sources, every, now)) {
      try { const job = await refresh(tenant, s._id, { auto: true }); await job; n++; } catch (e) { console.error(`[kb] avto-yenilənmə ${tenant.tenantId}:`, e.message); }
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  return n;
}

/** Servis açılanda çağırılır: 2 dəqiqə sonra ilk yoxlama, sonra hər 30 dəqiqədən bir. Yalnız TƏK prosesdə işləməlidir. */
export function startAutoRefresh({ everyMs = 30 * 60_000, firstMs = 2 * 60_000 } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { const n = await autoRefreshTick(); if (n) console.log(`[kb] ${n} mənbə avtomatik yeniləndi`); }
    catch (e) { console.error("[kb] avto-yenilənmə xətası:", e); }
    finally { running = false; }
  };
  setTimeout(tick, firstMs).unref();
  setInterval(tick, everyMs).unref();
}
