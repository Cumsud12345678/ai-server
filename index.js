import "dotenv/config";
import { startAutoRefresh } from "./src/kb/autorefresh.js";
import { startFeedRefresh } from "./src/connectors/feedService.js";
import { createApp } from "./src/app.js";
process.on("unhandledRejection", (e) => console.error("[xəta] işlənməmiş promise:", e));
process.on("uncaughtException", (e) => console.error("[xəta] tutulmamış istisna:", e));
import { initStores } from "./src/store/init.js";

const PORT = process.env.PORT || 3000;
await initStores();
createApp().listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
startFeedRefresh(); // link ilə qoşulmuş feed-lərin avtomatik yenilənməsi
startAutoRefresh(); // saytdan oxunmuş mənbələrin avtomatik yenilənməsi (yalnız bir prosesdə)
