import { initCustomerStore, reloadCustomerTenants } from "../tenants/customerStore.js";
import { refreshTenants } from "../tenants/tenantStore.js";
import { mongoEnabled } from "./mongo.js";

/** Server başlayanda çağırılır. MongoDB rejimində müştəriləri yükləyir və hər 30 saniyədən bir yeniləyir (çoxlu server üçün). */
export async function initStores() {
  if (!mongoEnabled()) return;
  await initCustomerStore();
  refreshTenants();
  setInterval(async () => {
    try { await reloadCustomerTenants(); refreshTenants(); }
    catch (e) { console.warn("[store] müştəri siyahısı yenilənmədi:", e.message); }
  }, 30_000).unref();
  console.log("[store] müştərilər və istifadə MongoDB-dədir");
}
