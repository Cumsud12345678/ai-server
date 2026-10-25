import "dotenv/config";
import { createMockApi } from "./customerApi.js";
const PORT = process.env.MOCK_PORT || 4000;
createMockApi().listen(PORT, () => console.log(`Saxta müştəri API-si: http://localhost:${PORT}  (açar: X-Api-Key)`));
