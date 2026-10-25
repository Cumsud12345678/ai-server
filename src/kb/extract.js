// Sənəddən mətn çıxarır: PDF, DOCX, TXT/MD/CSV/JSON, HTML.
import * as cheerio from "cheerio";

export class KbError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const clean = (s) => String(s).replace(/\r/g, "").replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();

export function extractHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const title = clean($("title").first().text() || $("h1").first().text() || "").slice(0, 160);
  const links = new Set();
  if (baseUrl) {
    $("a[href]").each((_, a) => {
      try {
        const u = new URL($(a).attr("href"), baseUrl);
        if (/^https?:$/.test(u.protocol)) { u.hash = ""; links.add(u.href); }
      } catch { /* yararsız link */ }
    });
  }
  $("script, style, noscript, svg, iframe, form, nav, footer, header, aside, [role=navigation], [aria-hidden=true], .cookie, #cookie").remove();
  const root = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
  // Başlıqlar və siyahı elementləri sətir kimi qalsın ki, bölmə sərhədləri itməsin
  root.find("h1,h2,h3,h4").each((_, el) => { $(el).prepend("\n\n# ").append("\n"); });
  root.find("p,li,tr,div,section,br,dt,dd").each((_, el) => { $(el).append("\n"); });
  root.find("td,th").each((_, el) => { $(el).append(" | "); });
  return { title, text: clean(root.text()), links: [...links] };
}

const decode = (buf) => new TextDecoder("utf-8", { fatal: false }).decode(buf);

/** { name, mime, buffer } -> { title, text }. */
export async function extractFile({ name = "", mime = "", buffer }) {
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]) ?? "";
  const title = name.replace(/\.[^.]+$/, "").slice(0, 160) || "Sənəd";
  const isPdf = ext === "pdf" || /pdf/i.test(mime) || buffer.subarray(0, 5).toString() === "%PDF-";
  if (isPdf) {
    let text;
    try {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const out = await extractText(pdf, { mergePages: false });
      text = out.text.map((p, i) => `\n\n[Səhifə ${i + 1}]\n${p}`).join("");
    } catch (e) { throw new KbError("PDF oxuna bilmədi (zədəli və ya parolludur)", "BAD_PDF"); }
    text = clean(text);
    if (text.replace(/\[Səhifə \d+\]/g, "").trim().length < 30)
      throw new KbError("PDF-də oxunan mətn yoxdur (skan edilmiş şəkil ola bilər). Mətnli PDF və ya Word yükləyin.", "SCANNED_PDF");
    return { title, text };
  }
  if (ext === "docx" || /wordprocessingml/i.test(mime)) {
    try {
      const mammoth = (await import("mammoth")).default;
      const { value } = await mammoth.extractRawText({ buffer });
      const text = clean(value);
      if (!text) throw new Error("boş");
      return { title, text };
    } catch { throw new KbError("Word faylı oxuna bilmədi", "BAD_DOCX"); }
  }
  if (["txt", "md", "markdown", "csv", "log"].includes(ext) || /^text\/(plain|markdown|csv)/i.test(mime)) {
    const text = clean(decode(buffer));
    if (!text) throw new KbError("Fayl boşdur", "EMPTY");
    return { title, text };
  }
  if (ext === "json" || /json/i.test(mime)) {
    const text = clean(decode(buffer));
    if (!text) throw new KbError("Fayl boşdur", "EMPTY");
    return { title, text };
  }
  if (["html", "htm"].includes(ext) || /html/i.test(mime)) {
    const r = extractHtml(decode(buffer));
    if (!r.text) throw new KbError("Səhifədə mətn tapılmadı", "EMPTY");
    return { title: r.title || title, text: r.text };
  }
  throw new KbError("Dəstəklənməyən format. PDF, DOCX, TXT, MD, CSV və ya HTML yükləyin.", "UNSUPPORTED");
}

export const cleanText = clean;
