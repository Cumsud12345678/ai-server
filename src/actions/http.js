// Yazma əməliyyatları üçün TƏHLÜKƏSİZ HTTP sorğusu.
//  - Yalnız https (lokal inkişafda ALLOW_LOCAL_CONNECTORS=1 ilə http://localhost).
//  - DNS bir dəfə həll olunur, ünvan yoxlanır və bağlantı MƏHZ O ünvana qurulur (DNS rebinding ilə daxili şəbəkəyə keçid mümkün deyil).
//  - Redirect izlənmir, cavab ölçüsü və vaxt məhdudlaşdırılıb. Sorğu heç vaxt avtomatik təkrarlanmır.
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { ConnectorError, isPrivateIp } from "../connectors/safeFetch.js";

export async function safeRequest(urlStr, { method = "POST", headers = {}, body, timeoutMs = Number(process.env.ACTION_TIMEOUT_MS) || 8000, maxBytes = 200_000 } = {}) {
  const local = process.env.ALLOW_LOCAL_CONNECTORS === "1";
  let url;
  try { url = new URL(urlStr); } catch { throw new ConnectorError("Ünvan düzgün deyil", "BAD_URL"); }
  const isHttps = url.protocol === "https:";
  if (!isHttps && !(local && url.protocol === "http:")) throw new ConnectorError("Yalnız https ünvanlarına icazə var", "UNSAFE_URL");
  if (url.username || url.password) throw new ConnectorError("Ünvanda istifadəçi adı/parol ola bilməz", "UNSAFE_URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addr;
  if (net.isIP(host)) addr = { address: host, family: net.isIPv6(host) ? 6 : 4 };
  else {
    let list;
    try { list = await dns.lookup(host, { all: true }); } catch { throw new ConnectorError("Domen tapılmadı", "DNS"); }
    addr = list.find((a) => a.family === 4) ?? list[0];
  }
  if (!addr) throw new ConnectorError("Domen tapılmadı", "DNS");
  if (!local && isPrivateIp(addr.address)) throw new ConnectorError("Daxili şəbəkə ünvanlarına icazə yoxdur", "UNSAFE_URL");
  const payload = body === undefined ? null : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request({
      protocol: url.protocol, hostname: host, port: url.port || (isHttps ? 443 : 80), path: `${url.pathname}${url.search}`, method,
      headers: { ...headers, ...(payload && { "content-length": String(payload.length) }) },
      lookup: (_h, o, cb) => (o?.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)), // yoxlanmış ünvana pinləmə
      servername: net.isIP(host) ? undefined : host, timeout: timeoutMs,
    }, (res) => {
      const chunks = []; let total = 0;
      res.on("data", (c) => { total += c.length; if (total > maxBytes) { req.destroy(new ConnectorError("Cavab çox böyükdür", "TOO_LARGE")); return; } chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new ConnectorError("Server vaxtında cavab vermədi", "TIMEOUT")));
    req.on("error", (e) => reject(e instanceof ConnectorError ? e : new ConnectorError(`Qoşulmaq alınmadı (${e.code ?? e.message})`, "NETWORK")));
    if (payload) req.write(payload);
    req.end();
  });
}
