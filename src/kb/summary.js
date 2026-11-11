// Söhbətin AI xülasəsi (operator və sahib üçün): nə istəyir, əhvalı necədir, nəyə etiraz edir, növbəti addım nədir, almağa nə qədər yaxındır.
// Heç nə müştəriyə getmir. Nəticə qısa JSON-dur; panel onu kart kimi göstərir və təkrar xərc olmasın deyə saxlayır.
import { geminiClient } from "./client.js";
import { generate } from "./answer.js";
import { newMeter } from "../billing/pricing.js";
import { chatModels, RETRYABLE } from "../ai/llm.js";

const LANG = { az: "Azərbaycan dili (Latın əlifbası)", en: "English", ru: "русский", tr: "Türkçe" };
const ROLES = { visitor: "Müştəri", user: "Müştəri", operator: "Operator", ai: "AI köməkçi", model: "AI köməkçi" };
export const MOODS = ["positive", "neutral", "negative"];
export const TEMPS = ["hot", "warm", "cold"];
const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, n);

export const validSummaryInput = (b) =>
  b && Array.isArray(b.messages) && b.messages.length > 0 && b.messages.length <= 60
  && b.messages.every((m) => m && Object.hasOwn(ROLES, m.from) && typeof m.text === "string");

/** Modelin JSON cavabını yoxlayır: tanınmayan dəyərlər atılır, mətnlər qısaldılır. */
export function parseSummary(text) {
  const raw = String(text ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  let o;
  try { o = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const summary = clip(o.summary, 400);
  if (!summary) return null;
  return {
    summary,
    intent: clip(o.intent, 120),
    mood: MOODS.includes(o.mood) ? o.mood : "neutral",
    objections: (Array.isArray(o.objections) ? o.objections : []).map((x) => clip(x, 100)).filter(Boolean).slice(0, 3),
    nextStep: clip(o.nextStep, 200),
    temperature: TEMPS.includes(o.temperature) ? o.temperature : "warm",
  };
}

/** Qaytarır: { summary: {...}, tokens, costUsd } */
export async function summarizeChat({ tenant, messages }, client = geminiClient()) {
  const p = tenant.profile ?? {};
  const lang = LANG[p.language] ?? LANG.az;
  const system = `Sən "${p.businessName ?? "şirkət"}" şirkətinin satış və dəstək komandası üçün müştəri söhbətini təhlil edirsən. Məqsəd: operator söhbəti oxumadan 5 saniyəyə vəziyyəti başa düşsün.
Yalnız söhbətdə olanlara əsaslan, heç nə uydurma. Müştərinin şəxsi məlumatını (telefon, e-poçt, ünvan, kart) xülasəyə yazma.
Yalnız bu JSON-u qaytar:
{"summary": "1-2 cümlə: müştəri kimdir, nə istəyir, nəyə qədər gəlinib",
 "intent": "qısa niyyət, məs. 'Qiymət öyrənmək', 'Sifariş vermək', 'Şikayət: çatdırılma gecikib'",
 "mood": "positive | neutral | negative",
 "objections": ["müştərinin etirazları və ya tərəddüdləri, məs. 'Çatdırılma bahadır'; yoxdursa boş siyahı"],
 "nextStep": "operatorun indi etməli olduğu konkret addım, məs. 'Endirim təklif et və ünvanı soruş'",
 "temperature": "hot (almağa hazırdır) | warm (maraqlanır) | cold (maraq azdır və ya yalnız sual verir)"}
Bütün mətnləri bu dildə yaz: ${lang}.`;
  const convo = messages.slice(-60).map((m) => `${ROLES[m.from]}: ${clip(m.text, 500)}`).join("\n");
  const contents = [{ role: "user", parts: [{ text: `SÖHBƏT:\n${convo}` }] }];
  const meter = newMeter();
  let lastErr;
  for (const model of chatModels()) {
    try {
      const res = await generate(client, { model, contents, config: { systemInstruction: system, responseMimeType: "application/json" } });
      meter.add(model, res.usageMetadata);
      const summary = parseSummary(res.text);
      if (!summary) { lastErr = Object.assign(new Error("Model düzgün xülasə qaytarmadı"), { status: 502 }); continue; }
      return { summary, tokens: meter.tokens, costUsd: meter.costUsd };
    } catch (err) {
      lastErr = err;
      if (RETRYABLE.includes(err.status)) continue;
      throw err;
    }
  }
  throw lastErr;
}
