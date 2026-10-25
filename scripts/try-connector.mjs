// Müştəri konnektorunu sınamaq üçün. İstifadə:
//   node scripts/try-connector.mjs demo-musteri '{"maxPrice":15000,"make":"BMW"}'
import "dotenv/config";
import { getTenant } from "../src/tenants/tenantStore.js";
import { getRepo } from "../src/data/repoFactory.js";
import { sanitizeFilters, PUBLIC_FIELDS } from "../src/data/filters.js";
import { maskPII } from "../src/util/mask.js";
import { initStores } from "../src/store/init.js";

await initStores();

const [tenantId, json = "{}"] = process.argv.slice(2);
const tenant = tenantId && getTenant(tenantId);
if (!tenant) { console.error("İstifadə: node scripts/try-connector.mjs <tenantId> '<filtrlər JSON>'"); process.exit(1); }
const repo = await getRepo(tenant);
if (!repo.searchWithDebug) { console.log(`"${tenantId}" REST konnektor deyil (tip: ${tenant.source.type}), test lazım deyil.`); process.exit(0); }

const filters = sanitizeFilters(JSON.parse(json), { maxResults: tenant.profile?.maxResults, schema: repo.schema });
console.log("Standart filtr:", JSON.stringify(filters));
console.log("Dəstəklənən filtrlər:", repo.supportedFilters.join(", "), "\n");

try {
  const { listings, debug } = await repo.searchWithDebug(filters);
  console.log("Müştəriyə gedən sorğu :", debug.request ?? "(göndərilmədi)", debug.cached ? "(keşdən)" : "");
  if (debug.note) console.log("Qeyd                  :", debug.note);
  console.log("Xam elan sayı         :", debug.rawCount);
  console.log("Xam 1-ci elan (maskalı):", JSON.stringify(maskPII(debug.rawFirst), null, 2));
  console.log(`\nÇevrilmiş nəticə (${listings.length}):`);
  console.table(listings.map(({ id, title, price, currency, year, mileage, bodyType, city }) => ({ id, title, price, currency, year, mileage, bodyType, city })));
  if (debug.dropped.length) console.log("Atılan elanlar:", debug.dropped.join("; "));

  const missing = PUBLIC_FIELDS.filter((k) => k !== "attributes" && listings.length && listings.every((l) => l[k] === null || l[k] === undefined));
  if (missing.length) console.log("\nDİQQƏT, bütün nəticələrdə boş olan standart sahələr:", missing.join(", "), "\n(konfiqurasiyada response.fields-ə baxın; bəzisi müştəridə olmaya bilər)");
} catch (e) {
  console.error("\nXƏTA:", e.code ?? "", e.message);
  process.exit(1);
}
