import "dotenv/config";
import { createApp } from "./src/app.js";
process.on("unhandledRejection", (e) => console.error("[xəta] işlənməmiş promise:", e));
process.on("uncaughtException", (e) => console.error("[xəta] tutulmamış istisna:", e));
import { initStores } from "./src/store/init.js";

const PORT = process.env.PORT || 3000;
await initStores();
createApp().listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
