import "dotenv/config";
import { startAutoRefresh } from "./src/kb/autorefresh.js";
import { startFeedRefresh } from "./src/connectors/feedService.js";
import { createApp } from "./src/app.js";
process.on("unhandledRejection", (e) => console.error("[xəta] işlənməmiş promise:", e));
// Gözlənilməz istisnadan sonra prosesin vəziyyəti etibarlı deyil: yazıb çıxırıq, hostinq (Render/PM2/Docker) yenidən qaldırır.
process.on("uncaughtException", (e) => {
  console.error("[xəta] tutulmamış istisna:", e);
  process.exit(1);
});
import { initStores } from "./src/store/init.js";
import { onModelCost } from "./src/billing/pricing.js";
import { recordModelCost } from "./src/billing/billing.js";

const PORT = process.env.PORT || 3000;
await initStores();
onModelCost((model, costUsd, tokens) => recordModelCost(model, costUsd, tokens)); // admin "Maliyyə": model üzrə xərc
const server = createApp().listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
// Deploy/restart zamanı yarımçıq sorğular kəsilməsin: yeni sorğu qəbul etmə, mövcudları bitir, sonra çıx.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[server] ${sig} alındı, bağlanır...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref(); // açıq qalan bağlantılar varsa 10 san-dən sonra məcburi çıxış
  });
}
startFeedRefresh(); // link ilə qoşulmuş feed-lərin avtomatik yenilənməsi
startAutoRefresh(); // saytdan oxunmuş mənbələrin avtomatik yenilənməsi (yalnız bir prosesdə)
