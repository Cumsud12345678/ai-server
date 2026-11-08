// Qoşulma sehirbazı üçün: müştərinin API ünvanını bir dəfə çağırıb XAM cavabı qaytarır.
// Brauzerdən birbaşa çağırmaq CORS-a ilişir, ona görə sorğunu server göndərir (eyni SSRF qoruması ilə).
// Açar yalnız bu sorğu üçün işlənir, heç yerdə saxlanmır və cavaba düşmür.
import { safeFetchJson, ConnectorError } from "./safeFetch.js";

const AUTH = ["none", "header", "bearer", "query"];
const NAME_RE = /^[A-Za-z0-9_.-]{1,60}$/;

export function validateSampleRequest(b = {}) {
  if (typeof b.url !== "string" || !b.url.trim() || b.url.length > 2000) return "url tələb olunur (maksimum 2000 simvol)";
  if (b.method !== undefined && !["GET", "POST"].includes(String(b.method).toUpperCase())) return "method GET və ya POST olmalıdır";
  if (b.body !== undefined && (typeof b.body !== "string" || b.body.length > 20_000)) return "body mətn olmalıdır (maksimum 20000 simvol)";
  const a = b.auth;
  if (a !== undefined) {
    if (!a || typeof a !== "object" || !AUTH.includes(a.type ?? "none")) return "auth.type dəstəklənmir";
    if ((a.type === "header" || a.type === "query") && !NAME_RE.test(String(a.name ?? ""))) return "auth.name (başlıq və ya parametr adı) düzgün deyil";
    if (a.type !== "none" && a.type !== undefined && (typeof b.apiSecret !== "string" || !b.apiSecret)) return "Bu autentifikasiya üçün apiSecret tələb olunur";
  }
  if (b.apiSecret !== undefined && (typeof b.apiSecret !== "string" || b.apiSecret.length > 2000)) return "apiSecret düzgün deyil";
  return null;
}

/** Böyük cavabı kiçildir: siyahılardan ilk 20 element, uzun mətnlər kəsilir, dərinlik 8. */
export function trimSample(v, depth = 0) {
  if (depth > 8) return null;
  if (typeof v === "string") return v.length > 400 ? `${v.slice(0, 400)}…` : v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => trimSample(x, depth + 1));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 80)) out[k] = trimSample(x, depth + 1);
    return out;
  }
  return v;
}

export async function fetchSample(b) {
  const url = new URL(b.url.trim());
  const method = String(b.method ?? "GET").toUpperCase();
  const headers = {};
  const a = b.auth ?? { type: "none" };
  if (a.type === "header") headers[a.name] = b.apiSecret;
  else if (a.type === "bearer") headers.Authorization = `Bearer ${b.apiSecret}`;
  else if (a.type === "query") url.searchParams.set(a.name, b.apiSecret);
  let body;
  if (method === "POST") { body = b.body?.trim() || "{}"; headers["content-type"] = "application/json"; }
  const started = Date.now();
  const json = await safeFetchJson(url.toString(), { method, headers, body, timeoutMs: 10_000, maxBytes: 3_000_000 });
  if (json === null || typeof json !== "object") throw new ConnectorError("Cavab obyekt və ya siyahı deyil", "BAD_JSON");
  return { json: trimSample(json), ms: Date.now() - started };
}
