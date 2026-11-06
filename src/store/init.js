import { initCustomerStore, reloadCustomerTenants } from "../tenants/customerStore.js";
import { refreshTenants } from "../tenants/tenantStore.js";
import { mongoEnabled } from "./mongo.js";
import { autoImportIfEmpty } from "./fileImport.js";

/** Server başlayanda çağırılır. MongoDB rejimində müştəriləri yükləyir və hər 30 saniyədən bir yeniləyir (çoxlu server üçün). */
export async function initStores() {
  if (!mongoEnabled()) return;
  // Fayl rejimindən keçid: Mongo boşdursa fayllardakı müştəri və balansları köçür (bir dəfə)
  try { await autoImportIfEmpty(); } catch (e) { console.error("[store] avtomatik köçürmə alınmadı:", e.message); }
  await initCustomerStore();
  refreshTenants();
  setInterval(async () => {
    try { await reloadCustomerTenants(); refreshTenants(); }
    catch (e) { console.warn("[store] müştəri siyahısı yenilənmədi:", e.message); }
  }, 30_000).unref();
  console.log("[store] müştərilər və istifadə MongoDB-dədir");
}