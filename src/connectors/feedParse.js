// Fayl/link ilə onboarding: CSV, JSON və XML (Google Merchant, RSS, Atom, öz XML-i) mətnini sətir massivinə çevirir.
// Çıxış: { format, items: [{...}], itemsPath, truncated }. Xam sətirlər olduğu kimi saxlanır, xəritələmə ayrıca tətbiq olunur.
import * as cheerio from "cheerio";
import { getPath } from "./mapper.js";
import { ConnectorError } from "./safeFetch.js";

export const FEED_MAX_BYTES = 5_000_000;
export const FEED_MAX_ITEMS = 5000;
export const FEED_MAX_STORED_CHARS = 12_000_000;
const CELL_MAX = 500;
const FORMATS = ["json", "csv", "xml"];
export const FEED_FORMATS = FORMATS;

export function sniffFormat(text) {
  const t = text.replace(/^﻿/, "").trimStart();
  if (t.startsWith("<")) return "xml";
  if (t.startsWith("[") || t.startsWith("{")) return "json";
  return "csv";
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const clipVal = (v, depth = 0) => {
  if (typeof v === "string") return v.length > CELL_MAX ? v.slice(0, CELL_MAX) : v;
  if (Array.isArray(v)) return depth > 3 ? null : v.slice(0, 20).map((x) => clipVal(x, depth + 1));
  if (isObj(v)) {
    if (depth > 3) return null;
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 80)) o[k] = clipVal(x, depth + 1);
    return o;
  }
  return v;
};

// ---------- CSV ----------
function detectDelimiter(head) {
  let best = ",", bestN = 0;
  for (const d of [",", ";", "\t", "|"]) {
    let n = 0, q = false;
    for (const ch of head) { if (ch === '"') q = !q; else if (!q && ch === d) n++; if (!q && ch === "\n") break; }
    if (n > bestN) { best = d; bestN = n; }
  }
  return best;
}

export function parseCsvRows(text, delimiter) {
  const rows = [];
  let row = [], cell = "", q = false, i = 0;
  const push = () => { row.push(cell); cell = ""; };
  const end = () => { push(); if (row.some((c) => c.trim() !== "")) rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell === "") q = true;
    else if (ch === delimiter) push();
    else if (ch === "\n") end();
    else if (ch === "\r") { /* \r\n */ }
    else cell += ch;
    i++;
    if (rows.length > FEED_MAX_ITEMS + 1) break;
  }
  if (cell !== "" || row.length) end();
  return rows;
}

function parseCsv(text, { delimiter } = {}) {
  const t = text.replace(/^﻿/, "");
  const d = delimiter && delimiter.length === 1 ? delimiter : detectDelimiter(t.slice(0, 4000));
  const rows = parseCsvRows(t, d);
  if (rows.length < 2) throw new ConnectorError("CSV-də başlıq sətri və ən azı bir məlumat sətri olmalıdır", "FEED_EMPTY");
  const seen = new Map();
  const header = rows[0].map((h, idx) => {
    let name = h.trim().replace(/\./g, "_") || `sutun${idx + 1}`;
    const n = seen.get(name) ?? 0; seen.set(name, n + 1);
    return n ? `${name}_${n + 1}` : name;
  });
  const items = rows.slice(1).map((r) => Object.fromEntries(header.map((h, idx) => [h, (r[idx] ?? "").trim()]).filter(([, v]) => v !== "")));
  return { items: items.filter((o) => Object.keys(o).length), itemsPath: "" , delimiter: d };
}

// ---------- JSON ----------
function findArray(json, depth = 0) {
  if (Array.isArray(json)) return json.some(isObj) ? "" : null;
  if (!isObj(json) || depth > 3) return null;
  for (const [k, v] of Object.entries(json)) {
    if (Array.isArray(v) && v.length && v.some(isObj)) return k;
  }
  for (const [k, v] of Object.entries(json)) {
    const sub = findArray(v, depth + 1);
    if (sub !== null && isObj(v)) return sub ? `${k}.${sub}` : k;
  }
  return null;
}

function parseJson(text, { itemsPath } = {}) {
  let json;
  try { json = JSON.parse(text.replace(/^﻿/, "")); } catch { throw new ConnectorError("Fayl düzgün JSON deyil", "BAD_JSON"); }
  const path = itemsPath ?? findArray(json);
  if (path === null || path === undefined) throw new ConnectorError("JSON-da obyektlərdən ibarət siyahı tapılmadı", "FEED_SHAPE");
  const arr = getPath(json, path);
  if (!Array.isArray(arr)) throw new ConnectorError(`JSON-da "${path}" siyahı deyil`, "FEED_SHAPE");
  return { items: arr.filter(isObj), itemsPath: path };
}

// ---------- XML ----------
const localName = (n) => String(n).replace(/^.*:/, "");
function nodeToValue($, el) {
  const kids = $(el).children().toArray();
  const attrs = Object.entries(el.attribs ?? {}).filter(([k]) => !k.startsWith("xmlns"));
  if (!kids.length) {
    const txt = $(el).text().trim();
    if (!attrs.length) return txt;
    const o = Object.fromEntries(attrs.map(([k, v]) => [`@${localName(k)}`, v]));
    if (txt) o["#text"] = txt;
    return o;
  }
  const o = Object.fromEntries(attrs.map(([k, v]) => [`@${localName(k)}`, v]));
  for (const k of kids) {
    const name = localName(k.name);
    const v = nodeToValue($, k);
    if (name in o) o[name] = Array.isArray(o[name]) ? [...o[name], v] : [o[name], v];
    else o[name] = v;
  }
  return o;
}

function parseXml(text, { itemsPath } = {}) {
  const $ = cheerio.load(text.replace(/^﻿/, ""), { xmlMode: true });
  const root = $.root().children().get(0);
  if (!root) throw new ConnectorError("Fayl düzgün XML deyil", "BAD_XML");
  let tag = itemsPath;
  if (!tag) {
    // Təkrarlanan ən çox element (RSS: item, Atom: entry, Merchant: item/entry, öz XML-i: product, offer, elan...)
    const counts = new Map();
    $("*").each((_, el) => {
      if (el === root || !$(el).children().length) return;
      const n = localName(el.name);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    });
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    tag = ranked[0]?.[0];
    if (!tag) {
      const kids = $(root).children().toArray();
      if (!kids.length) throw new ConnectorError("XML-də element tapılmadı", "FEED_SHAPE");
      tag = localName(kids[0].name);
    }
  }
  const items = [];
  $("*").each((_, el) => {
    if (localName(el.name) !== tag || el === root) return;
    if (items.length >= FEED_MAX_ITEMS + 1) return false;
    const v = nodeToValue($, el);
    if (isObj(v)) items.push(v);
  });
  if (!items.length) throw new ConnectorError(`XML-də "${tag}" elementləri tapılmadı`, "FEED_SHAPE");
  return { items, itemsPath: tag };
}

/** Mətni sətirlərə çevirir. Xəta ConnectorError. */
export function parseFeed(text, { format, itemsPath, delimiter } = {}) {
  if (typeof text !== "string" || !text.trim()) throw new ConnectorError("Fayl boşdur", "FEED_EMPTY");
  if (Buffer.byteLength(text) > FEED_MAX_BYTES) throw new ConnectorError(`Fayl çox böyükdür (maksimum ${Math.round(FEED_MAX_BYTES / 1e6)} MB)`, "TOO_LARGE");
  const f = FORMATS.includes(format) ? format : sniffFormat(text);
  const r = f === "csv" ? parseCsv(text, { delimiter }) : f === "json" ? parseJson(text, { itemsPath }) : parseXml(text, { itemsPath });
  const truncated = r.items.length > FEED_MAX_ITEMS;
  const items = r.items.slice(0, FEED_MAX_ITEMS).map((o) => clipVal(o));
  if (!items.length) throw new ConnectorError("Faylda məhsul/elan tapılmadı", "FEED_EMPTY");
  if (JSON.stringify(items).length > FEED_MAX_STORED_CHARS) throw new ConnectorError("Fayl çox böyükdür: sətir sayını və ya sütunları azalt", "TOO_LARGE");
  return { format: f, items, itemsPath: r.itemsPath ?? "", truncated, ...(r.delimiter && { delimiter: r.delimiter }) };
}

/** Sətirlərdəki skalyar sahələrin yolları ("a", "a.b", "a[0]"), hər birinin nümunə dəyərləri ilə. */
export function columnsOf(items, { sampleRows = 200, maxColumns = 80 } = {}) {
  const cols = new Map();
  const walk = (v, path, depth, row) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) { if (depth < 3 && v.length) walk(v[0], `${path}[0]`, depth + 1, row); return; }
    if (isObj(v)) { if (depth < 3) for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1, row); return; }
    const s = String(v).trim();
    if (!s) return;
    let c = cols.get(path);
    if (!c) { if (cols.size >= maxColumns) return; c = { path, filled: 0, totalLen: 0, samples: [] }; cols.set(path, c); }
    c.filled++; c.totalLen += s.length;
    if (c.samples.length < 3 && !c.samples.includes(s)) c.samples.push(s.slice(0, 80));
  };
  const rows = items.slice(0, sampleRows);
  for (const it of rows) for (const [k, v] of Object.entries(it)) walk(v, k, 0, it);
  return [...cols.values()].map((c) => ({ path: c.path, filled: c.filled / rows.length, avgLen: c.totalLen / c.filled, samples: c.samples }));
}
