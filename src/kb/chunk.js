// Mətni mənaca bütöv hissələrə bölür (başlıq/abzas sərhədlərinə hörmət edir, qonşu hissələr bir az üst-üstə düşür).
const SIZE = Number(process.env.KB_CHUNK_CHARS) || 900;
const OVERLAP = Number(process.env.KB_CHUNK_OVERLAP) || 120;

function splitLong(p) {
  if (p.length <= SIZE) return [p];
  const out = [];
  const sentences = p.match(/[^.!?\n]+[.!?]*\s*/g) ?? [p];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > SIZE && cur) { out.push(cur.trim()); cur = ""; }
    if (s.length > SIZE) { for (let i = 0; i < s.length; i += SIZE) out.push(s.slice(i, i + SIZE).trim()); }
    else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Qaytarır: [{ text, heading }] */
export function chunkText(text) {
  const paras = String(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = "", heading = "", curHeading = "";
  const flush = () => {
    if (cur.trim().length >= 20) chunks.push({ text: cur.trim(), heading: curHeading });
    cur = "";
  };
  for (const p of paras) {
    const h = p.match(/^#{1,4}\s+(.+)$/m);
    if (/^#{1,4}\s/.test(p) && p.split("\n").length === 1) { flush(); heading = p.replace(/^#+\s+/, "").slice(0, 120); curHeading = heading; cur = p.replace(/^#+\s+/, "") + "\n"; continue; }
    for (const piece of splitLong(p)) {
      if ((cur + "\n" + piece).length > SIZE && cur.trim()) {
        const tail = cur.slice(-OVERLAP);
        flush();
        curHeading = heading;
        cur = (tail.length >= 40 ? "…" + tail.slice(tail.indexOf(" ") + 1) + "\n" : "") + piece;
      } else cur += (cur ? "\n" : "") + piece;
      void h;
    }
  }
  flush();
  return chunks;
}
