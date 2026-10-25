// Yeni müştəri açarı yaradır. Açıq açarı müştəriyə VER, hash-i tenants.json-a yaz. Açıq açar heç yerdə saxlanmır.
import crypto from "node:crypto";
const key = "ck_live_" + crypto.randomBytes(24).toString("base64url");
const hash = crypto.createHash("sha256").update(key).digest("hex");
console.log(`\nAçıq açar (müştəriyə ver, bir daha göstərilməyəcək):\n  ${key}\n\ntenants.json-da "apiKeyHash":\n  ${hash}\n`);
