// Müştərilərin konfiqurasiyası. API açarları SHA-256 hash şəklində saxlanılır (açıq açar heç yerdə yoxdur).
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { listCustomerTenants } from "./customerStore.js";

export const hashKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");

let byHash, byId;
function load() {
  if (byHash) return;
  const file = process.env.TENANTS_FILE || new URL("./tenants.json", import.meta.url);
  const list = [...JSON.parse(readFileSync(file, "utf8")), ...listCustomerTenants()];
  byHash = new Map(); byId = new Map();
  for (const t of list) {
    if (!t.tenantId || !t.apiKeyHash || (t.profile?.mode !== "support" && !["memory", "mongo", "rest", "feed"].includes(t.source?.type))) {
      console.warn(`[tenants] natamam konfiqurasiya atıldı: ${t.tenantId ?? "(adsız)"}`);
      continue;
    }
    if (t.devOnly && process.env.NODE_ENV === "production") {
      console.warn(`[tenants] "${t.tenantId}" yalnız inkişaf üçündür, production-da yüklənmir`);
      continue;
    }
    byHash.set(t.apiKeyHash, t);
    byId.set(t.tenantId, t);
  }
}

export function refreshTenants() { byHash = undefined; byId = undefined; load(); }

export function getTenantByKey(key) {
  if (!key) return null;
  load();
  return byHash.get(hashKey(key)) ?? null;
}
export function getTenant(id) { load(); return byId.get(id) ?? null; }
export function listTenants() { load(); return [...byId.values()]; }
