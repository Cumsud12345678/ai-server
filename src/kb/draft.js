// Operator köməkçisi: canlı söhbətə baxıb cavab QARALAMASI yazır. Heç nə ziyarətçiyə avtomatik getmir: operator redaktə edib özü göndərir.
import { geminiClient } from "./client.js";
import { searchKb } from "./search.js";
import { contextBlock, generate } from "./answer.js";
import { newMeter } from "../billing/pricing.js";

const MODELS = (process.env.GEMINI_MODELS || "gemini-3.5-flash,gemini-3-flash-preview").split(",").map((s) => s.trim()).filter(Boolean);
const LANG = { az: "Azərbaycan dili (Latın əlifbası)", en: "English", ru: "русский" };
const clip = (v, n) => String(v ?? "").slice(0, n);

export const validDraftInput = (b) =>
  b && Array.isArray(b.messages) && b.messages.length > 0 && b.messages.length <= 20 && b.messages.every((m) => m && ["visitor", "operator"].includes(m.from) && typeof m.text === "string")
  && (b.context === undefined || (Array.isArray(b.context) && b.context.length <= 10 && b.context.every((m) => m && ["user", "model"].includes(m.role) && typeof m.text === "string")));

/** Qaytarır: { draft, tokens, costUsd }. */
export async function draftReply({ tenant, messages, context = [] }, client = geminiClient()) {
  const lastVisitor = [...messages].reverse().find((m) => m.from === "visitor");
  const found = await searchKb(tenant.tenantId, clip(lastVisitor?.text, 300), { k: 4, client }).catch(() => ({ hits: [], relevant: false, weak: false }));
  const hits = (found.hits ?? []).filter((h) => !h.chunk.proc);
  const kb = found.relevant || found.weak ? contextBlock(hits.slice(0, 4)) : "";
  const p = tenant.profile ?? {};
  const system = `Sən "${tenant.businessName ?? "şirkət"}" şirkətinin canlı dəstək operatoruna kömək edirsən. Operator müştəri ilə yazışır; sən operatorun göndərəcəyi növbəti mesajın QARALAMASINI yazırsan.
Qaydalar: yalnız aşağıdakı KONTEKSTDƏ və söhbətdə olan məlumata əsaslan; qiymət, tarix, siyasət və ya vəd uydurma. Cavab üçün məlumat yoxdursa qısa aydınlaşdırıcı sual ver və ya operatorun yoxlamalı olduğunu "[Operator: ...]" şəklində mötərizədə yaz. Cavabı müştəriyə ünvanla, qısa (1-4 cümlə) və nəzakətli yaz. Dil: ${LANG[p.language] ?? LANG.az}. Ton: ${p.tone ?? "dostcasına, peşəkar"}. Yalnız mesajın mətnini qaytar, izah və ya başlıq yazma.${p.extraInstructions ? "\n" + clip(p.extraInstructions, 800) : ""}`;
  const convo = [
    ...(context.length ? [`AI ilə əvvəlki yazışma:\n${context.map((m) => `${m.role === "user" ? "Müştəri" : "AI"}: ${clip(m.text, 400)}`).join("\n")}`] : []),
    `Canlı söhbət:\n${messages.map((m) => `${m.from === "visitor" ? "Müştəri" : "Operator"}: ${clip(m.text, 600)}`).join("\n")}`,
  ].join("\n\n");
  const contents = [{ role: "user", parts: [{ text: `KONTEKST:\n${kb || "(uyğun məzmun tapılmadı)"}\n\n${convo}\n\nOperatorun növbəti mesajının qaralaması:` }] }];
  const meter = newMeter();
  let lastErr;
  for (const model of MODELS) {
    try {
      const res = await generate(client, { model, contents, config: { systemInstruction: system } });
      meter.add(model, res.usageMetadata);
      const draft = clip(res.text, 1000).replace(/^["“]|["”]$/g, "").trim();
      return { draft, tokens: meter.tokens, costUsd: meter.costUsd };
    } catch (err) {
      lastErr = err;
      if ([503, 500, 429, 404].includes(err.status)) continue;
      throw err;
    }
  }
  throw lastErr;
}
