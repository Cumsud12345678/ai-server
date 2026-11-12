// Operator cavablarından öyrənmə: canlı söhbət bağlananda AI operatorun verdiyi, başqa müştərilərə də yarayan məlumatları
// sual-cavab təklifi kimi çıxarır (məs. "Gəncəyə çatdırılma var? — Bəli, 2 günə, 5 AZN"). Bilik bazası bunu artıq bilirsə təklif olunmur.
// Təklif avtomatik bilik bazasına düşmür: sahib paneldə baxır, düzəldir, təsdiqləyir və ya rədd edir.
import { geminiClient } from "./client.js";
import { generate } from "./answer.js";
import { searchKb } from "./search.js";
import { newMeter } from "../billing/pricing.js";
import { chatModels, RETRYABLE } from "../ai/llm.js";

const LANG = { az: "Azərbaycan dili (Latın əlifbası)", en: "English", ru: "русский", tr: "Türkçe" };
const ROLES = { visitor: "Müştəri", operator: "Operator" };
const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, n);
export const MAX_PAIRS = 3;

export const validLearnInput = (b) =>
  b && Array.isArray(b.messages) && b.messages.length >= 2 && b.messages.length <= 80
  && b.messages.every((m) => m && Object.hasOwn(ROLES, m.from) && typeof m.text === "string")
  && b.messages.some((m) => m.from === "operator" && m.text.trim().length >= 10);

/** Şəxsi məlumat (telefon, e-poçt, sifariş nömrəsi kimi uzun rəqəmlər) olan cütlər atılır */
const PERSONAL = /[^\s@]+@[^\s@]+\.[^\s@]+|(?:\+?\d[\d\s()-]{7,}\d)|#\s?\d{4,}|№\s?\d{3,}/;

export function parsePairs(text) {
  const raw = String(text ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  let o;
  try { o = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw); } catch { return []; }
  const seen = new Set();
  return (Array.isArray(o?.pairs) ? o.pairs : [])
    .map((p) => ({ question: clip(p?.question, 200), answer: clip(p?.answer, 1000) }))
    .filter((p) => p.question.length >= 5 && p.answer.length >= 2 && !PERSONAL.test(p.question) && !PERSONAL.test(p.answer))
    .filter((p) => { const k = p.question.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, MAX_PAIRS);
}

/** Qaytarır: { pairs: [{question, answer}], tokens, costUsd } (bilik bazasının artıq bildikləri çıxarılıb) */
export async function learnFromChat({ tenant, messages }, client = geminiClient()) {
  const p = tenant.profile ?? {};
  const system = `Sən "${p.businessName ?? "şirkət"}" şirkətinin köməkçisinin bilik bazasını genişləndirirsən. Aşağıda müştəri ilə canlı operatorun söhbəti var.
Operatorun cavablarından BAŞQA müştərilərə də yarayan ümumi məlumatları sual-cavab cütü kimi çıxar: qiymət, çatdırılma, iş saatı, ünvan, qayda, xidmət, stok və s.
Qaydalar:
- Yalnız operatorun açıq dediyi faktlar. Uydurma, ümumiləşdirmə etmə.
- Bu müştəriyə aid şəxsi şeyləri (onun sifarişi, adı, telefonu, ünvanı, ödənişi, şikayətinin həlli) YAZMA.
- Sual müştərinin soruşacağı kimi qısa olsun, cavab operatorun dediyi kimi, 1-3 cümlə.
- Ən çox ${MAX_PAIRS} cüt. Yararlı heç nə yoxdursa boş siyahı.
Yalnız bu JSON-u qaytar: {"pairs": [{"question": "...", "answer": "..."}]}
Mətnləri bu dildə yaz: ${LANG[p.language] ?? LANG.az}.`;
  const convo = messages.slice(-80).map((m) => `${ROLES[m.from]}: ${clip(m.text, 600)}`).join("\n");
  const meter = newMeter();
  let lastErr;
  for (const model of chatModels()) {
    try {
      const res = await generate(client, { model, contents: [{ role: "user", parts: [{ text: `SÖHBƏT:\n${convo}` }] }], config: { systemInstruction: system, responseMimeType: "application/json" } });
      meter.add(model, res.usageMetadata);
      const out = [];
      for (const pair of parsePairs(res.text)) {
        // Köməkçi bunu artıq bilirsə təklif etmə
        const found = await searchKb(tenant.tenantId, pair.question, { k: 3, client }).catch(() => null);
        if (found?.relevant && !found.weak) continue;
        out.push(pair);
      }
      return { pairs: out, tokens: meter.tokens, costUsd: meter.costUsd };
    } catch (err) {
      lastErr = err;
      if (RETRYABLE.includes(err.status)) continue;
      throw err;
    }
  }
  throw lastErr;
}
