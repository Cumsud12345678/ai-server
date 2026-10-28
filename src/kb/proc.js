// Ssenarilər (Procedures): sahib sadə dildə addım-addım qayda yazır ("qaytarma", "sifariş ləğvi", "görüş rezervi").
// İstifadəçinin sualı ssenarinin "nə vaxt" ifadələrindən birinə yaxındırsa, addımlar modelə təlimat kimi verilir (model sözbəsöz oxumur, söhbət tərzində addımları aparır).
import { embedDocuments } from "./embed.js";
import { KbError } from "./extract.js";
import { listSources, newSource, putSource, replaceSourceChunks, countChunks, getSource } from "./store.js";

export const MAX_TRIGGERS = 6, MAX_TRIGGER_CHARS = 200, MAX_NAME_CHARS = 80, MAX_STEPS_CHARS = 2500;
const maxProc = (t) => t.limits?.kbProc ?? (Number(process.env.KB_MAX_PROC) || 20);
const maxChunks = (t) => t.limits?.kbChunks ?? (Number(process.env.KB_MAX_CHUNKS) || 2500);
/** Bu oxşarlıqdan (cosine) yuxarı uyğunluq "ssenari işə düşdü" sayılır. Sual-cavabdan aşağıdır: tətik ifadələri vəziyyəti təsvir edir. */
const PROC_COS = () => Number(process.env.KB_PROC_COSINE) || 0.66;

const clean = (s) => String(s ?? "").replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();

export function parseProc(input) {
  const name = clean(input?.name).replace(/\s+/g, " ");
  const trig = (Array.isArray(input?.triggers) ? input.triggers : []).map((q) => clean(q).replace(/\s+/g, " ")).filter(Boolean);
  const triggers = [...new Set(trig)];
  const steps = clean(input?.steps);
  if (name.length < 2 || name.length > MAX_NAME_CHARS) throw new KbError(`Ssenarinin adı 2-${MAX_NAME_CHARS} simvol olmalıdır`, "BAD_PROC");
  if (!triggers.length) throw new KbError("Ssenarinin nə vaxt işləməli olduğunu ən azı bir ifadə ilə yazın", "BAD_PROC");
  if (triggers.length > MAX_TRIGGERS) throw new KbError(`Ən çox ${MAX_TRIGGERS} ifadə yaza bilərsiniz`, "BAD_PROC");
  if (triggers.some((q) => q.length < 3 || q.length > MAX_TRIGGER_CHARS)) throw new KbError(`Hər ifadə 3-${MAX_TRIGGER_CHARS} simvol olmalıdır`, "BAD_PROC");
  if (steps.length < 10) throw new KbError("Addımlar çox qısadır", "BAD_PROC");
  if (steps.length > MAX_STEPS_CHARS) throw new KbError(`Addımlar çox uzundur (maksimum ${MAX_STEPS_CHARS} simvol)`, "BAD_PROC");
  return { name, triggers, steps };
}

async function writeProc(tenant, source, { name, triggers, steps }) {
  const others = (await countChunks(tenant.tenantId)) - (source.chunks ?? 0);
  if (others + triggers.length > maxChunks(tenant)) throw new KbError("Bilik bazası həcm limitini aşır. Köhnə mənbələri silin.", "CHUNK_LIMIT");
  const vectors = await embedDocuments(triggers.map((q) => `${name}. ${q}`));
  await replaceSourceChunks(tenant.tenantId, source._id, triggers.map((q, i) => ({
    title: name, heading: "Ssenari", text: `Ssenari: ${name}\nNə vaxt: ${q}`, proc: true, procName: name, procSteps: steps, emb: vectors[i],
  })));
  Object.assign(source, { name, triggers, steps, status: "ready", error: null, chunks: triggers.length, chars: steps.length, pages: 1, lastIndexedAt: new Date().toISOString() });
  return putSource(source);
}

export async function createProc(tenant, input) {
  const parsed = parseProc(input);
  const existing = (await listSources(tenant.tenantId)).filter((s) => s.type === "proc");
  if (existing.length >= maxProc(tenant)) throw new KbError(`Ən çox ${maxProc(tenant)} ssenari əlavə edə bilərsiniz`, "SOURCE_LIMIT");
  return writeProc(tenant, newSource(tenant.tenantId, { type: "proc", name: parsed.name }), parsed);
}

export async function updateProc(tenant, id, input) {
  const parsed = parseProc(input);
  const source = await getSource(tenant.tenantId, id);
  if (!source || source.type !== "proc") return null;
  return writeProc(tenant, source, parsed);
}

/** hits: searchKb nəticəsi. Ən yaxın ssenari kifayət qədər yaxındırsa { name, steps }, yoxsa null. */
export function procedureHit(hits) {
  let best = null;
  for (const h of hits ?? []) if (h.chunk?.proc && h.chunk.procSteps && h.cos >= PROC_COS() && (!best || h.cos > best.cos)) best = h;
  return best ? { name: best.chunk.procName ?? best.chunk.title, steps: best.chunk.procSteps } : null;
}

/** Sistem təlimatına əlavə olunan blok (sahibin yazdığı etibarlı təlimat) */
export const procedurePrompt = (p) => p ? `\n\nSSENARİ "${p.name}" (sahibin təyin etdiyi qayda): İstifadəçinin sualı bu ssenariyə aiddir. Aşağıdakı addımlara sıra ilə əməl et: söhbət tərzində, bir dəfəyə yalnız lazım olan addımı/sualı yaz, istifadəçinin cavabını gözlə. Addımlarda olmayan şərt, qiymət, vəd uydurma; addımlarda cavabı olmayan məsələdə [[NO_ANSWER]] yaz.\n${p.steps}` : "";
