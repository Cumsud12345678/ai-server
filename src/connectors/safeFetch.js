// Müştərinin API-sini TƏHLÜKƏSİZ çağırır (SSRF qoruması, timeout, ölçü limiti, redirect qadağası)
import dns from "node:dns/promises";
import net from "node:net";
import { isPrivateIp } from "./ipCheck.js";
import { guardedFetch, isPrivateIpError } from "./safeDispatcher.js";

export class ConnectorError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export { isPrivateIp };

// Yalnız https və xarici (public) ünvanlar. Lokal inkişaf üçün ALLOW_LOCAL_CONNECTORS=1.
export async function assertSafeUrl(urlStr) {
  const local = process.env.ALLOW_LOCAL_CONNECTORS === "1";
  let url;
  try { url = new URL(urlStr); } catch { throw new ConnectorError("Müştəri URL-i düzgün deyil", "BAD_URL"); }
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new ConnectorError("Yalnız https ünvanlarına icazə var", "UNSAFE_URL");
  if (!local) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addrs;
    try { addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }); }
    catch { throw new ConnectorError("Müştəri domeni tapılmadı", "DNS"); }
    if (addrs.some((a) => isPrivateIp(a.address))) throw new ConnectorError("Daxili şəbəkə ünvanlarına icazə yoxdur", "UNSAFE_URL");
  }
  return url;
}

export async function safeFetchJson(urlStr, { method = "GET", headers = {}, body, timeoutMs = 5000, maxBytes = 1_000_000 } = {}) {
  const url = await assertSafeUrl(urlStr);
  try {
    const res = await guardedFetch(url, {
      method, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json", ...headers },
    });
    if (res.status >= 300 && res.status < 400) throw new ConnectorError("Yönləndirmə (redirect) icazəli deyil", "REDIRECT");
    if (!res.ok) throw new ConnectorError(`Müştəri API-si ${res.status} qaytardı`, `HTTP_${res.status}`);

    const reader = res.body.getReader();
    const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { await reader.cancel(); throw new ConnectorError("Müştəri cavabı çox böyükdür", "TOO_LARGE"); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ConnectorError("Müştəri cavabı JSON deyil", "BAD_JSON"); }
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    if (isPrivateIpError(e)) throw new ConnectorError("Daxili şəbəkə ünvanlarına icazə yoxdur", "UNSAFE_URL");
    if (e.name === "TimeoutError" || e.name === "AbortError") throw new ConnectorError("Müştəri API-si vaxtında cavab vermədi", "TIMEOUT");
    throw new ConnectorError(`Müştəri API-sinə qoşulmaq alınmadı (${e.cause?.code ?? e.message})`, "NETWORK");
  }
}

/** Feed faylını/linkini TƏHLÜKƏSİZ yükləyir (https + xarici ünvan, ≤3 redirect hər dəfə yenidən yoxlanır, ölçü və vaxt limiti). Mətn qaytarır. */
export async function safeFetchText(urlStr, { timeoutMs = 20_000, maxBytes = 5_000_000, redirects = 3 } = {}) {
  let current = urlStr;
  try {
    for (let hop = 0; hop <= redirects; hop++) {
      const url = await assertSafeUrl(current);
      const res = await guardedFetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "text/csv, application/json, application/xml, text/xml, */*", "user-agent": "ChatbotFeedBot/1.0" } });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { current = new URL(res.headers.get("location"), url).toString(); continue; }
      if (!res.ok) throw new ConnectorError(`Link ${res.status} qaytardı`, `HTTP_${res.status}`);
      const reader = res.body.getReader();
      const chunks = []; let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { await reader.cancel(); throw new ConnectorError(`Fayl çox böyükdür (maksimum ${Math.round(maxBytes / 1e6)} MB)`, "TOO_LARGE"); }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    }
    throw new ConnectorError("Çox sayda yönləndirmə", "REDIRECT");
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    if (isPrivateIpError(e)) throw new ConnectorError("Daxili şəbəkə ünvanlarına icazə yoxdur", "UNSAFE_URL");
    if (e.name === "TimeoutError" || e.name === "AbortError") throw new ConnectorError("Link vaxtında cavab vermədi", "TIMEOUT");
    throw new ConnectorError(`Linkə qoşulmaq alınmadı (${e.cause?.code ?? e.message})`, "NETWORK");
  }
}
