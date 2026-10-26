// Hibrid axtarış: vektor oxşarlığı (cosine) + açar söz uyğunluğu. Embedding alınmasa açar sözə düşür.
import { listChunks } from "./store.js";
import { embedQuery } from "./embed.js";

const FOLD = { "ə": "e", "ı": "i", "ö": "o", "ü": "u", "ç": "c", "ş": "s", "ğ": "g", "ё": "е" };
export const fold = (s) => String(s).toLowerCase().replace(/[əıöüçşğё]/g, (c) => FOLD[c]).replace(/i̇/g, "i");
const STOP = new Set(["ve", "ya", "bu", "o", "ne", "nece", "hansi", "ucun", "ile", "var", "yox", "mi", "mu", "the", "and", "for", "how", "what", "is", "are", "to", "of", "a", "и", "в", "на", "как", "что", "это", "для", "по"]);
const tokens = (s) => fold(s).split(/[^a-z0-9а-я]+/).filter((t) => t.length >= 3 && !STOP.has(t)).map((t) => t.slice(0, 6));

const MIN_COS = () => Number(process.env.KB_MIN_COSINE) || 0.55;
const MIN_COS_WITH_KW = () => Number(process.env.KB_MIN_COSINE_KW) || 0.45;
// "Zəif uyğunluq": hədd keçilməsə də ən yaxın hissələr modelə verilir, o özü qərar verir (dialekt, səhv yazılış, danışıq dili sorğularında hədd tez-tez səhv rədd edirdi)
const WEAK_COS = () => Number(process.env.KB_WEAK_COSINE) || 0.38;

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Qaytarır: { hits: [{ chunk, score, cos, kw }], relevant: bool, weak: bool }. hits azalan sırada, ən çox k ədəd. */
export async function searchKb(tenantId, query, { k = 5, client } = {}) {
  const chunks = await listChunks(tenantId);
  if (!chunks.length) return { hits: [], relevant: false, empty: true };
  let qv = null;
  try { qv = await embedQuery(query, client); } catch (e) { console.warn(`[kb] sorğu embedding alınmadı, açar sözə keçdim: ${e.message}`); }
  const qt = new Set(tokens(query));
  const scored = chunks.map((c) => {
    const cos = qv && c.emb ? dot(qv, c.emb) : 0;
    let kw = 0;
    if (qt.size) { const ct = new Set(tokens(`${c.title ?? ""} ${c.heading ?? ""} ${c.text}`)); let n = 0; for (const t of qt) if (ct.has(t)) n++; kw = n / qt.size; }
    return { chunk: c, cos, kw, score: qv ? 0.8 * cos + 0.2 * kw : kw };
  }).sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, k);
  const top = hits[0];
  const relevant = qv ? top.cos >= MIN_COS() || (top.kw >= 0.6 && top.cos >= MIN_COS_WITH_KW()) : top.kw >= 0.6;
  const weak = !relevant && (qv ? top.cos >= WEAK_COS() : top.kw >= 0.3);
  return { hits, relevant, weak };
}
