// Portal vasitəsilə yaradılan müştərilərin saxlanması.
//  - AI_MONGODB_URI verilibsə: MongoDB ("tenants" kolleksiyası), oxuma yaddaşdakı nüsxədən (sinxron), yazma DB-yə.
//  - Verilməyibsə: fayl (inkişaf/test üçün, bir proses).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mongoEnabled, storeDb } from "../store/mongo.js";

// ---------- fayl rejimi ----------
const file = () => process.env.CUSTOMER_TENANTS_FILE
  ? path.resolve(process.env.CUSTOMER_TENANTS_FILE)
  : fileURLToPath(new URL("../../data/customer-tenants.json", import.meta.url));

const readFile = () => {
  try { return JSON.parse(fs.readFileSync(file(), "utf8")); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
};
const writeFile = (value) => {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
};

// ---------- MongoDB rejimi ----------
let cache = null;
const col = async () => (await storeDb()).collection("tenants");
const fromDoc = ({ _id, ...tenant }) => tenant;

export async function reloadCustomerTenants() {
  const docs = await (await col()).find({}).toArray();
  cache = docs.map(fromDoc);
}

export async function initCustomerStore() {
  if (mongoEnabled()) await reloadCustomerTenants();
}

export function listCustomerTenants() {
  if (!mongoEnabled()) return readFile();
  if (!cache) throw new Error("Müştəri bazası hazır deyil: əvvəlcə initStores() çağırılmalıdır");
  return cache;
}

export async function addCustomerTenant(tenant) {
  if (!mongoEnabled()) {
    const tenants = readFile();
    if (tenants.some((t) => t.tenantId === tenant.tenantId)) throw new Error("Bu tenantId artıq mövcuddur");
    tenants.push(tenant);
    writeFile(tenants);
    return tenant;
  }
  await (await col()).insertOne({ _id: tenant.tenantId, ...tenant }); // eyni ID olsa DB xəta verir
  listCustomerTenants().push(tenant);
  return tenant;
}

export async function updateCustomerTenant(id, updater) {
  if (!mongoEnabled()) {
    const tenants = readFile();
    const index = tenants.findIndex((t) => t.tenantId === id);
    if (index < 0) return null;
    tenants[index] = updater(tenants[index]);
    writeFile(tenants);
    return tenants[index];
  }
  const list = listCustomerTenants();
  const index = list.findIndex((t) => t.tenantId === id);
  if (index < 0) return null;
  const old = list[index];
  const next = updater(old);
  list[index] = next; // eyni anda gələn sorğular yenisini görsün
  try {
    await (await col()).replaceOne({ _id: id }, { _id: id, ...next });
  } catch (e) {
    list[index] = old;
    throw e;
  }
  return next;
}

export async function removeCustomerTenant(id) {
  if (!mongoEnabled()) {
    const tenants = readFile();
    const next = tenants.filter((t) => t.tenantId !== id);
    if (next.length === tenants.length) return false;
    writeFile(next);
    return true;
  }
  const list = listCustomerTenants();
  const index = list.findIndex((t) => t.tenantId === id);
  if (index < 0) return false;
  await (await col()).deleteOne({ _id: id });
  list.splice(list.findIndex((t) => t.tenantId === id), 1);
  return true;
}
