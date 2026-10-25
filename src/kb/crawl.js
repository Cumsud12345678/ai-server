// Sayt oxuma: bir səhifə, sitemap və ya linklərlə bütün sayt. SSRF qoruması safeFetch ilə eynidir (hər yönləndirmə yenidən yoxlanır).
import { assertSafeUrl, ConnectorError } from "../connectors/safeFetch.js";
import { extractHtml, extractFile, KbError } from "./extract.js";

const UA = "SupportBotCrawler/1.0 (+bilik-bazasi)";
const MAX_BYTES = Number(process.env.KB_MAX_PAGE_BYTES) || 3_000_000;
const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|css|js|mjs|json|xml|zip|rar|gz|mp4|mp3|avi|mov|woff2?|ttf|eot|exe|dmg|apk)(\?|$)/i;

async function readLimited(res, max) {
  const reader = res.body.getReader(); const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel(); throw new KbError("Səhifə çox böyükdür", "TOO_LARGE"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Yönləndirməni (maks. 4) yoxlayaraq izləyir. Qaytarır: { url, contentType, buffer } */
export async function fetchSafe(urlStr, { timeoutMs = 10_000, maxBytes = MAX_BYTES } = {}) {
  let current = urlStr;
  for (let hop = 0; hop < 5; hop++) {
    const url = await assertSafeUrl(current);
    let res;
    try {
      res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": UA, accept: "text/html,application/pdf,text/plain,application/xml;q=0.9,*/*;q=0.5", "accept-language": "az,en;q=0.8,ru;q=0.7" } });
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      if (e.name === "TimeoutError" || e.name === "AbortError") throw new KbError("Sayt vaxtında cavab vermədi", "TIMEOUT");
      throw new KbError(`Sayta qoşulmaq alınmadı (${e.cause?.code ?? e.message})`, "NETWORK");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location"), url).href;
      await res.body?.cancel();
      continue;
    }
    if (!res.ok) { await res.body?.cancel(); throw new KbError(`Sayt ${res.status} qaytardı`, `HTTP_${res.status}`); }
    return { url: url.href, contentType: res.headers.get("content-type") ?? "", buffer: await readLimited(res, maxBytes) };
  }
  throw new KbError("Çox yönləndirmə", "REDIRECTS");
}

/** Bir ünvandan mətn çıxarır (HTML, PDF və ya düz mətn ola bilər). Qaytarır: { url, title, text, links } */
export async function fetchPage(urlStr) {
  const r = await fetchSafe(urlStr);
  const ct = r.contentType.toLowerCase();
  if (/pdf/.test(ct) || r.url.toLowerCase().split("?")[0].endsWith(".pdf")) {
    const x = await extractFile({ name: decodeURIComponent(new URL(r.url).pathname.split("/").pop() || "sənəd.pdf"), mime: "application/pdf", buffer: r.buffer });
    return { url: r.url, title: x.title, text: x.text, links: [] };
  }
  if (/text\/plain/.test(ct)) {
    const x = await extractFile({ name: "page.txt", mime: "text/plain", buffer: r.buffer });
    return { url: r.url, title: new URL(r.url).hostname, text: x.text, links: [] };
  }
  if (ct && !/html|xml/.test(ct)) throw new KbError("Bu ünvan səhifə deyil (HTML, PDF və ya mətn gözlənilirdi)", "NOT_PAGE");
  const x = extractHtml(r.buffer.toString("utf8"), r.url);
  return { url: r.url, ...x };
}

async function robotsRules(origin) {
  try {
    const r = await fetchSafe(`${origin}/robots.txt`, { timeoutMs: 5000, maxBytes: 200_000 });
    const lines = r.buffer.toString("utf8").split(/\r?\n/);
    const disallow = []; const sitemaps = [];
    let applies = false;
    for (const raw of lines) {
      const line = raw.replace(/#.*/, "").trim();
      const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const k = m[1].toLowerCase(), v = m[2].trim();
      if (k === "user-agent") applies = v === "*";
      else if (k === "disallow" && applies && v) disallow.push(v);
      else if (k === "sitemap") sitemaps.push(v);
    }
    return { disallow, sitemaps };
  } catch { return { disallow: [], sitemaps: [] }; }
}

async function sitemapUrls(candidates, host, limit) {
  const out = []; const seen = new Set();
  const queue = [...candidates]; let fetched = 0;
  while (queue.length && out.length < limit && fetched < 8) {
    const sm = queue.shift();
    if (seen.has(sm)) continue; seen.add(sm); fetched++;
    try {
      const r = await fetchSafe(sm, { timeoutMs: 8000, maxBytes: 5_000_000 });
      const xml = r.buffer.toString("utf8");
      const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
      if (/<sitemapindex/i.test(xml)) queue.push(...locs.slice(0, 5));
      else for (const l of locs) { try { if (new URL(l).hostname === host) out.push(l); } catch { /* */ } }
    } catch { /* növbəti */ }
  }
  return out;
}

/**
 * Saytı gəzir. onPage({url,title,text}) hər uğurlu səhifədə çağırılır. Qaytarır: { pages, skipped }.
 * opts: { maxPages, onProgress }
 */
export async function crawlSite(startUrl, { maxPages = Number(process.env.KB_MAX_PAGES) || 40, onPage, onProgress } = {}) {
  const start = new URL(startUrl);
  const host = start.hostname;
  const rules = await robotsRules(start.origin);
  const allowed = (u) => { const p = new URL(u).pathname; return !rules.disallow.some((d) => p.startsWith(d)); };
  const norm = (u) => { const x = new URL(u); x.hash = ""; if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, ""); return x.href; };

  const queue = [norm(start.href)];
  const seen = new Set(queue);
  const fromSitemap = await sitemapUrls([`${start.origin}/sitemap.xml`, ...rules.sitemaps], host, maxPages * 2);
  for (const u of fromSitemap) { const n = norm(u); if (!seen.has(n) && !SKIP_EXT.test(n) && allowed(n)) { seen.add(n); queue.push(n); } }

  let pages = 0, skipped = 0;
  const errors = [];
  while (queue.length && pages < maxPages) {
    const batch = queue.splice(0, 3);
    const results = await Promise.allSettled(batch.map((u) => fetchPage(u)));
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== "fulfilled" || r.value.text.length < 60) {
        skipped++;
        if (r.status === "rejected" && errors.length < 5) errors.push(`${batch[i]}: ${r.reason.message}`);
        continue;
      }
      if (pages >= maxPages) break;
      pages++;
      await onPage({ url: r.value.url, title: r.value.title, text: r.value.text });
      for (const l of r.value.links) {
        let n; try { n = norm(l); } catch { continue; }
        if (seen.has(n) || SKIP_EXT.test(n) || new URL(n).hostname !== host || !allowed(n)) continue;
        if (seen.size >= maxPages * 4) break;
        seen.add(n); queue.push(n);
      }
    }
    onProgress?.({ pages, skipped });
  }
  return { pages, skipped, errors };
}
