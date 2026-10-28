// Sual-cavab cütləri: sahib bir suala dəqiq cavab yazır (bir neçə fərqli ifadə ilə). İstifadəçinin sualı
// bu suallardan birinə kifayət qədər yaxındırsa, cavab MODELSİZ, sözbəsöz verilir (sürətli, pulsuz, uydurma yoxdur).
// Əks halda cütlük adi mənbə kimi kontekstə düşür və model ondan istifadə edə bilər.
import { embedDocuments } from "./embed.js";
import { KbError } from "./extract.js";
import { listSources, newSource, putSource, replaceSourceChunks, countChunks, getSource } from "./store.js";

export const MAX_QUESTIONS = 8, MAX_QUESTION_CHARS = 200, MAX_ANSWER_CHARS = 2000;
const maxQa = (t) => t.limits?.kbQa ?? (Number(process.env.KB_MAX_QA) || 300);
const maxChunks = (t) => t.limits?.kbChunks ?? (Number(process.env.KB_MAX_CHUNKS) || 2500);
/** Bu oxşarlıqdan (cosine) yuxarı uyğunluq "eyni sual" sayılır */
const EXACT_COS = () => Number(process.env.KB_QA_COSINE) || 0.84;

const clean = (s) => String(s ?? "").replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();

/** Qaytarır: { questions, answer } və ya xəta atır */
export function parseQa(input) {
  const qs = (Array.isArray(input?.questions) ? input.questions : []).map((q) => clean(q).replace(/\s+/g, " ")).filter(Boolean);
  const questions = [...new Set(qs)];
  const answer = clean(input?.answer);
  if (!questions.length) throw new KbError("Ən azı bir sual yazın", "BAD_QA");
  if (questions.length > MAX_QUESTIONS) throw new KbError(`Bir cavab üçün ən çox ${MAX_QUESTIONS} sual ifadəsi yaza bilərsiniz`, "BAD_QA");
  if (questions.some((q) => q.length < 3 || q.length > MAX_QUESTION_CHARS)) throw new KbError(`Hər sual 3-${MAX_QUESTION_CHARS} simvol olmalıdır`, "BAD_QA");
  if (answer.length < 2) throw new KbError("Cavab boşdur", "BAD_QA");
  if (answer.length > MAX_ANSWER_CHARS) throw new KbError(`Cavab çox uzundur (maksimum ${MAX_ANSWER_CHARS} simvol)`, "BAD_QA");
  return { questions, answer };
}

async function writeQa(tenant, source, { questions, answer }) {
  const others = (await countChunks(tenant.tenantId)) - (source.chunks ?? 0);
  if (others + questions.length > maxChunks(tenant)) throw new KbError("Bilik bazası həcm limitini aşır. Köhnə mənbələri silin.", "CHUNK_LIMIT");
  const vectors = await embedDocuments(questions);
  await replaceSourceChunks(tenant.tenantId, source._id, questions.map((q, i) => ({
    title: source.name, heading: "Sual-cavab", text: `Sual: ${q}\nCavab: ${answer}`, qa: true, qaAnswer: answer, emb: vectors[i],
  })));
  Object.assign(source, { name: questions[0].slice(0, 160), questions, answer, status: "ready", error: null, chunks: questions.length, chars: answer.length, pages: 1, lastIndexedAt: new Date().toISOString() });
  return putSource(source);
}

export async function createQa(tenant, input) {
  const parsed = parseQa(input);
  const existing = (await listSources(tenant.tenantId)).filter((s) => s.type === "qa");
  if (existing.length >= maxQa(tenant)) throw new KbError(`Ən çox ${maxQa(tenant)} sual-cavab cütü əlavə edə bilərsiniz`, "SOURCE_LIMIT");
  const source = newSource(tenant.tenantId, { type: "qa", name: parsed.questions[0].slice(0, 160) });
  return writeQa(tenant, source, parsed);
}

export async function updateQa(tenant, id, input) {
  const parsed = parseQa(input);
  const source = await getSource(tenant.tenantId, id);
  if (!source || source.type !== "qa") return null;
  return writeQa(tenant, source, parsed);
}

/** hits: searchKb nəticəsi. Ən yaxın sual-cavab cütü kifayət qədər yaxındırsa onun cavabını qaytarır. */
export function exactAnswer(hits) {
  let best = null;
  for (const h of hits ?? []) if (h.chunk?.qa && h.chunk.qaAnswer && h.cos >= EXACT_COS() && (!best || h.cos > best.cos)) best = h;
  return best ? { answer: best.chunk.qaAnswer, title: best.chunk.title } : null;
}
