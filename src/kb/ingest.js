// Mənbələrin qəbulu: fayl, sayt (bir səhifə və ya bütün sayt), yapışdırılmış mətn. İş fonda gedir; status mənbə üzərində yazılır.
import { createHash } from "node:crypto";
import { extractFile, cleanText, KbError } from "./extract.js";
import { chunkText } from "./chunk.js";
import { embedDocuments } from "./embed.js";
import { fetchPage, crawlSite } from "./crawl.js";
import { assertSafeUrl } from "../connectors/safeFetch.js";
import { listSources, newSource, putSource, replaceSourceChunks, countChunks, getSource } from "./store.js";

export const MAX_FILE_BYTES = Number(process.env.KB_MAX_FILE_BYTES) || 6 * 1024 * 1024;
const MAX_TEXT_CHARS = Number(process.env.KB_MAX_TEXT_CHARS) || 300_000;
const maxSources = (t) => t.limits?.kbSources ?? (Number(process.env.KB_MAX_SOURCES) || 30);
const maxChunks = (t) => t.limits?.kbChunks ?? (Number(process.env.KB_MAX_CHUNKS) || 2500);

const jobs = new Set();
/** Testlər üçün: bütün fon işlərinin bitməsini gözləyir. */
export const idle = async () => { while (jobs.size) await Promise.allSettled([...jobs]); };
function background(fn) {
  // Fon işindəki gözlənilməz xəta bütün servisi çökdürməsin (Node işlənməmiş promise rədddində prosesi dayandırır)
  const p = fn().catch((e) => console.error("[kb] fon işi uğursuz oldu:", e)).finally(() => jobs.delete(p));
  jobs.add(p);
  return p;
}

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 32);

async function guardCapacity(tenant) {
  const sources = (await listSources(tenant.tenantId)).filter((s) => s.type !== "qa"); // sual-cavab cütlərinin öz limiti var
  if (sources.length >= maxSources(tenant)) throw new KbError(`Ən çox ${maxSources(tenant)} mənbə əlavə edə bilərsiniz. Köhnələrini silin.`, "SOURCE_LIMIT");
  return sources;
}

/** pages: [{ title, url?, text }] -> hissələrə bölür, vektorlaşdırır və yazır. Qaytarır: { chunks, chars } */
async function indexPages(tenant, source, pages) {
  const prepared = [];
  for (const p of pages) for (const c of chunkText(p.text)) prepared.push({ title: p.title || source.name, url: p.url, heading: c.heading, text: c.text });
  if (!prepared.length) throw new KbError("Mətn tapılmadı", "EMPTY");
  const others = (await countChunks(tenant.tenantId)) - (source.chunks ?? 0);
  if (others + prepared.length > maxChunks(tenant)) throw new KbError("Bilik bazası həcm limitini aşır. Köhnə mənbələri silin və ya daha kiçik sənəd yükləyin.", "CHUNK_LIMIT");
  const vectors = await embedDocuments(prepared.map((c) => `${c.title}${c.heading ? " — " + c.heading : ""}\n${c.text}`));
  await replaceSourceChunks(tenant.tenantId, source._id, prepared.map((c, i) => ({ ...c, emb: vectors[i] })));
  return { chunks: prepared.length, chars: prepared.reduce((n, c) => n + c.text.length, 0) };
}

const failMsg = (e) => (e instanceof KbError || e?.code ? e.message : e?.status === 429 ? "Xidmət yüklüdür, bir azdan yenidən cəhd edin" : "Emal alınmadı");

async function run(tenant, source, work) {
  try {
    const done = await work();
    Object.assign(source, done, { status: "ready", error: null, lastIndexedAt: new Date().toISOString() });
  } catch (e) {
    if (!(e instanceof KbError) && !e?.code) console.error(`[kb] ${tenant.tenantId} ${source._id}:`, e);
    Object.assign(source, { status: "failed", error: failMsg(e) });
  }
  try { await putSource(source); } catch (e) { console.error(`[kb] ${tenant.tenantId} ${source._id} statusu yazıla bilmədi:`, e); }
}

export async function ingestFile(tenant, { name, mime, buffer }) {
  if (!buffer?.length) throw new KbError("Fayl boşdur", "EMPTY");
  if (buffer.length > MAX_FILE_BYTES) throw new KbError(`Fayl çox böyükdür (maksimum ${Math.round(MAX_FILE_BYTES / 1048576)} MB)`, "TOO_LARGE");
  const sources = await guardCapacity(tenant);
  const hash = sha(buffer);
  if (sources.some((s) => s.hash === hash)) throw new KbError("Bu fayl artıq əlavə edilib", "DUPLICATE");
  const source = await putSource(newSource(tenant.tenantId, { type: "file", name: String(name || "sənəd").slice(0, 160), mime, size: buffer.length, hash }));
  background(() => run(tenant, source, async () => {
    const { title, text } = await extractFile({ name, mime, buffer });
    const r = await indexPages(tenant, source, [{ title, text: text.slice(0, MAX_TEXT_CHARS * 3) }]);
    return { ...r, pages: 1 };
  }));
  return source;
}

export async function ingestText(tenant, { title, text }) {
  const body = cleanText(text ?? "");
  if (body.length < 20) throw new KbError("Mətn çox qısadır", "EMPTY");
  if (body.length > MAX_TEXT_CHARS) throw new KbError(`Mətn çox uzundur (maksimum ${MAX_TEXT_CHARS} simvol)`, "TOO_LARGE");
  const sources = await guardCapacity(tenant);
  const hash = sha(body);
  if (sources.some((s) => s.hash === hash)) throw new KbError("Bu mətn artıq əlavə edilib", "DUPLICATE");
  const name = String(title || "").trim().slice(0, 160) || body.slice(0, 40);
  const source = await putSource(newSource(tenant.tenantId, { type: "text", name, size: body.length, hash }));
  background(() => run(tenant, source, async () => ({ ...(await indexPages(tenant, source, [{ title: name, text: body }])), pages: 1 })));
  return source;
}

export async function ingestUrl(tenant, { url, crawl = false }) {
  let u;
  try { u = await assertSafeUrl(String(url).trim()); } catch (e) { throw new KbError(e.message, e.code ?? "BAD_URL"); }
  const sources = await guardCapacity(tenant);
  const href = u.href;
  if (sources.some((s) => s.url === href && s.type === (crawl ? "site" : "url"))) throw new KbError("Bu ünvan artıq əlavə edilib", "DUPLICATE");
  const source = await putSource(newSource(tenant.tenantId, { type: crawl ? "site" : "url", name: u.hostname + (u.pathname !== "/" && !crawl ? u.pathname : ""), url: href }));
  background(() => run(tenant, source, () => indexUrlSource(tenant, source)));
  return source;
}

/** Mənbənin səhifələrini yükləyir (indeksləmədən). */
async function collectPages(source) {
  const pages = [];
  if (source.type === "url") {
    const p = await fetchPage(source.url);
    if (p.text.length < 60) throw new KbError("Səhifədə oxunan mətn tapılmadı (səhifə JavaScript ilə yüklənə bilər)", "EMPTY");
    pages.push({ title: p.title, url: p.url, text: p.text });
  } else {
    await crawlSite(source.url, { onPage: (p) => pages.push(p) });
    if (!pages.length) throw new KbError("Saytdan mətn oxuna bilmədi (səhifələr JavaScript ilə yüklənə və ya robots.txt ilə bağlı ola bilər)", "EMPTY");
  }
  return pages;
}
const hashPages = (pages) => sha(pages.map((p) => p.text).join("\n"));

async function indexUrlSource(tenant, source) {
  const pages = await collectPages(source);
  const r = await indexPages(tenant, source, pages);
  return { ...r, pages: pages.length, hash: hashPages(pages) };
}

/** Sayt mənbəyini yenidən oxuyur (köhnə hissələr uğurlu olandan sonra əvəz olunur). */
export async function refreshSource(tenant, id, { auto = false } = {}) {
  const source = await getSource(tenant.tenantId, id);
  if (!source) return null;
  if (!["url", "site"].includes(source.type)) throw new KbError("Yalnız sayt mənbələri yenilənə bilər", "NOT_REFRESHABLE");
  if (source.status === "processing") throw new KbError("Mənbə hazırda emal olunur", "BUSY");
  if (auto) return autoRefresh(tenant, source);
  Object.assign(source, { status: "processing", error: null });
  await putSource(source);
  background(() => run(tenant, source, () => indexUrlSource(tenant, source)));
  return source;
}

/**
 * Avtomatik yenilənmə (planlaşdırıcı çağırır): məzmun dəyişməyibsə vektorlaşdırma aparılmır (xərc yoxdur).
 * Uğursuz olsa köhnə hissələr qalır və mənbə "hazır" qalır (bot sınmır), xəta `refreshError`-da saxlanır.
 * Qaytarır: işin promise-i (testlər və planlaşdırıcı gözləyə bilər).
 */
function autoRefresh(tenant, source) {
  return background(async () => {
    const now = () => new Date().toISOString();
    try {
      const pages = await collectPages(source);
      const hash = hashPages(pages);
      if (hash === source.hash && source.chunks > 0) { Object.assign(source, { lastRefreshAt: now(), refreshError: null, unchanged: true }); }
      else {
        const r = await indexPages(tenant, source, pages);
        Object.assign(source, r, { pages: pages.length, hash, status: "ready", error: null, lastIndexedAt: now(), lastRefreshAt: now(), refreshError: null, unchanged: false });
      }
    } catch (e) {
      if (!(e instanceof KbError) && !e?.code) console.error(`[kb] avto-yenilənmə ${tenant.tenantId} ${source._id}:`, e);
      Object.assign(source, { status: source.chunks > 0 ? "ready" : "failed", lastRefreshAt: now(), refreshError: failMsg(e) });
    }
    try { await putSource(source); } catch (e) { console.error(`[kb] ${tenant.tenantId} ${source._id} statusu yazıla bilmədi:`, e); }
  });
}
